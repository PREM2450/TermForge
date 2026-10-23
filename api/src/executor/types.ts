import WebSocket from "ws";

export type WorkspaceTemplate = "git-github" | "docker" | "data-migration";

export interface IsolatedExecutor {
  createWorkspace(input: {
    attemptId: string;
    questionId: string;
    template: WorkspaceTemplate;
  }): Promise<{ id: string }>;
  openTerminal(workspaceId: string): WebSocket;
  execute(input: { attemptId: string; questionId: string; input: string }): Promise<{ output: string }>;
  inspect(input: { attemptId: string; questionId: string }): Promise<unknown>;
}

export class ExecutorUnavailableError extends Error {
  readonly code = "EXECUTOR_UNAVAILABLE";

  constructor() {
    super(
      "Terminal execution and state validation are unavailable: no isolated sandbox worker is configured.",
    );
    this.name = "ExecutorUnavailableError";
  }
}

export class UnavailableExecutor implements IsolatedExecutor {
  async createWorkspace(): Promise<{ id: string }> {
    throw new ExecutorUnavailableError();
  }

  openTerminal(): WebSocket {
    throw new ExecutorUnavailableError();
  }

  async execute(): Promise<{ output: string }> {
    throw new ExecutorUnavailableError();
  }

  async inspect(): Promise<unknown> {
    throw new ExecutorUnavailableError();
  }
}

export class HttpIsolatedExecutor implements IsolatedExecutor {
  constructor(
    private readonly baseUrl: URL,
    private readonly token: string,
  ) {}

  async createWorkspace(input: {
    attemptId: string;
    questionId: string;
    template: WorkspaceTemplate;
  }): Promise<{ id: string }> {
    const response = await this.request("/v1/workspaces", input);
    if (typeof response.id !== "string" || !/^[0-9a-f-]{36}$/i.test(response.id)) {
      throw new Error("Sandbox worker returned an invalid workspace");
    }
    return { id: response.id };
  }

  openTerminal(workspaceId: string): WebSocket {
    if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) {
      throw new Error("Invalid isolated workspace identifier");
    }
    const url = new URL(`/v1/workspaces/${encodeURIComponent(workspaceId)}/terminal`, this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return new WebSocket(url, {
      headers: { authorization: `Bearer ${this.token}` },
    });
  }

  async execute(input: {
    attemptId: string;
    questionId: string;
    input: string;
  }): Promise<{ output: string }> {
    const response = await this.request(
      `/v1/attempts/${encodeURIComponent(input.attemptId)}/questions/${encodeURIComponent(input.questionId)}/input`,
      { input: input.input },
    );
    if (typeof response.output !== "string") {
      throw new Error("Sandbox worker returned an invalid terminal response");
    }
    return { output: response.output };
  }

  async inspect(input: { attemptId: string; questionId: string }): Promise<unknown> {
    const response = await this.request(
      `/v1/attempts/${encodeURIComponent(input.attemptId)}/questions/${encodeURIComponent(input.questionId)}/state`,
      {},
    );
    if (!("state" in response)) throw new Error("Sandbox worker returned no state");
    return response.state;
  }

  private async request(path: string, body: object): Promise<Record<string, unknown>> {
    const response = await fetch(new URL(path, this.baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Sandbox worker request failed (${response.status})`);
    const data: unknown = await response.json();
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("Sandbox worker returned an invalid response");
    }
    return data as Record<string, unknown>;
  }
}

export function createExecutor(
  workerUrl = process.env.SANDBOX_WORKER_URL,
  token = process.env.SANDBOX_WORKER_TOKEN,
): IsolatedExecutor {
  if (!workerUrl || !token) return new UnavailableExecutor();
  const url = new URL(workerUrl);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("SANDBOX_WORKER_URL must use HTTPS except for localhost development");
  }
  return new HttpIsolatedExecutor(url, token);
}
