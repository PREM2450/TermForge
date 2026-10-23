import "dotenv/config";
import { createWorkerApp } from "./app.js";
import { DockerCliRuntime } from "./docker-runtime.js";
import { DockerWorkspaceManager } from "./workspaces.js";

const host = process.env.WORKER_HOST ?? "127.0.0.1";
const port = Number(process.env.WORKER_PORT ?? 7001);
const workerToken = process.env.SANDBOX_WORKER_TOKEN;

if (!workerToken) {
  throw new Error("SANDBOX_WORKER_TOKEN is required");
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("WORKER_PORT must be a valid TCP port");
}

const workspaceManager = new DockerWorkspaceManager(new DockerCliRuntime());
const app = await createWorkerApp(workspaceManager, workerToken);

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error({ err: error }, "Worker failed to start");
  await workspaceManager.dispose();
  process.exitCode = 1;
}

const shutdown = async () => {
  try {
    await workspaceManager.dispose();
    await app.close();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, "Worker shutdown could not clean up every workspace");
    process.exit(1);
  }
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
