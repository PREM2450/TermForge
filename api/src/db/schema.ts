import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const userRole = pgEnum("user_role", ["candidate", "admin"]);
export const attemptStatus = pgEnum("attempt_status", [
  "IN_PROGRESS",
  "SUBMITTED",
  "EXPIRED",
]);
export const questionStatus = pgEnum("question_status", [
  "LOCKED",
  "ACTIVE",
  "SUBMITTED",
  "SKIPPED",
  "EXPIRED",
]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: varchar("email", { length: 254 }).notNull(),
    passwordHash: varchar("password_hash", { length: 255 }).notNull(),
    role: userRole("role").notNull().default("candidate"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("users_email_uq").on(table.email)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("sessions_user_idx").on(table.userId)],
);

export const topics = pgTable(
  "topics",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: varchar("slug", { length: 80 }).notNull(),
    title: varchar("title", { length: 160 }).notNull(),
    description: varchar("description", { length: 1000 }).notNull(),
    published: boolean("published").notNull().default(false),
  },
  (table) => [uniqueIndex("topics_slug_uq").on(table.slug)],
);

export const exams = pgTable("exams", {
  id: uuid("id").defaultRandom().primaryKey(),
  topicId: uuid("topic_id").notNull().references(() => topics.id, { onDelete: "cascade" }),
  title: varchar("title", { length: 200 }).notNull(),
  totalMarks: integer("total_marks").notNull(),
  durationSeconds: integer("duration_seconds").notNull(),
  published: boolean("published").notNull().default(false),
  allowPrevious: boolean("allow_previous").notNull().default(false),
});

export const questions = pgTable(
  "questions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    examId: uuid("exam_id").notNull().references(() => exams.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    title: varchar("title", { length: 200 }).notNull(),
    prompt: varchar("prompt", { length: 4000 }).notNull(),
    marks: integer("marks").notNull(),
    timeLimitSeconds: integer("time_limit_seconds").notNull(),
  },
  (table) => [
    uniqueIndex("questions_exam_ordinal_uq").on(table.examId, table.ordinal),
    index("questions_exam_idx").on(table.examId),
  ],
);

export const subquestions = pgTable(
  "subquestions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    questionId: uuid("question_id").notNull().references(() => questions.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    label: varchar("label", { length: 80 }).notNull(),
    prompt: varchar("prompt", { length: 1000 }).notNull(),
    marks: integer("marks").notNull(),
    rubric: jsonb("rubric").$type<{ path: string; equals: unknown }>().notNull(),
  },
  (table) => [uniqueIndex("subquestions_question_ordinal_uq").on(table.questionId, table.ordinal)],
);

export const attempts = pgTable(
  "exam_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    examId: uuid("exam_id").notNull().references(() => exams.id),
    status: attemptStatus("status").notNull().default("IN_PROGRESS"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    score: integer("score").notNull().default(0),
  },
  (table) => [
    index("attempts_owner_idx").on(table.userId, table.startedAt),
    uniqueIndex("attempts_one_active_per_exam_uq")
      .on(table.userId, table.examId)
      .where(sql`${table.status} = 'IN_PROGRESS'`),
  ],
);

export const questionAttempts = pgTable(
  "question_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    attemptId: uuid("attempt_id").notNull().references(() => attempts.id, { onDelete: "cascade" }),
    questionId: uuid("question_id").notNull().references(() => questions.id),
    status: questionStatus("status").notNull().default("LOCKED"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
    score: integer("score").notNull().default(0),
    validation: jsonb("validation").$type<unknown>(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("question_attempts_attempt_question_uq").on(table.attemptId, table.questionId),
    index("question_attempts_attempt_idx").on(table.attemptId),
  ],
);

export const validationRequests = pgTable(
  "validation_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    questionAttemptId: uuid("question_attempt_id")
      .notNull()
      .references(() => questionAttempts.id, { onDelete: "cascade" }),
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
    response: jsonb("response").$type<unknown>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("validation_requests_idempotency_uq").on(
      table.questionAttemptId,
      table.idempotencyKey,
    ),
  ],
);
