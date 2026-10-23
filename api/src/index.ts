import { randomUUID } from "node:crypto";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import websocket from "@fastify/websocket";
import argon2 from "argon2";
import WebSocket, { type RawData } from "ws";
import { z } from "zod";
import { examCatalog, type ExamDefinition, type QuestionDefinition } from "./exams/catalog.js";
import { effectiveDeadline, gradeQuestion } from "./exams/rules.js";
import {
  createExecutor,
  ExecutorUnavailableError,
  type WorkspaceTemplate,
} from "./executor/types.js";

type AttemptStatus = "in_progress" | "submitted" | "expired";
type QuestionStatus = "locked" | "active" | "submitted" | "expired" | "skipped";

interface Candidate {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  role: "candidate";
  sessions: Set<string>;
}

interface QuestionAttempt {
  questionId: string;
  status: QuestionStatus;
  startedAt: Date | null;
  deadlineAt: Date | null;
  submittedAt: Date | null;
  score: number;
  feedback?: string[];
}

interface ExamAttempt {
  id: string;
  userId: string;
  exam: ExamDefinition;
  status: AttemptStatus;
  startedAt: Date;
  deadlineAt: Date;
  submittedAt: Date | null;
  currentQuestionId: string | null;
  questions: QuestionAttempt[];
  totalScore: number;
}

interface SessionClaims {
  sub: string;
  sid: string;
}

interface PublicUser {
  id: string;
  name: string;
  email: string;
  role: "candidate";
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

declare module "fastify" {
  interface FastifyRequest {
    candidate: PublicUser | null;
  }
}

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3001);
const isProduction = process.env.NODE_ENV === "production";
const cookieSecure = process.env.COOKIE_SECURE === "true" || isProduction;
const jwtSecret =
  process.env.JWT_SECRET ?? "termforge-local-development-secret-change-before-deploy";
const cookieName = "termforge_session";

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be a valid TCP port");
}
if (isProduction && !process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET must be configured in production");
}
if (jwtSecret.length < 32) {
  throw new Error("JWT_SECRET must contain at least 32 characters");
}

const candidatesByEmail = new Map<string, Candidate>();
const candidatesById = new Map<string, Candidate>();
const attemptsById = new Map<string, ExamAttempt>();
const terminalTickets = new Map<string, TerminalTicket>();
const executor = createExecutor();
const app = Fastify({
  logger: true,
  bodyLimit: 16 * 1024,
  trustProxy: false,
});

app.decorateRequest("candidate", null);
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
  request.log.error({ err: error }, "Request failed");
  return reply.code(500).send({
    error: "INTERNAL_ERROR",
    message: "The server could not complete the request.",
  });
});

function publicUser(candidate: Candidate): PublicUser {
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
  const candidate = candidatesById.get(claims.sub);
  if (!candidate || !candidate.sessions.has(claims.sid)) {
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

function findAttempt(userId: string, attemptId: string): ExamAttempt {
  const attempt = attemptsById.get(attemptId);
  if (!attempt || attempt.userId !== userId) {
    throw new HttpError(404, "Attempt not found.", "NOT_FOUND");
  }
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

function finalizeAttempt(attempt: ExamAttempt, status: "submitted" | "expired"): void {
  if (attempt.status !== "in_progress") return;
  const now = new Date();
  for (const question of attempt.questions) {
    if (question.status === "active") {
      question.status = status === "expired" ? "expired" : "skipped";
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
  refreshAttempt(attempt);
  return {
    id: attempt.id,
    examId: attempt.exam.slug,
    status: attempt.status,
    startedAt: attempt.startedAt.toISOString(),
    examDeadlineAt: attempt.deadlineAt.toISOString(),
    currentQuestionId: attempt.currentQuestionId,
    totalScore: attempt.totalScore,
    questions: attempt.exam.questions.map((question, index) => {
      const progress = attempt.questions[index];
      if (!progress) throw new Error("Attempt question state is missing");
      const dto: {
        id: string;
        title: string;
        prompt: string;
        timeLimitSeconds: number;
        marks: number;
        subquestions: Array<{ id: string; prompt: string; marks: number }>;
        status: QuestionStatus;
        startedAt: string | null;
        deadlineAt: string | null;
        score: number;
        feedback?: string[];
      } = {
        id: progress.questionId,
        title: question.title,
        prompt: question.prompt,
        timeLimitSeconds: question.timeLimitSeconds,
        marks: question.marks,
        subquestions: question.subquestions.map((subquestion, subIndex) => ({
          id: `${progress.questionId}-s${subIndex + 1}`,
          prompt: subquestion.prompt,
          marks: subquestion.marks,
        })),
        status: progress.status,
        startedAt: progress.startedAt?.toISOString() ?? null,
        deadlineAt: progress.deadlineAt?.toISOString() ?? null,
        score: progress.score,
      };
      if (attempt.exam.slug && progress.feedback) dto.feedback = progress.feedback;
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

function getWorkspaceTemplate(slug: string): WorkspaceTemplate {
  if (slug === "git-github" || slug === "docker" || slug === "data-migration") {
    return slug;
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

function topicDto(exam: ExamDefinition) {
  return {
    id: exam.slug,
    slug: exam.slug,
    name: exam.title,
    description: exam.description,
    exam: {
      id: exam.slug,
      title: exam.examTitle,
      overallDurationSeconds: exam.durationSeconds,
      totalMarks: exam.totalMarks,
      questions: exam.questions.map((question, index) => ({
        id: questionId(exam, index),
        title: question.title,
        prompt: question.prompt,
        timeLimitSeconds: question.timeLimitSeconds,
        marks: question.marks,
        subquestions: question.subquestions.map((subquestion, subIndex) => ({
          id: `${questionId(exam, index)}-s${subIndex + 1}`,
          prompt: subquestion.prompt,
          marks: subquestion.marks,
        })),
      })),
    },
  };
}

app.get("/health", async () => ({
  status: "ok",
  mode: "local-memory",
  terminalExecution:
    process.env.SANDBOX_WORKER_URL && process.env.SANDBOX_WORKER_TOKEN
      ? "configured"
      : "unavailable",
}));

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
  candidate.sessions.add(sessionId);
  const token = await reply.jwtSign({ sub: candidate.id, sid: sessionId });
  reply.setCookie(cookieName, token, {
    path: "/",
    httpOnly: true,
    secure: cookieSecure,
    sameSite: "lax",
    maxAge: 60 * 60 * 12,
  });
  return publicUser(candidate);
}

app.post("/api/auth/register", async (request, reply) => {
  const body = registrationSchema.parse(request.body);
  const email = body.email.toLowerCase();
  if (candidatesByEmail.has(email)) {
    throw new HttpError(409, "An account with this email already exists.", "EMAIL_IN_USE");
  }
  const candidate: Candidate = {
    id: randomUUID(),
    name: body.name,
    email,
    passwordHash: await argon2.hash(body.password),
    role: "candidate",
    sessions: new Set(),
  };
  candidatesByEmail.set(email, candidate);
  candidatesById.set(candidate.id, candidate);
  return reply.code(201).send({ user: await setSession(candidate, reply) });
});

app.post("/api/auth/login", async (request, reply) => {
  const body = loginSchema.parse(request.body);
  const candidate = candidatesByEmail.get(body.email.toLowerCase());
  if (!candidate || !(await argon2.verify(candidate.passwordHash, body.password))) {
    throw new HttpError(401, "Email or password is incorrect.", "INVALID_CREDENTIALS");
  }
  return { user: await setSession(candidate, reply) };
});

app.post("/api/auth/logout", { preHandler: authenticate }, async (request, reply) => {
  const token = request.cookies[cookieName];
  if (token) {
    try {
      const claims = app.jwt.verify<SessionClaims>(token);
      candidatesById.get(claims.sub)?.sessions.delete(claims.sid);
    } catch {
      request.log.info("Ignoring invalid session token during logout");
    }
  }
  return reply.clearCookie(cookieName, { path: "/" }).code(204).send();
});

app.get("/api/topics", { preHandler: authenticate }, async () =>
  examCatalog.map(topicDto),
);

app.get<{ Params: { examId: string } }>(
  "/api/exams/:examId/briefing",
  { preHandler: authenticate },
  async (request) => {
    const exam = findExam(request.params.examId);
    return {
      id: exam.slug,
      title: exam.examTitle,
      topicId: exam.slug,
      overallDurationSeconds: exam.durationSeconds,
      totalMarks: exam.totalMarks,
      navigationPolicy: "forward-only",
      reviewPolicy: "score",
      questions: topicDto(exam).exam.questions,
    };
  },
);

app.post<{ Params: { examId: string } }>(
  "/api/exams/:examId/attempts",
  { preHandler: authenticate },
  async (request, reply) => {
    const candidate = requireCandidate(request);
    const exam = findExam(request.params.examId);
    const existing = [...attemptsById.values()].find(
      (attempt) => attempt.userId === candidate.id && attempt.exam.slug === exam.slug && attempt.status === "in_progress",
    );
    if (existing) return toAttemptDto(existing);

    const now = new Date();
    const attemptId = randomUUID();
    const deadlineAt = new Date(now.getTime() + exam.durationSeconds * 1000);
    const questions: QuestionAttempt[] = exam.questions.map((_, index) => ({
      questionId: questionId(exam, index),
      status: index === 0 ? "active" : "locked",
      startedAt: index === 0 ? now : null,
      deadlineAt:
        index === 0
          ? new Date(Math.min(deadlineAt.getTime(), now.getTime() + exam.questions[0]!.timeLimitSeconds * 1000))
          : null,
      submittedAt: null,
      score: 0,
    }));
    const attempt: ExamAttempt = {
      id: attemptId,
      userId: candidate.id,
      exam,
      status: "in_progress",
      startedAt: now,
      deadlineAt,
      submittedAt: null,
      currentQuestionId: questionId(exam, 0),
      questions,
      totalScore: 0,
    };
    attemptsById.set(attempt.id, attempt);
    return reply.code(201).send(toAttemptDto(attempt));
  },
);

app.get<{ Params: { attemptId: string } }>(
  "/api/attempts/:attemptId",
  { preHandler: authenticate },
  async (request) => toAttemptDto(findAttempt(requireCandidate(request).id, request.params.attemptId)),
);

app.post<{ Params: { attemptId: string; questionId: string } }>(
  "/api/attempts/:attemptId/questions/:questionId/check",
  { preHandler: authenticate },
  async (request) => {
    const attempt = findAttempt(requireCandidate(request).id, request.params.attemptId);
    const { question, progress } = getActiveQuestion(attempt, request.params.questionId);
    try {
      const state = await executor.inspect({
        attemptId: attempt.id,
        questionId: progress.questionId,
      });
      const result = gradeQuestion(state, question);
      progress.score = result.score;
      if (attempt.exam.slug) {
        progress.feedback = result.checks.map(
          (check, index) =>
            `${question.subquestions[index]?.label ?? index + 1}: ${check.earned}/${check.maximum} marks`,
        );
      }
      recomputeScore(attempt);
      return { score: result.score, maximum: result.maximum };
    } catch (error) {
      if (error instanceof ExecutorUnavailableError) {
        throw new HttpError(503, "Isolated terminal execution is not configured.", error.code);
      }
      request.log.error({ err: error }, "Could not inspect isolated exam environment");
      throw new HttpError(503, "The isolated exam environment is temporarily unavailable.", "EXECUTOR_UNAVAILABLE");
    }
  },
);

app.post<{ Params: { attemptId: string; questionId: string } }>(
  "/api/attempts/:attemptId/questions/:questionId/activate",
  { preHandler: authenticate },
  async (request) => {
    const attempt = findAttempt(requireCandidate(request).id, request.params.attemptId);
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
    return toAttemptDto(attempt);
  },
);

app.post<{ Params: { attemptId: string; questionId: string } }>(
  "/api/attempts/:attemptId/questions/:questionId/submit",
  { preHandler: authenticate },
  async (request) => {
    const attempt = findAttempt(requireCandidate(request).id, request.params.attemptId);
    const { progress } = getActiveQuestion(attempt, request.params.questionId);
    progress.status = "submitted";
    progress.submittedAt = new Date();
    recomputeScore(attempt);
    return toAttemptDto(attempt);
  },
);

app.post<{ Params: { attemptId: string } }>(
  "/api/attempts/:attemptId/submit",
  { preHandler: authenticate },
  async (request) => {
    const attempt = findAttempt(requireCandidate(request).id, request.params.attemptId);
    refreshAttempt(attempt);
    if (attempt.status === "in_progress") finalizeAttempt(attempt, "submitted");
    return toAttemptDto(attempt);
  },
);

app.get<{ Params: { attemptId: string } }>(
  "/api/attempts/:attemptId/result",
  { preHandler: authenticate },
  async (request) => {
    const attempt = findAttempt(requireCandidate(request).id, request.params.attemptId);
    refreshAttempt(attempt);
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
    const attempt = findAttempt(candidate.id, request.params.attemptId);
    refreshAttempt(attempt);
    if (attempt.status !== "in_progress" || !attempt.currentQuestionId) {
      throw new HttpError(409, "This attempt does not have an active terminal question.", "ATTEMPT_CLOSED");
    }
    const { progress } = getActiveQuestion(attempt, attempt.currentQuestionId);
    try {
      const workspace = await executor.createWorkspace({
        attemptId: attempt.id,
        questionId: progress.questionId,
        template: getWorkspaceTemplate(attempt.exam.slug),
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
  (socket, request) => {
    const candidate = requireCandidate(request);
    const ticket = terminalTickets.get(request.params.ticket);
    terminalTickets.delete(request.params.ticket);
    if (!ticket || ticket.userId !== candidate.id || ticket.expiresAt <= Date.now()) {
      socket.close(1008, "Terminal ticket is invalid or expired");
      return;
    }

    try {
      const attempt = findAttempt(candidate.id, ticket.attemptId);
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

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error({ err: error }, "Could not start the API server");
  process.exitCode = 1;
  await app.close();
}

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
