import { describe, expect, it } from "vitest";
import { assertExamDefinition, examCatalog } from "./catalog.js";

describe("published command test sets", () => {
  it.each(["git-github", "docker"] as const)(
    "%s publishes 15 tests with 20 graded terminal questions each",
    (topicSlug) => {
      const tests = examCatalog.filter((exam) => exam.topicSlug === topicSlug);
      expect(tests).toHaveLength(15);
      expect(new Set(tests.map((exam) => exam.slug)).size).toBe(15);
      for (const exam of tests) {
        expect(exam.questions).toHaveLength(20);
        expect(exam.questions.reduce((sum, question) => sum + question.marks, 0)).toBe(40);
        expect(exam.questions.every((question) => question.subquestions.length === 1)).toBe(true);
        expect(exam.questions.map((question) => question.difficulty)).toEqual([
          ...Array(5).fill("easy"),
          ...Array(9).fill("medium"),
          ...Array(6).fill("high"),
        ]);
        expect(() => assertExamDefinition(exam)).not.toThrow();
      }
    },
  );

  it("keeps the existing Data Migration exam available", () => {
    const exam = examCatalog.find((item) => item.topicSlug === "data-migration");
    expect(exam?.questions).toHaveLength(5);
    expect(exam?.totalMarks).toBe(40);
  });
});
