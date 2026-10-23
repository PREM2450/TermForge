# TermForge API

## Local development

```sh
npm install
npm run dev
```

The server listens on `http://127.0.0.1:3001` by default. `GET /health`
reports its current mode. The local mode uses in-memory accounts and attempts:
all data is discarded when the API process stops. It is intended for local UI
development only, not multi-instance deployment or production.

Register an account in the web app, then sign in. The API serves the three
published exam catalog entries and enforces authentication, ownership,
question order, server-side deadlines, and server-side mark calculation.

## Configuration

- `HOST` / `PORT`: bind address and port (defaults `127.0.0.1:3001`).
- `JWT_SECRET`: signing secret; a local-only development value is used when
  omitted. Set a unique secret of at least 32 characters outside development.
- `COOKIE_SECURE`: secure-cookie flag. It is enabled automatically in
  production.
- `DATABASE_URL`: reserved for PostgreSQL persistence. The current API
  entrypoint does not yet connect to PostgreSQL; local accounts and attempts
  remain volatile.
- `SANDBOX_WORKER_URL` / `SANDBOX_WORKER_TOKEN`: credentials for the isolated
  execution worker. A WebSocket gateway is not implemented yet, so terminal
  sessions and grading remain unavailable even if the worker URL is set.

Candidate commands are never executed by this API process. Do not replace the
isolated worker with a local shell or expose the host Docker socket.

## Checks

```sh
npm run build
```
