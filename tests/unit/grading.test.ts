import { describe, expect, it } from 'vitest';
import {
  buildAssessment,
  isGradable,
  scoreEvaluation,
  summarizeAssessments,
  validateEvaluation,
  validateRubricContent,
  type Evaluation,
  type RubricContent,
} from '../../src/domain/grading';
import { validateRecord } from '../../src/content/backup';
import type { Assessment, CriterionResult, Rubric } from '../../src/domain/types';

const rubric: RubricContent = {
  criteria: [
    { id: 'left', description: 'Keeps every left row', weight: 3, requiredConcepts: [], acceptableAlternatives: [] },
    { id: 'null', description: 'Unmatched right columns are NULL', weight: 2, requiredConcepts: [], acceptableAlternatives: [] },
  ],
  criticalMisconceptions: ['Drops unmatched left rows'],
};

function raw(results: [CriterionResult, CriterionResult], extra: Record<string, unknown> = {}) {
  return {
    status: 'assessed',
    criteria: [
      { id: 'left', result: results[0], evidence: 'keeps all customers' },
      { id: 'null', result: results[1], evidence: '' },
    ],
    incorrectClaims: [],
    contradictsReference: false,
    criticalMisconceptions: [],
    correctAspects: ['Explains preservation of left-table rows.'],
    missingAspects: [],
    explanation: 'Your main idea is correct.',
    uncertaintyReason: '',
    ...extra,
  };
}

function evaluate(results: [CriterionResult, CriterionResult], extra: Record<string, unknown> = {}): Evaluation {
  const checked = validateEvaluation(raw(results, extra), rubric);
  if (!checked.ok) throw new Error(checked.reason);
  return checked.value;
}

describe('rubric validation', () => {
  it('tidies text, drops blank list entries, and gives new criteria IDs', () => {
    const { value } = validateRubricContent({
      criteria: [
        { id: 'c1', description: '  First  ', weight: 2, requiredConcepts: ['a', '  ', ''], acceptableAlternatives: [] },
        { id: '', description: 'Second', weight: 1 },
      ],
      criticalMisconceptions: ['', ' wrong idea '],
    });
    expect(value).toEqual({
      criteria: [
        { id: 'c1', description: 'First', weight: 2, requiredConcepts: ['a'], acceptableAlternatives: [] },
        { id: 'c2', description: 'Second', weight: 1, requiredConcepts: [], acceptableAlternatives: [] },
      ],
      criticalMisconceptions: ['wrong idea'],
    });
  });

  it('requires 1 to 8 criteria with a description and a whole weight from 1 to 5', () => {
    const c = { description: 'x', weight: 1 };
    expect(validateRubricContent({ criteria: [] }).value).toBeNull();
    expect(validateRubricContent({ criteria: Array.from({ length: 9 }, () => c) }).value).toBeNull();
    expect(validateRubricContent({ criteria: [{ description: ' ', weight: 1 }] }).errors[0]).toMatch(/description/);
    for (const weight of [0, 6, 1.5, -1, '2']) {
      expect(validateRubricContent({ criteria: [{ description: 'x', weight }] }).errors[0]).toMatch(/weight/);
    }
    expect(
      validateRubricContent({
        criteria: [
          { id: 'a', ...c },
          { id: 'a', ...c },
        ],
      }).errors[0],
    ).toMatch(/repeats/);
  });
});

describe('evaluation validation', () => {
  it('accepts a complete result and keeps the rubric’s order', () => {
    const input = raw(['met', 'missing']);
    input.criteria.reverse();
    const checked = validateEvaluation(input, rubric);
    expect(checked.ok && checked.value.criteria.map((c) => c.id)).toEqual(['left', 'null']);
    expect(checked.ok && checked.value.uncertaintyReason).toBeNull();
  });

  it.each([
    ['not an object', 'nope'],
    ['unknown status', raw(['met', 'met'], { status: 'graded' })],
    ['unknown criterion', raw(['met', 'met'], { criteria: [{ id: 'other', result: 'met', evidence: '' }] })],
    ['a missing criterion', raw(['met', 'met'], { criteria: [{ id: 'left', result: 'met', evidence: '' }] })],
    [
      'a repeated criterion',
      raw(['met', 'met'], {
        criteria: [
          { id: 'left', result: 'met', evidence: '' },
          { id: 'left', result: 'met', evidence: '' },
        ],
      }),
    ],
    ['an unknown result', raw(['met', 'met'], { criteria: [{ id: 'left', result: 'excellent', evidence: '' }] })],
    ['evidence that is too long', raw(['met', 'met'], { criteria: [{ id: 'left', result: 'met', evidence: 'x'.repeat(601) }] })],
    ['a list that is not text', raw(['met', 'met'], { incorrectClaims: [1] })],
    ['too many list entries', raw(['met', 'met'], { missingAspects: Array.from({ length: 11 }, (_, i) => `m${i}`) })],
    ['a non-boolean contradiction flag', raw(['met', 'met'], { contradictsReference: 'no' })],
    ['an explanation that is too long', raw(['met', 'met'], { explanation: 'x'.repeat(3001) })],
    ['no explanation', raw(['met', 'met'], { explanation: ' ' })],
    ['a numeric score in place of text', raw(['met', 'met'], { explanation: 0.9 })],
  ])('rejects %s', (_name, input) => {
    expect(validateEvaluation(input, rubric).ok).toBe(false);
  });

  it('an unable-to-assess result needs a reason and carries no findings', () => {
    expect(validateEvaluation(raw(['met', 'met'], { status: 'unable_to_assess' }), rubric).ok).toBe(false);
    const checked = validateEvaluation(
      raw(['met', 'met'], { status: 'unable_to_assess', uncertaintyReason: 'The reference is ambiguous.' }),
      rubric,
    );
    expect(checked.ok && checked.value).toMatchObject({
      criteria: [],
      correctAspects: [],
      uncertaintyReason: 'The reference is ambiguous.',
    });
    expect(checked.ok && scoreEvaluation(checked.value, rubric)).toEqual({ score: null, label: 'unable', suggestedRating: null });
  });
});

describe('scoring', () => {
  it('computes weighted coverage with met 1, partial 0.5, missing 0', () => {
    expect(scoreEvaluation(evaluate(['met', 'met']), rubric).score).toBe(1);
    expect(scoreEvaluation(evaluate(['met', 'partial']), rubric).score).toBe(0.8);
    expect(scoreEvaluation(evaluate(['met', 'missing']), rubric).score).toBe(0.6);
    expect(scoreEvaluation(evaluate(['missing', 'met']), rubric).score).toBe(0.4);
    expect(scoreEvaluation(evaluate(['missing', 'missing']), rubric).score).toBe(0);
  });

  it('labels by threshold and suggests Good, Hard, or Again, never Easy', () => {
    expect(scoreEvaluation(evaluate(['met', 'met']), rubric)).toMatchObject({ label: 'correct', suggestedRating: 3 });
    expect(scoreEvaluation(evaluate(['met', 'partial']), rubric)).toMatchObject({ label: 'partial', suggestedRating: 2 });
    expect(scoreEvaluation(evaluate(['missing', 'met']), rubric)).toMatchObject({ label: 'partial', suggestedRating: 2 });
    expect(scoreEvaluation(evaluate(['partial', 'missing']), rubric)).toMatchObject({
      score: 0.3,
      label: 'incorrect',
      suggestedRating: 1,
    });
  });

  it('a critical misconception or a material contradiction is Incorrect whatever the coverage', () => {
    expect(
      scoreEvaluation(evaluate(['met', 'met'], { criticalMisconceptions: ['Drops unmatched left rows'] }), rubric),
    ).toMatchObject({
      score: 1,
      label: 'incorrect',
      suggestedRating: 1,
    });
    expect(scoreEvaluation(evaluate(['met', 'met'], { contradictsReference: true }), rubric).label).toBe('incorrect');
    // A wrong claim that isn't a material contradiction is reported, not punished.
    expect(scoreEvaluation(evaluate(['met', 'met'], { incorrectClaims: ['A side remark that is off.'] }), rubric).label).toBe(
      'correct',
    );
  });

  it('a typed answer needs at least one letter or digit', () => {
    expect(isGradable('  ...  ')).toBe(false);
    expect(isGradable('')).toBe(false);
    expect(isGradable('O(n)')).toBe(true);
    expect(isGradable('答え')).toBe(true);
  });
});

describe('assessment records', () => {
  const stored: Rubric = { id: 'card', cardId: 'card', version: 2, ...rubric, reviewed: true, createdAt: 1, updatedAt: 2 };
  const source = { provider: 'anthropic', model: 'claude-haiku-5-5', promptVersion: 'recall-grade-v1' };
  const attempt = { id: 'attempt', cardId: 'card', cardVersion: 3 };
  const build = (e: Evaluation): Assessment => buildAssessment(attempt, stored, e, source, 100);

  it('binds a result to its attempt, card version, and rubric version, and passes storage validation', () => {
    const a = build(evaluate(['met', 'partial']));
    expect(a).toMatchObject({
      id: 'attempt',
      attemptId: 'attempt',
      cardVersion: 3,
      rubricVersion: 2,
      score: 0.8,
      label: 'partial',
      suggestedRating: 2,
      model: 'claude-haiku-5-5',
      finalRating: null,
    });
    expect(validateRecord('assessments', a)).toEqual([]);
    expect(validateRecord('rubrics', stored)).toEqual([]);
  });

  it('storage validation refuses a tampered assessment', () => {
    const a = build(evaluate(['met', 'met']));
    expect(validateRecord('assessments', { ...a, suggestedRating: 4 })).not.toEqual([]);
    expect(validateRecord('assessments', { ...a, label: 'unable' })).not.toEqual([]);
    expect(validateRecord('assessments', { ...a, criteria: a.criteria.slice(1) })).not.toEqual([]);
    expect(validateRecord('assessments', { ...a, id: 'other' })).not.toEqual([]);
    expect(validateRecord('rubrics', { ...stored, criteria: [] })).not.toEqual([]);
  });

  it('summarizes for Progress: unable is excluded, agreement counts only committed ratings', () => {
    const unable = validateEvaluation(
      raw(['met', 'met'], { status: 'unable_to_assess', uncertaintyReason: 'Ambiguous.' }),
      rubric,
    );
    if (!unable.ok) throw new Error(unable.reason);
    const list: Assessment[] = [
      { ...build(evaluate(['met', 'met'])), finalRating: 3 },
      { ...build(evaluate(['met', 'met'])), finalRating: 4 },
      { ...build(evaluate(['met', 'partial'])), finalRating: 1 },
      build(evaluate(['missing', 'missing'])),
      build(unable.value),
    ];
    expect(summarizeAssessments(list)).toEqual({
      total: 5,
      scored: 4,
      unable: 1,
      labels: { correct: 2, partial: 1, incorrect: 1 },
      agreement: { count: 1, total: 3 },
      ratedHigher: 1,
      ratedLower: 1,
    });
  });
});
