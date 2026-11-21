// The evaluator boundary. A screen asks an Evaluator for an assessment and
// gets back either a checked, scored record or an error to show; it never
// sees a provider, a key, or raw model output.
//
// Modes (a per-device setting):
// - off: no evaluator.
// - external: the learner copies a prompt into an assistant of their choice.
//   Nothing comes back into Recall, so there is no Evaluator for it either;
//   see externalGradingPrompt in prompt.ts.
// - server: the sync server asks its configured model.

import { buildAssessment, isGradable, validateEvaluation } from '../domain/grading';
import type { Assessment, Card, Rubric } from '../domain/types';
import { AiClientError, type AiClient } from './client';
import type { AiInfo } from './protocol';

export interface GradeInput {
  attempt: { id: string; cardId: string; cardVersion: number; response: string };
  card: Card;
  rubric: Rubric;
}

export interface Evaluator {
  /** What to tell the learner before anything is sent. */
  readonly destination: string;
  readonly model: string;
  grade(input: GradeInput, now: number): Promise<Assessment>;
}

export function createServerEvaluator(client: AiClient, info: AiInfo): Evaluator {
  return {
    destination: info.destination ?? 'your sync server',
    model: info.model ?? 'a model',
    async grade({ attempt, card, rubric }, now) {
      if (!isGradable(attempt.response)) throw new AiClientError('bad-request', 'AI feedback needs a typed answer.');
      const content = { criteria: rubric.criteria, criticalMisconceptions: rubric.criticalMisconceptions };
      const result = await client.grade(
        {
          attemptId: attempt.id,
          cardId: card.id,
          cardVersion: attempt.cardVersion,
          rubricVersion: rubric.version,
          question: card.question,
          referenceAnswer: card.answer,
          rubric: content,
          response: attempt.response,
        },
        info.timeoutMs,
      );
      // A result is only attached to the attempt, card version, and rubric version it was made for.
      if (
        result.attemptId !== attempt.id ||
        result.cardId !== card.id ||
        result.cardVersion !== attempt.cardVersion ||
        result.rubricVersion !== rubric.version
      ) {
        throw new AiClientError('ai-malformed', 'The result was for a different attempt, so it was discarded.');
      }
      // Checked again here: the app doesn't display anything it hasn't validated itself.
      const checked = validateEvaluation(result.evaluation, content);
      if (!checked.ok) throw new AiClientError('ai-malformed', `The result didn't pass Recall's checks: ${checked.reason}`);
      const text = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() !== '' ? v.slice(0, 100) : fallback);
      return buildAssessment(
        attempt,
        rubric,
        checked.value,
        {
          provider: text(result.provider, 'unknown'),
          model: text(result.model, 'unknown'),
          promptVersion: text(result.promptVersion, 'unknown'),
        },
        now,
      );
    },
  };
}
