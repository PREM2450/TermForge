export interface RubricRule {
  path: string;
  equals: unknown;
}

export type QuestionDifficulty = "easy" | "medium" | "high";

export interface SubquestionDefinition {
  label: string;
  prompt: string;
  marks: number;
  rubric: RubricRule;
}

export interface QuestionDefinition {
  title: string;
  prompt: string;
  marks: number;
  timeLimitSeconds: number;
  difficulty: QuestionDifficulty;
  subquestions: SubquestionDefinition[];
}

export interface ExamDefinition {
  slug: string;
  title: string;
  description: string;
  topicSlug: "git-github" | "docker" | "data-migration";
  topicTitle: string;
  examTitle: string;
  totalMarks: number;
  durationSeconds: number;
  questions: QuestionDefinition[];
}

interface TaskDefinition {
  title: string;
  prompt: (testNumber: number) => string;
  rubric: (testNumber: number) => RubricRule;
}

function taskQuestion(task: TaskDefinition, testNumber: number, index: number): QuestionDefinition {
  const difficulty: QuestionDifficulty =
    index < 5 ? "easy" : index < 14 ? "medium" : "high";
  return {
    title: task.title,
    prompt: task.prompt(testNumber),
    marks: 2,
    timeLimitSeconds: 120,
    difficulty,
    subquestions: [{
      label: "A",
      prompt: "Complete the terminal task and leave the requested state in the workspace.",
      marks: 2,
      rubric: task.rubric(testNumber),
    }],
  };
}

const gitTasks: TaskDefinition[] = [
  {
    title: "Set the primary branch",
    prompt: () => "Rename the current branch to main with git branch -m main.",
    rubric: () => ({ path: "git.branch", equals: "main" }),
  },
  {
    title: "Set the commit author",
    prompt: (n) => `In this repository, set the local Git user name to Candidate ${n}.`,
    rubric: (n) => ({ path: "git.config.userName", equals: `Candidate ${n}` }),
  },
  {
    title: "Set the commit email",
    prompt: (n) => `Set the local Git commit email to candidate${n}@termforge.test.`,
    rubric: (n) => ({ path: "git.config.userEmail", equals: `candidate${n}@termforge.test` }),
  },
  {
    title: "Create a feature branch",
    prompt: (n) => `Create a branch named feature/release-${n}.`,
    rubric: (n) => ({ path: `git.branches.feature/release-${n}`, equals: true }),
  },
  {
    title: "Switch to the feature branch",
    prompt: (n) => `Create and switch to feature/release-${n}.`,
    rubric: (n) => ({ path: "git.currentBranch", equals: `feature/release-${n}` }),
  },
  {
    title: "Stage a release note",
    prompt: (n) => `Create release-${n}.md and stage it for commit.`,
    rubric: (n) => ({ path: `git.stagedRelease${n}`, equals: true }),
  },
  {
    title: "Commit the release note",
    prompt: (n) => `Create release-${n}.md, stage it, and commit with the exact message "Add release ${n} notes".`,
    rubric: (n) => ({ path: "git.latestCommit.message", equals: `Add release ${n} notes` }),
  },
  {
    title: "Create a second commit",
    prompt: (n) => `Add a file named build-${n}.txt and commit it with message "Record build ${n}".`,
    rubric: (n) => ({ path: "git.commitCount", equals: 2 }),
  },
  {
    title: "Create an annotated tag",
    prompt: (n) => `Create the annotated tag v1.0.${n} with message "Release ${n}".`,
    rubric: (n) => ({ path: `git.releaseTag${n}`, equals: true }),
  },
  {
    title: "Configure the origin remote",
    prompt: (n) => `Add origin with URL https://example.test/team/release-${n}.git.`,
    rubric: (n) => ({ path: "git.remotes.origin", equals: `https://example.test/team/release-${n}.git` }),
  },
  {
    title: "Set the upstream branch",
    prompt: (n) => `Add origin at https://example.test/team/release-${n}.git, create the local tracking ref origin/feature/release-${n} at HEAD, then set the current branch to track it.`,
    rubric: (n) => ({ path: "git.upstream", equals: `origin/feature/release-${n}` }),
  },
  {
    title: "Ignore generated files",
    prompt: (n) => `Add *.release-${n}.tmp to .gitignore and verify that report.release-${n}.tmp is ignored.`,
    rubric: (n) => ({ path: `git.ignoredRelease${n}`, equals: true }),
  },
  {
    title: "Set a repository preference",
    prompt: (n) => `Set the repository-local core.editor to "nano-${n}".`,
    rubric: (n) => ({ path: "git.config.core.editor", equals: `nano-${n}` }),
  },
  {
    title: "Stash a tracked change",
    prompt: (n) => `Append a line to the tracked README.md, then stash the tracked change.`,
    rubric: (n) => ({ path: "git.stashCount", equals: 1 }),
  },
  {
    title: "Rename a branch",
    prompt: (n) => `Create branch draft-${n}, then rename it to review-${n}.`,
    rubric: (n) => ({ path: `git.branches.review-${n}`, equals: true }),
  },
  {
    title: "Create a merge commit",
    prompt: (n) => `Create branches feature-${n} and main-work, make a commit on each, then merge main-work into feature-${n}.`,
    rubric: (n) => ({ path: "git.latestCommit.parentCount", equals: 2 }),
  },
  {
    title: "Set a push destination",
    prompt: (n) => `Add origin at https://example.test/team/release-${n}.git, then configure its push URL as https://push.example.test/release-${n}.git.`,
    rubric: (n) => ({ path: "git.remotes.originPush", equals: `https://push.example.test/release-${n}.git` }),
  },
  {
    title: "Cherry-pick a change",
    prompt: (n) => `Create a commit on source-${n} with message "Cherry-pick release ${n}", switch to target-${n}, and cherry-pick that commit.`,
    rubric: (n) => ({ path: "git.latestCommit.message", equals: `Cherry-pick release ${n}` }),
  },
  {
    title: "Clean the working tree",
    prompt: (n) => `Create and commit clean-${n}.txt with message "Clean release ${n}", then leave the working tree clean.`,
    rubric: (n) => ({ path: `git.cleanRelease${n}`, equals: true }),
  },
  {
    title: "Remove a local branch",
    prompt: (n) => `The pre-created branch obsolete-${n} is fully merged. Delete it safely.`,
    rubric: (n) => ({ path: `git.branches.obsolete-${n}`, equals: false }),
  },
];

const dockerTasks: TaskDefinition[] = [
  {
    title: "Build a tagged image",
    prompt: (n) => `Build the provided Dockerfile as image release-web:${n}.`,
    rubric: (n) => ({ path: "docker.builtImage", equals: `release-web:${n}` }),
  },
  {
    title: "Tag an image",
    prompt: (n) => `Tag the available image source:latest as registry.example.test/team/app:${n}.`,
    rubric: (n) => ({ path: "docker.taggedImage", equals: `registry.example.test/team/app:${n}` }),
  },
  {
    title: "Create a named container",
    prompt: (n) => `Run image web:${n} as a detached container named web-${n}.`,
    rubric: (n) => ({ path: "docker.detachedContainer", equals: `web-${n}` }),
  },
  {
    title: "Publish a container port",
    prompt: (n) => `Run api:${n} as api-${n}, publishing host port ${8000 + n} to container port 8080.`,
    rubric: (n) => ({ path: `docker.publishedPorts.${8000 + n}`, equals: 8080 }),
  },
  {
    title: "Create a named volume",
    prompt: (n) => `Create a named Docker volume called data-${n}.`,
    rubric: (n) => ({ path: "docker.createdVolume", equals: `data-${n}` }),
  },
  {
    title: "Mount persistent data",
    prompt: (n) => `Create volume data-${n}, then run db:${n} as db-${n} and mount data-${n} at /var/lib/app.`,
    rubric: (n) => ({ path: "docker.volumeMount", equals: `data-${n}:/var/lib/app` }),
  },
  {
    title: "Create an application network",
    prompt: (n) => `Create a user-defined network named app-net-${n}.`,
    rubric: (n) => ({ path: "docker.createdNetwork", equals: `app-net-${n}` }),
  },
  {
    title: "Connect a container to a network",
    prompt: (n) => `Create network app-net-${n}, then run worker:${n} as worker-${n} on that network.`,
    rubric: (n) => ({ path: "docker.networkAttachment", equals: `worker-${n}@app-net-${n}` }),
  },
  {
    title: "Apply a memory limit",
    prompt: (n) => `Run cache:${n} as cache-${n} with a 256m memory limit.`,
    rubric: () => ({ path: "docker.memoryLimit", equals: "256m" }),
  },
  {
    title: "Set a restart policy",
    prompt: (n) => `Run service:${n} as service-${n} with restart policy unless-stopped.`,
    rubric: () => ({ path: "docker.restartPolicy", equals: "unless-stopped" }),
  },
  {
    title: "Set a container environment variable",
    prompt: (n) => `Run app:${n} as app-${n} with APP_ENV=release-${n}.`,
    rubric: (n) => ({ path: "docker.environment.APP_ENV", equals: `release-${n}` }),
  },
  {
    title: "Inspect image metadata",
    prompt: (n) => `Create a Dockerfile containing FROM scratch and LABEL owner=team-${n}, build it as inspected:${n}, then inspect the image.`,
    rubric: (n) => ({ path: "docker.inspectedImageOwner", equals: `team-${n}` }),
  },
  {
    title: "Rename a container",
    prompt: (n) => `Run task:${n} as task-old-${n}, then rename it task-${n}.`,
    rubric: (n) => ({ path: "docker.renamedContainer", equals: `task-${n}` }),
  },
  {
    title: "Stop a container",
    prompt: (n) => `Run daemon:${n} as daemon-${n}, then stop it.`,
    rubric: (n) => ({ path: "docker.stoppedContainer", equals: `daemon-${n}` }),
  },
  {
    title: "Remove a container",
    prompt: (n) => `Run temporary:${n} as temporary-${n}, stop it, and remove it.`,
    rubric: (n) => ({ path: "docker.removedContainer", equals: `temporary-${n}` }),
  },
  {
    title: "Publish two ports",
    prompt: (n) => `Run gateway:${n} as gateway-${n}, publishing ${8100 + n}:80 and ${8200 + n}:443.`,
    rubric: (n) => ({ path: "docker.publishedPortPair", equals: `${8100 + n}:80,${8200 + n}:443` }),
  },
  {
    title: "Configure a read-only mount",
    prompt: (n) => `Run frontend:${n} as frontend-${n} with ./site mounted read-only at /usr/share/site.`,
    rubric: () => ({ path: "docker.readOnlyMount", equals: true }),
  },
  {
    title: "Set CPU and memory limits",
    prompt: (n) => `Run batch:${n} as batch-${n} with 0.5 CPUs and a 512m memory limit.`,
    rubric: () => ({ path: "docker.resourceLimits", equals: "cpu=0.5,memory=512m" }),
  },
  {
    title: "Remove an unused image",
    prompt: (n) => `Pull and then remove image obsolete:${n}.`,
    rubric: (n) => ({ path: "docker.removedImage", equals: `obsolete:${n}` }),
  },
  {
    title: "Copy a file into a container",
    prompt: (n) => `Create container copy-target-${n} from app:${n}, then copy the provided config.json to /etc/app/config.json.`,
    rubric: () => ({ path: "docker.copiedFile", equals: "/etc/app/config.json=config.json" }),
  },
];

const migrationQuestions: QuestionDefinition[] = [
  {
    title: "Create the destination schema",
    prompt: "Create the destination users table with its identity and email fields.",
    marks: 8,
    timeLimitSeconds: 300,
    difficulty: "easy",
    subquestions: [
      { label: "A", prompt: "Create destination table users.", marks: 4, rubric: { path: "destination.tables.users.exists", equals: true } },
      { label: "B", prompt: "Add an email column with the required text type.", marks: 4, rubric: { path: "destination.tables.users.columns.email.type", equals: "text" } },
    ],
  },
  {
    title: "Migrate source records",
    prompt: "Migrate all valid source user rows into the destination.",
    marks: 8,
    timeLimitSeconds: 300,
    difficulty: "easy",
    subquestions: [
      { label: "A", prompt: "Migrate the five valid source rows.", marks: 4, rubric: { path: "destination.tables.users.rowCount", equals: 5 } },
      { label: "B", prompt: "Preserve every source identifier.", marks: 4, rubric: { path: "destination.tables.users.idsPreserved", equals: true } },
    ],
  },
  {
    title: "Transform and normalize data",
    prompt: "Normalize email values and convert names to the required format.",
    marks: 8,
    timeLimitSeconds: 300,
    difficulty: "medium",
    subquestions: [
      { label: "A", prompt: "Normalize all email values to lowercase.", marks: 4, rubric: { path: "destination.tables.users.emailsLowercase", equals: true } },
      { label: "B", prompt: "Trim leading and trailing whitespace from names.", marks: 4, rubric: { path: "destination.tables.users.namesTrimmed", equals: true } },
    ],
  },
  {
    title: "Enforce data integrity",
    prompt: "Apply the required uniqueness and referential integrity constraints.",
    marks: 8,
    timeLimitSeconds: 300,
    difficulty: "medium",
    subquestions: [
      { label: "A", prompt: "Make email values unique.", marks: 4, rubric: { path: "destination.tables.users.emailUnique", equals: true } },
      { label: "B", prompt: "Add the required foreign key to organizations.", marks: 4, rubric: { path: "destination.tables.users.organizationForeignKey", equals: true } },
    ],
  },
  {
    title: "Verify a safe migration",
    prompt: "Run the migration verification checks and record a reversible migration.",
    marks: 8,
    timeLimitSeconds: 300,
    difficulty: "high",
    subquestions: [
      { label: "A", prompt: "Verify source and destination row counts match.", marks: 4, rubric: { path: "migration.rowCountsMatch", equals: true } },
      { label: "B", prompt: "Provide a rollback migration.", marks: 4, rubric: { path: "migration.rollbackAvailable", equals: true } },
    ],
  },
];

function createTestSet(
  topicSlug: ExamDefinition["topicSlug"],
  topicTitle: string,
  testNumber: number,
  tasks: TaskDefinition[],
): ExamDefinition {
  const slug = `${topicSlug}-test-${String(testNumber).padStart(2, "0")}`;
  return {
    slug,
    title: `${topicTitle} Test ${testNumber}`,
    description: `Terminal command assessment ${testNumber} of 15. Questions progress from easy through medium to high difficulty.`,
    topicSlug,
    topicTitle,
    examTitle: `${topicTitle} — Test ${testNumber}`,
    totalMarks: 40,
    durationSeconds: 2400,
    questions: tasks.map((task, index) => taskQuestion(task, testNumber, index)),
  };
}

export const examCatalog: ExamDefinition[] = [
  ...Array.from({ length: 15 }, (_, index) =>
    createTestSet("git-github", "Git & GitHub", index + 1, gitTasks),
  ),
  ...Array.from({ length: 15 }, (_, index) =>
    createTestSet("docker", "Docker", index + 1, dockerTasks),
  ),
  {
    slug: "data-migration",
    title: "Data Migration",
    description: "Plan and verify safe schema and data transformations.",
    topicSlug: "data-migration",
    topicTitle: "Data Migration",
    examTitle: "Data Migration Practical Exam",
    totalMarks: 40,
    durationSeconds: 2400,
    questions: migrationQuestions,
  },
];

export function assertExamDefinition(definition: ExamDefinition): void {
  if (definition.totalMarks !== 40 || definition.durationSeconds <= 0) {
    throw new Error(`Invalid published exam totals or duration for ${definition.slug}`);
  }
  const isCommandExam = definition.topicSlug === "git-github" || definition.topicSlug === "docker";
  if (isCommandExam && definition.questions.length !== 20) {
    throw new Error(`Published exam ${definition.slug} must have exactly 20 questions`);
  }
  if (!isCommandExam && definition.questions.length === 0) {
    throw new Error(`Published exam ${definition.slug} must have questions`);
  }
  const total = definition.questions.reduce((sum, question) => sum + question.marks, 0);
  for (const question of definition.questions) {
    const subquestionMarks = question.subquestions.reduce((sum, item) => sum + item.marks, 0);
    if (
      question.marks <= 0 ||
      question.timeLimitSeconds <= 0 ||
      subquestionMarks !== question.marks ||
      question.subquestions.some((item) => item.marks < 0 || !item.rubric.path)
    ) {
      throw new Error(`Invalid question marks, timer, or rubric in ${definition.slug}`);
    }
    if (isCommandExam && (question.marks !== 2 || question.subquestions.length !== 1)) {
      throw new Error(`Invalid command question scoring in ${definition.slug}`);
    }
  }
  if (total !== definition.totalMarks) {
    throw new Error(`Exam ${definition.slug} has ${total} marks instead of ${definition.totalMarks}`);
  }
}

for (const definition of examCatalog) {
  assertExamDefinition(definition);
}
