// Rubrics and AI assessments in storage: an assessment is bound to its
// attempt, never moves a schedule, and records the learner's final rating
// separately from the suggestion (PRD AC20, AC21).

import { afterEach, describe, expect, it } from 'vitest';
import { buildBackup, validateBackup } from '../../src/content/backup';
import { buildAssessment, validateEvaluation, type RubricContent } from '../../src/domain/grading';
import type { Assessment, CardContent, CriterionResult } from '../../src/domain/types';
import { createRepository, type PracticeState, type Repository } from '../../src/storage/repository';
import { validateChange } from '../../src/sync/protocol';
import { hlcAt } from '../../src/sync/hlc';

const T0 = Date.UTC(2026, 10, 12, 18, 0, 0);
const MIN = 60_000;

let counter = 0;
const repos: Repository[] = [];
function freshRepo(): Repository {
  const repo = createRepository(`recall-grading-test-${Date.now()}-${counter++}`);
  repos.push(repo);
  return repo;
}
afterEach(async () => {
  await Promise.all(repos.splice(0).map((r) => r.close()));
});

const content: CardContent = {
  topic: 'SQL',
  question: 'What does a LEFT JOIN return?',
  answer: 'Every left row; unmatched right columns are NULL.',
  kind: 'recall',
  source: null,
  choices: null,
};

const rubricContent: RubricContent = {
  criteria: [
    { id: 'c1', description: 'Keeps every left row', weight: 3, requiredConcepts: [], acceptableAlternatives: [] },
    { id: 'c2', description: 'Unmatched right columns are NULL', weight: 2, requiredConcepts: [], acceptableAlternatives: [] },
  ],
  criticalMisconceptions: [],
};

/** A card with a saved rubric and a revealed attempt on it. */
async function revealed(repo: Repository, response = 'It keeps all the left rows.') {
  const added = await repo.addCards([content], T0);
  const cardId = added.cardIds[0]!;
  const rubric = await repo.saveRubric(cardId, rubricContent, T0);
  const started = await repo.startSession({ topics: null, size: 5, now: T0 + MIN });
  if (started.status !== 'started') throw new Error('no session');
  const attemptId = started.state.session.attempt!.id;
  const state = (await repo.reveal(
    started.state.session.id,
    attemptId,
    { response, confidence: null },
    T0 + 2 * MIN,
  )) as PracticeState;
  return { cardId, rubric, sessionId: state.session.id, attempt: state.session.attempt! };
}

async function assess(
  repo: Repository,
  ctx: Awaited<ReturnType<typeof revealed>>,
  results: [CriterionResult, CriterionResult] = ['met', 'missing'],
): Promise<Assessment> {
  const rubric = (await repo.getRubric(ctx.cardId))!;
  const checked = validateEvaluation(
    {
      status: 'assessed',
      criteria: [
        { id: 'c1', result: results[0], evidence: 'keeps all the left rows' },
        { id: 'c2', result: results[1], evidence: '' },
      ],
      incorrectClaims: [],
      contradictsReference: false,
      criticalMisconceptions: [],
      correctAspects: ['Left rows are kept.'],
      missingAspects: ['NULLs for unmatched rows.'],
      explanation: 'You have the main idea; also mention the NULLs.',
      uncertaintyReason: '',
    },
    rubric,
  );
  if (!checked.ok) throw new Error(checked.reason);
  return buildAssessment(
    ctx.attempt,
    rubric,
    checked.value,
    { provider: 'anthropic', model: 'claude-haiku-5-5', promptVersion: 'recall-grade-v1' },
    T0 + 3 * MIN,
  );
}

describe('rubrics', () => {
  it('saves one rubric per card, versioned, without touching the card or its schedule', async () => {
    const repo = freshRepo();
    const { cardIds } = await repo.addCards([content], T0);
    const before = await repo.loadWorkspace();
    const first = await repo.saveRubric(cardIds[0]!, rubricContent, T0 + MIN);
    expect(first).toMatchObject({ id: cardIds[0], cardId: cardIds[0], version: 1, reviewed: true, createdAt: T0 + MIN });
    // Saving the same content again is not a new version.
    expect((await repo.saveRubric(cardIds[0]!, rubricContent, T0 + 2 * MIN)).version).toBe(1);
    const edited = await repo.saveRubric(
      cardIds[0]!,
      { ...rubricContent, criticalMisconceptions: ['Drops unmatched left rows'] },
      T0 + 3 * MIN,
    );
    expect(edited).toMatchObject({ version: 2, createdAt: T0 + MIN, updatedAt: T0 + 3 * MIN });
    const after = await repo.loadWorkspace();
    expect(after.cards).toEqual(before.cards);
    expect(after.schedules).toEqual(before.schedules);
  });

  it('refuses an invalid rubric and a rubric for a deleted card', async () => {
    const repo = freshRepo();
    const { cardIds } = await repo.addCards([content], T0);
    await expect(repo.saveRubric(cardIds[0]!, { criteria: [], criticalMisconceptions: [] }, T0)).rejects.toThrow(/1 to 8/);
    await repo.deleteCard(cardIds[0]!, T0);
    await expect(repo.saveRubric(cardIds[0]!, rubricContent, T0)).rejects.toThrow(/no longer exists/);
    expect(await repo.getRubric(cardIds[0]!)).toBeNull();
  });
});

describe('assessments', () => {
  it('storing an assessment changes no schedule, review, or session position', async () => {
    const repo = freshRepo();
    const ctx = await revealed(repo);
    const before = await repo.loadWorkspace();
    const saved = await repo.saveAssessment(ctx.sessionId, await assess(repo, ctx), T0 + 3 * MIN);
    expect(saved.status).toBe('saved');
    const after = await repo.loadWorkspace();
    expect(after.schedules).toEqual(before.schedules);
    expect(after.reviews).toEqual([]);
    expect(after.activeSession).toEqual(before.activeSession);
    expect(after.assessments).toHaveLength(1);
    expect(after.assessments[0]).toMatchObject({ label: 'partial', suggestedRating: 2, finalRating: null });
  });

  it('keeps one assessment per attempt: a second save returns the first', async () => {
    const repo = freshRepo();
    const ctx = await revealed(repo);
    const first = await assess(repo, ctx, ['met', 'missing']);
    await repo.saveAssessment(ctx.sessionId, first, T0 + 3 * MIN);
    const again = await repo.saveAssessment(ctx.sessionId, await assess(repo, ctx, ['met', 'met']), T0 + 4 * MIN);
    expect(again).toEqual({ status: 'duplicate', assessment: first });
    expect((await repo.getGrading(ctx.cardId, ctx.attempt.id)).assessment).toEqual(first);
  });

  it('rejects a stale result: card edited, rubric changed, or attempt gone', async () => {
    const edited = freshRepo();
    let ctx = await revealed(edited);
    let assessment = await assess(edited, ctx);
    await edited.updateCard(ctx.cardId, { ...content, answer: 'A new answer.' }, T0 + 3 * MIN);
    expect(await edited.saveAssessment(ctx.sessionId, assessment, T0 + 4 * MIN)).toEqual({ status: 'stale', reason: 'edited' });

    const rubricChanged = freshRepo();
    ctx = await revealed(rubricChanged);
    assessment = await assess(rubricChanged, ctx);
    await rubricChanged.saveRubric(ctx.cardId, { ...rubricContent, criticalMisconceptions: ['New'] }, T0 + 3 * MIN);
    expect(await rubricChanged.saveAssessment(ctx.sessionId, assessment, T0 + 4 * MIN)).toEqual({
      status: 'stale',
      reason: 'rubric-changed',
    });

    const moved = freshRepo();
    ctx = await revealed(moved);
    assessment = await assess(moved, ctx);
    await moved.endSession(ctx.sessionId, T0 + 3 * MIN);
    expect(await moved.saveAssessment(ctx.sessionId, assessment, T0 + 4 * MIN)).toEqual({
      status: 'stale',
      reason: 'session-changed',
    });
    for (const repo of [edited, rubricChanged, moved]) expect((await repo.loadWorkspace()).assessments).toEqual([]);
  });

  it('refuses an assessment that fails validation, or one for an unrevealed attempt', async () => {
    const repo = freshRepo();
    const ctx = await revealed(repo);
    const assessment = await assess(repo, ctx);
    await expect(repo.saveAssessment(ctx.sessionId, { ...assessment, suggestedRating: 4 as 3 }, T0)).rejects.toThrow();

    const unrevealed = freshRepo();
    const { cardIds } = await unrevealed.addCards([content], T0);
    await unrevealed.saveRubric(cardIds[0]!, rubricContent, T0);
    const started = await unrevealed.startSession({ topics: null, size: 5, now: T0 + MIN });
    if (started.status !== 'started') throw new Error('no session');
    const attempt = started.state.session.attempt!;
    const early = { ...assessment, id: attempt.id, attemptId: attempt.id, cardId: cardIds[0]! };
    expect(await unrevealed.saveAssessment(started.state.session.id, early, T0 + 2 * MIN)).toEqual({
      status: 'stale',
      reason: 'session-changed',
    });
  });

  it('AC21: an override drives scheduling; the suggestion and the reason stay on the assessment', async () => {
    const repo = freshRepo();
    const ctx = await revealed(repo);
    await repo.saveAssessment(ctx.sessionId, await assess(repo, ctx, ['met', 'missing']), T0 + 3 * MIN);
    // Suggested Hard (2); the learner chooses Good (3).
    const result = await repo.commitReview(ctx.sessionId, ctx.attempt.id, 3, T0 + 4 * MIN, '  I said the NULL part aloud.  ');
    if (result.status !== 'committed') throw new Error(result.status);
    expect(result.review.rating).toBe(3);

    const same = freshRepo();
    const plain = await revealed(same);
    const control = await same.commitReview(plain.sessionId, plain.attempt.id, 3, T0 + 4 * MIN);
    if (control.status !== 'committed') throw new Error(control.status);
    // Exactly the schedule a Good rating gives without any AI involved.
    expect(result.review.after).toEqual(control.review.after);

    const stored = (await repo.getGrading(ctx.cardId, ctx.attempt.id)).assessment!;
    expect(stored).toMatchObject({
      suggestedRating: 2,
      label: 'partial',
      finalRating: 3,
      overrideReason: 'I said the NULL part aloud.',
      finalizedAt: T0 + 4 * MIN,
    });
    expect(stored.id).toBe(result.review.id);
  });

  it('agreeing with the suggestion records the rating and drops any reason', async () => {
    const repo = freshRepo();
    const ctx = await revealed(repo);
    await repo.saveAssessment(ctx.sessionId, await assess(repo, ctx, ['met', 'missing']), T0 + 3 * MIN);
    await repo.commitReview(ctx.sessionId, ctx.attempt.id, 2, T0 + 4 * MIN, 'not needed');
    expect((await repo.getGrading(ctx.cardId, ctx.attempt.id)).assessment).toMatchObject({
      finalRating: 2,
      overrideReason: null,
    });
  });

  it('a retried commit does not finalize twice or change the assessment', async () => {
    const repo = freshRepo();
    const ctx = await revealed(repo);
    await repo.saveAssessment(ctx.sessionId, await assess(repo, ctx), T0 + 3 * MIN);
    await repo.commitReview(ctx.sessionId, ctx.attempt.id, 1, T0 + 4 * MIN, 'first');
    const retry = await repo.commitReview(ctx.sessionId, ctx.attempt.id, 4, T0 + 5 * MIN, 'second');
    expect(retry.status).toBe('duplicate');
    expect((await repo.getGrading(ctx.cardId, ctx.attempt.id)).assessment).toMatchObject({
      finalRating: 1,
      overrideReason: 'first',
      finalizedAt: T0 + 4 * MIN,
    });
  });

  it('rubrics and assessments survive a backup and restore, and pass the sync server’s checks', async () => {
    const repo = freshRepo();
    const ctx = await revealed(repo);
    await repo.saveAssessment(ctx.sessionId, await assess(repo, ctx), T0 + 3 * MIN);
    await repo.commitReview(ctx.sessionId, ctx.attempt.id, 3, T0 + 4 * MIN, 'why');
    const data = await repo.exportWorkspace();
    expect(data.rubrics).toHaveLength(1);
    expect(data.assessments).toHaveLength(1);
    const checked = validateBackup(JSON.parse(JSON.stringify(buildBackup(data, T0 + 5 * MIN))));
    if (!checked.ok) throw new Error(checked.errors.join(' '));
    expect(checked.counts).toMatchObject({ rubrics: 1, assessments: 1 });
    const other = freshRepo();
    await other.replaceWorkspace(checked.data);
    expect(await other.getRubric(ctx.cardId)).toEqual(data.rubrics[0]);
    expect((await other.loadWorkspace()).assessments).toEqual(data.assessments);

    const hlc = hlcAt(T0, 'device-a');
    expect(validateChange({ store: 'rubrics', key: ctx.cardId, hlc, value: data.rubrics[0] }).ok).toBe(true);
    expect(validateChange({ store: 'assessments', key: ctx.attempt.id, hlc, value: data.assessments[0] }).ok).toBe(true);
    expect(validateChange({ store: 'assessments', key: ctx.attempt.id, hlc, value: { id: ctx.attempt.id } }).ok).toBe(false);
  });

  it('queues rubric and assessment changes for sync, and keeps the AI mode on the device', async () => {
    const repo = freshRepo();
    await repo.connectSync(
      { url: 'https://recall.test/', key: 'k'.repeat(20), deviceId: 'device-a', serverId: 's1', connectedAt: T0 },
      'upload',
      T0,
    );
    await repo.saveAiMode('server');
    const ctx = await revealed(repo);
    await repo.saveAssessment(ctx.sessionId, await assess(repo, ctx), T0 + 3 * MIN);
    await repo.commitReview(ctx.sessionId, ctx.attempt.id, 2, T0 + 4 * MIN);
    const { items } = await repo.readOutbox(100);
    const queued = items.map((i) => `${i.change.store}/${i.change.key}`);
    expect(queued).toContain(`rubrics/${ctx.cardId}`);
    expect(queued).toContain(`assessments/${ctx.attempt.id}`);
    expect(items.find((i) => i.change.store === 'assessments')!.change.value).toMatchObject({ finalRating: 2 });
    expect(items.some((i) => i.change.store === 'preferences')).toBe(false);
    expect((await repo.loadWorkspace()).aiMode).toBe('server');
    // Not part of a backup: a restore elsewhere starts with AI feedback off.
    expect(JSON.stringify(await repo.exportWorkspace())).not.toContain('aiMode":"server');
    const fresh = freshRepo();
    expect((await fresh.loadWorkspace()).aiMode).toBe('off');
  });
});
