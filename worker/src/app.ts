import { createHash, timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import {
  WorkspaceUnavailableError,
  type WorkspaceTemplate,
  workspaceTemplates,
  type WorkspaceManager,
  type WorkspaceScope,
} from "./workspaces.js";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

class InvalidWorkspaceRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWorkspaceRequestError";
  }
}

function tokenMatches(authorization: string | undefined, expectedToken: string): boolean {
  if (!authorization?.startsWith("Bearer ")) return false;
  const suppliedToken = authorization.slice("Bearer ".length);
  const suppliedHash = createHash("sha256").update(suppliedToken).digest();
  const expectedHash = createHash("sha256").update(expectedToken).digest();
  return timingSafeEqual(suppliedHash, expectedHash);
}

function parseCreateWorkspace(input: unknown): WorkspaceScope {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new InvalidWorkspaceRequestError("Request body must be an object.");
  }
  const body = input as Record<string, unknown>;
  const fields = Object.keys(body).sort();
  if (
    fields.length !== 3 ||
    fields[0] !== "attemptId" ||
    fields[1] !== "questionId" ||
    fields[2] !== "template"
  ) {
    throw new InvalidWorkspaceRequestError(
      "Only attemptId, questionId, and template may be provided.",
    );
  }
  if (typeof body.attemptId !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(body.attemptId)) {
    throw new InvalidWorkspaceRequestError("attemptId must be a UUID.");
  }
  if (typeof body.questionId !== "string" || !/^[a-z0-9-]+-q[1-9][0-9]*$/.test(body.questionId)) {
    throw new InvalidWorkspaceRequestError("questionId is invalid.");
  }
  if (
    typeof body.template !== "string" ||
    !isWorkspaceTemplate(body.template)
  ) {
    throw new InvalidWorkspaceRequestError("template is not an approved workspace template.");
  }
  return {
    attemptId: body.attemptId,
    questionId: body.questionId,
    template: body.template,
  };
}

function isWorkspaceTemplate(input: string): input is WorkspaceTemplate {
  return workspaceTemplates.some((template) => template === input);
}

function parseWorkspaceId(input: string): string {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(input)) {
    throw new InvalidWorkspaceRequestError("workspaceId must be a UUID.");
  }
  return input;
}

export async function createWorkerApp(manager: WorkspaceManager, workerToken: string) {
  const app = Fastify({
    logger: true,
    bodyLimit: 16 * 1024,
  });
  await app.register(websocket, { options: { maxPayload: 16 * 1024 } });

  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health") return;
    if (!tokenMatches(request.headers.authorization, workerToken)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof InvalidWorkspaceRequestError) {
      return reply.code(400).send({
        error: "INVALID_REQUEST",
        message: error.message,
      });
    }
    if (error instanceof WorkspaceUnavailableError) {
      return reply.code(503).send({
        error: "WORKSPACE_UNAVAILABLE",
        message: error.message,
      });
    }
    request.log.error({ err: error }, "Worker request failed");
    return reply.code(500).send({
      error: "INTERNAL_ERROR",
      message: "The worker could not complete the request.",
    });
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "termforge-worker",
    docker: await manager.availability(),
  }));

  app.post("/v1/workspaces", async (request, reply) => {
    const body = parseCreateWorkspace(request.body);
    const workspace = await manager.create(body);
    return reply.code(201).send(workspace);
  });

  app.get<{ Params: { workspaceId: string } }>("/v1/workspaces/:workspaceId", async (request, reply) => {
    const workspaceId = parseWorkspaceId(request.params.workspaceId);
    const workspace = await manager.inspect(workspaceId);
    if (!workspace) {
      return reply.code(404).send({ error: "WORKSPACE_NOT_FOUND" });
    }
    return workspace;
  });

  app.delete<{ Params: { workspaceId: string } }>("/v1/workspaces/:workspaceId", async (request, reply) => {
    const workspaceId = parseWorkspaceId(request.params.workspaceId);
    const destroyed = await manager.destroy(workspaceId);
    if (!destroyed) {
      return reply.code(404).send({ error: "WORKSPACE_NOT_FOUND" });
    }
    return reply.code(204).send();
  });

  app.get<{ Params: { workspaceId: string } }>(
    "/v1/workspaces/:workspaceId/terminal",
    { websocket: true },
    async (socket, request) => {
      let shell: ChildProcessWithoutNullStreams | undefined;
      let shellClosed = false;
      let pendingInputBytes = 0;
      const pendingInput: Buffer[] = [];
      let closed = false;
      const closeShell = () => {
        if (shellClosed || !shell) return;
        shellClosed = true;
        shell.stdin.end();
        shell.kill("SIGTERM");
      };
      const receiveInput = (data: Buffer | Buffer[] | ArrayBuffer) => {
        const input = Array.isArray(data)
          ? Buffer.concat(data)
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : data;
        if (!shell) {
          pendingInputBytes += input.length;
          if (pendingInputBytes > 16 * 1024) {
            socket.close(1009, "Terminal input buffer exceeded");
            closeShell();
            return;
          }
          pendingInput.push(input);
          return;
        }
        if (!shell.stdin.write(input) && shell.stdin.writableLength > 16 * 1024) {
          socket.close(1013, "Terminal input buffer exceeded");
        }
      };
      socket.on("message", receiveInput);
      socket.once("close", () => {
        closed = true;
        closeShell();
      });
      socket.once("error", closeShell);

      try {
        shell = await manager.openShell(parseWorkspaceId(request.params.workspaceId));
      } catch (error) {
        request.log.warn({ err: error }, "Could not open isolated terminal shell");
        if (socket.readyState === 1) socket.close(1011, "Workspace unavailable");
        closeShell();
        return;
      }
      if (closed || socket.readyState !== 1) {
        shell.stdin.end();
        shell.kill("SIGTERM");
        shellClosed = true;
        return;
      }

      const forwardOutput = (data: Buffer) => {
        if (socket.readyState !== 1) return;
        if (socket.bufferedAmount > 1024 * 1024) {
          socket.close(1013, "Terminal output buffer exceeded");
          closeShell();
          return;
        }
        socket.send(data, { binary: true });
      };

      shell.stdout.on("data", forwardOutput);
      shell.stderr.on("data", forwardOutput);
      shell.once("error", (error) => {
        request.log.warn({ err: error }, "Isolated terminal shell failed");
        if (socket.readyState === 1) socket.close(1011, "Terminal shell failed");
        closeShell();
      });
      shell.once("exit", () => {
        if (socket.readyState === 1) socket.close(1000, "Terminal shell exited");
        closeShell();
      });
      for (const input of pendingInput) receiveInput(input);
    },
  );

  return app;
}
