// Sends the curated fixtures to the real, configured model provider and
// reports what came back. It costs a few provider requests, so it only runs
// when asked:
//
//   RECALL_AI_PROVIDER=anthropic ANTHROPIC_API_KEY=... npm run test:ai-real
//   RECALL_AI_PROVIDER=openai-compatible RECALL_AI_BASE_URL=http://127.0.0.1:11434/v1 \
//     RECALL_AI_MODEL=<model> npm run test:ai-real
//
// The settings are the server's own (docs/AI.md). A fixture passes when the
// app's label for the model's evaluation is one a sound evaluator may give.
// Record the outcome in docs/ACCEPTANCE.md; a pass here is what AC19 and AC20
// mean by "inspect actual provider results".

import { describe, expect, it } from 'vitest';
import { scoreEvaluation } from '../../src/domain/grading';
import { createAiService, readAiConfig } from '../../server/ai';
import { FIXTURES } from './fixtures';

const config = readAiConfig(process.env);

describe.skipIf(!config)('real provider', () => {
  const service = config ? createAiService({ ...config, dailyLimit: 100 }) : null;

  it.each(FIXTURES)(
    '$name',
    async (fixture) => {
      const result = await service!.grade({
        attemptId: `fixture-${fixture.name}`,
        cardId: 'fixture-card',
        cardVersion: 1,
        rubricVersion: 1,
        question: fixture.question,
        referenceAnswer: fixture.referenceAnswer,
        rubric: fixture.rubric,
        response: fixture.response,
      });
      const verdict = scoreEvaluation(result.evaluation, fixture.rubric);
      console.log(
        `\n[${result.model}] ${fixture.name}\n  label: ${verdict.label}  score: ${verdict.score}  suggested: ${verdict.suggestedRating}` +
          `\n  criteria: ${result.evaluation.criteria.map((c) => `${c.id}=${c.result}`).join(', ') || '(none)'}` +
          `\n  wrong: ${JSON.stringify([...result.evaluation.criticalMisconceptions, ...result.evaluation.incorrectClaims])}` +
          `\n  ${result.evaluation.uncertaintyReason ?? result.evaluation.explanation}`,
      );
      expect(fixture.expect).toContain(verdict.label);
      if (verdict.label === 'unable') expect(verdict.score).toBeNull();
    },
    180_000,
  );

  it('drafts a usable rubric', async () => {
    const draft = await service!.draftRubric({ question: FIXTURES[0]!.question, referenceAnswer: FIXTURES[0]!.referenceAnswer });
    console.log(`\n[${draft.model}] rubric draft\n${JSON.stringify(draft.rubric, null, 2)}`);
    expect(draft.rubric.criteria.length).toBeGreaterThan(0);
  }, 180_000);
});
