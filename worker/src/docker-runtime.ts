import {
  execFile as execFileCallback,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const dockerCommandTimeoutMs = 5_000;
const dockerOutputLimitBytes = 16 * 1024;

export interface DockerAvailability {
  available: boolean;
  serverVersion: string | null;
  reason?: "docker_cli_missing" | "daemon_unavailable" | "non_local_context";
}

export interface ContainerLimits {
  memoryMb: number;
  cpuCount: number;
  processCount: number;
  workspaceMb: number;
}

export interface CreateContainerInput {
  name: string;
  labels: Record<string, string>;
  image: string;
  limits: ContainerLimits;
}

export interface DockerRuntime {
  checkAvailability(): Promise<DockerAvailability>;
  create(input: CreateContainerInput): Promise<string>;
  start(containerId: string): Promise<void>;
  inspectRunning(containerId: string): Promise<boolean>;
  openShell(containerId: string): ChildProcessWithoutNullStreams;
  remove(containerId: string): Promise<void>;
}

export function buildDockerCreateArgs(input: CreateContainerInput): string[] {
  return [
    "create",
    "--name",
    input.name,
    "--label",
    "com.termforge.managed=true",
    ...Object.entries(input.labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--pids-limit",
    String(input.limits.processCount),
    "--memory",
    `${input.limits.memoryMb}m`,
    "--cpus",
    String(input.limits.cpuCount),
    "--user",
    "1000:1000",
    "--workdir",
    "/workspace",
    "--tmpfs",
    `/workspace:rw,noexec,nosuid,nodev,size=${input.limits.workspaceMb}m,uid=1000,gid=1000,mode=0700`,
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=32m,uid=1000,gid=1000,mode=0700",
    "--restart",
    "no",
    "--pull",
    "never",
    "--entrypoint",
    "/bin/sleep",
    input.image,
    "infinity",
  ];
}

export class DockerCliRuntime implements DockerRuntime {
  async checkAvailability(): Promise<DockerAvailability> {
    try {
      const dockerHost = process.env.DOCKER_HOST;
      const endpoint = dockerHost ?? (await this.run([
        "context",
        "inspect",
        "--format",
        '{{ (index .Endpoints "docker").Host }}',
      ]));

      if (!endpoint.startsWith("unix://") && !endpoint.startsWith("npipe://")) {
        return { available: false, serverVersion: null, reason: "non_local_context" };
      }

      const serverVersion = await this.run([
        "info",
        "--format",
        "{{.ServerVersion}}",
      ]);
      if (!serverVersion) {
        return { available: false, serverVersion: null, reason: "daemon_unavailable" };
      }
      return { available: true, serverVersion };
    } catch (error) {
      const code = error !== null && typeof error === "object" && "code" in error
        ? error.code
        : undefined;
      return {
        available: false,
        serverVersion: null,
        reason: code === "ENOENT" ? "docker_cli_missing" : "daemon_unavailable",
      };
    }
  }

  async create(input: CreateContainerInput): Promise<string> {
    const output = await this.run(buildDockerCreateArgs(input));
    const containerId = output.trim();
    if (!/^[a-f0-9]{12,64}$/i.test(containerId)) {
      throw new Error("Docker returned an invalid container identifier");
    }
    return containerId;
  }

  async start(containerId: string): Promise<void> {
    await this.run(["start", this.requireContainerId(containerId)]);
  }

  async inspectRunning(containerId: string): Promise<boolean> {
    const output = await this.run([
      "inspect",
      "--format",
      "{{.State.Running}}",
      this.requireContainerId(containerId),
    ]);
    if (output.trim() === "true") return true;
    if (output.trim() === "false") return false;
    throw new Error("Docker returned an invalid container state");
  }

  openShell(containerId: string): ChildProcessWithoutNullStreams {
    return spawn(
      "docker",
      [
        "exec",
        "--interactive",
        "--env",
        "PS1=$ ",
        "--env",
        "TERM=xterm-256color",
        this.requireContainerId(containerId),
        "/usr/local/bin/termforge-shell",
      ],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
  }

  async remove(containerId: string): Promise<void> {
    await this.run(["rm", "--force", this.requireContainerId(containerId)]);
  }

  private requireContainerId(containerId: string): string {
    if (!/^[a-f0-9]{12,64}$/i.test(containerId)) {
      throw new Error("Invalid internal Docker container identifier");
    }
    return containerId;
  }

  private async run(args: string[]): Promise<string> {
    const result = await execFile("docker", args, {
      timeout: dockerCommandTimeoutMs,
      maxBuffer: dockerOutputLimitBytes,
      encoding: "utf8",
      windowsHide: true,
    });
    return result.stdout.trim();
  }
}
