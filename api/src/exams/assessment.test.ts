import { describe, expect, it } from "vitest";
import { assessQuestionState } from "./assessment.js";
import type { QuestionDefinition } from "./catalog.js";

const question: Pick<QuestionDefinition, "subquestions"> = {
  subquestions: [
    {
      label: "A",
      prompt: "Set the primary branch.",
      marks: 2,
      rubric: { path: "git.branch", equals: "main" },
    },
  ],
};

describe("assessQuestionState", () => {
  it("awards rubric marks and feedback from the terminal state", () => {
    expect(assessQuestionState({ git: { branch: "main" } }, question)).toEqual({
      score: 2,
      maximum: 2,
      feedback: [
        'A: Correct — 2/2 marks. Expected git.branch = "main"; observed "main".',
      ],
    });
  });

  it("awards no marks when the terminal state does not satisfy the rubric", () => {
    expect(assessQuestionState({ git: { branch: "master" } }, question)).toEqual({
      score: 0,
      maximum: 2,
      feedback: [
        'A: Incorrect — 0/2 marks. Expected git.branch = "main"; observed "master".',
      ],
    });
  });
});
