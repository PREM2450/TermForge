import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import argon2 from "argon2";
import { drizzle } from "drizzle-orm/node-postgres";
import { DataType, newDb } from "pg-mem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "./client.js";
import * as schema from "./schema.js";
import {
  createExamAttempt,
  createUserSession,
  findActiveAttemptId,
  findSessionUser,
  findUserByEmail,
  insertUser,
  loadExamAttempt,
  registerUserWithSession,
  revokeUserSession,
  saveExamAttempt,
  syncExamCatalog,
} from "./persistence.js";
import { examCatalog } from "../exams/catalog.js";

function patchPgMemQuery(client: object): void {
  const queryHost = client as {
    query: (...args: unknown[]) => Promise<unknown>;
  };
  const originalQuery = queryHost.query.bind(client);
  Object.defineProperty(client, "query", {
    configurable: true,
    value: async (...args: unknown[]) => {
      const config = args[0];
      const rowMode =
        config !== null && typeof config === "object" && "rowMode" in config
          ? config.rowMode
          : undefined;
      if (config !== null && typeof config === "object") {
        args[0] = { ...config, rowMode: undefined, types: undefined };
      }
      const result = await originalQuery(...args);
      if (
        rowMode !== "array" ||
        result === null ||
        typeof result !== "object" ||
        !("rows" in result) ||
        !Array.isArray(result.rows)
      ) {
        return result;
      }
      return {
        ...result,
        rows: result.rows.map((row: unknown) =>
          row !== null && typeof row === "object" ? Object.values(row) : row,
        ),
      };
    },
  });
}

describe("PostgreSQL persistence", () => {
  let db: Database;
  let pool: { end(): Promise<void> };

  beforeEach(async () => {
    const memoryDatabase = newDb();
    memoryDatabase.public.registerFunction({
      name: "gen_random_uuid",
      returns: DataType.uuid,
      implementation: randomUUID,
      impure: true,
    });
    const { Pool } = memoryDatabase.adapters.createPg();
    const testPool = new Pool();
    patchPgMemQuery(testPool);
    const poolWithConnect = testPool as unknown as {
      connect(): Promise<object>;
    };
    const originalConnect = poolWithConnect.connect.bind(testPool);
    Object.defineProperty(testPool, "connect", {
      configurable: true,
      value: async () => {
        const client = await originalConnect();
        patchPgMemQuery(client);
        return client;
      },
    });
    pool = testPool;
    db = drizzle(testPool, { schema });

    for (const migration of [
      "0000_concerned_raza.sql",
      "0001_clever_hiroim.sql",
      "0002_durable_exam_catalog.sql",
    ]) {
      const contents = readFileSync(join("drizzle", migration), "utf8");
      for (const statement of contents
        .split("--> statement-breakpoint")
        .map((part) => part.trim())
        .filter(Boolean)) {
        await testPool.query(statement);
      }
    }
  });

  afterEach(async () => {
    await pool.end();
  });

  it("stores registered users with password hashes and retrieves them for login", async () => {
    const password = "test-password-only";
    const passwordHash = await argon2.hash(password);
    const sessionId = randomUUID();
    const registered = await registerUserWithSession(
      db,
      {
        name: "Test Candidate",
        email: "candidate@example.test",
        passwordHash,
        role: "candidate",
      },
      randomUUID(),
      sessionId,
      new Date(Date.now() + 60_000),
    );

    const loginUser = await findUserByEmail(db, "candidate@example.test");
    expect(loginUser).toMatchObject({
      id: registered.id,
      name: "Test Candidate",
      email: "candidate@example.test",
      role: "candidate",
      passwordHash,
    });
    expect(loginUser?.passwordHash).not.toBe(password);
    await expect(argon2.verify(loginUser!.passwordHash, password)).resolves.toBe(true);
    await expect(argon2.verify(loginUser!.passwordHash, "incorrect")).resolves.toBe(false);
    expect(await findSessionUser(db, sessionId)).toMatchObject({ id: registered.id });
    const duplicateSessionId = randomUUID();
    await expect(
      registerUserWithSession(
        db,
        {
          name: "Duplicate",
          email: "candidate@example.test",
          passwordHash,
          role: "candidate",
        },
        randomUUID(),
        duplicateSessionId,
        new Date(Date.now() + 60_000),
      ),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
    expect(await findSessionUser(db, duplicateSessionId)).toBeUndefined();
  });

  it("persists, expires, and revokes database-backed sessions", async () => {
    const user = await insertUser(db, {
      name: "Session Candidate",
      email: "session@example.test",
      passwordHash: await argon2.hash("session-password"),
      role: "candidate",
    });
    const sessionId = randomUUID();
    const expiresAt = new Date(Date.now() + 60_000);
    await createUserSession(db, user.id, sessionId, expiresAt);

    expect(await findSessionUser(db, sessionId)).toMatchObject({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
    });
    expect(await findSessionUser(db, sessionId, new Date(expiresAt.getTime() + 1))).toBeUndefined();
    await revokeUserSession(db, sessionId);
    expect(await findSessionUser(db, sessionId)).toBeUndefined();
  });

  it("saves attempt and question progress and restores it from PostgreSQL", async () => {
    const exam = examCatalog.find((item) => item.topicSlug === "data-migration");
    expect(exam).toBeDefined();
    await syncExamCatalog(db, [exam!]);
    await syncExamCatalog(db, [exam!]);
    const user = await insertUser(db, {
      name: "Attempt Candidate",
      email: "attempt@example.test",
      passwordHash: await argon2.hash("attempt-password"),
      role: "candidate",
    });
    const startedAt = new Date();
    const attemptId = await createExamAttempt(db, user.id, exam!, startedAt);

    expect(await findActiveAttemptId(db, user.id, exam!.slug)).toBe(attemptId);
    const attempt = await loadExamAttempt(db, user.id, attemptId, [exam!]);
    expect(attempt).toBeDefined();
    expect(attempt?.questions).toHaveLength(exam!.questions.length);
    expect(attempt?.questions[0]).toMatchObject({
      questionId: `${exam!.slug}-q1`,
      status: "active",
    });

    const activeAttempt = attempt!;
    activeAttempt.questions[0]!.score = 4;
    activeAttempt.questions[0]!.feedback = ["A: 4/4 marks"];
    activeAttempt.questions[0]!.status = "submitted";
    activeAttempt.questions[0]!.submittedAt = new Date();
    activeAttempt.questions[1]!.status = "active";
    activeAttempt.questions[1]!.startedAt = new Date();
    activeAttempt.questions[1]!.deadlineAt = new Date(Date.now() + 30_000);
    activeAttempt.currentQuestionId = `${exam!.slug}-q2`;
    activeAttempt.totalScore = 4;
    await saveExamAttempt(db, activeAttempt);

    const restored = await loadExamAttempt(db, user.id, attemptId, [exam!]);
    expect(restored).toMatchObject({
      id: attemptId,
      status: "in_progress",
      totalScore: 4,
      currentQuestionId: `${exam!.slug}-q2`,
    });
    expect(restored?.questions[0]).toMatchObject({
      status: "submitted",
      score: 4,
      feedback: ["A: 4/4 marks"],
    });
    expect(restored?.questions[1]?.status).toBe("active");
  });

  it("backfills stable slugs without removing existing exam rows and includes the user name migration", async () => {
    const memoryDatabase = newDb();
    memoryDatabase.public.registerFunction({
      name: "gen_random_uuid",
      returns: DataType.uuid,
      implementation: randomUUID,
      impure: true,
    });
    const { Pool } = memoryDatabase.adapters.createPg();
    const migrationPool = new Pool();
    try {
      const firstMigration = readFileSync(join("drizzle", "0000_concerned_raza.sql"), "utf8");
      for (const statement of firstMigration
        .split("--> statement-breakpoint")
        .map((part) => part.trim())
        .filter(Boolean)) {
        await migrationPool.query(statement);
      }
      await migrationPool.query(
        "INSERT INTO topics (slug, title, description) VALUES ('existing-topic', 'Existing topic', 'Keep this row')",
      );
      const existing = await migrationPool.query(
        "INSERT INTO exams (topic_id, title, total_marks, duration_seconds) SELECT id, 'Existing exam', 10, 60 FROM topics WHERE slug = 'existing-topic' RETURNING id",
      );
      const existingId = existing.rows[0].id as string;

      for (const migration of ["0001_clever_hiroim.sql", "0002_durable_exam_catalog.sql"]) {
        const contents = readFileSync(join("drizzle", migration), "utf8");
        for (const statement of contents
          .split("--> statement-breakpoint")
          .map((part) => part.trim())
          .filter(Boolean)) {
          await migrationPool.query(statement);
        }
      }
      const migrated = await migrationPool.query(
        "SELECT slug, title FROM exams WHERE id = $1",
        [existingId],
      );
      expect(migrated.rows[0]).toEqual({
        slug: `legacy-${existingId}`,
        title: "Existing exam",
      });
      const namedUser = await migrationPool.query(
        "INSERT INTO users (email, password_hash, name) VALUES ('name@example.test', 'hash', 'Name preserved') RETURNING name",
      );
      expect(namedUser.rows[0].name).toBe("Name preserved");
    } finally {
      await migrationPool.end();
    }
  });
});
