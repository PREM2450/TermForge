# TermForge web app

The candidate-facing React application for TermForge's timed practical exams.
It includes account access, the candidate dashboard, topic selection, exam
briefing, the timed workspace, terminal session UI, attempt recovery, and
results.

## Run locally

```sh
npm install
npm run dev
```

The Vite development server proxies `/api` to `http://127.0.0.1:3001` by
default. Override the target with `VITE_API_PROXY` when starting Vite:

```sh
VITE_API_PROXY=http://127.0.0.1:3001 npm run dev
```

For a deployed API on another origin, set `VITE_API_URL` at build time. The API
must allow credentialed requests from the web origin.

## API and execution requirements

The web app expects the API contract implemented in [src/api.ts](./src/api.ts).
At minimum, the API must support authentication, topics and briefings, attempt
creation/recovery, question activation/check/submission, final submission,
results, and attempt-scoped terminal-session creation.

Terminal commands are sent only over the secure WebSocket URL issued by the
authenticated API. The web app does not execute commands locally. If the API
or isolated sandbox worker is unavailable, terminal access stays disabled and
the app explains why. Do not connect candidate input to a host shell or expose
the application host's Docker socket.

Attempt IDs are kept in browser storage only as a resume hint; the API remains
authoritative for ownership, attempt state, scores, and deadlines.

## Verify

```sh
npm run lint
npm run build
```
