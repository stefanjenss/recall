// Rubrics and AI assessments: validation and scoring. Pure.
//
// The evaluator (a model behind the sync server) only reports what it found:
// a result per rubric criterion, wrong claims, and misconceptions. Everything
// here is checked before it is shown, and the score, label, and suggested
// rating are computed in this file, never taken from the model.

import { charCount } from './limits';
import {
  CRITERION_RESULTS,
  type Assessment,
  type AssessmentLabel,
  type AssessmentStatus,
  type CriterionAssessment,
  type Rubric,
  type RubricCriterion,
} from './types';

export const RUBRIC_LIMITS = {
  minCriteria: 1,
  maxCriteria: 8,
  description: 300,
  minWeight: 1,
  maxWeight: 5,
  /** Entries per list (required concepts, acceptable alternatives, misconceptions). */
  listItems: 8,
  listItem: 300,
} as const;

export const EVALUATION_LIMITS = {
  evidence: 600,
  listItems: 10,
  listItem: 600,
  explanation: 3000,
  uncertaintyReason: 1000,
} as const;

/** Product defaults from PRD section 9, not validated measures of mastery. */
export const CORRECT_THRESHOLD = 0.85;
export const PARTIAL_THRESHOLD = 0.4;

export const OVERRIDE_REASON_LIMIT = 500;

/** What a learner edits: a rubric without its bookkeeping. */
export interface RubricContent {
  criteria: RubricCriterion[];
  criticalMisconceptions: string[];
}

export function newCriterionId(taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let n = 1; ; n += 1) {
    const id = `c${n}`;
    if (!used.has(id)) return id;
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

function cleanList(value: unknown, label: string, errors: string[]): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((x) => typeof x !== 'string')) {
    errors.push(`${label} must be a list of text.`);
    return [];
  }
  const items = (value as string[]).map((x) => x.trim()).filter((x) => x !== '');
  if (items.length > RUBRIC_LIMITS.listItems) errors.push(`${label} can have at most ${RUBRIC_LIMITS.listItems} entries.`);
  if (items.some((x) => charCount(x) > RUBRIC_LIMITS.listItem)) {
    errors.push(`Each entry in ${label.toLowerCase()} can be at most ${RUBRIC_LIMITS.listItem} characters.`);
  }
  return items;
}

/**
 * Check and tidy a rubric: text is trimmed and blank list entries dropped.
 * Criteria without an ID get one. Returns every problem found.
 */
export function validateRubricContent(input: unknown): { value: RubricContent | null; errors: string[] } {
  const errors: string[] = [];
  if (!isObj(input) || !Array.isArray(input.criteria)) return { value: null, errors: ['A rubric needs a list of criteria.'] };
  const { minCriteria, maxCriteria } = RUBRIC_LIMITS;
  const rawCriteria: unknown[] = input.criteria;
  const givenIds = rawCriteria.flatMap((c) => (isObj(c) && typeof c.id === 'string' ? [c.id.trim()] : []));
  if (rawCriteria.length < minCriteria || rawCriteria.length > maxCriteria) {
    errors.push(`A rubric needs ${minCriteria} to ${maxCriteria} criteria.`);
  }
  const ids = new Set<string>();
  const criteria: RubricCriterion[] = [];
  rawCriteria.forEach((raw, i) => {
    const label = `Criterion ${i + 1}`;
    if (!isObj(raw)) {
      errors.push(`${label} is malformed.`);
      return;
    }
    const description = typeof raw.description === 'string' ? raw.description.trim() : '';
    if (description === '') errors.push(`${label} needs a description.`);
    else if (charCount(description) > RUBRIC_LIMITS.description) {
      errors.push(`${label}'s description can be at most ${RUBRIC_LIMITS.description} characters.`);
    }
    const weight = raw.weight;
    if (
      typeof weight !== 'number' ||
      !Number.isInteger(weight) ||
      weight < RUBRIC_LIMITS.minWeight ||
      weight > RUBRIC_LIMITS.maxWeight
    ) {
      errors.push(`${label}'s weight must be a whole number from ${RUBRIC_LIMITS.minWeight} to ${RUBRIC_LIMITS.maxWeight}.`);
    }
    let id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (id !== '' && !/^[A-Za-z0-9_-]{1,40}$/.test(id)) errors.push(`${label} has a malformed ID.`);
    if (id !== '' && ids.has(id)) errors.push(`${label} repeats the ID of another criterion.`);
    if (id === '') id = newCriterionId([...ids, ...givenIds]);
    ids.add(id);
    criteria.push({
      id,
      description,
      weight: typeof weight === 'number' ? weight : 1,
      requiredConcepts: cleanList(raw.requiredConcepts, `${label}'s required concepts`, errors),
      acceptableAlternatives: cleanList(raw.acceptableAlternatives, `${label}'s acceptable alternatives`, errors),
    });
  });
  const criticalMisconceptions = cleanList(input.criticalMisconceptions, 'Critical misconceptions', errors);
  return errors.length > 0 ? { value: null, errors } : { value: { criteria, criticalMisconceptions }, errors };
}

export function sameRubricContent(a: RubricContent, b: RubricContent): boolean {
  return (
    JSON.stringify({ c: a.criteria, m: a.criticalMisconceptions }) ===
    JSON.stringify({ c: b.criteria, m: b.criticalMisconceptions })
  );
}

// ---------------------------------------------------------------------------
// Evaluator output

/** What an evaluator returns for one answer, before the app scores it. */
export interface Evaluation {
  status: AssessmentStatus;
  criteria: CriterionAssessment[];
  incorrectClaims: string[];
  contradictsReference: boolean;
  criticalMisconceptions: string[];
  correctAspects: string[];
  missingAspects: string[];
  explanation: string;
  uncertaintyReason: string | null;
}

export type EvaluationCheck = { ok: true; value: Evaluation } | { ok: false; reason: string };

function textList(o: Obj, key: string): string[] | string {
  const v = o[key];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return `"${key}" must be a list of text.`;
  const items = (v as string[]).map((x) => x.trim()).filter((x) => x !== '');
  if (items.length > EVALUATION_LIMITS.listItems) return `"${key}" has more than ${EVALUATION_LIMITS.listItems} entries.`;
  if (items.some((x) => charCount(x) > EVALUATION_LIMITS.listItem)) return `An entry in "${key}" is too long.`;
  return items;
}

/**
 * Check an evaluator's output against the rubric it was given: every enum,
 * length, and ID. An assessed result must cover each criterion exactly once.
 * Anything else is rejected whole rather than repaired.
 */
export function validateEvaluation(raw: unknown, rubric: RubricContent): EvaluationCheck {
  const bad = (reason: string): EvaluationCheck => ({ ok: false, reason });
  if (!isObj(raw)) return bad('The result is not an object.');
  if (raw.status !== 'assessed' && raw.status !== 'unable_to_assess') return bad('"status" has an unsupported value.');
  const status: AssessmentStatus = raw.status;

  const lists: Record<string, string[]> = {};
  for (const key of ['incorrectClaims', 'criticalMisconceptions', 'correctAspects', 'missingAspects']) {
    const list = textList(raw, key);
    if (typeof list === 'string') return bad(list);
    lists[key] = list;
  }
  if (typeof raw.explanation !== 'string') return bad('"explanation" must be text.');
  const explanation = raw.explanation.trim();
  if (charCount(explanation) > EVALUATION_LIMITS.explanation) return bad('"explanation" is too long.');
  if (typeof raw.contradictsReference !== 'boolean') return bad('"contradictsReference" must be true or false.');
  const rawReason = raw.uncertaintyReason;
  if (rawReason !== null && rawReason !== undefined && typeof rawReason !== 'string') {
    return bad('"uncertaintyReason" must be text or null.');
  }
  const reason = typeof rawReason === 'string' ? rawReason.trim() : '';
  if (charCount(reason) > EVALUATION_LIMITS.uncertaintyReason) return bad('"uncertaintyReason" is too long.');

  if (!Array.isArray(raw.criteria)) return bad('"criteria" must be a list.');
  const criteria: CriterionAssessment[] = [];
  const seen = new Set<string>();
  const known = new Set(rubric.criteria.map((c) => c.id));
  for (const item of raw.criteria) {
    if (!isObj(item) || typeof item.id !== 'string') return bad('A criterion result is malformed.');
    if (!known.has(item.id)) return bad(`The result names a criterion that isn't in the rubric (${item.id.slice(0, 40)}).`);
    if (seen.has(item.id)) return bad(`The result repeats criterion ${item.id}.`);
    seen.add(item.id);
    if (!(CRITERION_RESULTS as readonly unknown[]).includes(item.result))
      return bad(`Criterion ${item.id} has an unsupported result.`);
    if (typeof item.evidence !== 'string') return bad(`Criterion ${item.id} has no evidence text.`);
    const evidence = item.evidence.trim();
    if (charCount(evidence) > EVALUATION_LIMITS.evidence) return bad(`Criterion ${item.id}'s evidence is too long.`);
    criteria.push({ id: item.id, result: item.result as CriterionAssessment['result'], evidence });
  }

  if (status === 'unable_to_assess') {
    if (reason === '') return bad('An unable-to-assess result must say why.');
    // No partial verdicts: nothing from an unassessable answer is scored or shown as a finding.
    return {
      ok: true,
      value: {
        status,
        criteria: [],
        incorrectClaims: [],
        contradictsReference: false,
        criticalMisconceptions: [],
        correctAspects: [],
        missingAspects: [],
        explanation,
        uncertaintyReason: reason,
      },
    };
  }

  if (seen.size !== known.size) return bad('The result does not cover every rubric criterion.');
  if (explanation === '') return bad('An assessed result needs an explanation.');
  // Keep the rubric's order, whatever order the evaluator used.
  const byId = new Map(criteria.map((c) => [c.id, c]));
  return {
    ok: true,
    value: {
      status,
      criteria: rubric.criteria.map((c) => byId.get(c.id)!),
      incorrectClaims: lists.incorrectClaims!,
      contradictsReference: raw.contradictsReference,
      criticalMisconceptions: lists.criticalMisconceptions!,
      correctAspects: lists.correctAspects!,
      missingAspects: lists.missingAspects!,
      explanation,
      uncertaintyReason: null,
    },
  };
}

const RESULT_VALUE = { met: 1, partial: 0.5, missing: 0 } as const;

export interface Verdict {
  score: number | null;
  label: AssessmentLabel;
  suggestedRating: 1 | 2 | 3 | null;
}

/**
 * Weighted coverage, label, and suggested rating for a validated evaluation.
 * A critical misconception or a material contradiction makes it Incorrect
 * whatever the coverage. Easy is never suggested from one graded answer.
 */
export function scoreEvaluation(evaluation: Evaluation, rubric: RubricContent): Verdict {
  if (evaluation.status === 'unable_to_assess') return { score: null, label: 'unable', suggestedRating: null };
  const weights = new Map(rubric.criteria.map((c) => [c.id, c.weight]));
  let total = 0;
  let earned = 0;
  for (const c of evaluation.criteria) {
    const w = weights.get(c.id) ?? 0;
    total += w;
    earned += w * RESULT_VALUE[c.result];
  }
  const score = total > 0 ? Math.round((earned / total) * 1000) / 1000 : 0;
  if (evaluation.criticalMisconceptions.length > 0 || evaluation.contradictsReference) {
    return { score, label: 'incorrect', suggestedRating: 1 };
  }
  if (score >= CORRECT_THRESHOLD) return { score, label: 'correct', suggestedRating: 3 };
  if (score >= PARTIAL_THRESHOLD) return { score, label: 'partial', suggestedRating: 2 };
  return { score, label: 'incorrect', suggestedRating: 1 };
}

/** A typed answer with something in it to grade. */
export function isGradable(response: string): boolean {
  return /[\p{L}\p{N}]/u.test(response);
}

export interface AssessmentSource {
  provider: string;
  model: string;
  promptVersion: string;
}

/** Build the stored record for a validated evaluation of one attempt. */
export function buildAssessment(
  attempt: { id: string; cardId: string; cardVersion: number },
  rubric: Rubric,
  evaluation: Evaluation,
  source: AssessmentSource,
  now: number,
): Assessment {
  const content = { criteria: rubric.criteria, criticalMisconceptions: rubric.criticalMisconceptions };
  return {
    id: attempt.id,
    attemptId: attempt.id,
    cardId: attempt.cardId,
    cardVersion: attempt.cardVersion,
    rubricVersion: rubric.version,
    rubric: content,
    ...evaluation,
    ...scoreEvaluation(evaluation, content),
    provider: source.provider,
    model: source.model,
    promptVersion: source.promptVersion,
    createdAt: now,
    finalRating: null,
    overrideReason: null,
    finalizedAt: null,
  };
}

// ---------------------------------------------------------------------------
// Progress

export interface AssessmentSummary {
  /** Every stored assessment, including unable-to-assess ones. */
  total: number;
  /** Assessed results: the denominator for the label shares. */
  scored: number;
  unable: number;
  labels: Record<Exclude<AssessmentLabel, 'unable'>, number>;
  /** Committed reviews that had a suggestion, and how many the learner's rating matched. */
  agreement: { count: number; total: number };
  /** Of the committed disagreements, how many the learner rated higher than suggested. */
  ratedHigher: number;
  ratedLower: number;
}

export function summarizeAssessments(assessments: Assessment[]): AssessmentSummary {
  const s: AssessmentSummary = {
    total: assessments.length,
    scored: 0,
    unable: 0,
    labels: { correct: 0, partial: 0, incorrect: 0 },
    agreement: { count: 0, total: 0 },
    ratedHigher: 0,
    ratedLower: 0,
  };
  for (const a of assessments) {
    if (a.label === 'unable') {
      s.unable += 1;
      continue;
    }
    s.scored += 1;
    s.labels[a.label] += 1;
    if (a.finalRating === null || a.suggestedRating === null) continue;
    s.agreement.total += 1;
    if (a.finalRating === a.suggestedRating) s.agreement.count += 1;
    else if (a.finalRating > a.suggestedRating) s.ratedHigher += 1;
    else s.ratedLower += 1;
  }
  return s;
}
