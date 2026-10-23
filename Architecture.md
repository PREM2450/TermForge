# Terminal-Based Exam Platform — Architecture

**Document version:** 1.0  
**Status:** Proposed system architecture  
**Related documents:** `Terminal_Based_Exam_Platform_PRD.md`, `Terminal_Based_Exam_Platform_DESIGN.md`

---

## 1. Architecture Overview

The Terminal-Based Exam Platform is a browser-based assessment system in which candidates complete practical, timed exams by executing commands inside isolated terminal environments.

The first release supports three topics:

- Git & GitHub
- Docker
- Data Migration

Each exam is worth 40 marks and contains timed questions that may include independently scored subquestions. Both per-question and overall exam timers are enforced by the server.

The Git & GitHub and Docker topics each provide 15 selectable test sets, with
20 terminal-command questions per set. The Docker sandbox uses a restricted
in-memory command simulator and does not connect to or launch containers on
the host Docker daemon.

The system is designed as a **modular monolith for the application API, with a separately isolated execution plane**. This keeps ordinary product logic straightforward to develop while separating untrusted command execution from application services and sensitive data.

### Core architectural decisions

1. React and TypeScript provide the candidate and administrator interfaces.
2. Fastify and TypeScript provide the application API.
3. PostgreSQL stores durable product and exam state.
4. The execution orchestrator provisions disposable sandboxes.
5. xterm.js renders the terminal in the browser; it does not itself execute commands.
6. A WebSocket relays input and output between the browser and an authorized sandbox process.
7. Validators inspect sandbox state using restricted, server-controlled mechanisms.
8. The scoring service calculates marks on the server.
9. Server timestamps are authoritative for all deadlines and submission decisions.
10. The execution plane has no access to production secrets or unrelated candidate workspaces.

## 2. High-Level Architecture Diagram

```text
                           CANDIDATE / ADMIN
                                  |
                                  v
                   +-----------------------------+
                   | Browser                     |
                   | React + TypeScript + Vite   |
                   | Tailwind CSS + xterm.js     |
                   +--------------+--------------+
                                  |
                       HTTPS REST | WSS Terminal
                                  |
                                  v
                   +-----------------------------+
                   | Application API             |
                   | Fastify + TypeScript         |
                   |                             |
                   | Authentication / RBAC        |
                   | Topics / Exams / Questions   |
                   | Attempts / Timers            |
                   | Validation orchestration     |
                   | Results / Admin APIs          |
                   +------+----------------+-----+
                          |                |
                    SQL   |                | Private control API
                          v                v
                +----------------+  +----------------------+
                | PostgreSQL     |  | Execution Orchestr.  |
                | Users          |  | Provision / Stop     |
                | Exams          |  | Session authorization|
                | Attempts       |  | Resource policy      |
                | Scores / Audit |  +----------+-----------+
                +----------------+             |
                                                v
                                   +--------------------------+
                                   | Isolated Worker Pool     |
                                   | Disposable sandboxes     |
                                   |                          |
                                   | Git environment          |
                                   | Docker environment       |
                                   | Data migration env       |
                                   +------------+-------------+
                                                |
                                                v
                                   +--------------------------+
                                   | Restricted Validator     |
                                   | Read-only state inspection|
                                   +------------+-------------+
                                                |
                                                v
                                   +--------------------------+
                                   | Scoring / Result Store   |
                                   | Server-side only         |
                                   +--------------------------+
```

The diagram shows logical responsibilities. In a small deployment, the application API, validator, and scoring modules can live in one codebase and process. The execution orchestrator and sandbox workers must remain separated by a strict trust boundary.

## 3. Architectural Style and Deployment Boundaries

### 3.1 Application plane

The application plane contains trusted product services:
- Identity and access control.
- Topic and exam configuration.
- Question and subquestion management.
- Attempt lifecycle.
- Timer enforcement.
- Terminal-session authorization.
- Validation orchestration.
- Scoring and results.
- Administrative actions and audit records.

These modules can initially be implemented in a single Fastify application, using clear module boundaries and dependency interfaces.

### 3.2 Execution plane

The execution plane handles untrusted candidate commands:
- Sandbox provisioning and termination.
- Terminal process management.
- Interactive input/output.
- Filesystem and process isolation.
- CPU, memory, storage, process, and time limits.
- Approved environment images.
- Sandbox state inspection for grading.

It must not share the application's filesystem, host shell, production credentials, or database credentials with candidate processes.

### 3.3 Data plane

PostgreSQL stores durable state. The sandbox filesystem is ephemeral and is not the authority for scores, attempt status, or deadlines. If an exam requires workspace continuity, preserve state only inside the isolated attempt boundary and follow a documented checkpoint/recovery policy.

## 4. Recommended Technology Choices

| Concern | Technology | Reason |
|---|---|---|
| Frontend | React + TypeScript + Vite | Mature component ecosystem and fast development |
| Styling | Tailwind CSS | Consistent responsive UI |
| Terminal rendering | xterm.js | Browser terminal interface |
| API | Fastify + TypeScript | Lightweight API with schema validation support |
| API schemas | TypeBox or Zod | Runtime validation and typed contracts |
| Database | PostgreSQL | Transactions, constraints, and relational data |
| ORM/migrations | Drizzle ORM | Type-safe queries and schema management |
| Terminal transport | WebSocket | Interactive low-latency input/output |
| Execution orchestration | Dedicated worker/orchestrator service | Keeps untrusted execution away from API |
| Sandbox | Hardened container or microVM runtime | Limits access to host resources |
| Reverse proxy | Caddy or Nginx | TLS, routing, and request limits |
| Local development | Docker Compose | Repeatable local setup |
| Unit/integration tests | Vitest and API test tooling | Fast automated feedback |
| Browser tests | Playwright | End-to-end workflow verification |
| Observability | Structured logs, metrics, and error tracking | Debugging and operations |

### Execution-runtime recommendation

For a private MVP, start with a dedicated Linux worker pool using a hardened, non-privileged sandbox configuration. For public access to arbitrary shell commands, evaluate microVM-backed isolation or an equivalent stronger boundary. Docker exam tasks must never require exposing the host Docker socket to a candidate.

## 5. Logical Module Architecture

```text
apps/
  web/
    authentication/
    dashboard/
    topic-selection/
    exam-briefing/
    exam-workspace/
    terminal-ui/
    results/
    admin/

  api/
    modules/
      identity/
      topics/
      exams/
      questions/
      attempts/
      timers/
      terminal-sessions/
      validation/
      scoring/
      results/
      audit/
      admin/

services/
  execution-orchestrator/
  sandbox-worker/
  validator-runtime/

packages/
  shared-contracts/
  exam-types/
  validation-schemas/
  logger/
  test-fixtures/
```

This is a suggested logical structure, not a requirement to create every package on day one. Keep modules in one repository if that makes development easier, but do not collapse the security boundary between the API and command execution.

### Module responsibilities

| Module | Responsibility |
|---|---|
| Identity | Resolve authenticated user and role |
| Topics | Return enabled exam topics |
| Exams | Publish and retrieve exam metadata |
| Questions | Serve question content and rubric metadata permitted to candidates |
| Attempts | Create, resume, submit, and finalize attempts |
| Timers | Calculate deadlines and reject late actions |
| Terminal sessions | Authorize, connect, disconnect, and expire terminal access |
| Execution orchestrator | Provision and terminate sandboxes |
| Validator | Check resulting environment state against approved rules |
| Scoring | Apply mark limits and partial-credit rules |
| Results | Return candidate-visible scores and permitted feedback |
| Admin | Manage exams, questions, publication, and attempt review |
| Audit | Record significant security and lifecycle events |

## 6. Core Runtime Flows

### 6.1 Start an exam

1. Candidate authenticates and requests the exam briefing.
2. API confirms that the exam is published and available.
3. Candidate confirms `Begin Exam`.
4. API creates an attempt in a database transaction.
5. API records `started_at` and `exam_deadline_at`.
6. API activates the first question and records its deadline.
7. Execution orchestrator provisions an approved sandbox.
8. API returns attempt metadata and authoritative deadlines.
9. Browser renders the question and connects to the authorized terminal session.

The API must prevent multiple simultaneous attempts if the exam policy allows only one active attempt per candidate.

### 6.2 Execute a terminal command

1. Browser sends terminal input through an authenticated WebSocket.
2. Terminal gateway verifies the session token and attempt status.
3. The server checks the effective deadline and terminal-session permissions.
4. Input is forwarded only to the assigned sandbox process.
5. Output is streamed back to the browser.
6. Rate limits, message limits, process limits, and execution limits remain active.
7. The client cannot choose an arbitrary host command process, container ID, filesystem path, or worker.

### 6.3 Check an answer

1. Browser requests validation for the active question.
2. API verifies user ownership, attempt status, and both deadlines.
3. Validator receives the relevant question's trusted rubric and a restricted view of sandbox state.
4. Each subquestion is evaluated.
5. Scoring applies configured marks and partial-credit policy.
6. A database transaction stores validation events and the awarded score.
7. API returns the result allowed by the exam's feedback policy.
8. Repeated requests are handled idempotently so marks cannot be duplicated.

### 6.4 Advance to the next question

1. API verifies the current attempt and navigation policy.
2. Current question is submitted or skipped according to configured rules.
3. API records the transition and locks the previous question when required.
4. The next question's deadline is calculated on the server.
5. The sandbox is retained or replaced according to the exam's isolation policy.
6. The client receives the new question and deadline.

### 6.5 Finish or expire an exam

- Early submission requires explicit confirmation.
- Overall deadline expiry finalizes the attempt even if a question has time remaining.
- The server locks the attempt and persists final marks exactly once.
- Terminal access is revoked and sandbox cleanup is scheduled.
- The result API exposes only permitted information.

## 7. Timer and Concurrency Architecture

Store deadlines as server-generated timestamps, preferably using UTC instants.

```text
effective_deadline =
  min(exam_deadline_at, active_question_deadline_at)
```

For every command, check-answer, navigation, and submit operation, the server checks the applicable deadlines and attempt state. The browser countdown is only a display.

### State transitions

```text
Attempt:
CREATED -> IN_PROGRESS -> SUBMITTED
                      \-> EXPIRED
                      \-> CANCELLED (admin/system policy only)

Question attempt:
LOCKED -> ACTIVE -> SUBMITTED
                 \-> EXPIRED
                 \-> SKIPPED (if allowed)
```

Use conditional database updates or transactions to avoid conflicting transitions. For example, a timer-expiry worker and a candidate submission must not both finalize the same attempt differently.

Use an idempotency key or unique validation record so network retries cannot award marks more than once. Scheduled cleanup is a fallback; correctness must not depend on a background worker running at the exact deadline.

## 8. Terminal Session and Sandbox Architecture

### 8.1 Provisioning contract

The application API asks the orchestrator to create a sandbox using a server-approved environment template. The request contains only validated identifiers and resource-policy references; it must not accept arbitrary image names, host paths, privileged flags, or runtime options from the browser.

The orchestrator returns:
- An opaque sandbox identifier.
- A session endpoint or connection handle.
- A short-lived, attempt-scoped session credential.
- Expiry metadata.

The credential must not grant access to other attempts or arbitrary workers.

### 8.2 Isolation controls

Each sandbox must:
- Run with least privilege and a non-root user where feasible.
- Use CPU, memory, process, disk, and time limits.
- Restrict outbound network access by default.
- Have no production secrets or database credentials.
- Have no access to the host Docker socket.
- Avoid privileged containers and broad host mounts.
- Use a dedicated workspace per attempt or question.
- Be terminated after submission, expiry, or policy-defined inactivity.
- Emit controlled logs and metrics without leaking sensitive content.

For untrusted public shell access, assess a microVM or stronger sandbox runtime. Containers alone share the host kernel and must not be treated as a perfect isolation boundary.

### 8.3 Topic-specific environment templates

**Git & GitHub**
- Approved Linux image with Git and seeded repositories.
- Use local bare remotes or controlled remote fixtures for remote questions.
- Avoid requiring personal GitHub tokens in exam sandboxes.

**Docker**
- Dedicated hardened worker or VM.
- No access to the host daemon.
- Use approved images and constrained runtime features.
- Security-test nested container behavior before allowing Docker commands.

**Data Migration**
- Disposable database and seeded CSV/JSON fixtures.
- Source and destination schemas are isolated per attempt.
- Validators inspect destination rows, schema, constraints, and transformed values.

## 9. Data Architecture

PostgreSQL is the durable source of truth for identity references, exam configuration, attempts, deadlines, marks, and audit events.

Core entities:

```text
User 1---N ExamAttempt N---1 Exam
Exam 1---N Question
Question 1---N Subquestion
ExamAttempt 1---N QuestionAttempt
QuestionAttempt 1---N ValidationEvent
ExamAttempt 1---N TerminalSession
User 1---N AuditEvent
```

### Core tables

- `users`
- `topics`
- `exams`
- `questions`
- `subquestions`
- `exam_attempts`
- `question_attempts`
- `terminal_sessions`
- `validation_events`
- `audit_events`

### Integrity constraints

- Published exams in this format must total exactly 40 marks.
- Subquestion marks must sum to the parent question's marks.
- Scores must be between zero and the configured maximum.
- A question attempt must belong to the same exam attempt as its question.
- An attempt must belong to one user and one exam.
- Finalized attempts cannot be reopened through candidate APIs.
- Use foreign keys, unique constraints, and indexes for ownership checks, attempt status, ordering, and deadlines.

Keep scoring rubrics and validator identifiers on the server. Do not store arbitrary executable validator code submitted through the admin UI.

## 10. API and Communication Boundaries

### REST API

| Endpoint | Responsibility |
|---|---|
| `GET /api/me` | Current authenticated user |
| `GET /api/topics` | Available topics |
| `GET /api/exams?topic=...` | Published exams |
| `GET /api/exams/:examId/briefing` | Pre-exam instructions |
| `POST /api/exams/:examId/attempts` | Create attempt and deadlines |
| `GET /api/attempts/:attemptId` | Resume current attempt state |
| `POST /api/attempts/:attemptId/questions/:questionId/activate` | Navigate/activate a question |
| `POST /api/attempts/:attemptId/questions/:questionId/check` | Validate answer |
| `POST /api/attempts/:attemptId/questions/:questionId/submit` | Lock current question |
| `POST /api/attempts/:attemptId/submit` | Finalize attempt |
| `GET /api/attempts/:attemptId/result` | Candidate-visible result |
| `POST /api/attempts/:attemptId/terminal-session` | Request terminal session |

### WebSocket

Use WebSocket only for terminal input/output and connection lifecycle events. Authenticate the handshake, scope the token to one attempt and terminal session, limit message sizes and rates, and close expired sessions.

Never expose the orchestrator's internal API directly to the public browser.

## 11. Security Architecture

### Identity and authorization
- Enforce role and ownership checks on every relevant endpoint.
- Keep admin APIs separate by authorization policy.
- Use secure session management and TLS.
- Rate-limit sign-in, attempt creation, validation, and terminal-session creation.

### Sandbox protection
- Separate execution workers from the API and database networks.
- Deny access to production credentials and internal metadata endpoints.
- Apply least-privilege policies, quotas, process limits, and network controls.
- Patch sandbox images and runtime dependencies.
- Revoke terminal sessions at question/attempt expiry.
- Destroy sandboxes and remove temporary files after the retention period.

### Scoring integrity
- Calculate marks only on the server.
- Do not trust client-submitted score values or deadlines.
- Use immutable validation events and transactional score updates.
- Keep hidden answers and grading configuration out of public question responses.
- Audit administrative changes to exams and scoring rules.

## 12. Observability and Operations

Collect structured events and metrics for:
- Attempt starts, submissions, and expiries.
- Question activation and deadline enforcement.
- Sandbox provisioning latency and failures.
- Active sandboxes and resource usage.
- Terminal disconnects and reconnects.
- Validation outcomes and scoring failures.
- Orphaned sandboxes and cleanup failures.
- Authorization denials and suspicious request patterns.

Avoid logging secrets, session tokens, or unnecessary terminal contents. Define log retention and access permissions. Back up PostgreSQL and test recovery procedures.

## 13. Deployment Architecture

```text
                         Public Internet
                               |
                               v
                       +---------------+
                       | TLS Proxy     |
                       +-------+-------+
                               |
                     +---------+----------+
                     |                    |
                     v                    v
              +-------------+      +-------------+
              | Web Client  |      | API Service |
              | Static app  |      | Private API |
              +-------------+      +------+------+
                                          |
                        +-----------------+----------------+
                        |                                  |
                        v                                  v
                 +-------------+                   +----------------+
                 | PostgreSQL  |                   | Orchestrator   |
                 | Private DB  |                   | Private network|
                 +-------------+                   +-------+--------+
                                                           |
                                                           v
                                                  +------------------+
                                                  | Isolated workers |
                                                  | Disposable VMs / |
                                                  | sandbox runtime  |
                                                  +------------------+
```

Keep the database and orchestrator on private networks. Execution workers should not be able to initiate connections to PostgreSQL or other candidate sandboxes. The API should be the policy enforcement point for candidate access.

## 14. Scalability Strategy

Start with a single API deployment and a small worker pool. Scale the execution workers independently from the API because terminal sessions consume CPU and memory for their duration.

Potential later improvements:
- Queue sandbox provisioning when capacity is limited.
- Maintain a small pool of pre-warmed, clean environments.
- Apply per-user and global concurrency limits.
- Add worker health checks and automatic replacement.
- Separate validator workers from interactive terminal workers.
- Partition or archive old audit/terminal events when volume warrants it.

Never reuse a dirty sandbox between candidates. A pre-warmed environment must be reset to a verified clean state before assignment.

## 15. Failure Handling

| Failure | Architectural response |
|---|---|
| API restart | Restore attempt state and deadlines from PostgreSQL |
| Browser refresh | Re-fetch current attempt; do not reset timers |
| WebSocket disconnect | Reauthorize and reconnect to the same permitted session if it remains active |
| Sandbox crash | Record incident; recover from a known checkpoint only if safe |
| Overall deadline reached | Finalize attempt and revoke terminal access |
| Duplicate submission | Idempotent response; no duplicate score |
| Worker unavailable | Queue or reject provisioning with a clear retryable error |
| Database unavailable | Fail closed for score/timer-changing operations |
| Unauthorized attempt access | Deny request and record security event |
| Orphaned sandbox | Cleanup controller detects and terminates it |

## 16. Architecture Decision Records

### ADR-001: Modular monolith for application logic
**Decision:** Use one well-structured Fastify application initially.  
**Reason:** Easier to develop, test, and deploy than many microservices.  
**Constraint:** Execution remains a separate trust boundary.

### ADR-002: Server-authoritative timers
**Decision:** Persist overall and question deadlines on the server.  
**Reason:** Browser timers can be manipulated or reset.

### ADR-003: State-based grading
**Decision:** Validate resulting environment state, not exact command strings.  
**Reason:** Equivalent valid command sequences should receive fair credit.

### ADR-004: Disposable execution environments
**Decision:** Run commands in isolated, short-lived environments.  
**Reason:** Candidates execute untrusted commands and must not affect the application host or each other.

### ADR-005: PostgreSQL as durable source of truth
**Decision:** Store exam and scoring state in PostgreSQL.  
**Reason:** Relational constraints and transactions support reliable attempt lifecycle and scoring.

### ADR-006: Separate Docker assessment runtime
**Decision:** Do not expose the host Docker socket. Use a dedicated isolated runtime for Docker tasks.  
**Reason:** Access to the host daemon can grant effective control over the host.

## 17. Delivery Milestones

1. **Foundation:** Identity, topics, exam schema, dashboard.
2. **Exam lifecycle:** Attempts, dual timers, navigation, finalization.
3. **Terminal infrastructure:** Orchestrator, isolated sandbox, xterm.js, authenticated WebSocket.
4. **First vertical slice:** One Git & GitHub exam with real command execution and state-based grading.
5. **Scoring and results:** Partial credit, audit events, result policy.
6. **Additional environments:** Docker and Data Migration.
7. **Production readiness:** Admin tools, security review, monitoring, backups, load testing.

A vertical slice is complete only when a candidate can start an exam, execute commands in an isolated sandbox, receive server-computed marks, and see a correct final result.

## 18. Architecture Acceptance Criteria

The architecture is implemented correctly when:

- Candidate commands never execute in the API process or on the application host.
- Each terminal session is authorized for exactly the intended attempt and environment.
- Both question and overall deadlines are enforced by the server.
- Candidate-controlled input cannot change scoring rules or awarded marks.
- Sandboxes cannot access production secrets, PostgreSQL, other candidates' files, or the host Docker socket.
- Attempt state and scores survive API restarts.
- Duplicate requests do not duplicate marks or finalization.
- Expired attempts cannot continue using terminal sessions.
- Sandbox resources are cleaned up after completion or expiry.
- Automated tests cover authorization, timer races, sandbox policy, scoring, and recovery.

---

## 19. Summary

The platform uses a modular application API backed by PostgreSQL and a separate execution plane for untrusted terminal commands. React and xterm.js provide the browser experience; Fastify manages exam lifecycle, access control, timers, and results; the orchestrator provisions isolated environments; and trusted validators and scoring logic assess resulting state. The architecture supports Git & GitHub, Docker, and Data Migration exams while prioritizing security, reliable timing, fair grading, and future extensibility.
