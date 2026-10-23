# Terminal-Based Exam Platform --- Product Requirements Document

**Document version:** 1.1\
**Status:** Initial product specification\
**Purpose:** Define the product scope, user experience, exam rules,
isolated real-terminal execution, scoring, and technical requirements for a
browser-based terminal exam platform.

------------------------------------------------------------------------

## 1. Product Overview

Build a web-based examination platform where users sign in, choose a
technical topic, and complete a timed, 40-mark exam by entering commands
into an interactive terminal embedded beneath each question.

The platform should assess practical command-line skills rather than
only theoretical knowledge. Users must perform the requested operations
in the terminal, and the platform should validate the resulting state
before awarding marks.

### Initial exam topics

1.  **Git & GitHub**
2.  **Docker**
3.  **Data Migration**
The architecture should make it straightforward to add more topics and
question sets later.

Git & GitHub and Docker each publish **15 selectable test sets**. Each set
contains **20 terminal-command questions**, is worth 40 marks, and runs for
40 minutes. Questions are graded 2 marks each and span easy, medium, and high
difficulty (5, 9, and 6 questions respectively). Docker exercises use a
restricted command simulator; they practice Docker CLI workflows without
creating real images or containers or exposing the host Docker daemon.

## 2. Product Goals

-   Provide a simple, secure sign-in experience.
-   Let users start a contest and select an available exam topic.
-   Present practical, terminal-based questions with clear instructions.
-   Give each question its own time limit.
-   Support questions containing multiple subquestions.
-   Award a total of 40 marks per exam.
-   Validate terminal operations and award marks consistently.
-   Let users navigate between questions while following defined timer
    rules.
-   Save answers and progress so accidental refreshes do not
    unnecessarily destroy an attempt.
-   Show a result summary after submission or when the exam expires.

## 3. User Roles

### 3.1 Candidate

A candidate can: - Register or sign in. - View available topics. - Start
an exam. - Read questions and subquestions. - Enter commands in the
terminal. - Move between questions. - Submit an exam. - View the result
and question-wise feedback, according to the platform's review policy. -
View previous attempts, if attempt history is enabled.

### 3.2 Administrator / Examiner

An administrator should be able to: - Create, edit, publish, and archive
exams. - Add questions and subquestions. - Set question instructions,
terminal starting state, time limits, marks, and validation rules. -
Configure which topics and exams are available. - Review attempts,
scores, and command logs where permitted. - Inspect failed validations
and resolve disputed results. - Manage users and exam availability.

Administrator functionality may be delivered after the first
candidate-facing MVP, but the data model should not make it difficult to
add.

## 4. Main User Journey

1.  The user opens the platform.
2.  The user registers or signs in.
3.  The user reaches the dashboard.
4.  The dashboard displays a prominent **Start Contest** button.
5.  The user clicks **Start Contest**.
6.  The topic-selection screen displays:
    -   Git & GitHub
    -   Docker
    -   Data Migration
7.  The user selects a topic.
8.  The platform displays an exam briefing, including:
    -   Total marks: 40
    -   Number of questions
    -   Time limits
    -   Rules for navigation
    -   Whether returning to previous questions is permitted
    -   Whether terminal commands persist between questions
9.  The user clicks **Begin Exam**.
10. The platform creates an exam attempt and starts the first question's
    timer.
11. The question appears above an interactive terminal.
12. The candidate executes commands to complete the task.
13. The candidate clicks **Check Answer** or **Submit Question**.
14. The platform validates the terminal state and records the score.
15. The candidate clicks **Next Question** to continue.
16. When all questions are complete, the candidate submits the exam or
    the exam ends automatically.
17. The result screen displays the score out of 40, question-wise marks,
    completion status, and permitted feedback.

## 5. Core Screens

### 5.1 Authentication

Include: - Sign-in page. - Registration page, if self-registration is
enabled. - Password reset or the chosen authentication provider's
equivalent. - Clear validation and error messages. - Secure session
handling.

### 5.2 Candidate Dashboard

Display: - Welcome message. - **Start Contest** button. - Available
topics or a link to topic selection. - Previous attempts and results, if
enabled. - Any published exam instructions.

### 5.3 Topic Selection

Show a separate card for each topic: - **Git & GitHub** --- version
control, branching, commits, remotes, and collaboration. - **Docker**
--- images, containers, volumes, networks, and container operations. -
**Data Migration** --- importing, exporting, transforming, validating,
and moving data between systems.

Each card should show availability and, when configured, the exam
duration, total marks, and difficulty.

### 5.4 Exam Briefing

Before starting, show: - Topic and exam name. - Total marks: 40. -
Question count. - Per-question time limits. - Navigation and submission
rules. - Terminal environment rules. - A clear **Begin Exam** button.

Starting the exam should require an explicit action. The server must
record the attempt and timer start time.

### 5.5 Exam Workspace

Use a focused, responsive layout.

**Recommended desktop layout:**

``` text
+------------------------------------------------------------------+
| Topic: Git & GitHub     Question 2 of 6     Total: 40 marks       |
| Question timer: 04:35 remaining             Exam progress: 33%    |
+------------------------------------------------------------------+
| QUESTION                                                         |
| Create a branch named feature/login and switch to it.             |
|                                                                  |
| Subquestion A (2 marks): Create the branch.                       |
| Subquestion B (2 marks): Switch to the branch.                    |
+------------------------------------------------------------------+
| TERMINAL                                                         |
| user@exam:~/workspace$ git branch feature/login                   |
| user@exam:~/workspace$ git switch feature/login                   |
| user@exam:~/workspace$                                           |
+------------------------------------------------------------------+
| [Reset Terminal] [Check Answer] [Previous] [Next Question]        |
+------------------------------------------------------------------+
```

The exact UI can differ, but the essential relationship must remain: the
question is clearly visible above the terminal in which the candidate
performs the task.

The workspace should include: - Topic and question number. - Question
timer with clear visual emphasis. - Overall exam progress. - Question
statement and any subquestions. - Marks available for each question and
subquestion. - Terminal with command input and output. - Check Answer /
Submit Question control. - Previous and Next Question controls,
according to exam policy. - A submission or completion indicator. -
Clear messages for invalid commands, failed checks, and time expiry.

On small screens, stack the question and terminal vertically. Do not let
navigation controls obscure terminal output.

## 6. Question and Subquestion Design

Questions should assess practical operations. A question may contain one
task or multiple independently scored subquestions.

### Example question

**Question 2: Create and switch to a feature branch --- 4 marks**

Starting state: - A Git repository exists in the terminal workspace. -
The current branch is `main`. - The repository contains a file named
`README.md`.

Tasks: - **A. Create a branch named `feature/login`. --- 2 marks** -
**B. Switch to `feature/login`. --- 2 marks**

The candidate must execute the operations in the terminal. Merely typing
an answer into a text box must not receive credit.

### Question authoring fields

Each question should support: - Question title. - Question statement. -
Topic and difficulty. - Question order. - Total marks. - Time limit in
seconds. - Optional setup instructions. - Terminal starting state or
environment template. - One or more subquestions. - Marks per
subquestion. - Validation rules for each subquestion. - Hints, if
permitted. - Explanation or solution, hidden until the appropriate
result/review stage. - Whether partial credit is allowed. - Whether the
terminal state is isolated or shared with other questions. - Question
availability and publication status.

### Marks validation

The system must enforce these rules: - Every exam totals exactly **40
marks**. - The sum of subquestion marks equals the parent question's
marks. - Marks cannot be negative. - Question and exam time limits must
be valid positive values. - The server, not the browser, is
authoritative for scores and timing.

## 7. Exam Timing Rules

Every exam has both an **overall exam timer** and a **separate timer for each question**. The server is the authority for all deadlines.

### 7.1 Overall exam timer

- The overall timer starts when the candidate clicks **Begin Exam** and the server successfully creates the attempt.
- The server stores an immutable `exam_deadline_at` for the attempt.
- The exam ends when the overall deadline is reached, even if a question still has time remaining.
- At overall expiry, the server locks the attempt, rejects new commands and submissions, finalizes available scores, and marks unfinished work according to the exam policy.
- The overall timer never resets on refresh, reconnect, or browser clock changes.

### 7.2 Per-question timer

- A question timer starts when the server activates that question.
- The server stores a `question_deadline_at` for each question attempt.
- The question deadline cannot exceed the overall exam deadline.
- Switching to another question does not pause or reset the previous question's timer.
- When a question timer expires, its environment is frozen, the question is locked, and the platform records the score from valid work completed before expiry.
- The candidate cannot reopen a submitted or expired question by default.

### 7.3 Timer display and recovery

- Show both **Overall time remaining** and **Question time remaining** in the workspace.
- Use server-issued deadlines to calculate the display; the browser countdown is visual only.
- Warn the candidate before either timer expires (for example, at 60 seconds and 15 seconds, where the duration permits).
- Refreshes and reconnects must retrieve the existing attempt and deadlines.
- A network interruption does not pause either timer unless an administrator explicitly configures an accommodation policy.
- The server must reject commands, validation requests, and submissions received after the relevant deadline.
- If the overall timer expires while a question timer is still active, the overall deadline takes precedence.
- Record attempt start, question start, submission, expiry, reconnect, and finalization events.

### 7.4 Recommended navigation defaults

Allow candidates to move between unanswered questions, but do not pause timers when they leave. Submitted or expired questions are locked. The product may allow revisiting an active question only while its own timer and the overall timer are still running. These rules must be displayed before the exam begins.

## 8. Terminal Requirements

The terminal is a core assessment component, not a decorative
terminal-looking text box.

### 8.1 Required behavior

The terminal should: - Accept keyboard input. - Display commands and
their output. - Support command history using the up/down arrow keys, if
feasible. - Support clear-screen behavior. - Display a realistic prompt
and working directory. - Preserve terminal state according to the
question's isolation policy. - Execute commands in a controlled
environment. - Return realistic success and error messages. - Expose
structured state to the validator without allowing candidates to modify
scoring data. - Allow the platform to distinguish executed commands from
text merely typed into the input. - Provide a reset option where
permitted.

### 8.2 Topic-specific environments

**Git & GitHub** - Use a real or accurately simulated Git repository. -
Support the commands required by the question set, such as `git init`,
`git status`, `git add`, `git commit`, `git branch`, `git switch`,
`git merge`, and selected remote operations. - Clearly define which
network-dependent operations are available. GitHub authentication and
live remote access should not be assumed inside an isolated exam
terminal.

**Docker** - Support or accurately simulate required operations
involving images, containers, logs, ports, volumes, and networks. - If
real Docker is used, isolate the environment and do not expose the host
Docker socket or unrestricted privileged containers to candidates. -
Provide seeded images and sample services where appropriate.

**Data Migration** - Provide a controlled sample source and destination,
such as CSV files and a sandbox database. - Support the specific
migration commands and tools included in the exam. - Let the validator
inspect source and destination data, schema, row counts, constraints,
and transformation results. - Reset the data environment safely between
attempts.

### 8.3 Required approach: real terminal in an isolated sandbox

The platform will run real commands inside a disposable, isolated execution environment. It must never run candidate commands directly on the application host or in a privileged production container.

#### Execution lifecycle

1. When an attempt or question starts, the backend requests an isolated workspace from the execution service.
2. The execution service creates a short-lived sandbox from an approved topic-specific image.
3. The browser connects to the terminal gateway using an authenticated, short-lived session token.
4. Commands run only inside that candidate's sandbox, subject to execution limits.
5. The validator inspects the workspace or uses trusted validation scripts to evaluate the resulting state.
6. At question expiry, question submission, or overall exam completion, the platform stops accepting commands for that scope.
7. The workspace is destroyed after the configured retention period; only permitted results and audit metadata are retained.

#### Recommended isolation model

- Use a dedicated execution service separate from the web/API service.
- Use disposable containers or stronger sandbox technology such as gVisor or microVMs, selected according to the threat model and hosting environment.
- Do not mount the host Docker socket into candidate containers.
- Do not run containers as privileged; use a non-root user, read-only base filesystem where practical, and narrowly scoped writable workspaces.
- Apply CPU, memory, process-count, disk, output-size, and wall-clock limits.
- Restrict outbound network access by default. Allow only explicitly required endpoints or preloaded resources.
- Do not inject production credentials, cloud credentials, or other candidates' data into the environment.
- Apply seccomp, capabilities restrictions, filesystem isolation, and runtime patching appropriate to the chosen platform.
- Terminate runaway processes and clean up the sandbox reliably.
- Treat terminal output and files created by candidates as untrusted data.

#### Topic-specific images

**Git & GitHub:** Provide Git and supporting utilities in a prebuilt image. Use seeded local repositories for most tasks. Remote GitHub operations should use disposable test repositories and narrowly scoped, short-lived credentials only if those operations are part of an exam.

**Docker:** Running Docker commands inside a sandbox is a special security concern. Do not expose the host Docker socket. If questions require building or running containers, use a separately isolated nested-runtime service or a dedicated microVM, with resource and network restrictions. If this is not available, restrict the exam to safe Docker CLI inspection tasks against a controlled service.

**Data Migration:** Provide a disposable workspace with sample source files and a temporary database. Validate schema, row counts, transformed values, constraints, and destination state. Reset the source and destination between candidates.

#### Terminal UI and transport

- Use **xterm.js** in the browser for terminal rendering.
- Use a secure WebSocket connection through an authenticated terminal gateway for interactive input and output.
- Enforce authorization on both the WebSocket handshake and every session attachment.
- Do not expose raw container IDs or unrestricted execution-service APIs to the browser.
- Use an idempotent session-creation flow to avoid spawning duplicate sandboxes on retries.

#### Operational safeguards

A real terminal offers flexibility but introduces substantial security and operating cost. Before public launch, perform sandbox escape reviews, resource-exhaustion tests, network-isolation tests, cross-user isolation tests, and cleanup tests. Keep the execution service on private networking and monitor it independently from the application API.

## 9. Answer Validation and Scoring

Validation should evaluate the resulting state, not simply compare the
exact command string.

For example, if a question asks the candidate to create and switch to a
branch, the validator should check: - Whether the branch exists. -
Whether the active branch is correct.

It should not require one exact command if multiple legitimate command
sequences achieve the requested state.

### Scoring requirements

-   Maximum exam score: 40.
-   Each question and subquestion has a defined maximum score.
-   Partial credit may be granted for independently completed tasks.
-   A subquestion's score cannot exceed its configured marks.
-   Repeated submissions must not award duplicate marks.
-   The server computes and persists scores.
-   Unanswered tasks receive zero unless an explicit grading policy says
    otherwise.
-   Terminal command history may be recorded for audit and
    troubleshooting, subject to privacy and retention rules.
-   Show feedback only when allowed by the exam's review policy.

### Example scoring table

  Task                          Marks Validation
  --------------------------- ------- ---------------------------
  Create `feature/login`            2 Branch exists
  Switch to `feature/login`         2 Current branch is correct
  **Total**                     **4** **Maximum 4 marks**

## 10. Navigation and Attempt Rules

Define these behaviors before implementation: - Whether candidates can
move to previous questions. - Whether the timer continues when they
leave a question. - Whether terminal state is preserved between
questions. - Whether a question can be checked multiple times. - Whether
the first successful validation locks the score. - Whether candidates
can submit the whole exam early. - What happens if the browser refreshes
or closes. - What happens if the connection is lost. - Whether multiple
attempts are allowed. - Whether answers and scores are visible
immediately after submission.

Recommended defaults: - Save progress automatically on the server. -
Allow Next Question only after explicit navigation or a defined
completion action. - Let candidates submit early after confirmation. -
Preserve attempt state after refresh. - Lock the attempt after final
submission or expiry. - Never allow an already-finalized attempt to be
reopened through ordinary client requests.

## 11. Results Screen

After the exam ends, show: - Exam topic and attempt date. - Score out of
40. - Percentage. - Number of completed, partially completed, and
unanswered questions. - Question-wise marks. - Time used, where
available. - Pass/fail status only if a pass threshold is configured. -
Feedback or correct solutions only if the review policy allows them. - A
link back to the dashboard.

Example:

``` text
Exam Completed

Topic: Git & GitHub
Score: 31 / 40
Percentage: 77.5%
Completed: 5 questions
Partially completed: 1 question

[View Allowed Feedback] [Back to Dashboard]
```

## 12. Recommended Technical Architecture

The following stack is recommended for a maintainable MVP that can grow into a production service. These are implementation recommendations, not existing project constraints.

### 12.1 Frontend

- **React + TypeScript + Vite** for the web application.
- **Tailwind CSS** for responsive styling and a consistent design system.
- **xterm.js** for terminal rendering and keyboard interaction.
- **TanStack Query** for API state, caching, and refetching after reconnects.
- A small shared exam-state layer for current question, server deadlines, and navigation state.

The client must not calculate authoritative marks or control the real deadline. It should render the server's state and provide immediate, non-authoritative timer displays.

### 12.2 Backend API

- **Node.js + TypeScript + Fastify** for the REST API. Express is also acceptable if the team already has established Express conventions; do not maintain both frameworks without a clear reason.
- **Zod** for request and configuration validation.
- **WebSocket gateway** for terminal input/output, authenticated through short-lived session tokens.
- Separate modules for authentication, topics, exams, questions, attempts, timers, terminal sessions, validation, scoring, and reporting.
- Server-side authorization on every attempt and terminal-session endpoint.

### 12.3 Authentication

For the fastest secure delivery, use **Clerk** or another managed identity provider. Keep the application role (`CANDIDATE` / `ADMIN`) in the application database and enforce it in backend authorization checks. Never trust a role supplied by the browser.

### 12.4 Database and persistence

- **PostgreSQL** as the primary relational database.
- **Drizzle ORM** or parameterized SQL for typed database access and migrations. Choose one access approach and use it consistently.
- Store users, topics, exam definitions, questions, subquestions, attempts, deadlines, scores, validation events, and audit records in PostgreSQL.
- Use database transactions for final scoring, attempt finalization, and state transitions that must be atomic.
- A Redis-compatible store may be added for ephemeral terminal-session routing or rate limiting if the deployment requires it; PostgreSQL remains the source of truth for exam attempts and scores.

### 12.5 Isolated terminal execution service

- Run a separate **Execution Service** that provisions disposable sandboxes from approved images.
- Use a container runtime with a hardened isolation layer; evaluate **gVisor or microVMs** for untrusted workloads and use ordinary containers only where the threat model and hosting environment make them acceptable.
- Keep the execution service on a private network, separate from the public API.
- Provide topic-specific images for Git, Docker-related tasks, and data migration.
- Use a terminal gateway to proxy authenticated WebSocket sessions; never expose the container runtime socket or raw runtime API publicly.
- Add strict CPU, memory, PID, disk, output, wall-clock, and network limits.
- Build images ahead of time and avoid unrestricted package installation during exams.

### 12.6 Deployment recommendation

- Deploy the web app and API on a managed platform suitable for Node.js.
- Deploy the execution service on dedicated compute where sandboxing, networking, and cleanup can be controlled.
- Use managed PostgreSQL with backups and migrations.
- Store secrets in the hosting provider's secret manager, not in source control or candidate workspaces.
- Add structured logs, metrics, health checks, alerts, and audit trails.
- Do not place the untrusted terminal execution workload in the same trust boundary as the application API or database.

### 12.7 Core architecture flow

```text
Browser (React + xterm.js)
        | HTTPS API / authenticated WebSocket
        v
API Service (Fastify) -------- PostgreSQL
        |
        | short-lived, authorized execution request
        v
Terminal Gateway / Execution Service
        |
        v
Disposable Isolated Sandbox
        |
        v
Trusted Validator -> Scoring Service -> PostgreSQL
```

The frontend must not determine the final score, extend deadlines, or authorize access to another candidate's attempt. The execution service must not be able to read production secrets or unrelated candidates' workspaces.

## 13. Suggested Data Model

A preliminary relational model may include:

### `users`

-   `id`
-   `name`
-   `email`
-   `auth_provider_id` or password hash, depending on the authentication
    approach
-   `role`
-   `created_at`

### `topics`

-   `id`
-   `name`
-   `slug`
-   `description`
-   `is_active`

### `exams`

-   `id`
-   `topic_id`
-   `title`
-   `total_marks` --- configured as 40 for these exams
-   `overall_duration_seconds`, optional
-   `navigation_policy`
-   `review_policy`
-   `status`

### `questions`

-   `id`
-   `exam_id`
-   `title`
-   `prompt`
-   `question_order`
-   `marks`
-   `time_limit_seconds`
-   `environment_template_id`
-   `state_isolation_policy`

### `subquestions`

-   `id`
-   `question_id`
-   `prompt`
-   `marks`
-   `validation_config`
-   `partial_credit_policy`

### `exam_attempts`

-   `id`
-   `user_id`
-   `exam_id`
-   `started_at`
-   `deadline_at`, optional
-   `submitted_at`
-   `status`
-   `total_score`

### `question_attempts`

-   `id`
-   `exam_attempt_id`
-   `question_id`
-   `started_at`
-   `deadline_at`
-   `submitted_at`
-   `status`
-   `score`

### `validation_events`

-   `id`
-   `question_attempt_id`
-   `subquestion_id`, optional
-   `result`
-   `awarded_marks`
-   `details`
-   `created_at`

### `terminal_sessions`

-   `id`
-   `question_attempt_id` or `exam_attempt_id`, according to isolation
    policy
-   `environment_id`
-   `status`
-   `created_at`
-   `expires_at`

This is a starting point. Final schema design should account for
concurrency, indexing, data retention, and the chosen terminal
implementation.

## 14. Security, Privacy, and Reliability

-   Use secure authentication and server-side authorization.
-   Candidates must only access their own attempts and permitted exam
    content.
-   Validate all API input.
-   Keep scoring and validation configuration on the server.
-   Isolate terminal execution from the application and database.
-   Never expose environment secrets to terminal sessions.
-   Prevent shell escape, container breakout, unauthorized network
    access, and cross-attempt data access.
-   Apply command execution timeouts and resource limits.
-   Rate-limit sensitive APIs.
-   Record important state changes.
-   Define retention rules for terminal logs and user data.
-   Handle browser refreshes, reconnects, duplicate requests, and
    simultaneous requests safely.
-   Test timer expiry and submission races.
-   Do not publish hidden solutions or future exam answers to the client
    before permitted review.

## 15. Functional Acceptance Criteria

The MVP is acceptable when all the following are true:

1.  A user can register or sign in using the chosen authentication
    method.
2.  The dashboard displays a working **Start Contest** action.
3.  The user can choose Git & GitHub, Docker, or Data Migration.
4.  The selected exam is configured for a total of exactly 40 marks.
5.  Every question has a configured time limit.
6.  A question can contain multiple independently scored subquestions.
7.  The question appears above a usable terminal.
8.  The candidate can execute the supported operations in the terminal.
9.  The validator checks the resulting state and awards the configured
    marks.
10. The candidate can move to another question according to the
    navigation policy.
11. Timer state survives a page refresh and cannot be extended by
    changing the browser clock.
12. Expired questions and submitted attempts cannot receive unauthorized
    additional time or marks.
13. The final score is calculated and persisted by the server.
14. The results screen displays the score out of 40.
15. A candidate cannot view or change another candidate's attempt.
16. Terminal environments are isolated and cleaned up according to
    policy.
17. The exam works at common desktop sizes and remains usable on smaller
    screens.
18. Error messages clearly explain recoverable problems without exposing
    secrets or internal system details.

## 16. Testing Plan

Include tests for: - Authentication and access control. - Topic
selection. - Exam creation and the 40-mark total. - Question and
subquestion mark validation. - Timer start, expiry, and server-side
enforcement. - Page refresh and reconnect behavior. - Valid and invalid
terminal operations. - State-based grading and partial credit. -
Duplicate submissions and repeated validation requests. - Question
navigation and terminal-state isolation. - Early submission and
automatic expiry. - Final score calculation. - Cross-user attempt
access. - Execution limits, sandbox isolation, and cleanup. - Responsive
layout and accessibility.

## 17. Suggested Delivery Phases

### Phase 1 — Product foundation
- Set up the React + TypeScript frontend, API service, PostgreSQL schema, authentication, and CI checks.
- Build the candidate dashboard, Start Contest button, topic selection, exam briefing, and exam workspace shell.
- Seed one sample exam per topic and enforce the 40-mark total.

### Phase 2 — Exam engine and timers
- Implement attempt creation and server-authoritative overall and per-question deadlines.
- Implement navigation, autosave, reconnect recovery, early submission, expiry, and finalization.
- Add concurrency-safe score and attempt state transitions.

### Phase 3 — Secure real terminal MVP
- Build the private execution service and authenticated terminal gateway.
- Provision disposable, isolated workspaces with strict resource and network controls.
- Integrate xterm.js with WebSocket transport.
- Implement sandbox cleanup and observability before allowing candidate execution.

### Phase 4 — Validation and first topic
- Complete Git & GitHub questions end-to-end using real Git operations.
- Build trusted state validators and subquestion scoring.
- Test terminal isolation, timer expiry, duplicate requests, and score integrity.

### Phase 5 — Expand topics
- Add Docker tasks using a separately isolated runtime strategy; never mount the host Docker socket.
- Add Data Migration tasks using disposable sample files and temporary databases.
- Add question-authoring tools and administrative review.

### Phase 6 — Production hardening
- Conduct sandbox escape, resource-exhaustion, network-isolation, and cross-user access tests.
- Add backups, monitoring, alerting, rate limits, retention policies, and incident procedures.
- Perform load testing and accessibility/usability reviews.

A sensible MVP is one complete topic end-to-end plus the secure execution architecture. Do not expose a real terminal publicly until isolation, resource limits, and cleanup have been tested.

## 18. Confirmed Decisions and Remaining Product Policies

### 18.1 Confirmed decisions

The following choices are confirmed for this version of the PRD:

1. **Terminal execution:** Run real commands in an isolated, disposable sandbox. Do not use a text-only terminal mock or run commands on the application host.
2. **Timing:** Every exam has both an overall timer and a separate timer for each question. The server enforces both deadlines, and the earlier applicable deadline wins.
3. **Recommended stack:** React + TypeScript + Vite, Tailwind CSS, xterm.js, Node.js + TypeScript + Fastify, Zod, PostgreSQL, and Drizzle ORM or parameterized SQL. Use a separate hardened execution service and authenticated WebSocket terminal gateway. Clerk is the recommended managed authentication option.

### 18.2 Remaining policy decisions

These settings can be configured before launch without changing the main architecture. Recommended defaults are provided.

1. **Question navigation:** Recommended default: allow navigation to unanswered questions, but timers continue while a candidate is away. Submitted and expired questions remain locked.
2. **Terminal persistence:** Recommended default: use a fresh sandbox per question for predictable grading. If a question intentionally builds on earlier work, define a shared workspace explicitly in the exam configuration.
3. **Partial credit:** Recommended default: award marks independently for validated subquestions, with each subquestion capped at its configured marks.
4. **Attempts:** Recommended default: one attempt per published contest unless an administrator enables retakes.
5. **Results and solutions:** Recommended default: show scores after submission; release solutions only according to the exam's configured review policy.
6. **Question authoring:** Recommended default: begin with version-controlled seed files, then add an administrator question editor after the core exam engine is stable.
7. **Data Migration scope:** Recommended initial scope: CSV import/export, SQL transformations, and migration into a disposable PostgreSQL database. Add database-to-database tasks when the sandbox and validator support them safely.
8. **GitHub network access:** Recommended default: use local repositories for most Git tasks. If live GitHub operations are assessed, use disposable test repositories and short-lived, least-privilege credentials.

These defaults should be displayed to candidates in the exam briefing and stored as exam configuration rather than being hard-coded into frontend behavior.

## 19. Product Summary

The platform is a practical, terminal-first contest system. Candidates
sign in, select one of three topics, and complete a 40-mark exam by
executing commands in an interactive terminal beneath each question.
Each question has a server-enforced timer, may contain independently
scored subquestions, and is evaluated by validating the resulting
environment state. The platform records progress, enforces access
controls, calculates results on the server, and supports future
administration and expansion.
