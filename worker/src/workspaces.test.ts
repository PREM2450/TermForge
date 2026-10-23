import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import WebSocket from "ws";
import { createWorkerApp } from "./app.js";
import type {
  ContainerLimits,
  CreateContainerInput,
  DockerAvailability,
  DockerRuntime,
} from "./docker-runtime.js";
import { buildDockerCreateArgs } from "./docker-runtime.js";
import {
  DockerWorkspaceManager,
  WorkspaceUnavailableError,
  type Workspace,
  type WorkspaceScope,
} from "./workspaces.js";

class FakeDockerRuntime implements DockerRuntime {
  availabilityResult: DockerAvailability = { available: true, serverVersion: "test" };
  readonly created: CreateContainerInput[] = [];
  readonly running = new Set<string>();
  readonly removed: string[] = [];
  readonly initialized: string[] = [];
  failStart = false;

  async checkAvailability(): Promise<DockerAvailability> {
    return this.availabilityResult;
  }

  async create(input: CreateContainerInput): Promise<string> {
    this.created.push(input);
    return `internal-container-${this.created.length}`;
  }

  async start(containerId: string): Promise<void> {
    if (this.failStart) throw new Error("test start failure");
    this.running.add(containerId);
  }

  async inspectRunning(containerId: string): Promise<boolean> {
    return this.running.has(containerId);
  }

  async initializeWorkspace(_containerId: string, template: WorkspaceScope["template"]): Promise<void> {
    this.initialized.push(template);
  }

  async inspectState(): Promise<unknown> {
    return { state: "ready" };
  }

  openShell(): never {
    throw new Error("Shells are not available in this test runtime");
  }

  async remove(containerId: string): Promise<void> {
    this.running.delete(containerId);
    this.removed.push(containerId);
  }
}

const scope: WorkspaceScope = {
  attemptId: "31f503c0-e970-4fbb-8e57-c9bac2c00c99",
  questionId: "git-github-q1",
  template: "git-github",
};

const limits: ContainerLimits = {
  memoryMb: 256,
  cpuCount: 0.5,
  processCount: 64,
  workspaceMb: 128,
};

const managers: DockerWorkspaceManager[] = [];
const apps: Array<Awaited<ReturnType<typeof createWorkerApp>>> = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const manager of managers.splice(0)) await manager.dispose();
});

function makeManager(runtime = new FakeDockerRuntime()) {
  const manager = new DockerWorkspaceManager(runtime, {
    SANDBOX_IMAGE_GIT: "termforge/git-exam:local",
  });
  managers.push(manager);
  return { manager, runtime };
}

describe("DockerWorkspaceManager", () => {
  it("creates an opaque, scoped workspace with bounded runtime settings", async () => {
    const { manager, runtime } = makeManager();

    const workspace = await manager.create(scope);

    assert.match(workspace.id, /^[0-9a-f-]{36}$/);
    assert.equal(workspace.attemptId, scope.attemptId);
    assert.equal(workspace.questionId, scope.questionId);
    assert.equal(workspace.status, "running");
    assert.equal(JSON.stringify(workspace).includes("internal-container"), false);
    assert.equal(runtime.created.length, 1);
    assert.equal(runtime.created[0]?.name, `termforge-${workspace.id}`);
    assert.equal(runtime.created[0]?.image, "termforge/git-exam:local");
    assert.deepEqual(runtime.created[0]?.limits, limits);
    assert.equal(runtime.created[0]?.labels["com.termforge.workspace-id"], workspace.id);
    assert.deepEqual(runtime.initialized, ["git-github"]);
  });

  it("returns the existing workspace for a retried scope and supports inspect and destroy", async () => {
    const { manager, runtime } = makeManager();

    const created = await manager.create(scope);
    const retried = await manager.create(scope);

    assert.equal(retried.id, created.id);
    assert.equal(runtime.created.length, 1);
    assert.equal((await manager.inspect(created.id))?.id, created.id);
    assert.equal(await manager.destroy(created.id), true);
    assert.deepEqual(runtime.removed, ["internal-container-1"]);
    assert.equal(await manager.inspect(created.id), null);
    assert.equal(await manager.destroy(created.id), false);
  });

  it("deduplicates concurrent create requests for the same attempt and question", async () => {
    const { manager, runtime } = makeManager();

    const [first, second] = await Promise.all([
      manager.create(scope),
      manager.create(scope),
    ]);

    assert.equal(first.id, second.id);
    assert.equal(runtime.created.length, 1);
  });

  it("expires workspaces after the local development lifetime", async () => {
    const runtime = new FakeDockerRuntime();
    let currentTime = new Date("2026-01-01T00:00:00.000Z");
    const manager = new DockerWorkspaceManager(
      runtime,
      { SANDBOX_IMAGE_GIT: "termforge/git-exam:local" },
      () => currentTime,
    );
    managers.push(manager);
    const created = await manager.create(scope);
    currentTime = new Date(currentTime.getTime() + 60 * 60 * 1000);

    assert.equal(await manager.inspect(created.id), null);
    assert.deepEqual(runtime.removed, ["internal-container-1"]);
  });

  it("does not create a container when Docker or the approved image is unavailable", async () => {
    const { manager, runtime } = makeManager();
    runtime.availabilityResult = {
      available: false,
      serverVersion: null,
      reason: "daemon_unavailable",
    };
    await assert.rejects(manager.create(scope), WorkspaceUnavailableError);
    assert.equal(runtime.created.length, 0);

    runtime.availabilityResult = { available: true, serverVersion: "test" };
    await assert.rejects(
      manager.create({ ...scope, template: "docker" }),
      /No preloaded Docker image is configured/,
    );
    assert.equal(runtime.created.length, 0);
  });

  it("removes a created container if startup fails", async () => {
    const { manager, runtime } = makeManager();
    runtime.failStart = true;

    await assert.rejects(manager.create(scope), /test start failure/);
    assert.deepEqual(runtime.removed, ["internal-container-1"]);
  });

  it("builds a restricted Docker create request without mounts or candidate commands", () => {
    const args = buildDockerCreateArgs({
      name: "termforge-opaque-id",
      labels: { "com.termforge.workspace-id": "opaque-id" },
      image: "termforge/git-exam:local",
      limits,
    });

    assert.ok(args.includes("--network") && args[args.indexOf("--network") + 1] === "none");
    assert.ok(args.includes("--read-only"));
    assert.ok(args.includes("--cap-drop") && args[args.indexOf("--cap-drop") + 1] === "ALL");
    assert.ok(args.includes("--pids-limit") && args[args.indexOf("--pids-limit") + 1] === "64");
    assert.ok(args.includes("--memory") && args[args.indexOf("--memory") + 1] === "256m");
    assert.ok(args.includes("--tmpfs") && args.some((arg) => arg.startsWith("/run:rw,")));
    assert.ok(args.includes("--user") && args[args.indexOf("--user") + 1] === "1000:1000");
    assert.ok(args.includes("--pull") && args[args.indexOf("--pull") + 1] === "never");
    assert.equal(args.includes("--privileged"), false);
    assert.equal(args.some((arg) => ["-v", "--volume", "--mount"].includes(arg)), false);
    assert.equal(args.some((arg) => arg.includes("docker.sock")), false);
    assert.ok(args.includes("--entrypoint") && args[args.indexOf("--entrypoint") + 1] === "/bin/sleep");
    assert.deepEqual(args.slice(-2), ["termforge/git-exam:local", "infinity"]);
  });
});

describe("worker API", () => {
  it("authenticates lifecycle calls and never returns a Docker container identifier", async () => {
    const { manager } = makeManager();
    const app = await createWorkerApp(manager, "worker-test-token");
    apps.push(app);

    const unauthorized = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      payload: scope,
    });
    assert.equal(unauthorized.statusCode, 401);

    const health = await app.inject({ method: "GET", url: "/health" });
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().docker.available, true);

    const created = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { authorization: "Bearer worker-test-token" },
      payload: scope,
    });
    assert.equal(created.statusCode, 201);
    const workspace = created.json<Workspace>();
    assert.match(workspace.id, /^[0-9a-f-]{36}$/);
    assert.equal(created.body.includes("internal-container"), false);

    const inspected = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${workspace.id}`,
      headers: { authorization: "Bearer worker-test-token" },
    });
    assert.equal(inspected.statusCode, 200);

    const destroyed = await app.inject({
      method: "DELETE",
      url: `/v1/workspaces/${workspace.id}`,
      headers: { authorization: "Bearer worker-test-token" },
    });
    assert.equal(destroyed.statusCode, 204);
  });

  it("rejects browser-controlled container IDs and extra creation fields", async () => {
    const { manager } = makeManager();
    const app = await createWorkerApp(manager, "worker-test-token");
    apps.push(app);
    const headers = { authorization: "Bearer worker-test-token" };

    const invalidId = await app.inject({
      method: "GET",
      url: "/v1/workspaces/internal-container-1",
      headers,
    });
    assert.equal(invalidId.statusCode, 400);

    const arbitraryImage = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers,
      payload: { ...scope, image: "attacker-controlled-image" },
    });
    assert.equal(arbitraryImage.statusCode, 400);
  });

  it("returns state only for the matching attempt and question workspace", async () => {
    const { manager } = makeManager();
    await manager.create(scope);
    const app = await createWorkerApp(manager, "worker-test-token");
    apps.push(app);
    const headers = { authorization: "Bearer worker-test-token" };
    const state = await app.inject({
      method: "POST",
      url: `/v1/attempts/${scope.attemptId}/questions/${scope.questionId}/state`,
      headers,
    });
    assert.equal(state.statusCode, 200);
    assert.deepEqual(state.json(), { state: { state: "ready" } });

    const unavailable = await app.inject({
      method: "POST",
      url: `/v1/attempts/${scope.attemptId}/questions/git-github-q2/state`,
      headers,
    });
    assert.equal(unavailable.statusCode, 503);
  });

  it("rejects a terminal upgrade when the scoped workspace shell cannot be opened", async () => {
    const { manager } = makeManager();
    const workspace = await manager.create(scope);
    const app = await createWorkerApp(manager, "worker-test-token");
    apps.push(app);
    const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    const url = new URL(`/v1/workspaces/${workspace.id}/terminal`, baseUrl);
    url.protocol = "ws:";

    const closeCode = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(url, {
        headers: { authorization: "Bearer worker-test-token" },
      });
      socket.once("close", resolve);
      socket.once("error", reject);
    });

    assert.equal(closeCode, 1011);
  });
});
