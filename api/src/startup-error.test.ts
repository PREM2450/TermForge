import { describe, expect, it } from "vitest";
import { getSafeStartupErrorDetails } from "./startup-error.js";

describe("startup error details", () => {
  it("includes safe PostgreSQL diagnostic metadata from a wrapped database error", () => {
    const databaseError = Object.assign(
      new Error("duplicate key includes fake-sensitive-value"),
      {
        code: "23505",
        constraint: "topics_slug_uq",
        schema: "public",
        table: "topics",
      },
    );
    const queryError = new Error(
      "failed query with postgresql://user:fake-password@db.example " +
        'parameters ["fake-token-value"]',
      { cause: databaseError },
    );

    const details = getSafeStartupErrorDetails(queryError);
    const serialized = JSON.stringify(details);

    expect(details).toMatchObject({
      errorName: "Error",
      errorCode: "23505",
      constraintName: "topics_slug_uq",
      schemaName: "public",
      tableName: "topics",
    });
    expect(serialized).not.toContain("fake-sensitive-value");
    expect(serialized).not.toContain("fake-password");
    expect(serialized).not.toContain("fake-token-value");
    expect(serialized).not.toContain("postgresql://");
    expect(serialized).not.toContain("parameters");
  });

  it.each(["23505", "28P01", "42P10"])("accepts PostgreSQL SQLSTATE %s", (code) => {
    const error = Object.assign(new Error("database error"), { code });

    expect(getSafeStartupErrorDetails(error).errorCode).toBe(code);
  });

  it("omits malformed diagnostic metadata", () => {
    const error = Object.assign(new Error("database error"), {
      code: "not-a-code",
      constraint: "constraint with parameters",
      schema: "public; DROP TABLE users",
      table: "topics",
    });

    expect(getSafeStartupErrorDetails(error)).toEqual({
      errorName: "Error",
      tableName: "topics",
    });
  });

  it("does not stringify unknown errors or include an error stack", () => {
    expect(getSafeStartupErrorDetails({ message: "do-not-log-this" })).toEqual({
      errorName: "UnknownError",
    });
  });
});
