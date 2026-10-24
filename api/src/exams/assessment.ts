import { gradeQuestion } from "./rules.js";
import type { QuestionDefinition } from "./catalog.js";

function valueAtPath(state: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, segment) => {
    if (value === null || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[segment];
  }, state);
}

function formatValue(value: unknown): string {
  if (value === undefined) return "not set";
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
}

export function expectedAnswer(question: QuestionDefinition["subquestions"][number]): string {
  return `${question.rubric.path} = ${formatValue(question.rubric.equals)}`;
}

export function assessQuestionState(
  state: unknown,
  question: Pick<QuestionDefinition, "subquestions">,
): { score: number; maximum: number; feedback: string[] } {
  const result = gradeQuestion(state, question);
  return {
    score: result.score,
    maximum: result.maximum,
    feedback: result.checks.map((check, index) => {
      const subquestion = question.subquestions[index];
      if (!subquestion) throw new Error("Assessment result has no matching subquestion");
      const outcome =
        check.earned === check.maximum
          ? "Correct"
          : check.earned === 0
            ? "Incorrect"
            : "Partially correct";
      return `${check.label}: ${outcome} — ${check.earned}/${check.maximum} marks. Expected ${expectedAnswer(subquestion)}; observed ${formatValue(valueAtPath(state, subquestion.rubric.path))}.`;
    }),
  };
}
