import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const apiDirectory = new URL("../", import.meta.url).pathname;
const clusterDirectory = await mkdtemp(join(tmpdir(), "termforge-persistence-restart-"));
const postgresLog = join(clusterDirectory, "postgres.log");
let postgresStarted = false;
let apiProcess;

async function unusedPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not allocate a local test port");
  }
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function command(binary, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: apiDirectory,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${binary} exited with code ${code}`));
      }
    });
  });
}

async function stopApi() {
  if (!apiProcess || apiProcess.exitCode !== null || apiProcess.signalCode !== null) return;
  const exited = once(apiProcess, "exit");
  apiProcess.kill("SIGTERM");
  await Promise.race([
    exited,
    delay(10_000).then(() => {
      apiProcess.kill("SIGKILL");
      throw new Error("The test API did not stop after SIGTERM");
    }),
  ]);
  apiProcess = undefined;
}

async function startApi(port, databaseUrl) {
  apiProcess = spawn("node", ["dist/index.js"], {
    cwd: apiDirectory,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      HOST: "127.0.0.1",
      PORT: String(port),
      NODE_ENV: "test",
      JWT_SECRET: randomUUID() + randomUUID(),
    },
    stdio: "ignore",
  });
  const child = apiProcess;
  let exitInfo;
  child.once("exit", (code, signal) => {
    exitInfo = { code, signal };
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (exitInfo) {
      throw new Error(`Test API exited before becoming healthy (${exitInfo.code ?? exitInfo.signal})`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      const health = await response.json();
      if (
        response.ok &&
        health.status === "ok" &&
        health.mode === "postgres" &&
        health.database === "connected"
      ) {
        return;
      }
    } catch {
      await delay(200);
    }
  }
  throw new Error("Test API did not become healthy against the isolated database");
}

async function requestJson(port, path, { method = "GET", body, cookie } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    throw new Error(`API returned a non-JSON response for ${method} ${path}`);
  }
  if (!response.ok) {
    throw new Error(`API request ${method} ${path} failed with status ${response.status}`);
  }
  return { data, response };
}

function sessionCookie(response) {
  const header = response.headers.get("set-cookie");
  const match = header?.match(/(?:^|,\s*)termforge_session=([^;]+)/);
  if (!match?.[1]) throw new Error("API response did not set the session cookie");
  return `termforge_session=${match[1]}`;
}

try {
  const username = process.env.USER ?? process.env.LOGNAME;
  if (!username) throw new Error("Could not determine the local PostgreSQL test user");
  const postgresPort = await unusedPort();
  const apiPort = await unusedPort();
  const databaseName = `termforge_restart_${process.pid}`;
  const databaseUrl = `postgres://${encodeURIComponent(username)}@127.0.0.1:${postgresPort}/${databaseName}`;

  await command("initdb", [
    "--auth=trust",
    "--no-locale",
    "--encoding=UTF8",
    "-U",
    username,
    "-D",
    join(clusterDirectory, "data"),
  ]);
  await command("pg_ctl", [
    "-D",
    join(clusterDirectory, "data"),
    "-l",
    postgresLog,
    "-o",
    `-h 127.0.0.1 -p ${postgresPort}`,
    "-w",
    "start",
  ]);
  postgresStarted = true;

  await command(
    "createdb",
    ["--host=127.0.0.1", `--port=${postgresPort}`, `--username=${username}`, databaseName],
  );
  await command("npm", ["run", "db:migrate"], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });

  await startApi(apiPort, databaseUrl);
  const email = `restart-${randomUUID()}@termforge.test`;
  const password = `Restart-test-${randomUUID()}`;
  const registration = await requestJson(apiPort, "/api/auth/register", {
    method: "POST",
    body: { name: "Restart Test Candidate", email, password },
  });
  if (registration.response.status !== 201) {
    throw new Error("Registration did not return HTTP 201");
  }
  const firstCookie = sessionCookie(registration.response);

  const createdAttempt = await requestJson(apiPort, "/api/exams/data-migration/attempts", {
    method: "POST",
    cookie: firstCookie,
  });
  const attemptId = createdAttempt.data?.id;
  if (typeof attemptId !== "string" || createdAttempt.data.questions?.length !== 5) {
    throw new Error("API did not create the expected data migration attempt");
  }

  const firstQuestionId = createdAttempt.data.questions[0].id;
  const secondQuestionId = createdAttempt.data.questions[1].id;
  await requestJson(
    apiPort,
    `/api/attempts/${encodeURIComponent(attemptId)}/questions/${encodeURIComponent(firstQuestionId)}/submit`,
    { method: "POST", cookie: firstCookie },
  );
  const progress = await requestJson(
    apiPort,
    `/api/attempts/${encodeURIComponent(attemptId)}/questions/${encodeURIComponent(secondQuestionId)}/activate`,
    { method: "POST", cookie: firstCookie },
  );
  if (
    progress.data.questions[0].status !== "submitted" ||
    progress.data.questions[1].status !== "active"
  ) {
    throw new Error("API did not save the expected pre-restart question progress");
  }

  await stopApi();
  await startApi(apiPort, databaseUrl);

  const login = await requestJson(apiPort, "/api/auth/login", {
    method: "POST",
    body: { email, password },
  });
  const restartedCookie = sessionCookie(login.response);
  if (login.data?.user?.email !== email) {
    throw new Error("Registered user could not log in after API restart");
  }
  const restored = await requestJson(
    apiPort,
    `/api/attempts/${encodeURIComponent(attemptId)}`,
    { cookie: restartedCookie },
  );
  if (
    restored.data?.id !== attemptId ||
    restored.data.questions?.[0]?.status !== "submitted" ||
    restored.data.questions?.[1]?.status !== "active"
  ) {
    throw new Error("Attempt or saved question progress was not restored after API restart");
  }

  console.log("PASS: API registration, attempt progress, restart, login, and progress restoration.");
} finally {
  await stopApi().catch(() => {});
  if (postgresStarted) {
    try {
      await command(
        "pg_ctl",
        ["-D", join(clusterDirectory, "data"), "-m", "fast", "-w", "stop"],
      );
    } catch (error) {
      throw new Error(
        `Could not stop the temporary PostgreSQL server; preserving its data directory at ${clusterDirectory}. Stop PostgreSQL safely before removing that directory.`,
        { cause: error },
      );
    }
  }
  await rm(clusterDirectory, { recursive: true, force: true });
}
