# TermForge worker

The worker owns local Docker workspace lifecycle, isolated terminal sessions,
and fixed sandbox-state inspection for the exam API. Do not expose this service
to the Internet or use it for public exams.

## Docker availability

The worker checks the current Docker context and runs a read-only Docker
information query for its health endpoint:

```sh
docker context inspect --format '{{ (index .Endpoints "docker").Host }}'
docker info --format '{{.ServerVersion}}'
```

It only reports Docker as available when the selected endpoint is a local
Unix socket or Windows named pipe. It does not install Docker, pull images, or
start containers during startup or health checks.

## Configure local workspaces

Copy `.env.example` to `.env`, set `SANDBOX_WORKER_TOKEN` to a long random
value, and build the Git and Docker images using the commands in the example.
Set `SANDBOX_IMAGE_GIT` and `SANDBOX_IMAGE_DOCKER` to the corresponding local
image names. The worker binds to `127.0.0.1:7001` by default.

Images are selected only by server-side configuration and must not be supplied
in API requests. Each image must contain `/bin/sleep` and support UID/GID
`1000:1000`. The workspace worker does not pull missing images.

Start the service:

```sh
npm run dev
```

`GET /health` is unauthenticated and reports Docker availability. All workspace
routes require `Authorization: Bearer <SANDBOX_WORKER_TOKEN>`:

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/v1/workspaces` | Create a workspace for an attempt/question |
| `GET` | `/v1/workspaces/:workspaceId` | Inspect lifecycle metadata and running state |
| `DELETE` | `/v1/workspaces/:workspaceId` | Stop and remove that workspace |
| `GET` | `/v1/workspaces/:workspaceId/terminal` | Open the scoped terminal WebSocket |
| `POST` | `/v1/attempts/:attemptId/questions/:questionId/state` | Inspect fixed, server-selected grading state |

Create request:

```json
{
  "attemptId": "UUID issued by the API",
  "questionId": "git-github-q1",
  "template": "git-github"
}
```

The worker generates a UUID workspace ID. Docker container IDs remain private
to the worker process. Repeated creation for the same attempt/question returns
the existing workspace. Workspaces expire after one hour and are cleaned up
periodically; normal worker shutdown also attempts cleanup.

## Container restrictions in this milestone

The worker creates a fixed idle `/bin/sleep infinity` process and exposes only
the approved shell inside that container. Candidates cannot choose a Docker
image, host container ID, host path, bind mount, or network. The grading
endpoint accepts only attempt/question identifiers and runs a fixed inspector;
it does not accept candidate-selected commands.

Containers are created with:

- no network;
- a read-only root filesystem and no added Linux capabilities;
- `no-new-privileges`, a non-root UID, and process/memory/CPU limits;
- bounded tmpfs mounts for `/workspace` and `/tmp`;
- a private root-owned `/run` tmpfs for the Docker simulator service;
- no Docker socket, host bind mount, privileged mode, or automatic image pull.

The Docker exam image intercepts the `docker` command and models a limited set
of image, container, volume, network, port, and copy operations in memory. It
does not launch containers, build actual images, or connect to the host Docker
daemon. This keeps Docker command practice isolated and makes grading
deterministic; do not describe its results as real container execution.

This is a local-development isolation baseline, **not a security certification
for hostile public users**. Containers share the host kernel; use a hardened
sandbox runtime or microVMs for public arbitrary-code execution. Keep the
worker private and its token out of browser code.

Workspace metadata is held in worker memory. If the worker crashes, managed
containers may be orphaned because this milestone does not include a durable
registry or startup recovery process. Review the `com.termforge.managed=true`
Docker label before manually removing any orphan. Do not use broad prune
commands on a shared Docker host.

The WebSocket gateway is scoped to the active attempt/question and enforces
input/output limits and question deadlines. These local containers still share
the host kernel, and the Docker command simulator is not a substitute for a
dedicated real-container runtime.

## Verify

```sh
npm run build
npm test
npm run test:simulator
```
