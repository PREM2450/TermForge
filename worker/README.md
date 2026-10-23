# TermForge worker

The worker owns the local Docker workspace lifecycle. It does **not** accept
terminal input or execute candidate commands yet. Do not expose this service to
the Internet or use it for public exams.

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
value, and set `SANDBOX_IMAGE_GIT` to a locally preloaded, reviewed image.
Optional Docker and data-migration images use their own variables. The worker
binds to `127.0.0.1:7001` by default.

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

The worker creates and starts only a fixed idle `/bin/sleep infinity` process.
It does not expose Docker exec, a terminal shell, file upload, or a grading
state endpoint. The candidate cannot choose a Docker image, command, container
ID, host path, bind mount, or network.

Containers are created with:

- no network;
- a read-only root filesystem and no added Linux capabilities;
- `no-new-privileges`, a non-root UID, and process/memory/CPU limits;
- bounded tmpfs mounts for `/workspace` and `/tmp`;
- no Docker socket, host bind mount, privileged mode, or automatic image pull.

This is a local-development isolation baseline, **not a security certification
for hostile public users**. Containers share the host kernel; use a hardened
sandbox runtime or microVMs for public arbitrary-code execution. Keep the
worker private and its token out of browser code.

Workspace metadata is held in worker memory. If the worker crashes, managed
containers may be orphaned because this milestone does not include a durable
registry or startup recovery process. Review the `com.termforge.managed=true`
Docker label before manually removing any orphan. Do not use broad prune
commands on a shared Docker host.

The API's terminal-session endpoint must continue returning `503` until an
attempt-scoped WebSocket gateway, reconnect authorization, command/output
limits, deadline revocation, grading inspection, and end-to-end security tests
are implemented.

## Verify

```sh
npm run build
npm test
```
