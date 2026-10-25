import { randomUUID } from "node:crypto";
import "dotenv/config";
import { createDatabase } from "./db/client.js";
import {
  createExamAttempt,
  createUserSession,
  findActiveAttemptId,
  findSessionUser,
  findUserByEmail,
  loadExamAttempt,
  registerUserWithSession,
  revokeUserSession,
  saveExamAttempt,
  syncExamCatalog,
  type StoredExamAttempt,
  type StoredQuestionProgress,
} from "./db/persistence.js";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import websocket from "@fastify/websocket";
import argon2 from "argon2";
import WebSocket, { type RawData } from "ws";
import { z } from "zod";
import { corsOptions } from "./cors.js";
import { getSafeStartupErrorDetails } from "./startup-error.js";
import { examCatalog, type ExamDefinition, type QuestionDefinition } from "./exams/catalog.js";
import { assessQuestionState, expectedAnswer } from "./exams/assessment.js";
import { effectiveDeadline } from "./exams/rules.js";
import {
  createExecutor,
  ExecutorUnavailableError,
  type WorkspaceTemplate,
} from "./executor/types.js";

type QuestionStatus = "locked" | "active" | "submitted" | "expired" | "skipped";

interface Candidate {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  role: "candidate" | "admin";
}

type QuestionAttempt = StoredQuestionProgress;
type ExamAttempt = StoredExamAttempt;

interface SessionClaims {
  sub: string;
  sid: string;
}

interface PublicUser {
  id: string;
  name: string;
  email: string;
  role: "candidate" | "admin";
}

interface TerminalTicket {
  userId: string;
  attemptId: string;
  questionId: string;
  workspaceId: string;
  expiresAt: number;
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function isUniqueViolation(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  if ("code" in error && (error as { code?: unknown }).code === "23505") return true;
  return "cause" in error && isUniqueViolation(error.cause);
}

declare module "fastify" {
  interface FastifyRequest {
    candidate: PublicUser | null;
  }
}

const isProduction = process.env.NODE_ENV === "production";
const host = isProduction ? "0.0.0.0" : process.env.HOST ?? "127.0.0.1";
const rawPort = process.env.PORT;
const port = Number(rawPort ?? 3001);
const cookieSecure = process.env.COOKIE_SECURE === "true" || isProduction;
const jwtSecret =
  process.env.JWT_SECRET ?? "termforge-local-development-secret-change-before-deploy";
const cookieName = "termforge_session";
const terminalReadyMessage = "termforge:terminal-ready";
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL must be configured");
}
if (isProduction && !rawPort) {
  throw new Error("PORT must be configured in production");
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be a valid TCP port");
}
if (isProduction && !process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET must be configured in production");
}
if (jwtSecret.length < 32) {
  throw new Error("JWT_SECRET must contain at least 32 characters");
}

const { db, pool } = createDatabase(databaseUrl);
const terminalTickets = new Map<string, TerminalTicket>();
const executor = createExecutor();
const app = Fastify({
  logger: true,
  bodyLimit: 16 * 1024,
  trustProxy: false,
});

app.decorateRequest("candidate", null);
await app.register(cors, corsOptions);
await app.register(cookie);
await app.register(websocket);
await app.register(jwt, {
  secret: jwtSecret,
  cookie: { cookieName, signed: false },
  sign: { expiresIn: "12h" },
});

app.setErrorHandler((error, request, reply) => {
  if (error instanceof HttpError) {
    return reply.code(error.statusCode).send({
      error: error.code ?? "REQUEST_FAILED",
      message: error.message,
    });
  }
  if (error instanceof z.ZodError) {
    return reply.code(400).send({
      error: "INVALID_REQUEST",
      message: error.issues[0]?.message ?? "Request validation failed",
    });
  }
  request.log.error(
    { errorName: error instanceof Error ? error.name : "UnknownError" },
    "Request failed",
  );
  return reply.code(500).send({
    error: "INTERNAL_ERROR",
    message: "The server could not complete the request.",
  });
});

function publicUser(candidate: Pick<Candidate, "id" | "name" | "email" | "role">): PublicUser {
  return {
    id: candidate.id,
    name: candidate.name,
    email: candidate.email,
    role: candidate.role,
  };
}

const authenticate = async (request: FastifyRequest): Promise<void> => {
  let claims: SessionClaims;
  try {
    claims = await request.jwtVerify<SessionClaims>();
  } catch {
    throw new HttpError(401, "Sign in to continue.", "UNAUTHENTICATED");
  }
  const candidate = await findSessionUser(db, claims.sid);
  if (!candidate || candidate.id !== claims.sub) {
    throw new HttpError(401, "Your session has expired. Sign in again.", "UNAUTHENTICATED");
  }
  request.candidate = publicUser(candidate);
};

function requireCandidate(request: FastifyRequest): PublicUser {
  if (!request.candidate) {
    throw new HttpError(401, "Sign in to continue.", "UNAUTHENTICATED");
  }
  return request.candidate;
}

function findExam(examId: string): ExamDefinition {
  const exam = examCatalog.find((item) => item.slug === examId);
  if (!exam) throw new HttpError(404, "Exam not found.", "NOT_FOUND");
  return exam;
}

function questionId(exam: ExamDefinition, index: number): string {
  return `${exam.slug}-q${index + 1}`;
}

async function findAttempt(userId: string, attemptId: string): Promise<ExamAttempt> {
  const attempt = await loadExamAttempt(db, userId, attemptId, examCatalog);
  if (!attempt) {
    throw new HttpError(404, "Attempt not found.", "NOT_FOUND");
  }
  refreshAttempt(attempt);
  await saveExamAttempt(db, attempt);
  return attempt;
}

function findQuestion(attempt: ExamAttempt, id: string): {
  question: QuestionDefinition;
  progress: QuestionAttempt;
} {
  const index = attempt.questions.findIndex((item) => item.questionId === id);
  const question = attempt.exam.questions[index];
  const progress = attempt.questions[index];
  if (!question || !progress) throw new HttpError(404, "Question not found.", "NOT_FOUND");
  return { question, progress };
}

function recomputeScore(attempt: ExamAttempt): void {
  attempt.totalScore = attempt.questions.reduce((sum, item) => sum + item.score, 0);
}

async function assessActiveQuestion(
  attempt: ExamAttempt,
  question: QuestionDefinition,
  progress: QuestionAttempt,
  request: FastifyRequest,
): Promise<ReturnType<typeof assessQuestionState>> {
  let result: ReturnType<typeof assessQuestionState>;
  try {
    const state = await executor.inspect({
      attemptId: attempt.id,
      questionId: progress.questionId,
    });
    result = assessQuestionState(state, question);
  } catch (error) {
    if (error instanceof ExecutorUnavailableError) {
      throw new HttpError(503, "Isolated terminal execution is not configured.", error.code);
    }
    request.log.error("Could not inspect isolated exam environment");
    throw new HttpError(503, "The isolated exam environment is temporarily unavailable.", "EXECUTOR_UNAVAILABLE");
  }
  progress.score = result.score;
  progress.feedback = result.feedback;
  recomputeScore(attempt);
  return result;
}

function finalizeAttempt(attempt: ExamAttempt, status: "submitted" | "expired"): void {
  if (attempt.status !== "in_progress") return;
  const now = new Date();
  for (const question of attempt.questions) {
    if (question.status === "active") {
      question.status = status === "expired" ? "expired" : "submitted";
      question.submittedAt = now;
    } else if (question.status === "locked") {
      question.status = "skipped";
    }
  }
  attempt.status = status;
  attempt.submittedAt = now;
  attempt.currentQuestionId = null;
  recomputeScore(attempt);
}

function refreshAttempt(attempt: ExamAttempt): void {
  if (attempt.status !== "in_progress") return;
  const now = new Date();
  if (now >= attempt.deadlineAt) {
    finalizeAttempt(attempt, "expired");
    return;
  }
  const active = attempt.questions.find((question) => question.status === "active");
  if (
    active?.deadlineAt &&
    now >= effectiveDeadline(attempt.deadlineAt, active.deadlineAt)
  ) {
    active.status = "expired";
    active.submittedAt = now;
    attempt.currentQuestionId = active.questionId;
  }
}

function toAttemptDto(attempt: ExamAttempt) {
  const resultsReady = attempt.status !== "in_progress";
  return {
    id: attempt.id,
    examId: attempt.exam.slug,
    status: attempt.status,
    startedAt: attempt.startedAt.toISOString(),
    examDeadlineAt: attempt.deadlineAt.toISOString(),
    currentQuestionId: attempt.currentQuestionId,
    totalScore: resultsReady ? attempt.totalScore : null,
    questions: attempt.exam.questions.map((question, index) => {
      const progress = attempt.questions[index];
      if (!progress) throw new Error("Attempt question state is missing");
      const dto: {
        id: string;
        title: string;
        prompt: string;
        timeLimitSeconds: number;
        marks: number;
        difficulty: QuestionDefinition["difficulty"];
        subquestions: Array<{ id: string; prompt: string; marks: number }>;
        status: QuestionStatus;
        startedAt: string | null;
        deadlineAt: string | null;
        score: number | null;
        feedback?: string[];
        expectedAnswers?: Array<{ label: string; prompt: string; requirement: string }>;
      } = {
        id: progress.questionId,
        title: question.title,
        prompt: question.prompt,
        timeLimitSeconds: question.timeLimitSeconds,
        marks: question.marks,
        difficulty: question.difficulty,
        subquestions: question.subquestions.map((subquestion, subIndex) => ({
          id: `${progress.questionId}-s${subIndex + 1}`,
          prompt: subquestion.prompt,
          marks: subquestion.marks,
        })),
        status: progress.status,
        startedAt: progress.startedAt?.toISOString() ?? null,
        deadlineAt: progress.deadlineAt?.toISOString() ?? null,
        score: resultsReady ? progress.score : null,
      };
      if (resultsReady) {
        if (progress.feedback) dto.feedback = progress.feedback;
        dto.expectedAnswers = question.subquestions.map((subquestion) => ({
          label: subquestion.label,
          prompt: subquestion.prompt,
          requirement: expectedAnswer(subquestion),
        }));
      }
      return dto;
    }),
  };
}

function getActiveQuestion(attempt: ExamAttempt, id: string): {
  question: QuestionDefinition;
  progress: QuestionAttempt;
} {
  refreshAttempt(attempt);
  if (attempt.status !== "in_progress") {
    throw new HttpError(409, "This exam attempt is no longer active.", "ATTEMPT_CLOSED");
  }
  const result = findQuestion(attempt, id);
  if (result.progress.status !== "active") {
    throw new HttpError(409, "This question is not active.", "QUESTION_CLOSED");
  }
  if (!result.progress.deadlineAt || new Date() >= effectiveDeadline(attempt.deadlineAt, result.progress.deadlineAt)) {
    refreshAttempt(attempt);
    throw new HttpError(409, "The question deadline has passed.", "DEADLINE_PASSED");
  }
  return result;
}

function getWorkspaceTemplate(topicSlug: ExamDefinition["topicSlug"]): WorkspaceTemplate {
  if (topicSlug === "git-github" || topicSlug === "docker" || topicSlug === "data-migration") {
    return topicSlug;
  }
  throw new HttpError(503, "No isolated terminal is configured for this exam.", "EXECUTOR_UNAVAILABLE");
}

function pruneTerminalTickets(): void {
  const now = Date.now();
  for (const [id, ticket] of terminalTickets) {
    if (ticket.expiresAt <= now) terminalTickets.delete(id);
  }
}

function websocketBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data);
}

function topicDto(topicSlug: ExamDefinition["topicSlug"]) {
  const exams = examCatalog.filter((item) => item.topicSlug === topicSlug);
  const topicTitle = exams[0]?.topicTitle;
  if (!topicTitle) throw new Error(`No published exam exists for ${topicSlug}`);
  const description =
    topicSlug === "git-github"
      ? "Git fundamentals, branching, commits, remotes, and collaboration."
      : topicSlug === "docker"
        ? "Docker CLI workflows practiced safely in an in-memory simulator."
        : "Plan and verify safe schema and data transformations.";
  return {
    id: topicSlug,
    slug: topicSlug,
    name: topicTitle,
    description,
    tests: exams.map((exam) => ({
      id: exam.slug,
      title: exam.title,
      description: exam.description,
      totalMarks: exam.totalMarks,
      questionCount: exam.questions.length,
    })),
  };
}

app.get("/health", async (_request, reply) => {
  let database = "unavailable";
  try {
    await pool.query("SELECT 1");
    database = "connected";
  } catch {
    reply.code(503);
  }
  return {
    status: database === "connected" ? "ok" : "unavailable",
    mode: "postgres",
    database,
    terminalExecution:
      process.env.SANDBOX_WORKER_URL && process.env.SANDBOX_WORKER_TOKEN
        ? "configured"
        : "unavailable",
  };
});

app.get("/api/me", { preHandler: authenticate }, async (request) => ({
  ...requireCandidate(request),
}));

const registrationSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(128),
});

const loginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(128),
});

async function setSession(candidate: Candidate, reply: FastifyReply): Promise<PublicUser> {
  const sessionId = randomUUID();
  const token = await reply.jwtSign({ sub: candidate.id, sid: sessionId });
  await createUserSession(db, candidate.id, sessionId, new Date(Date.now() + 12 * 60 * 60 * 1000));
  applySessionCookie(reply, token);
  return publicUser(candidate);
}

function applySessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(cookieName, token, {
    path: "/",
    httpOnly: true,
    secure: cookieSecure,
    sameSite: "lax",
    maxAge: 60 * 60 * 12,
  });
}

app.post("/api/auth/register", async (request, reply) => {
  const body = registrationSchema.parse(request.body);
  const email = body.email.toLowerCase();
  const passwordHash = await argon2.hash(body.password);
  const userId = randomUUID();
  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);
  const token = await reply.jwtSign({ sub: userId, sid: sessionId });
  let candidate: Candidate;
  try {
    candidate = await registerUserWithSession(
      db,
      {
        name: body.name,
        email,
        passwordHash,
        role: "candidate",
      },
      userId,
      sessionId,
      expiresAt,
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new HttpError(409, "An account with this email already exists.", "EMAIL_IN_USE");
    }
    throw error;
  }
  applySessionCookie(reply, token);
  return reply.code(201).send({ user: publicUser(candidate) });
});

app.post("/api/auth/login", async (request, reply) => {
  const body = loginSchema.parse(request.body);
  const candidate = await findUserByEmail(db, body.email.toLowerCase());
  if (!candidate || !(await argon2.verify(candidate.passwordHash, body.password))) {
    throw new HttpError(401, "Email or password is incorrect.", "INVALID_CREDENTIALS");
  }
  return { user: await setSession(candidate, reply) };
});

app.post("/api/auth/logout", { preHandler: authenticate }, async (request, reply) => {
  const token = request.cookies[cookieName];
  if (token) {
    let claims: SessionClaims | undefined;
    try {
      claims = app.jwt.verify<SessionClaims>(token);
    } catch {
      request.log.info("Ignoring invalid session token during logout");
    }
    if (claims?.sub === requireCandidate(request).id) {
      await revokeUserSession(db, claims.sid);
    }
  }
  return reply.clearCookie(cookieName, { path: "/" }).code(204).send();
});

app.get("/api/topics", { preHandler: authenticate }, async () =>
  [...new Set(examCatalog.map((exam) => exam.topicSlug))].map(topicDto),
);

app.get<{ Params: { examId: string } }>(
  "/api/exams/:examId/briefing",
  { preHandler: authenticate },
  async (request) => {
    const exam = findExam(request.params.examId);
    return {
      id: exam.slug,
      title: exam.examTitle,
      topicId: exam.topicSlug,
      overallDurationSeconds: exam.durationSeconds,
      totalMarks: exam.totalMarks,
      navigationPolicy: "forward-only",
      reviewPolicy: "score",
      questions: exam.questions.map((question, index) => ({
        id: questionId(exam, index),
        title: question.title,
        prompt: question.prompt,
        timeLimitSeconds: question.timeLimitSeconds,
        marks: question.marks,
        difficulty: question.difficulty,
        subquestions: question.subquestions.map((subquestion, subIndex) => ({
          id: `${questionId(exam, index)}-s${subIndex + 1}`,
          prompt: subquestion.prompt,
          marks: subquestion.marks,
        })),
      })),
    };
  },
);

app.post<{ Params: { examId: string } }>(
  "/api/exams/:examId/attempts",
  { preHandler: authenticate },
  async (request, reply) => {
    const candidate = requireCandidate(request);
    const exam = findExam(request.params.examId);
    const existingId = await findActiveAttemptId(db, candidate.id, exam.slug);
    if (existingId) {
      const existing = await findAttempt(candidate.id, existingId);
      if (existing.status === "in_progress") return toAttemptDto(existing);
    }

    try {
      const attemptId = await createExamAttempt(db, candidate.id, exam, new Date());
      const attempt = await loadExamAttempt(db, candidate.id, attemptId, examCatalog);
      if (!attempt) throw new Error("The created exam attempt could not be loaded");
      return reply.code(201).send(toAttemptDto(attempt));
    } catch (error) {
      if (isUniqueViolation(error)) {
        const concurrentId = await findActiveAttemptId(db, candidate.id, exam.slug);
        if (concurrentId) {
          const concurrent = await findAttempt(candidate.id, concurrentId);
          return toAttemptDto(concurrent);
        }
      }
      throw error;
    }
  },
);

app.get<{ Params: { attemptId: string } }>(
  "/api/attempts/:attemptId",
  { preHandler: authenticate },
  async (request) =>
    toAttemptDto(await findAttempt(requireCandidate(request).id, request.params.attemptId)),
);

app.post<{ Params: { attemptId: string; questionId: string } }>(
  "/api/attempts/:attemptId/questions/:questionId/check",
  { preHandler: authenticate },
  async (request) => {
    const attempt = await findAttempt(requireCandidate(request).id, request.params.attemptId);
    const { question, progress } = getActiveQuestion(attempt, request.params.questionId);
    await assessActiveQuestion(attempt, question, progress, request);
    await saveExamAttempt(db, attempt);
    return { checked: true };
  },
);

app.post<{ Params: { attemptId: string; questionId: string } }>(
  "/api/attempts/:attemptId/questions/:questionId/activate",
  { preHandler: authenticate },
  async (request) => {
    const attempt = await findAttempt(requireCandidate(request).id, request.params.attemptId);
    refreshAttempt(attempt);
    if (attempt.status !== "in_progress") {
      throw new HttpError(409, "This exam attempt is no longer active.", "ATTEMPT_CLOSED");
    }
    const { progress } = findQuestion(attempt, request.params.questionId);
    const active = attempt.questions.find((item) => item.status === "active");
    if (active) {
      throw new HttpError(409, "Submit or wait for the active question before moving on.", "QUESTION_ACTIVE");
    }
    const nextAvailable = attempt.questions.find((item) => item.status === "locked" || item.status === "skipped");
    if (!nextAvailable || nextAvailable.questionId !== progress.questionId) {
      throw new HttpError(409, "Questions can only be activated in order.", "INVALID_NAVIGATION");
    }
    const now = new Date();
    const question = findQuestion(attempt, progress.questionId).question;
    progress.status = "active";
    progress.startedAt = now;
    progress.deadlineAt = new Date(
      Math.min(attempt.deadlineAt.getTime(), now.getTime() + question.timeLimitSeconds * 1000),
    );
    attempt.currentQuestionId = progress.questionId;
    await saveExamAttempt(db, attempt);
    return toAttemptDto(attempt);
  },
);

app.post<{ Params: { attemptId: string; questionId: string } }>(
  "/api/attempts/:attemptId/questions/:questionId/submit",
  { preHandler: authenticate },
  async (request) => {
    const attempt = await findAttempt(requireCandidate(request).id, request.params.attemptId);
    const { question, progress } = getActiveQuestion(attempt, request.params.questionId);
    if (attempt.exam.topicSlug !== "data-migration") {
      await assessActiveQuestion(attempt, question, progress, request);
    }
    progress.status = "submitted";
    progress.submittedAt = new Date();
    recomputeScore(attempt);
    await saveExamAttempt(db, attempt);
    return toAttemptDto(attempt);
  },
);

app.post<{ Params: { attemptId: string } }>(
  "/api/attempts/:attemptId/submit",
  { preHandler: authenticate },
  async (request) => {
    const attempt = await findAttempt(requireCandidate(request).id, request.params.attemptId);
    refreshAttempt(attempt);
    if (attempt.status === "in_progress") {
      const active = attempt.questions.find((progress) => progress.status === "active");
      if (active && attempt.exam.topicSlug !== "data-migration") {
        const { question } = findQuestion(attempt, active.questionId);
        await assessActiveQuestion(attempt, question, active, request);
      }
      finalizeAttempt(attempt, "submitted");
    }
    await saveExamAttempt(db, attempt);
    return toAttemptDto(attempt);
  },
);

app.get<{ Params: { attemptId: string } }>(
  "/api/attempts/:attemptId/result",
  { preHandler: authenticate },
  async (request) => {
    const attempt = await findAttempt(requireCandidate(request).id, request.params.attemptId);
    refreshAttempt(attempt);
    await saveExamAttempt(db, attempt);
    if (attempt.status === "in_progress") {
      throw new HttpError(409, "This exam attempt has not been submitted.", "ATTEMPT_ACTIVE");
    }
    return toAttemptDto(attempt);
  },
);

app.post<{ Params: { attemptId: string } }>(
  "/api/attempts/:attemptId/terminal-session",
  { preHandler: authenticate },
  async (request, reply) => {
    const candidate = requireCandidate(request);
    const attempt = await findAttempt(candidate.id, request.params.attemptId);
    refreshAttempt(attempt);
    if (attempt.status !== "in_progress" || !attempt.currentQuestionId) {
      throw new HttpError(409, "This attempt does not have an active terminal question.", "ATTEMPT_CLOSED");
    }
    const { progress } = getActiveQuestion(attempt, attempt.currentQuestionId);
    try {
      const workspace = await executor.createWorkspace({
        attemptId: attempt.id,
        questionId: progress.questionId,
        template: getWorkspaceTemplate(attempt.exam.topicSlug),
      });
      getActiveQuestion(attempt, progress.questionId);
      pruneTerminalTickets();
      const ticket = randomUUID();
      terminalTickets.set(ticket, {
        userId: candidate.id,
        attemptId: attempt.id,
        questionId: progress.questionId,
        workspaceId: workspace.id,
        expiresAt: Math.min(
          progress.deadlineAt?.getTime() ?? Date.now(),
          Date.now() + 15 * 60 * 1000,
        ),
      });
      return reply.send({
        id: ticket,
        websocketUrl: `/api/terminal/${ticket}`,
      });
    } catch (error) {
      if (error instanceof ExecutorUnavailableError) {
        throw new HttpError(503, error.message, error.code);
      }
      request.log.error({ err: error }, "Could not create isolated terminal workspace");
      throw new HttpError(
        503,
        "The isolated terminal workspace is temporarily unavailable.",
        "EXECUTOR_UNAVAILABLE",
      );
    }
  },
);

app.get<{ Params: { ticket: string } }>(
  "/api/terminal/:ticket",
  { websocket: true, preHandler: authenticate },
  async (socket, request) => {
    const candidate = requireCandidate(request);
    const ticket = terminalTickets.get(request.params.ticket);
    terminalTickets.delete(request.params.ticket);
    if (!ticket || ticket.userId !== candidate.id || ticket.expiresAt <= Date.now()) {
      socket.close(1008, "Terminal ticket is invalid or expired");
      return;
    }

    try {
      const attempt = await findAttempt(candidate.id, ticket.attemptId);
      getActiveQuestion(attempt, ticket.questionId);
    } catch {
      socket.close(1008, "Question is no longer active");
      return;
    }

    let upstream: WebSocket;
    try {
      upstream = executor.openTerminal(ticket.workspaceId);
    } catch (error) {
      request.log.error({ err: error }, "Could not connect to isolated terminal worker");
      socket.close(1011, "Terminal worker unavailable");
      return;
    }

    const pendingInput: Array<{ data: Buffer; binary: boolean }> = [];
    const expiryTimer = setTimeout(() => {
      if (socket.readyState === WebSocket.OPEN) socket.close(1008, "Question time expired");
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
        upstream.close();
      }
    }, Math.max(0, ticket.expiresAt - Date.now()));
    expiryTimer.unref();
    upstream.on("open", () => {
      if (socket.readyState !== WebSocket.OPEN) {
        upstream.close();
        return;
      }
      socket.send(terminalReadyMessage);
      for (const message of pendingInput.splice(0)) {
        upstream.send(message.data, { binary: message.binary });
      }
    });
    socket.on("message", (data, isBinary) => {
      const message = { data: websocketBuffer(data), binary: isBinary };
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(message.data, { binary: message.binary });
      } else if (
        upstream.readyState === WebSocket.CONNECTING &&
        pendingInput.reduce((size, item) => size + item.data.length, 0) + message.data.length <= 16 * 1024
      ) {
        pendingInput.push(message);
      } else {
        socket.close(1009, "Terminal input buffer exceeded");
      }
    });
    upstream.on("message", (data, isBinary) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > 1024 * 1024) {
        socket.close(1013, "Terminal output buffer exceeded");
        upstream.close();
        return;
      }
      socket.send(data, { binary: isBinary });
    });
    upstream.once("error", (error) => {
      request.log.warn({ err: error }, "Isolated terminal WebSocket failed");
      if (socket.readyState === WebSocket.OPEN) socket.close(1011, "Terminal worker connection failed");
    });
    upstream.once("close", () => {
      if (socket.readyState === WebSocket.OPEN) socket.close(1000, "Terminal worker closed");
    });
    socket.once("close", () => {
      clearTimeout(expiryTimer);
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
        upstream.close();
      }
    });
    socket.once("error", () => upstream.terminate());
  },
);

app.addHook("onClose", async () => {
  await pool.end();
});

let startupPhase = "exam catalog synchronization";
try {
  await syncExamCatalog(db, examCatalog);
  startupPhase = "HTTP server binding";
  await app.listen({ host, port });
} catch (error) {
  app.log.error(
    { startupPhase, ...getSafeStartupErrorDetails(error) },
    "Could not start the API server",
  );
  process.exitCode = 1;
  await app.close();
}

const shutdown = async () => {
  await app.close();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
