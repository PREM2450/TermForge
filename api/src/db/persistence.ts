import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import {
  attempts,
  exams,
  questionAttempts,
  questions,
  sessions,
  subquestions,
  topics,
  users,
} from "./schema.js";
import type { ExamDefinition } from "../exams/catalog.js";

export type StoredAttemptStatus = "in_progress" | "submitted" | "expired";
export type StoredQuestionStatus = "locked" | "active" | "submitted" | "expired" | "skipped";

export interface StoredQuestionProgress {
  questionId: string;
  status: StoredQuestionStatus;
  startedAt: Date | null;
  deadlineAt: Date | null;
  submittedAt: Date | null;
  score: number;
  feedback?: string[];
}

export interface StoredExamAttempt {
  id: string;
  userId: string;
  exam: ExamDefinition;
  status: StoredAttemptStatus;
  startedAt: Date;
  deadlineAt: Date;
  submittedAt: Date | null;
  currentQuestionId: string | null;
  questions: StoredQuestionProgress[];
  totalScore: number;
}

export interface StoredUser {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  role: "candidate" | "admin";
}

const dbAttemptStatus = {
  in_progress: "IN_PROGRESS",
  submitted: "SUBMITTED",
  expired: "EXPIRED",
} as const;

const dbQuestionStatus = {
  locked: "LOCKED",
  active: "ACTIVE",
  submitted: "SUBMITTED",
  expired: "EXPIRED",
  skipped: "SKIPPED",
} as const;

function parseFeedback(value: unknown): string[] | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const feedback = (value as { feedback?: unknown }).feedback;
  return Array.isArray(feedback) && feedback.every((item) => typeof item === "string")
    ? feedback
    : undefined;
}

export async function syncExamCatalog(db: Database, catalog: ExamDefinition[]): Promise<void> {
  await db.transaction(async (tx) => {
    const topicDefinitions = new Map(
      catalog.map((exam) => [
        exam.topicSlug,
        {
          slug: exam.topicSlug,
          title: exam.topicTitle,
          description:
            exam.topicSlug === "git-github"
              ? "Git fundamentals, branching, commits, remotes, and collaboration."
              : exam.topicSlug === "docker"
                ? "Docker CLI workflows practiced safely in an in-memory simulator."
                : "Plan and verify safe schema and data transformations.",
          published: true,
        },
      ]),
    );
    const storedTopics = await tx
      .insert(topics)
      .values([...topicDefinitions.values()])
      .onConflictDoUpdate({
        target: topics.slug,
        set: {
          title: sql`excluded.title`,
          description: sql`excluded.description`,
          published: sql`excluded.published`,
        },
      })
      .returning({ id: topics.id, slug: topics.slug });
    const topicIds = new Map(storedTopics.map((topic) => [topic.slug, topic.id]));

    const examRows = catalog.map((exam) => {
      const topicId = topicIds.get(exam.topicSlug);
      if (!topicId) throw new Error("Could not resolve an exam topic");
      return {
        slug: exam.slug,
        topicId,
        title: exam.title,
        totalMarks: exam.totalMarks,
        durationSeconds: exam.durationSeconds,
        published: true,
      };
    });
    const storedExams = await tx
      .insert(exams)
      .values(examRows)
      .onConflictDoUpdate({
        target: exams.slug,
        set: {
          topicId: sql`excluded.topic_id`,
          title: sql`excluded.title`,
          totalMarks: sql`excluded.total_marks`,
          durationSeconds: sql`excluded.duration_seconds`,
          published: sql`excluded.published`,
        },
      })
      .returning({ id: exams.id, slug: exams.slug });
    const examIds = new Map(storedExams.map((exam) => [exam.slug, exam.id]));

    const questionRows = catalog.flatMap((exam) => {
      const examId = examIds.get(exam.slug);
      if (!examId) throw new Error("Could not resolve a synchronized exam");
      return exam.questions.map((question, index) => ({
        examId,
        ordinal: index + 1,
        title: question.title,
        prompt: question.prompt,
        marks: question.marks,
        timeLimitSeconds: question.timeLimitSeconds,
      }));
    });
    const storedQuestions = await tx
      .insert(questions)
      .values(questionRows)
      .onConflictDoUpdate({
        target: [questions.examId, questions.ordinal],
        set: {
          title: sql`excluded.title`,
          prompt: sql`excluded.prompt`,
          marks: sql`excluded.marks`,
          timeLimitSeconds: sql`excluded.time_limit_seconds`,
        },
      })
      .returning({ id: questions.id, examId: questions.examId, ordinal: questions.ordinal });
    const questionIds = new Map(
      storedQuestions.map((question) => [`${question.examId}:${question.ordinal}`, question.id]),
    );

    const subquestionRows = catalog.flatMap((exam) => {
      const examId = examIds.get(exam.slug);
      if (!examId) throw new Error("Could not resolve a synchronized exam");
      return exam.questions.flatMap((question, questionIndex) => {
        const questionId = questionIds.get(`${examId}:${questionIndex + 1}`);
        if (!questionId) throw new Error("Could not resolve a synchronized question");
        return question.subquestions.map((subquestion, subquestionIndex) => ({
          questionId,
          ordinal: subquestionIndex + 1,
          label: subquestion.label,
          prompt: subquestion.prompt,
          marks: subquestion.marks,
          rubric: subquestion.rubric,
        }));
      });
    });
    await tx
      .insert(subquestions)
      .values(subquestionRows)
      .onConflictDoUpdate({
        target: [subquestions.questionId, subquestions.ordinal],
        set: {
          label: sql`excluded.label`,
          prompt: sql`excluded.prompt`,
          marks: sql`excluded.marks`,
          rubric: sql`excluded.rubric`,
        },
      });
  });
}

export async function findActiveAttemptId(
  db: Database,
  userId: string,
  examSlug: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ id: attempts.id })
    .from(attempts)
    .innerJoin(exams, eq(attempts.examId, exams.id))
    .where(
      and(
        eq(attempts.userId, userId),
        eq(exams.slug, examSlug),
        eq(attempts.status, "IN_PROGRESS"),
      ),
    )
    .limit(1);
  return row?.id;
}

export async function loadExamAttempt(
  db: Database,
  userId: string,
  attemptId: string,
  catalog: ExamDefinition[],
): Promise<StoredExamAttempt | undefined> {
  const [row] = await db
    .select({
      id: attempts.id,
      userId: attempts.userId,
      examSlug: exams.slug,
      status: attempts.status,
      startedAt: attempts.startedAt,
      deadlineAt: attempts.deadlineAt,
      submittedAt: attempts.submittedAt,
      score: attempts.score,
    })
    .from(attempts)
    .innerJoin(exams, eq(attempts.examId, exams.id))
    .where(and(eq(attempts.id, attemptId), eq(attempts.userId, userId)))
    .limit(1);
  if (!row) return undefined;
  const exam = catalog.find((item) => item.slug === row.examSlug);
  if (!exam) throw new Error("The attempt references an unknown exam");

  const progressRows = await db
    .select({
      ordinal: questions.ordinal,
      status: questionAttempts.status,
      startedAt: questionAttempts.startedAt,
      deadlineAt: questionAttempts.deadlineAt,
      submittedAt: questionAttempts.submittedAt,
      score: questionAttempts.score,
      validation: questionAttempts.validation,
    })
    .from(questionAttempts)
    .innerJoin(questions, eq(questionAttempts.questionId, questions.id))
    .where(eq(questionAttempts.attemptId, row.id))
    .orderBy(asc(questions.ordinal));
  if (progressRows.length !== exam.questions.length) {
    throw new Error("The stored attempt has an incomplete question state");
  }

  const progress: StoredQuestionProgress[] = progressRows.map((item) => {
    const question = exam.questions[item.ordinal - 1];
    if (!question) throw new Error("The stored attempt references an unknown question");
    const state = item.status.toLowerCase() as StoredQuestionStatus;
    const feedback = parseFeedback(item.validation);
    return {
      questionId: `${exam.slug}-q${item.ordinal}`,
      status: state,
      startedAt: item.startedAt,
      deadlineAt: item.deadlineAt,
      submittedAt: item.submittedAt,
      score: item.score,
      ...(feedback ? { feedback } : {}),
    };
  });

  const current = progress
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.startedAt !== null)
    .sort(
      (left, right) =>
        right.item.startedAt!.getTime() - left.item.startedAt!.getTime() ||
        right.index - left.index,
    )[0]?.item;
  return {
    id: row.id,
    userId: row.userId,
    exam,
    status: row.status.toLowerCase() as StoredAttemptStatus,
    startedAt: row.startedAt,
    deadlineAt: row.deadlineAt,
    submittedAt: row.submittedAt,
    currentQuestionId: row.status === "IN_PROGRESS" ? current?.questionId ?? null : null,
    questions: progress,
    totalScore: row.score,
  };
}

export async function createExamAttempt(
  db: Database,
  userId: string,
  exam: ExamDefinition,
  startedAt: Date,
): Promise<string> {
  return db.transaction(async (tx) => {
    const [storedExam] = await tx
      .select({ id: exams.id })
      .from(exams)
      .where(eq(exams.slug, exam.slug))
      .limit(1);
    if (!storedExam) throw new Error("The requested exam is not synchronized");

    const deadlineAt = new Date(startedAt.getTime() + exam.durationSeconds * 1000);
    const [attempt] = await tx
      .insert(attempts)
      .values({
        userId,
        examId: storedExam.id,
        startedAt,
        deadlineAt,
      })
      .returning({ id: attempts.id });
    if (!attempt) throw new Error("Could not create an exam attempt");

    const storedQuestions = await tx
      .select({ id: questions.id, ordinal: questions.ordinal })
      .from(questions)
      .where(eq(questions.examId, storedExam.id))
      .orderBy(asc(questions.ordinal));
    if (storedQuestions.length !== exam.questions.length) {
      throw new Error("The requested exam has an incomplete question catalog");
    }
    await tx.insert(questionAttempts).values(
      storedQuestions.map((question) => {
        const isFirst = question.ordinal === 1;
        const deadline = isFirst
          ? new Date(
              Math.min(
                deadlineAt.getTime(),
                startedAt.getTime() + exam.questions[0]!.timeLimitSeconds * 1000,
              ),
            )
          : null;
        return {
          attemptId: attempt.id,
          questionId: question.id,
          status: isFirst ? "ACTIVE" as const : "LOCKED" as const,
          startedAt: isFirst ? startedAt : null,
          deadlineAt: deadline,
        };
      }),
    );
    return attempt.id;
  });
}

export async function saveExamAttempt(db: Database, attempt: StoredExamAttempt): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(attempts)
      .set({
        status: dbAttemptStatus[attempt.status],
        submittedAt: attempt.submittedAt,
        score: attempt.totalScore,
      })
      .where(eq(attempts.id, attempt.id));

    const [storedExam] = await tx
      .select({ id: exams.id })
      .from(exams)
      .where(eq(exams.slug, attempt.exam.slug))
      .limit(1);
    if (!storedExam) throw new Error("The attempt exam is no longer synchronized");
    const storedQuestions = await tx
      .select({ id: questions.id, ordinal: questions.ordinal })
      .from(questions)
      .where(eq(questions.examId, storedExam.id));

    for (const question of storedQuestions) {
      const progress = attempt.questions[question.ordinal - 1];
      if (!progress) throw new Error("The attempt question state is incomplete");
      await tx
        .update(questionAttempts)
        .set({
          status: dbQuestionStatus[progress.status],
          startedAt: progress.startedAt,
          deadlineAt: progress.deadlineAt,
          submittedAt: progress.submittedAt,
          score: progress.score,
          validation: progress.feedback ? { feedback: progress.feedback } : null,
        })
        .where(
          and(
            eq(questionAttempts.attemptId, attempt.id),
            eq(questionAttempts.questionId, question.id),
          ),
        );
    }
  });
}

export async function createUserSession(
  db: Database,
  userId: string,
  sessionId: string,
  expiresAt: Date,
): Promise<void> {
  await db.insert(sessions).values({ id: sessionId, userId, expiresAt });
}

export async function insertUser(
  db: Database,
  input: Pick<StoredUser, "name" | "email" | "passwordHash" | "role">,
): Promise<StoredUser> {
  const [user] = await db
    .insert(users)
    .values(input)
    .returning({
      id: users.id,
      name: users.name,
      email: users.email,
      passwordHash: users.passwordHash,
      role: users.role,
    });
  if (!user) throw new Error("User insert returned no row");
  return user;
}

export async function registerUserWithSession(
  db: Database,
  input: Pick<StoredUser, "name" | "email" | "passwordHash" | "role">,
  userId: string,
  sessionId: string,
  expiresAt: Date,
): Promise<StoredUser> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({ ...input, id: userId })
      .returning({
        id: users.id,
        name: users.name,
        email: users.email,
        passwordHash: users.passwordHash,
        role: users.role,
      });
    if (!user) throw new Error("User insert returned no row");
    await tx.insert(sessions).values({ id: sessionId, userId: user.id, expiresAt });
    return user;
  });
}

export async function findUserByEmail(
  db: Database,
  email: string,
): Promise<StoredUser | undefined> {
  const [user] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      passwordHash: users.passwordHash,
      role: users.role,
    })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  return user;
}

export async function revokeUserSession(db: Database, sessionId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
}

export async function findSessionUser(db: Database, sessionId: string, now = new Date()) {
  const [row] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(
      and(
        eq(sessions.id, sessionId),
        isNull(sessions.revokedAt),
      ),
    )
    .limit(1);
  if (!row) return undefined;
  return row.expiresAt > now ? row : undefined;
}
