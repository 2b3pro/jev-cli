// ============================================================================
// Output shaping
// ============================================================================

import type { NoulResponse, ChoiceResponse, ScoreResponse } from "@typesafe-ai/sdk";

export type Answer = NoulResponse | ChoiceResponse | ScoreResponse;
export type AnswerValue = number | string;

/** The single value a question resolves to: P(yes), the chosen label, or the expected score. */
export function answerValue(answer: Answer): AnswerValue {
  switch (answer.type) {
    case "noul":
      return answer.noul;
    case "choice":
      return answer.choice;
    case "score":
      return answer.score;
  }
}

/** `{ name: answerObject }` → `{ name: value }`. */
export function flattenAnswers(answers: Readonly<Record<string, Answer>>): Record<string, AnswerValue> {
  return Object.fromEntries(Object.entries(answers).map(([name, answer]) => [name, answerValue(answer)]));
}
