import Fastify from "fastify";
import cors from "@fastify/cors";
import { afterEach, describe, expect, it } from "vitest";
import { corsOptions, corsOrigin } from "./cors.js";

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function createTestApp() {
  const app = Fastify();
  apps.push(app);
  await app.register(cors, corsOptions);
  app.get("/api/test", async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe("API CORS", () => {
  it("allows the production frontend origin with credentials", async () => {
    const app = await createTestApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/test",
      headers: { origin: corsOrigin },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe(corsOrigin);
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("does not allow other origins", async () => {
    const app = await createTestApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/test",
      headers: { origin: "https://other.example" },
    });

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("answers credentialed OPTIONS preflight requests", async () => {
    const app = await createTestApp();
    const response = await app.inject({
      method: "OPTIONS",
      url: "/api/test",
      headers: {
        origin: corsOrigin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(corsOrigin);
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    expect(response.headers["access-control-allow-methods"]).toContain("POST");
    expect(response.headers["access-control-allow-headers"]).toContain("content-type");
  });
});
