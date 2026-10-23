export interface RubricRule {
  path: string;
  equals: unknown;
}

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
  subquestions: SubquestionDefinition[];
}

export interface ExamDefinition {
  slug: string;
  title: string;
  description: string;
  examTitle: string;
  totalMarks: number;
  durationSeconds: number;
  questions: QuestionDefinition[];
}

const q = (
  title: string,
  prompt: string,
  leftPrompt: string,
  leftPath: string,
  leftEquals: unknown,
  rightPrompt: string,
  rightPath: string,
  rightEquals: unknown,
): QuestionDefinition => ({
  title,
  prompt,
  marks: 8,
  timeLimitSeconds: 300,
  subquestions: [
    { label: "A", prompt: leftPrompt, marks: 4, rubric: { path: leftPath, equals: leftEquals } },
    { label: "B", prompt: rightPrompt, marks: 4, rubric: { path: rightPath, equals: rightEquals } },
  ],
});

export const examCatalog: ExamDefinition[] = [
  {
    slug: "git-github",
    title: "Git & GitHub",
    description: "Git fundamentals, branching, collaboration, and release workflows.",
    examTitle: "Git & GitHub Practical Exam",
    totalMarks: 40,
    durationSeconds: 2400,
    questions: [
      q("Inspect and prepare a repository", "Inspect the provided repository and leave it on its primary branch with a clean working tree.", "Use the primary branch named main.", "git.branch", "main", "Leave no uncommitted changes.", "git.workingTreeClean", true),
      q("Create a feature branch", "Create and switch to the feature branch feature/auth.", "Create feature/auth.", "git.branches.feature/auth", true, "Make feature/auth the current branch.", "git.currentBranch", "feature/auth"),
      q("Record a change", "Stage the provided change and create the requested commit.", "Create a commit with the message Add login validation.", "git.latestCommit.message", "Add login validation", "Ensure at least one commit exists on the feature branch.", "git.featureCommitCount", 1),
      q("Configure a remote", "Configure the repository's approved origin remote and track its main branch.", "Configure the origin remote.", "git.remotes.origin", true, "Track origin/main.", "git.upstream", "origin/main"),
      q("Prepare a release", "Create the requested release tag and push the feature branch to its approved remote.", "Create tag v1.0.0.", "git.tags.v1.0.0", true, "Set the push target to origin/feature/auth.", "git.pushTarget", "origin/feature/auth"),
    ],
  },
  {
    slug: "docker",
    title: "Docker",
    description: "Build images, run containers, configure networking, and persist data.",
    examTitle: "Docker Practical Exam",
    totalMarks: 40,
    durationSeconds: 2400,
    questions: [
      q("Build a container image", "Build the provided application using the approved Dockerfile.", "Build an image named exam-web.", "docker.images.exam-web", true, "Tag the image exam-web:latest.", "docker.imageTags.exam-web", "latest"),
      q("Run the web service", "Run the supplied web application with the required container name and port.", "Run a container named web.", "docker.containers.web.exists", true, "Publish container port 8080 on host port 8080.", "docker.containers.web.ports.8080", 8080),
      q("Persist application data", "Create a named volume and attach it to the data path of the service.", "Create the named volume app-data.", "docker.volumes.app-data", true, "Mount app-data at /var/lib/app.", "docker.containers.web.mounts./var/lib/app", "app-data"),
      q("Create an application network", "Create a user-defined network and connect the web service.", "Create the network exam-net.", "docker.networks.exam-net", true, "Attach web to exam-net.", "docker.containers.web.networks.exam-net", true),
      q("Apply container limits", "Run the worker with the specified resource limits and restart policy.", "Set the memory limit to 256m.", "docker.containers.worker.memoryLimit", "256m", "Set the restart policy to unless-stopped.", "docker.containers.worker.restartPolicy", "unless-stopped"),
    ],
  },
  {
    slug: "data-migration",
    title: "Data Migration",
    description: "Plan and verify safe schema and data transformations.",
    examTitle: "Data Migration Practical Exam",
    totalMarks: 40,
    durationSeconds: 2400,
    questions: [
      q("Create the destination schema", "Create the destination users table with the required identity and email fields.", "Create destination table users.", "destination.tables.users.exists", true, "Add an email column of the required text type.", "destination.tables.users.columns.email.type", "text"),
      q("Migrate source records", "Migrate all valid source user rows into the destination.", "Migrate the five valid source rows.", "destination.tables.users.rowCount", 5, "Preserve every source identifier.", "destination.tables.users.idsPreserved", true),
      q("Transform and normalize data", "Normalize email values and convert names to the required format.", "Normalize all email values to lowercase.", "destination.tables.users.emailsLowercase", true, "Trim leading and trailing whitespace from names.", "destination.tables.users.namesTrimmed", true),
      q("Enforce data integrity", "Apply the required uniqueness and referential integrity constraints.", "Make email values unique.", "destination.tables.users.emailUnique", true, "Add the required foreign key to organizations.", "destination.tables.users.organizationForeignKey", true),
      q("Verify a safe migration", "Run the migration verification checks and record a reversible migration.", "Verify source and destination row counts match.", "migration.rowCountsMatch", true, "Provide a rollback migration.", "migration.rollbackAvailable", true),
    ],
  },
];

export function assertExamDefinition(definition: ExamDefinition): void {
  if (definition.totalMarks !== 40 || definition.durationSeconds <= 0) {
    throw new Error(`Invalid published exam totals or duration for ${definition.slug}`);
  }
  if (definition.questions.length === 0) {
    throw new Error(`Published exam ${definition.slug} must have questions`);
  }
  let total = 0;
  for (const question of definition.questions) {
    const subquestionMarks = question.subquestions.reduce((sum, item) => sum + item.marks, 0);
    if (
      question.marks <= 0 ||
      question.timeLimitSeconds <= 0 ||
      question.subquestions.length === 0 ||
      subquestionMarks !== question.marks ||
      question.subquestions.some((item) => item.marks < 0 || !item.rubric.path)
    ) {
      throw new Error(`Invalid question marks, timer, or rubric in ${definition.slug}`);
    }
    total += question.marks;
  }
  if (total !== definition.totalMarks) {
    throw new Error(`Exam ${definition.slug} has ${total} marks instead of ${definition.totalMarks}`);
  }
}

for (const definition of examCatalog) assertExamDefinition(definition);
