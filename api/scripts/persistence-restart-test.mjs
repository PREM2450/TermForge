import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const apiDirectory = new URL("../", import.meta.url).pathname;
const clusterDirectory = await mkdtemp(join(tmpdir(), "termforge-persistence-restart-"));
const postgresLog = join(clusterDirectory, "postgres.log");
let postgresStarted = false;
let apiProcess;
let gradingWorker;

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

async function startApi(port, databaseUrl, workerUrl, workerToken) {
  apiProcess = spawn("node", ["dist/index.js"], {
    cwd: apiDirectory,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      HOST: "127.0.0.1",
      PORT: String(port),
      NODE_ENV: "test",
      JWT_SECRET: randomUUID() + randomUUID(),
      SANDBOX_WORKER_URL: workerUrl,
      SANDBOX_WORKER_TOKEN: workerToken,
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

async function startGradingWorker() {
  const workerToken = randomUUID() + randomUUID();
  gradingWorker = createHttpServer((request, response) => {
    const match = request.url?.match(
      /^\/v1\/attempts\/[0-9a-f-]+\/questions\/(git-github-test-01-q[0-9]+)\/state$/,
    );
    if (
      request.method !== "POST" ||
      request.headers.authorization !== `Bearer ${workerToken}` ||
      !match
    ) {
      response.writeHead(404).end();
      return;
    }
    const state = match[1] === "git-github-test-01-q1"
      ? { git: { branch: "main" } }
      : match[1] === "git-github-test-01-q2"
        ? { git: { config: { userName: "Candidate 1" } } }
        : {};
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ state }));
  });
  gradingWorker.listen(0, "127.0.0.1");
  await once(gradingWorker, "listening");
  const address = gradingWorker.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not allocate a local test grading worker port");
  }
  return {
    token: workerToken,
    url: `http://127.0.0.1:${address.port}`,
  };
}

async function stopGradingWorker() {
  if (!gradingWorker?.listening) return;
  await new Promise((resolve, reject) =>
    gradingWorker.close((error) => (error ? reject(error) : resolve())),
  );
  gradingWorker = undefined;
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
  const gradingWorkerInfo = await startGradingWorker();

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

  await startApi(apiPort, databaseUrl, gradingWorkerInfo.url, gradingWorkerInfo.token);
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

  const createdAttempt = await requestJson(apiPort, "/api/exams/git-github-test-01/attempts", {
    method: "POST",
    cookie: firstCookie,
  });
  const attemptId = createdAttempt.data?.id;
  if (typeof attemptId !== "string" || createdAttempt.data.questions?.length !== 20) {
    throw new Error("API did not create the expected Git and GitHub attempt");
  }
  if (
    createdAttempt.data.totalScore !== null ||
    createdAttempt.data.questions[0].score !== null ||
    createdAttempt.data.questions[0].expectedAnswers !== undefined
  ) {
    throw new Error("Active attempts exposed scores or answer keys before final submission");
  }

  const firstQuestionId = createdAttempt.data.questions[0].id;
  const secondQuestionId = createdAttempt.data.questions[1].id;
  const thirdQuestionId = createdAttempt.data.questions[2].id;
  const submitted = await requestJson(
    apiPort,
    `/api/attempts/${encodeURIComponent(attemptId)}/questions/${encodeURIComponent(firstQuestionId)}/submit`,
    { method: "POST", cookie: firstCookie },
  );
  if (
    submitted.data.questions?.[0]?.score !== null ||
    submitted.data.totalScore !== null ||
    submitted.data.questions?.[0]?.expectedAnswers !== undefined ||
    submitted.data.questions?.[0]?.status !== "submitted"
  ) {
    throw new Error("Active attempt exposed a question score or answer key before final submission");
  }
  const progress = await requestJson(
    apiPort,
    `/api/attempts/${encodeURIComponent(attemptId)}/questions/${encodeURIComponent(secondQuestionId)}/activate`,
    { method: "POST", cookie: firstCookie },
  );
  if (
    progress.data.questions[0].status !== "submitted" ||
    progress.data.questions[0].score !== null ||
    progress.data.totalScore !== null ||
    progress.data.questions[0].feedback !== undefined ||
    progress.data.questions[1].status !== "active"
  ) {
    throw new Error("API did not save the expected pre-restart question progress");
  }
  const secondSubmitted = await requestJson(
    apiPort,
    `/api/attempts/${encodeURIComponent(attemptId)}/questions/${encodeURIComponent(secondQuestionId)}/submit`,
    { method: "POST", cookie: firstCookie },
  );
  if (
    secondSubmitted.data.questions?.[1]?.score !== null ||
    secondSubmitted.data.totalScore !== null ||
    secondSubmitted.data.questions?.[1]?.feedback !== undefined ||
    secondSubmitted.data.questions?.[1]?.status !== "submitted"
  ) {
    throw new Error("Active attempt exposed its question score or grading log before final submission");
  }
  const nextProgress = await requestJson(
    apiPort,
    `/api/attempts/${encodeURIComponent(attemptId)}/questions/${encodeURIComponent(thirdQuestionId)}/activate`,
    { method: "POST", cookie: firstCookie },
  );
  if (
    nextProgress.data.questions?.[0]?.score !== null ||
    nextProgress.data.questions?.[1]?.score !== null ||
    nextProgress.data.totalScore !== null ||
    nextProgress.data.questions?.[0]?.expectedAnswers !== undefined ||
    nextProgress.data.questions?.[2]?.status !== "active"
  ) {
    throw new Error("Cumulative score or next-question progress was not saved");
  }

  await stopApi();
  await startApi(apiPort, databaseUrl, gradingWorkerInfo.url, gradingWorkerInfo.token);

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
    restored.data.questions?.[0]?.score !== null ||
    restored.data.questions?.[1]?.status !== "submitted" ||
    restored.data.questions?.[1]?.score !== null ||
    restored.data.totalScore !== null ||
    restored.data.questions?.[0]?.feedback !== undefined ||
    restored.data.questions?.[0]?.expectedAnswers !== undefined ||
    restored.data.questions?.[2]?.status !== "active"
  ) {
    throw new Error("Attempt or saved question progress was not restored after API restart");
  }

  const finalResults = await requestJson(
    apiPort,
    `/api/attempts/${encodeURIComponent(attemptId)}/submit`,
    { method: "POST", cookie: restartedCookie },
  );
  if (
    finalResults.data?.status !== "submitted" ||
    finalResults.data.totalScore !== 4 ||
    finalResults.data.questions?.[0]?.score !== 2 ||
    finalResults.data.questions?.[1]?.score !== 2 ||
    finalResults.data.questions?.[2]?.score !== 0 ||
    finalResults.data.questions?.[0]?.expectedAnswers?.[0]?.requirement !== 'git.branch = "main"' ||
    !finalResults.data.questions?.[0]?.feedback?.[0]?.includes('observed "main"') ||
    !finalResults.data.questions?.[2]?.feedback?.[0]?.includes("Incorrect")
  ) {
    throw new Error("Final results did not reveal correct scores, expected answers, and grading logs");
  }

  console.log("PASS: hidden in-progress scores, final question review, cumulative grading, and restart persistence.");
} finally {
  await stopApi().catch(() => {});
  await stopGradingWorker().catch(() => {});
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
