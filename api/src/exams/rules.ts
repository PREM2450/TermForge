import type { QuestionDefinition, RubricRule } from "./catalog.js";

export interface QuestionResult {
  score: number;
  maximum: number;
  checks: Array<{ label: string; earned: number; maximum: number }>;
}

export function effectiveDeadline(
  overallDeadline: Date,
  questionDeadline: Date | null,
): Date {
  return questionDeadline && questionDeadline < overallDeadline
    ? questionDeadline
    : overallDeadline;
}

export function hasExpired(deadline: Date, now: Date): boolean {
  return now.getTime() >= deadline.getTime();
}

function valueAtPath(state: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, segment) => {
    if (value === null || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[segment];
  }, state);
}

export function ruleMatches(state: unknown, rule: RubricRule): boolean {
  return Object.is(valueAtPath(state, rule.path), rule.equals);
}

export function gradeQuestion(
  state: unknown,
  question: Pick<QuestionDefinition, "subquestions">,
): QuestionResult {
  const checks = question.subquestions.map((subquestion) => ({
    label: subquestion.label,
    earned: ruleMatches(state, subquestion.rubric) ? subquestion.marks : 0,
    maximum: subquestion.marks,
  }));
  return {
    score: checks.reduce((sum, check) => sum + check.earned, 0),
    maximum: checks.reduce((sum, check) => sum + check.maximum, 0),
    checks,
  };
}
