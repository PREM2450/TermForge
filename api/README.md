# TermForge API

## Local development

```sh
npm install
npm run dev
```

The server listens on `http://127.0.0.1:3001` by default. `GET /health`
checks PostgreSQL connectivity and reports `mode: "postgres"` only for the
database-backed API. Accounts, sessions, exam attempts, question state, and
scores are stored in PostgreSQL.

Apply committed migrations before starting the API:

```sh
npm run db:migrate
```

The API idempotently synchronizes its published topic, exam, question, and
subquestion catalog at startup. It does not delete catalog rows or user data.

Register an account in the web app, then sign in. The API publishes topics and
their exam sets and enforces authentication, ownership, question order,
server-side deadlines, and server-side mark calculation.

## Configuration

- `HOST` / `PORT`: bind address and port (defaults `127.0.0.1:3001`).
- `JWT_SECRET`: signing secret; a local-only development value is used when
  omitted. Set a unique secret of at least 32 characters outside development.
- `COOKIE_SECURE`: secure-cookie flag. It is enabled automatically in
  production.
- `DATABASE_URL`: PostgreSQL connection string used by the API and migration
  commands. The API exits without starting if database initialization or
  catalog synchronization fails.
- `SANDBOX_WORKER_URL` / `SANDBOX_WORKER_TOKEN`: credentials for the isolated
  execution worker used for terminal sessions and grading. Keep the worker
  private and do not expose its token or host Docker daemon to candidates.

Candidate commands are never executed by this API process. Do not replace the
isolated worker with a local shell or expose the host Docker socket.

## Checks

```sh
npm test
npm run build
```
