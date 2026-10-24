import { afterEach, describe, expect, it, vi } from "vitest";
import { getSafeStartupErrorDetails } from "./startup-error.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("startup error details", () => {
  it("redacts configured credentials, URLs, and sensitive assignments", () => {
    vi.stubEnv("JWT_SECRET", "jwt-secret-value");
    vi.stubEnv("SANDBOX_WORKER_TOKEN", "worker-token-value");

    const details = getSafeStartupErrorDetails(
      new Error(
        "failed at postgresql://db-user:db-password@db.example/termforge " +
          "JWT_SECRET=jwt-secret-value worker_token: worker-token-value password='another-secret'",
      ),
    );

    expect(details.errorMessage).not.toContain("db-password");
    expect(details.errorMessage).not.toContain("jwt-secret-value");
    expect(details.errorMessage).not.toContain("worker-token-value");
    expect(details.errorMessage).not.toContain("another-secret");
    expect(details.errorMessage).not.toContain("postgresql://");
    expect(details.errorName).toBe("Error");
  });

  it("redacts quoted JSON credential fields", () => {
    const secretValues = [
      "json-password-value",
      "json-token-value",
      "json-secret-value",
      "json-api-key-value",
      "json-private-key-value",
    ];
    const details = getSafeStartupErrorDetails(
      new Error(
        JSON.stringify({
          password: secretValues[0],
          token: secretValues[1],
          secret: secretValues[2],
          api_key: secretValues[3],
          privateKey: secretValues[4],
        }),
      ),
    );

    for (const secret of secretValues) {
      expect(details.errorMessage).not.toContain(secret);
    }
  });

  it.each(["23505", "28P01"])("preserves PostgreSQL SQLSTATE %s", (code) => {
    const error = Object.assign(new Error("database error"), { code });

    expect(getSafeStartupErrorDetails(error).errorCode).toBe(code);
  });

  it("does not stringify unknown errors or include an error stack", () => {
    expect(getSafeStartupErrorDetails({ message: "do-not-log-this" })).toEqual({
      errorName: "UnknownError",
    });
  });
});
