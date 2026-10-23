import { randomUUID } from "node:crypto";
import type {
  ChildProcessWithoutNullStreams,
} from "node:child_process";
import type { DockerAvailability, DockerRuntime } from "./docker-runtime.js";

export const workspaceTemplates = ["git-github", "docker", "data-migration"] as const;
export type WorkspaceTemplate = (typeof workspaceTemplates)[number];

export interface WorkspaceScope {
  attemptId: string;
  questionId: string;
  template: WorkspaceTemplate;
}

export interface Workspace {
  id: string;
  attemptId: string;
  questionId: string;
  template: WorkspaceTemplate;
  status: "running";
  createdAt: string;
  expiresAt: string;
}

interface WorkspaceRecord {
  workspace: Workspace;
  containerId: string;
}

export class WorkspaceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceUnavailableError";
  }
}

export interface WorkspaceManager {
  create(scope: WorkspaceScope): Promise<Workspace>;
  inspect(workspaceId: string): Promise<Workspace | null>;
  inspectState(attemptId: string, questionId: string): Promise<unknown>;
  openShell(workspaceId: string): Promise<ChildProcessWithoutNullStreams>;
  destroy(workspaceId: string): Promise<boolean>;
  availability(): Promise<DockerAvailability>;
  dispose(): Promise<void>;
}

const templateEnvironmentVariables: Record<WorkspaceTemplate, string> = {
  "git-github": "SANDBOX_IMAGE_GIT",
  docker: "SANDBOX_IMAGE_DOCKER",
  "data-migration": "SANDBOX_IMAGE_DATA_MIGRATION",
};

const workspaceLifetimeMs = 60 * 60 * 1000;
const cleanupIntervalMs = 30_000;
const defaultLimits = {
  memoryMb: 256,
  cpuCount: 0.5,
  processCount: 64,
  workspaceMb: 128,
} as const;

export class DockerWorkspaceManager implements WorkspaceManager {
  private readonly recordsById = new Map<string, WorkspaceRecord>();
  private readonly idsByScope = new Map<string, string>();
  private readonly pendingCreates = new Map<string, Promise<Workspace>>();
  private readonly cleanupTimer: NodeJS.Timeout;
  private disposed = false;

  constructor(
    private readonly runtime: DockerRuntime,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.cleanupTimer = setInterval(() => {
      void this.expireWorkspaces();
    }, cleanupIntervalMs);
    this.cleanupTimer.unref();
  }

  async availability(): Promise<DockerAvailability> {
    return this.runtime.checkAvailability();
  }

  async create(scope: WorkspaceScope): Promise<Workspace> {
    if (this.disposed) throw new WorkspaceUnavailableError("Worker is shutting down.");

    const scopeKey = this.scopeKey(scope);
    const pending = this.pendingCreates.get(scopeKey);
    if (pending) return { ...(await pending) };

    const creating = this.createWorkspace(scope, scopeKey);
    this.pendingCreates.set(scopeKey, creating);
    try {
      return { ...(await creating) };
    } finally {
      if (this.pendingCreates.get(scopeKey) === creating) {
        this.pendingCreates.delete(scopeKey);
      }
    }
  }

  private async createWorkspace(scope: WorkspaceScope, scopeKey: string): Promise<Workspace> {
    const existingId = this.idsByScope.get(scopeKey);
    if (existingId) {
      const existing = this.recordsById.get(existingId);
      if (existing && new Date(existing.workspace.expiresAt) > this.now()) {
        if (!(await this.runtime.inspectRunning(existing.containerId))) {
          throw new WorkspaceUnavailableError("The workspace container is not running.");
        }
        return { ...existing.workspace };
      }
      if (existing) await this.destroy(existingId);
    }

    const docker = await this.runtime.checkAvailability();
    if (!docker.available) {
      throw new WorkspaceUnavailableError(
        "Local Docker is unavailable; no workspace was created.",
      );
    }

    const image = this.environment[templateEnvironmentVariables[scope.template]];
    if (!image) {
      throw new WorkspaceUnavailableError(
        `No preloaded Docker image is configured for the ${scope.template} template.`,
      );
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,254}$/.test(image)) {
      throw new WorkspaceUnavailableError("The configured sandbox image name is invalid.");
    }

    const id = randomUUID();
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + workspaceLifetimeMs);
    const workspace: Workspace = {
      id,
      attemptId: scope.attemptId,
      questionId: scope.questionId,
      template: scope.template,
      status: "running",
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
    const containerId = await this.runtime.create({
      name: `termforge-${id}`,
      labels: {
        "com.termforge.workspace-id": id,
        "com.termforge.attempt-id": scope.attemptId,
        "com.termforge.question-id": scope.questionId,
        "com.termforge.template": scope.template,
        "com.termforge.expires-at": expiresAt.toISOString(),
      },
      image,
      limits: defaultLimits,
    });

    try {
      await this.runtime.start(containerId);
      if (!(await this.runtime.inspectRunning(containerId))) {
        throw new WorkspaceUnavailableError("Docker did not start the workspace container.");
      }
      if (scope.template !== "data-migration") {
        await this.runtime.initializeWorkspace(containerId, scope.template);
      }
      if (this.disposed) {
        throw new WorkspaceUnavailableError("Worker is shutting down.");
      }
    } catch (error) {
      try {
        await this.runtime.remove(containerId);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Workspace startup failed and its container could not be removed.",
        );
      }
      throw error;
    }

    this.recordsById.set(id, { workspace, containerId });
    this.idsByScope.set(scopeKey, id);
    return { ...workspace };
  }

  async inspect(workspaceId: string): Promise<Workspace | null> {
    const record = this.recordsById.get(workspaceId);
    if (!record) return null;
    if (new Date(record.workspace.expiresAt) <= this.now()) {
      await this.destroy(workspaceId);
      return null;
    }
    if (!(await this.runtime.inspectRunning(record.containerId))) {
      await this.destroy(workspaceId);
      return null;
    }
    return { ...record.workspace };
  }

  async inspectState(attemptId: string, questionId: string): Promise<unknown> {
    const workspaceId = this.idsByScope.get(`${attemptId}:${questionId}`);
    const record = workspaceId ? this.recordsById.get(workspaceId) : undefined;
    if (!record) throw new WorkspaceUnavailableError("The question workspace is unavailable.");
    const workspace = await this.inspect(record.workspace.id);
    if (!workspace) throw new WorkspaceUnavailableError("The question workspace is unavailable.");
    return this.runtime.inspectState(record.containerId, workspace.template);
  }

  async openShell(workspaceId: string): Promise<ChildProcessWithoutNullStreams> {
    const workspace = await this.inspect(workspaceId);
    const record = workspace ? this.recordsById.get(workspaceId) : undefined;
    if (!record) {
      throw new WorkspaceUnavailableError("The workspace is no longer available.");
    }
    return this.runtime.openShell(record.containerId);
  }

  async destroy(workspaceId: string): Promise<boolean> {
    const record = this.recordsById.get(workspaceId);
    if (!record) return false;
    await this.runtime.remove(record.containerId);
    this.recordsById.delete(workspaceId);
    this.idsByScope.delete(this.scopeKey(record.workspace));
    return true;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    clearInterval(this.cleanupTimer);
    const results = await Promise.allSettled(
      [...this.recordsById.keys()].map((workspaceId) => this.destroy(workspaceId)),
    );
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        "One or more workspace containers could not be removed during shutdown.",
      );
    }
  }

  private async expireWorkspaces(): Promise<void> {
    const expired = [...this.recordsById.values()]
      .filter((record) => new Date(record.workspace.expiresAt) <= this.now())
      .map((record) => record.workspace.id);
    for (const workspaceId of expired) {
      try {
        await this.destroy(workspaceId);
      } catch {
        process.stderr.write(`Failed to remove expired TermForge workspace ${workspaceId}\n`);
      }
    }
  }

  private scopeKey(scope: Pick<Workspace, "attemptId" | "questionId">): string {
    return `${scope.attemptId}:${scope.questionId}`;
  }
}
