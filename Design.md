# Terminal-Based Exam Platform — Design Document

**Document version:** 1.0  
**Status:** Proposed design  
**Related document:** `Terminal_Based_Exam_Platform_PRD.md`  
**Language:** English

---

## 1. Purpose

This document translates the product requirements into an implementable design for a browser-based, terminal-first exam platform.

Candidates sign in, select one of three topics—Git & GitHub, Docker, or Data Migration—and complete a practical exam worth 40 marks. Each question appears above a real terminal running in an isolated sandbox. Each question has its own timer, and the exam also has an overall timer.

The server is authoritative for authentication, exam state, timers, terminal-session permissions, validation, and scoring.

## 2. Design Principles

1. **Security by isolation:** Never execute candidate commands on the application host.
2. **Server authority:** The browser displays state but cannot determine deadlines, marks, or permissions.
3. **State-based grading:** Validate the resulting environment state rather than requiring one exact command sequence.
4. **Recoverability:** Refreshes and brief network interruptions must not reset timers or lose persisted progress.
5. **Clear separation of concerns:** Exam management, terminal execution, validation, scoring, and identity are separate modules.
6. **Extensibility:** Add topics and terminal environment templates without redesigning the core exam engine.
7. **Auditability:** Record important exam and validation events while applying appropriate log-retention and privacy rules.

## 3. Recommended Technology Stack

| Layer | Recommendation | Responsibility |
|---|---|---|
| Web client | React + TypeScript + Vite | Candidate and admin interfaces |
| Styling | Tailwind CSS | Responsive UI and design system |
| Terminal UI | xterm.js | Terminal display, keyboard input, output rendering |
| API server | Node.js + TypeScript + Fastify | Authentication integration, exam APIs, orchestration |
| Request validation | TypeBox or Zod | Validate request and response data |
| Database | PostgreSQL | Users, topics, exams, attempts, marks, audit events |
| Database access | Drizzle ORM | Typed schema and database queries |
| Terminal transport | WebSocket | Interactive terminal input/output |
| Execution runtime | Disposable Linux containers or microVM-backed workers | Isolated command execution |
| Reverse proxy | Caddy or Nginx | TLS termination and routing |
| Local development | Docker Compose | Run web, API, database, and local execution worker |
| Testing | Vitest + API integration tests + Playwright | Unit, integration, and end-to-end tests |

### Stack notes

- Use a terminal UI library such as xterm.js in the browser, but do not connect it directly to the application host's shell.
- The API should authorize the user and issue a short-lived, attempt-scoped terminal session.
- A separate execution service should provision and control sandboxes.
- PostgreSQL stores durable exam state. Terminal filesystems should be treated as disposable and recreated or restored according to the exam policy.
- The first release should use one well-defined Linux environment image per topic rather than allowing administrators to upload arbitrary images.

## 4. System Architecture

```text
+-------------------------------+
| Browser                       |
| React + TypeScript            |
| Dashboard / Exam UI / xterm.js|
+---------------+---------------+
                |
                | HTTPS: REST API
                | WSS: terminal stream
                v
+-------------------------------+
| API Server                    |
| Fastify + TypeScript          |
| Auth / Exams / Attempts       |
| Timers / Authorization        |
+------+------------------+-----+
       |                  |
       | SQL              | Provision / stop / inspect
       v                  v
+---------------+   +---------------------------+
| PostgreSQL    |   | Execution Orchestrator    |
| Exam data     |   | Sandbox lifecycle         |
| Timers/scores |   | Resource and access rules |
+---------------+   +-------------+-------------+
                                  |
                                  v
                    +---------------------------+
                    | Disposable Sandbox        |
                    | Linux + topic tools       |
                    | Git / Docker tools / SQL  |
                    | No production credentials |
                    +-------------+-------------+
                                  |
                                  | State snapshot / result
                                  v
                    +---------------------------+
                    | Validator + Scoring      |
                    | Server-side only         |
                    +---------------------------+
```

### Trust boundaries

- **Browser:** Untrusted. It may be modified by a candidate.
- **API:** Enforces identity, permissions, attempt state, and time limits.
- **Execution orchestrator:** Accepts only authorized, scoped operations from the API.
- **Sandbox:** Treat as hostile. It must not access production credentials, other candidates' files, or unrestricted host resources.
- **Validator and scoring service:** Uses trusted server-side rules and sandbox inspection. Candidate commands must not be able to alter scoring rules or marks.

## 5. Application Navigation and Screens

### 5.1 Public and authentication screens

- Sign in
- Registration, if enabled
- Password reset or identity-provider recovery
- Access-denied and session-expired states

### 5.2 Candidate screens

1. **Dashboard**
   - Welcome message
   - Primary `Start Contest` action
   - Available topics
   - Previous attempts and results, if enabled

2. **Topic selection**
   - Git & GitHub
   - Docker
   - Data Migration
   - Availability, difficulty, marks, and duration

3. **Exam briefing**
   - Exam title and topic
   - Total marks: 40
   - Overall time limit
   - Per-question timer policy
   - Navigation rules
   - Terminal restrictions
   - `Begin Exam` confirmation

4. **Exam workspace**
   - Question navigation and progress
   - Overall timer
   - Current question timer
   - Question statement and subquestions
   - Marks per task
   - Terminal
   - `Check Answer`, `Reset Terminal` when permitted, `Previous`, `Next`, and `Submit Exam`

5. **Results**
   - Score out of 40
   - Percentage
   - Question-wise marks
   - Completion summary
   - Feedback according to the review policy

### 5.3 Administrator screens

For the initial design, include an admin capability in the architecture even if the UI ships later:
- Exam list and status
- Create/edit exam
- Question and subquestion editor
- Timer and marks configuration
- Environment-template selection
- Preview question
- Publish/archive
- Attempt and scoring review

## 6. Exam Workspace Layout

Recommended desktop composition:

```text
+------------------------------------------------------------------+
| Git & GitHub | Question 2 / 6 | Overall: 21:40 | Question: 03:10 |
+------------------------------------------------------------------+
| Question 2 — Create and switch to a feature branch (4 marks)      |
|                                                                  |
| Starting state: a repository exists on branch main.               |
| A. Create branch feature/login.                         (2 marks) |
| B. Switch to feature/login.                            (2 marks) |
+------------------------------------------------------------------+
| Terminal: ~/workspace                                            |
| user@exam:~/workspace$ git branch feature/login                  |
| user@exam:~/workspace$ git switch feature/login                  |
| user@exam:~/workspace$ _                                         |
+------------------------------------------------------------------+
| [Check Answer] [Reset Terminal] [Previous] [Next] [Submit Exam]   |
+------------------------------------------------------------------+
```

### Layout behavior

- Keep the question visible while the terminal is used.
- Display both timers persistently. Do not rely on color alone to communicate urgency.
- Show an explicit warning near timer expiry.
- Show a connection indicator if the terminal stream disconnects.
- On narrow screens, stack the question and terminal vertically.
- Avoid hiding important controls behind terminal output.
- Warn before destructive terminal resets.
- Confirm before final exam submission.

## 7. Timer and Attempt State Design

### 7.1 Two independent deadlines

Each attempt has:
- `exam_deadline_at`: overall deadline
- `question_deadline_at`: deadline for the active question

The effective deadline for a command submission is the earlier of the two.

```text
effective_deadline =
    min(exam_deadline_at, question_deadline_at)
```

If the overall exam deadline expires first, the entire attempt is finalized even if time remains on the current question.

### 7.2 Timer lifecycle

1. The candidate presses `Begin Exam`.
2. The API creates the attempt and records the overall start time and deadline.
3. The API activates the first question and records its start time and deadline.
4. The client receives the authoritative deadlines and renders countdowns.
5. Each command, validation request, and navigation request is checked against the server clock.
6. When a question deadline expires, the question is locked and its final score is recorded.
7. When the overall deadline expires, the attempt is finalized and all remaining questions are locked.
8. A page refresh fetches the existing attempt state; it never creates extra time.

### 7.3 Recommended navigation policy

For a predictable first release:
- A candidate may move forward after checking/submitting a question, or use `Next` if the product policy allows unanswered questions to be skipped.
- Leaving a question does not pause its timer.
- Submitted or expired questions cannot be edited or reopened during the attempt.
- Returning to previous questions is disabled by default. It can be enabled in exam configuration later.
- An unanswered question receives zero marks.
- The overall deadline always overrides per-question time remaining.

### 7.4 Race conditions

The server must handle a command, validation, question transition, and timer expiry arriving at nearly the same time. Use a transaction or equivalent state transition so only one valid outcome is committed. Late submissions must be rejected according to server timestamps.

## 8. Real Terminal and Sandbox Design

### 8.1 Session flow

```text
Candidate clicks Begin Exam
          |
          v
API verifies user and attempt
          |
          v
Orchestrator creates a disposable sandbox
          |
          v
Sandbox is initialized from an approved image
          |
          v
API issues a short-lived terminal session token
          |
          v
Browser connects to terminal WebSocket
          |
          v
Commands run only inside that sandbox
          |
          v
Validator inspects state through a restricted channel
          |
          v
Sandbox is stopped and destroyed at attempt end/expiry
```

### 8.2 Sandbox requirements

Every sandbox must have:
- A non-root default user.
- CPU, memory, disk, process-count, and execution-time limits.
- A read-only base image where practical.
- A per-attempt writable workspace.
- No access to the Docker host socket.
- No privileged mode.
- No host filesystem mounts except explicitly controlled temporary storage.
- Restricted or disabled outbound networking by default.
- No production database credentials, API keys, or application secrets.
- A short-lived session identity bound to one candidate and one attempt.
- Cleanup on expiry, submission, disconnection timeout, or administrative termination.
- Logs and resource metrics that do not expose sensitive data.

**Important:** Containers share the host kernel. If the threat model includes untrusted public users executing arbitrary shell commands, consider a hardened sandbox runtime or microVM-based isolation, plus a separate worker pool. Do not treat an ordinary container alone as a complete security boundary.

### 8.3 Docker exam limitation

Candidates must be able to answer Docker questions, but they must not receive unrestricted control over the host's Docker daemon. Options include:
- A dedicated isolated worker/VM for Docker tasks.
- A rootless, restricted nested runtime where supported and tested.
- A curated Docker command environment for tasks that do not require launching privileged containers.

The chosen approach must be validated with security testing before public launch.

### 8.4 Topic environment images

**Git & GitHub**
- Linux shell, Git, pre-seeded local repositories and branches.
- Use local bare remotes or a controlled mock remote for remote-operation questions.
- Do not expose personal GitHub credentials or require public network access by default.

**Docker**
- Dedicated isolated environment with approved images and a restricted runtime.
- Preloaded sample images/services where possible.
- Prevent host socket access and privileged container creation.

**Data Migration**
- Sample CSV/JSON files and a disposable database.
- Seeded source and destination schemas.
- Controlled migration tools and fixtures.
- Validators inspect row counts, values, schemas, constraints, and transformation outcomes.

## 9. Terminal Transport and API Design

### 9.1 REST API outline

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/me` | Return current user |
| `GET` | `/api/topics` | List available topics |
| `GET` | `/api/exams?topic=...` | List published exams for a topic |
| `GET` | `/api/exams/:examId/briefing` | Retrieve exam instructions before starting |
| `POST` | `/api/exams/:examId/attempts` | Start an attempt and initialize timers |
| `GET` | `/api/attempts/:attemptId` | Retrieve current attempt state |
| `POST` | `/api/attempts/:attemptId/questions/:questionId/activate` | Activate a question if permitted |
| `POST` | `/api/attempts/:attemptId/questions/:questionId/check` | Validate current sandbox state and record marks |
| `POST` | `/api/attempts/:attemptId/questions/:questionId/submit` | Lock a question |
| `POST` | `/api/attempts/:attemptId/submit` | Submit/finalize the entire exam |
| `GET` | `/api/attempts/:attemptId/result` | Retrieve permitted result information |
| `POST` | `/api/attempts/:attemptId/terminal-session` | Request an authorized terminal session |

Every endpoint must verify that the authenticated user owns the attempt or has an authorized administrative role. Endpoint names may change during implementation, but these responsibilities should remain.

### 9.2 WebSocket terminal channel

Use a WebSocket for interactive terminal input/output. The server should:
- Authenticate the handshake.
- Verify a short-lived token scoped to one terminal session and attempt.
- Validate that the attempt and active question are still eligible for terminal use.
- Enforce message-size and rate limits.
- Relay input only to the assigned sandbox process.
- Stream output without allowing the client to specify an arbitrary host process or path.
- Close the connection when the attempt expires or the sandbox is terminated.
- Re-authorize reconnects rather than trusting a previous connection.

The WebSocket must never expose a general-purpose host shell.

## 10. Database Design

Use PostgreSQL for durable state. Suggested tables:

### `users`
- `id`
- `display_name`
- `email`
- `identity_provider_id`
- `role`
- `created_at`

### `topics`
- `id`
- `name`
- `slug`
- `description`
- `is_active`

### `exams`
- `id`
- `topic_id`
- `title`
- `total_marks` — must equal 40 for the specified exam format
- `overall_duration_seconds`
- `navigation_policy`
- `review_policy`
- `status`
- `published_at`

### `questions`
- `id`
- `exam_id`
- `title`
- `prompt`
- `question_order`
- `marks`
- `time_limit_seconds`
- `environment_template_id`
- `state_isolation_policy`

### `subquestions`
- `id`
- `question_id`
- `prompt`
- `marks`
- `validator_key`
- `validator_config`
- `partial_credit_policy`

Validator configuration must be validated and versioned. Do not allow arbitrary administrator-supplied executable code to run in the validator service.

### `exam_attempts`
- `id`
- `user_id`
- `exam_id`
- `status`
- `started_at`
- `deadline_at`
- `submitted_at`
- `total_score`

### `question_attempts`
- `id`
- `exam_attempt_id`
- `question_id`
- `status`
- `started_at`
- `deadline_at`
- `submitted_at`
- `score`

### `terminal_sessions`
- `id`
- `exam_attempt_id`
- `question_attempt_id`
- `sandbox_id`
- `status`
- `created_at`
- `expires_at`
- `terminated_at`

### `validation_events`
- `id`
- `question_attempt_id`
- `subquestion_id`
- `validator_version`
- `result`
- `awarded_marks`
- `details_json`
- `created_at`

### `audit_events`
- `id`
- `actor_user_id`
- `attempt_id`
- `event_type`
- `metadata_json`
- `created_at`

### Data integrity rules

- The sum of question marks must equal 40 for a published exam.
- Subquestion marks must sum to their parent question's marks.
- Scores must never exceed configured maximum marks.
- Each attempt belongs to one user and one exam.
- A finalized attempt cannot be reopened through ordinary candidate APIs.
- Use database transactions and unique/idempotency keys to avoid duplicate score awards.
- Index attempt ownership, attempt status, question order, and deadline fields used by common queries.

## 11. Validation and Scoring Design

### 11.1 Validation flow

1. Candidate selects `Check Answer`.
2. API authenticates the candidate and loads the attempt.
3. API checks attempt status and both deadlines.
4. Validator receives a read-only view or restricted inspection request for the relevant sandbox.
5. Each subquestion validator checks the required state.
6. Scoring service calculates marks according to the configured rubric.
7. A transaction records validation results and the question score.
8. API returns the earned marks and feedback allowed by the exam policy.

### 11.2 Example

Question: Create a branch named `feature/login` and switch to it.

| Subquestion | Marks | State-based validation |
|---|---:|---|
| Create the branch | 2 | Git reports that `feature/login` exists |
| Switch to the branch | 2 | Current branch is `feature/login` |
| **Total** | **4** | Maximum award: 4 |

The validator should not depend on a specific command string when multiple legitimate commands produce the same correct state.

### 11.3 Scoring protections

- The client never submits a trusted numeric score.
- The validator returns structured outcomes, not arbitrary score values supplied by the candidate.
- Scoring rules and marks are stored server-side.
- Repeated checks must not duplicate marks.
- Partial credit must be deterministic and documented.
- Store validator version and relevant evidence for later review.
- Hide solutions until the configured review window permits disclosure.

## 12. State Management and Recovery

### Durable state

Persist:
- Attempt creation and status.
- Overall and question deadlines.
- Active question.
- Question submission and expiry.
- Validation results and scores.
- Terminal lifecycle state.
- Important audit events.

### Terminal filesystem state

The terminal filesystem is not the source of truth for exam timing or marks. Its lifecycle depends on the exam's isolation policy:
- **Fresh per question:** Start each question from a known snapshot.
- **Shared within an attempt:** Preserve workspace changes between questions but isolate them from all other attempts.

Recommended default: use a fresh environment per question unless a multi-step question explicitly requires shared state. If shared state is needed, all questions in that attempt must remain in the same isolated workspace and the exam author must understand the dependency.

If a sandbox is lost, do not silently grant extra time. Recreate it from a checkpoint only when the platform can restore the expected state safely; otherwise show a recoverable error and record the incident for review.

## 13. Security and Privacy

### Authentication and authorization
- Use a reputable identity provider or secure authentication implementation.
- Require authorization on every attempt, terminal, result, and admin endpoint.
- Never rely on hidden UI elements as access control.
- Use secure cookies or another well-reviewed session mechanism.
- Protect against CSRF where cookie-based authentication requires it.

### Execution security
- Never run candidate commands in the API process.
- Never mount production secrets into a sandbox.
- Avoid privileged containers and host Docker socket access.
- Apply strict resource, process, storage, and network policies.
- Keep the orchestrator and workers on private networks.
- Validate all data crossing the sandbox boundary.
- Regularly patch base images and dependencies.
- Terminate and clean up expired environments.

### Data protection
- Define retention periods for command logs and audit events.
- Avoid logging passwords, tokens, or sensitive file contents.
- Restrict access to terminal transcripts.
- Tell candidates what activity is recorded.
- Use least-privilege database credentials and encrypted connections.

## 14. Error and Edge-Case Behavior

| Situation | Expected behavior |
|---|---|
| Browser refresh | Restore the same attempt and server deadlines |
| Temporary network loss | Reconnect and reauthorize the terminal session |
| Question timer expires | Lock the question and preserve recorded marks |
| Overall timer expires | Finalize the attempt and lock all questions |
| Duplicate check request | Return the existing result or safely revalidate without duplicate marks |
| Sandbox crashes | Record the event, attempt safe recovery, and do not silently extend deadlines |
| Candidate accesses another attempt ID | Return an authorization error |
| Terminal command exceeds execution limit | Stop that process and return a controlled error |
| Candidate submits after deadline | Reject the submission according to server time |
| Exam configuration totals other than 40 | Prevent publication |
| Terminal WebSocket token expires | Reject or require a newly authorized session |

## 15. Testing Strategy

### Unit tests
- Marks and subquestion validation.
- Timer deadline calculations.
- Attempt state transitions.
- Navigation policy.
- Validator result-to-score mapping.
- Authorization policies.

### Integration tests
- Database transaction behavior.
- Start attempt and activate question.
- Terminal session creation and teardown.
- Validator inspection of sandbox state.
- Duplicate request idempotency.
- Overall deadline overriding question deadline.

### End-to-end tests
- Sign in → Start Contest → select topic → begin exam.
- Execute commands in the terminal.
- Check answer and observe marks.
- Move between questions.
- Refresh without resetting timers.
- Submit early and view results.
- Automatic finalization at overall expiry.

### Security tests
- Cross-user attempt access.
- Sandbox-to-host escape attempts.
- Unauthorized network access.
- Resource exhaustion and runaway processes.
- Host socket and filesystem access.
- WebSocket token reuse across attempts.
- Attempts to alter marks or deadlines from the browser.
- Malicious filenames and terminal output rendering.

## 16. Deployment Topology

```text
Internet
   |
   v
TLS Reverse Proxy
   |
   +---------------------> Web Frontend
   |
   v
API Service (private application network)
   |
   +---------------------> PostgreSQL (private database network)
   |
   +---------------------> Execution Orchestrator
                                  |
                                  v
                         Isolated Worker Pool
                                  |
                                  v
                         Disposable Sandboxes
```

Production deployment requirements:
- Separate public-facing web/API services from execution workers.
- Keep PostgreSQL private and inaccessible from candidate sandboxes.
- Use a secrets manager for deployment secrets.
- Apply TLS to public endpoints and secure internal communication as appropriate.
- Monitor active sandboxes, execution failures, resource usage, and timer-finalization errors.
- Provide cleanup jobs for orphaned sandboxes.
- Back up durable database data and test restore procedures.
- Scale execution workers separately from the API.

## 17. Implementation Phases

### Phase 1 — Foundation
- Repository structure and coding standards.
- Authentication and user roles.
- Topic list and candidate dashboard.
- PostgreSQL schema and migrations.
- Exam configuration and 40-mark validation.

### Phase 2 — Exam engine
- Attempt creation.
- Overall and per-question deadlines.
- Question navigation.
- Autosave and refresh recovery.
- Submission and results.

### Phase 3 — Secure terminal MVP
- Execution orchestrator.
- Approved sandbox image.
- xterm.js and authenticated WebSocket.
- Resource limits and cleanup.
- One complete Git & GitHub exam.

### Phase 4 — Grading
- State-based validators.
- Subquestion scoring and partial credit.
- Idempotent validation and audit records.
- Candidate feedback and result policy.

### Phase 5 — Additional topics
- Docker environment and security review.
- Data Migration environment and fixtures.
- Additional question sets and test coverage.

### Phase 6 — Administration and production readiness
- Admin exam editor.
- Attempt review and reporting.
- Security and load testing.
- Monitoring, backups, and operational runbooks.

## 18. Definition of Done

The first production-ready slice is complete when:
- A candidate can sign in and start a 40-mark Git & GitHub exam.
- Both timers are displayed and enforced by the server.
- The candidate can execute real commands in a disposable isolated sandbox.
- The sandbox cannot access production secrets, unrelated attempts, or the host Docker socket.
- The validator grades resulting state and supports subquestion marks.
- Refresh and reconnect do not reset the attempt or timers.
- Expired attempts are finalized exactly once.
- Results are calculated and persisted server-side.
- Automated tests cover key functional, timing, authorization, and sandbox controls.
- Sandbox resources are cleaned up after completion and expiry.

---

## 19. Open Implementation Decisions

The architecture recommends defaults, but the following details must be finalized during implementation:

1. Identity provider and account-registration policy.
2. Cloud or hosting environment and supported sandbox runtime.
3. Whether Docker questions require a dedicated VM/microVM worker.
4. Exact overall exam duration and per-question time limits for each exam.
5. Whether previous questions can be revisited.
6. Whether workspace state is fresh per question or shared for selected multi-step tasks.
7. Retake limits and result-review timing.
8. Whether command transcripts are stored, for how long, and who can view them.

## 20. Summary

The design separates the browser, API, database, execution orchestrator, sandbox, validator, and scoring service. It uses a real terminal inside an isolated execution environment, with server-enforced per-question and overall timers. PostgreSQL stores durable exam state, and scoring is performed only by trusted server-side components. The architecture supports Git & GitHub, Docker, and Data Migration while prioritizing security, predictable exam behavior, and future expansion.
