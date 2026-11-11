import { openDB } from 'idb';
import { afterEach, describe, expect, it } from 'vitest';
import { BACKUP_FORMAT_VERSION, buildBackup, parseBackupText, validateBackup } from '../../src/content/backup';
import { STARTER_CARDS } from '../../src/content/starter';
import { DAY_MS } from '../../src/domain/scheduler';
import type { CardContent } from '../../src/domain/types';
import { createRepository, type PracticeState, type Repository } from '../../src/storage/repository';
import { validateChange } from '../../src/sync/protocol';

const T0 = Date.UTC(2026, 9, 12, 18, 0, 0);
const MIN = 60_000;

let counter = 0;
const repos: Repository[] = [];
function freshRepo(): Repository {
  const repo = createRepository(`recall-test-${Date.now()}-${counter++}`);
  repos.push(repo);
  return repo;
}
afterEach(async () => {
  await Promise.all(repos.splice(0).map((r) => r.close()));
});

const card = (question: string, topic = 'General'): CardContent => ({
  topic,
  question,
  answer: `Answer to ${question}`,
  kind: 'recall',
  source: null,
  choices: null,
});

// Records exactly as storage schema 1 / backup format 1 wrote them, before quick checks.
const V1_CONTENT = { topic: 'SQL', question: 'Q1', answer: 'A1', kind: 'recall', source: null };
const V1 = {
  cards: [
    { id: 'c1', ...V1_CONTENT, contentVersion: 1, createdAt: T0 - 5 * DAY_MS, updatedAt: T0 - 5 * DAY_MS, deletedAt: null },
    {
      id: 'c2',
      ...V1_CONTENT,
      question: 'Q2',
      contentVersion: 1,
      createdAt: T0 - 5 * DAY_MS,
      updatedAt: T0 - 5 * DAY_MS,
      deletedAt: null,
    },
  ],
  schedules: [
    {
      cardId: 'c1',
      dueAt: T0 - DAY_MS,
      intervalDays: 1,
      ease: 2.5,
      reviewCount: 1,
      lapseCount: 0,
      paused: false,
      schedulerVersion: 'recall-sm2-v1',
      stateVersion: 1,
      lastReviewedAt: T0 - 2 * DAY_MS,
    },
    {
      cardId: 'c2',
      dueAt: T0 - 5 * DAY_MS,
      intervalDays: 0,
      ease: 2.5,
      reviewCount: 0,
      lapseCount: 0,
      paused: false,
      schedulerVersion: 'recall-sm2-v1',
      stateVersion: 0,
      lastReviewedAt: null,
    },
  ],
  reviews: [
    {
      id: 'r1',
      cardId: 'c1',
      cardVersion: 1,
      sessionId: 's0',
      response: 'my answer',
      confidence: 'somewhat',
      rating: 3,
      before: { dueAt: T0 - 5 * DAY_MS, intervalDays: 0, ease: 2.5, reviewCount: 0, lapseCount: 0, stateVersion: 0 },
      after: { dueAt: T0 - DAY_MS, intervalDays: 1, ease: 2.5, reviewCount: 1, lapseCount: 0, stateVersion: 1 },
      schedulerVersion: 'recall-sm2-v1',
      startedAt: T0 - 2 * DAY_MS,
      revealedAt: T0 - 2 * DAY_MS,
      committedAt: T0 - 2 * DAY_MS,
      snapshot: V1_CONTENT,
    },
  ],
  sessions: [
    {
      id: 's1',
      topics: null,
      size: 20,
      queue: ['c1', 'c2'],
      index: 0,
      status: 'active',
      startedAt: T0 - MIN,
      endedAt: null,
      attempt: {
        id: 'att-1',
        cardId: 'c1',
        cardVersion: 1,
        expectedStateVersion: 1,
        response: 'draft',
        confidence: null,
        revealed: false,
        startedAt: T0 - MIN,
        revealedAt: null,
      },
      results: [],
    },
  ],
};

/** Create a database at storage schema 1, holding the V1 records. */
async function seedVersion1Database(name: string): Promise<void> {
  const db = await openDB(name, 1, {
    upgrade(d) {
      d.createObjectStore('cards', { keyPath: 'id' });
      d.createObjectStore('schedules', { keyPath: 'cardId' });
      const reviews = d.createObjectStore('reviews', { keyPath: 'id' });
      reviews.createIndex('byCard', 'cardId');
      reviews.createIndex('byCommittedAt', 'committedAt');
      reviews.createIndex('bySession', 'sessionId');
      d.createObjectStore('sessions', { keyPath: 'id' }).createIndex('byStatus', 'status');
      d.createObjectStore('reflections', { keyPath: 'id' }).createIndex('byCreatedAt', 'createdAt');
      d.createObjectStore('rubrics', { keyPath: 'id' }).createIndex('byCard', 'cardId');
      d.createObjectStore('assessments', { keyPath: 'id' }).createIndex('byAttempt', 'attemptId');
      d.createObjectStore('importBatches', { keyPath: 'id' });
      d.createObjectStore('meta', { keyPath: 'key' });
    },
  });
  const tx = db.transaction(['cards', 'schedules', 'reviews', 'sessions'], 'readwrite');
  await Promise.all([
    ...V1.cards.map((c) => tx.objectStore('cards').add(c)),
    ...V1.schedules.map((sc) => tx.objectStore('schedules').add(sc)),
    ...V1.reviews.map((r) => tx.objectStore('reviews').add(r)),
    ...V1.sessions.map((se) => tx.objectStore('sessions').add(se)),
  ]);
  await tx.done;
  db.close();
}

const withChoices = (question: string, topic = 'General'): CardContent => ({
  ...card(question, topic),
  choices: { correct: `Right: ${question}`, distractors: [`Wrong 1: ${question}`, `Wrong 2: ${question}`] },
});

async function quickState(repo: Repository, now = T0, size = 20): Promise<PracticeState> {
  const result = await repo.startSession({ topics: null, size, now, mode: 'quick-check' });
  if (result.status !== 'started') throw new Error(`expected started, got ${result.status}`);
  return result.state;
}

/** Index of the correct option, or of a wrong one. */
function optionIndex(state: PracticeState, correct: boolean): number {
  const right = state.card!.choices!.correct;
  return state.session.attempt!.options!.findIndex((o) => (o === right) === correct);
}

async function pickAndSave(repo: Repository, state: PracticeState, correct: boolean, now: number) {
  const attempt = state.session.attempt!;
  await repo.pickOption(state.session.id, attempt.id, optionIndex(state, correct), now);
  return repo.commitQuickCheck(state.session.id, attempt.id, now);
}

async function startedState(repo: Repository, now = T0, size = 20): Promise<PracticeState> {
  const result = await repo.startSession({ topics: null, size, now });
  if (result.status !== 'started') throw new Error(`expected started, got ${result.status}`);
  return result.state;
}

async function revealAndRate(repo: Repository, state: PracticeState, rating: 1 | 2 | 3 | 4, now: number) {
  const attempt = state.session.attempt!;
  await repo.reveal(state.session.id, attempt.id, { response: 'my answer', confidence: 'somewhat' }, now);
  return repo.commitReview(state.session.id, attempt.id, rating, now);
}

describe('repository: cards', () => {
  it('AC01: adds cards and completes a persisted session with no external services', async () => {
    const repo = freshRepo();
    await repo.addCards([card('Q1'), card('Q2')], T0);
    let state = await startedState(repo);
    expect(state.session.queue).toHaveLength(2);
    let result = await revealAndRate(repo, state, 3, T0 + MIN);
    expect(result.status).toBe('committed');
    if (result.status !== 'committed') return;
    state = result.state;
    result = await revealAndRate(repo, state, 1, T0 + 2 * MIN);
    if (result.status !== 'committed') throw new Error('expected commit');
    expect(result.state.session.status).toBe('completed');

    const ws = await repo.loadWorkspace();
    expect(ws.reviews).toHaveLength(2);
    expect(ws.activeSession).toBeNull();
    const dues = ws.schedules.map((s) => s.dueAt - (T0 + MIN)).sort((a, b) => a - b);
    expect(dues).toEqual([10 * MIN + MIN, DAY_MS].sort((a, b) => a - b));
  });

  it('new cards start with interval 0, ease 2.5, zero counts, unpaused, due now', async () => {
    const repo = freshRepo();
    await repo.addCards([card('Q1')], T0);
    const [s] = (await repo.loadWorkspace()).schedules;
    expect(s).toMatchObject({ dueAt: T0, intervalDays: 0, ease: 2.5, reviewCount: 0, lapseCount: 0, paused: false });
  });

  it('rejects an invalid batch without writing any of it', async () => {
    const repo = freshRepo();
    await expect(repo.addCards([card('ok'), { ...card('bad'), answer: '' }], T0)).rejects.toThrow(/Answer is required/);
    expect((await repo.loadWorkspace()).cards).toHaveLength(0);
  });

  it('AC04: retrying the same import batch does not add it twice', async () => {
    const repo = freshRepo();
    const first = await repo.addCards([card('Q1'), card('Q2')], T0, 'batch-1');
    const retry = await repo.addCards([card('Q1'), card('Q2')], T0, 'batch-1');
    expect(first.status).toBe('added');
    expect(retry).toEqual({ status: 'already-imported', cardIds: first.cardIds });
    expect((await repo.loadWorkspace()).cards).toHaveLength(2);
  });

  it('adding the starter collection twice skips identical samples', async () => {
    const repo = freshRepo();
    expect(await repo.addMissingCards(STARTER_CARDS, T0)).toEqual({ added: 6, skipped: 0 });
    expect(await repo.addMissingCards(STARTER_CARDS, T0)).toEqual({ added: 0, skipped: 6 });
    expect((await repo.loadWorkspace()).cards).toHaveLength(6);
  });

  it('AC11: edits keep scheduling and bump the content version; pause, resume, delete follow eligibility rules', async () => {
    const repo = freshRepo();
    const { cardIds } = await repo.addCards([card('Q1'), card('Q2')], T0);
    const [id1, id2] = cardIds as [string, string];

    // Review Q1 so it has a real schedule, then edit it.
    let state = await startedState(repo);
    const firstId = state.card!.id;
    const originalQuestion = state.card!.question;
    await revealAndRate(repo, state, 3, T0);
    await repo.endSession(state.session.id, T0);
    const before = (await repo.loadWorkspace()).schedules.find((s) => s.cardId === firstId)!;
    const edited = await repo.updateCard(firstId, { ...card('Q1 edited'), topic: 'New topic' }, T0 + MIN);
    expect(edited.contentVersion).toBe(2);
    const after = (await repo.loadWorkspace()).schedules.find((s) => s.cardId === firstId)!;
    expect(after).toEqual(before);

    // An unchanged save doesn't bump the version.
    expect((await repo.updateCard(firstId, { ...card('Q1 edited'), topic: 'New topic' }, T0 + 2 * MIN)).contentVersion).toBe(2);

    // Pause excludes from practice; resume keeps the due time.
    const other = firstId === id1 ? id2 : id1;
    const paused = await repo.setPaused(other, true, T0);
    expect((await repo.startSession({ topics: null, size: 20, now: T0 + MIN })).status).toBe('empty');
    const resumed = await repo.setPaused(other, false, T0);
    expect(resumed.dueAt).toBe(paused.dueAt);
    state = await startedState(repo, T0 + MIN);
    expect(state.session.queue).toEqual([other]);
    await repo.endSession(state.session.id, T0 + MIN);

    // Delete excludes the card but keeps its review history.
    await repo.deleteCard(firstId, T0 + 3 * MIN);
    const ws = await repo.loadWorkspace();
    expect(ws.cards.find((c) => c.id === firstId)!.deletedAt).toBe(T0 + 3 * MIN);
    expect(ws.reviews.filter((r) => r.cardId === firstId)).toHaveLength(1);
    expect(ws.reviews[0]!.snapshot.question).toBe(originalQuestion);
    const later = await repo.startSession({ topics: null, size: 20, now: T0 + 2 * DAY_MS });
    expect(later.status === 'started' && later.state.session.queue).toEqual([other]);
  });

  it('reset progress returns a card to new without deleting history', async () => {
    const repo = freshRepo();
    await repo.addCards([card('Q1')], T0);
    const state = await startedState(repo);
    await revealAndRate(repo, state, 4, T0);
    const reset = await repo.resetProgress(state.card!.id, T0 + MIN);
    expect(reset).toMatchObject({ intervalDays: 0, ease: 2.5, reviewCount: 0, dueAt: T0 + MIN, stateVersion: 2 });
    expect((await repo.loadWorkspace()).reviews).toHaveLength(1);
  });
});

describe('repository: sessions and reviews', () => {
  it('AC08: the current card, draft, confidence, reveal state, and queue survive a reload', async () => {
    const repo = freshRepo();
    await repo.addCards([card('Q1'), card('Q2'), card('Q3')], T0);
    const state = await startedState(repo);
    const attempt = state.session.attempt!;
    await repo.saveDraft(state.session.id, attempt.id, { response: 'partial thought', confidence: 'unsure' });
    await repo.close();

    const restored = await repo.ensureAttempt(state.session.id, T0 + 5 * MIN);
    expect(restored!.session.attempt).toMatchObject({
      id: attempt.id,
      response: 'partial thought',
      confidence: 'unsure',
      revealed: false,
    });
    expect(restored!.card!.id).toBe(state.card!.id);
    expect(restored!.session.queue).toEqual(state.session.queue);

    await repo.reveal(state.session.id, attempt.id, { response: 'final answer', confidence: 'confident' }, T0 + 6 * MIN);
    const again = await repo.ensureAttempt(state.session.id, T0 + 7 * MIN);
    expect(again!.session.attempt).toMatchObject({ revealed: true, response: 'final answer', confidence: 'confident' });
    // Once revealed, the response is frozen.
    expect(await repo.saveDraft(state.session.id, attempt.id, { response: 'improved later', confidence: 'confident' })).toBe(
      false,
    );
  });

  it('AC09: retrying a commit returns the committed review with exactly one event and one transition', async () => {
    const repo = freshRepo();
    await repo.addCards([card('Q1'), card('Q2')], T0);
    const state = await startedState(repo);
    const attempt = state.session.attempt!;
    await repo.reveal(state.session.id, attempt.id, { response: 'x', confidence: null }, T0);
    const first = await repo.commitReview(state.session.id, attempt.id, 3, T0);
    const retry = await repo.commitReview(state.session.id, attempt.id, 3, T0 + MIN);
    const retryOtherRating = await repo.commitReview(state.session.id, attempt.id, 1, T0 + MIN);
    expect(first.status).toBe('committed');
    expect(retry.status).toBe('duplicate');
    expect(retryOtherRating.status).toBe('duplicate');
    if (first.status === 'committed' && retry.status === 'duplicate') expect(retry.review).toEqual(first.review);

    const ws = await repo.loadWorkspace();
    expect(ws.reviews).toHaveLength(1);
    const s = ws.schedules.find((x) => x.cardId === attempt.cardId)!;
    expect(s.reviewCount).toBe(1);
    expect(s.stateVersion).toBe(1);
    expect(ws.activeSession!.index).toBe(1);
  });

  it('AC10: two tabs committing the same schedule version — one succeeds, the other is stale', async () => {
    const repo = freshRepo();
    await repo.addCards([card('Q1')], T0);
    // Tab A starts a session and gets to the reveal.
    const a = await startedState(repo);
    await repo.reveal(a.session.id, a.session.attempt!.id, { response: 'a', confidence: null }, T0);
    // Tab B can't start a second session while one is active, so simulate a separate session
    // that captured the same card at the same schedule version.
    await repo.endSession(a.session.id, T0);
    const b = await startedState(repo);
    await repo.reveal(b.session.id, b.session.attempt!.id, { response: 'b', confidence: null }, T0);
    expect(b.session.attempt!.expectedStateVersion).toBe(a.session.attempt!.expectedStateVersion);

    const committed = await repo.commitReview(b.session.id, b.session.attempt!.id, 3, T0 + MIN);
    expect(committed.status).toBe('committed');
    // Tab A's stale session can't commit at all.
    const stale = await repo.commitReview(a.session.id, a.session.attempt!.id, 4, T0 + MIN);
    expect(stale).toMatchObject({ status: 'stale', reason: 'session-changed' });

    const ws = await repo.loadWorkspace();
    expect(ws.reviews).toHaveLength(1);
    expect(ws.schedules[0]!.stateVersion).toBe(1);
  });

  it('AC10: the same attempt open in two tabs commits once', async () => {
    const repo = freshRepo();
    await repo.addCards([card('Q1'), card('Q2')], T0);
    const state = await startedState(repo);
    const attempt = state.session.attempt!;
    await repo.reveal(state.session.id, attempt.id, { response: 'x', confidence: null }, T0);
    const [r1, r2] = await Promise.all([
      repo.commitReview(state.session.id, attempt.id, 3, T0),
      repo.commitReview(state.session.id, attempt.id, 4, T0),
    ]);
    expect([r1.status, r2.status].sort()).toEqual(['committed', 'duplicate']);
    expect((await repo.loadWorkspace()).reviews).toHaveLength(1);
  });

  it('a review made elsewhere after the attempt began makes this commit stale', async () => {
    const repo = freshRepo();
    await repo.addCards([card('Q1')], T0);
    const state = await startedState(repo);
    const attempt = state.session.attempt!;
    await repo.reveal(state.session.id, attempt.id, { response: 'x', confidence: null }, T0);
    // Something else changes the schedule (e.g. a reset in the collection in another tab).
    await repo.resetProgress(attempt.cardId, T0);
    const result = await repo.commitReview(state.session.id, attempt.id, 3, T0 + MIN);
    expect(result).toMatchObject({ status: 'stale', reason: 'reviewed-elsewhere' });
    expect((await repo.loadWorkspace()).reviews).toHaveLength(0);
  });

  it('edited, paused, or deleted cards are rejected at commit with the draft preserved', async () => {
    const repo = freshRepo();
    await repo.addCards([card('Q1'), card('Q2'), card('Q3')], T0);
    let state = await startedState(repo);
    let attempt = state.session.attempt!;
    await repo.reveal(state.session.id, attempt.id, { response: 'draft one', confidence: 'unsure' }, T0);

    await repo.updateCard(attempt.cardId, card('Q edited'), T0);
    const edited = await repo.commitReview(state.session.id, attempt.id, 3, T0);
    expect(edited).toMatchObject({ status: 'stale', reason: 'edited' });
    const refreshed = await repo.refreshAttempt(state.session.id, attempt.id, T0 + MIN);
    expect(refreshed!.card!.question).toBe('Q edited');
    expect(refreshed!.session.attempt).toMatchObject({
      response: 'draft one',
      confidence: 'unsure',
      revealed: false,
      cardVersion: 2,
    });
    expect(refreshed!.session.attempt!.id).not.toBe(attempt.id);

    state = refreshed!;
    attempt = state.session.attempt!;
    await repo.reveal(state.session.id, attempt.id, { response: 'r', confidence: null }, T0);
    await repo.setPaused(attempt.cardId, true, T0);
    expect(await repo.commitReview(state.session.id, attempt.id, 3, T0)).toMatchObject({
      status: 'ineligible',
      reason: 'paused',
    });
    const skipped = await repo.skipCurrent(state.session.id, attempt.id, 'paused', T0);
    expect(skipped!.session.results.at(-1)).toMatchObject({ outcome: 'skipped', reason: 'paused' });

    state = skipped!;
    attempt = state.session.attempt!;
    await repo.reveal(state.session.id, attempt.id, { response: 'r', confidence: null }, T0);
    await repo.deleteCard(attempt.cardId, T0);
    expect(await repo.commitReview(state.session.id, attempt.id, 3, T0)).toMatchObject({
      status: 'ineligible',
      reason: 'deleted',
    });
    expect((await repo.loadWorkspace()).reviews).toHaveLength(0);
  });

  it('queued cards paused or deleted before their turn are skipped and recorded', async () => {
    const repo = freshRepo();
    await repo.addCards([card('Q1', 'A'), card('Q2', 'B'), card('Q3', 'A')], T0);
    const state = await startedState(repo);
    const [, second, third] = state.session.queue as [string, string, string];
    await repo.setPaused(second, true, T0);
    await repo.deleteCard(third, T0);
    const result = await revealAndRate(repo, state, 3, T0);
    if (result.status !== 'committed') throw new Error('expected commit');
    expect(result.state.session.status).toBe('completed');
    expect(result.state.session.results.map((r) => [r.outcome, r.reason])).toEqual([
      ['reviewed', null],
      ['skipped', 'paused'],
      ['skipped', 'deleted'],
    ]);
  });

  it('Again makes a card due in 10 minutes but never re-enters the same session', async () => {
    const repo = freshRepo();
    await repo.addCards([card('Q1'), card('Q2')], T0);
    let state = await startedState(repo);
    const firstCard = state.card!.id;
    const r1 = await revealAndRate(repo, state, 1, T0);
    if (r1.status !== 'committed') throw new Error('expected commit');
    state = r1.state;
    expect(state.card!.id).not.toBe(firstCard);
    const r2 = await revealAndRate(repo, state, 3, T0 + 11 * MIN);
    if (r2.status !== 'committed') throw new Error('expected commit');
    expect(r2.state.session.status).toBe('completed');
    const next = await startedState(repo, T0 + 11 * MIN);
    expect(next.session.queue).toEqual([firstCard]);
  });

  it('only one active session at a time; ending a session rates nothing', async () => {
    const repo = freshRepo();
    await repo.addCards([card('Q1')], T0);
    const state = await startedState(repo);
    expect((await repo.startSession({ topics: null, size: 20, now: T0 })).status).toBe('active-exists');
    await repo.endSession(state.session.id, T0 + MIN);
    const ws = await repo.loadWorkspace();
    expect(ws.activeSession).toBeNull();
    expect(ws.reviews).toHaveLength(0);
    expect(ws.schedules[0]!.dueAt).toBe(T0);
  });

  it('reports an empty selection when a topic filter has no due cards', async () => {
    const repo = freshRepo();
    await repo.addCards([card('Q1', 'SQL')], T0);
    expect((await repo.startSession({ topics: ['Python'], size: 20, now: T0 })).status).toBe('empty');
  });
});

describe('repository: quick checks', () => {
  it('quick-check sessions take only cards with options and freeze the shuffled order on the attempt', async () => {
    const repo = freshRepo();
    await repo.addCards([withChoices('Q1'), card('plain'), withChoices('Q2')], T0);
    const state = await quickState(repo);
    expect(state.session.mode).toBe('quick-check');
    expect(state.session.queue).toHaveLength(2);
    const options = state.session.attempt!.options!;
    expect([...options].sort()).toEqual([state.card!.choices!.correct, ...state.card!.choices!.distractors].sort());
    expect(state.session.attempt!.picked).toBeNull();

    const reloaded = await repo.ensureAttempt(state.session.id, T0 + MIN);
    expect(reloaded!.session.attempt!.id).toBe(state.session.attempt!.id);
    expect(reloaded!.session.attempt!.options).toEqual(options);
  });

  it('AC23: a correct pick is frozen, saved once, and never lengthens the interval', async () => {
    const repo = freshRepo();
    await repo.addCards([withChoices('Q1')], T0);
    const state = await quickState(repo);
    const attempt = state.session.attempt!;
    const right = optionIndex(state, true);
    await repo.pickOption(state.session.id, attempt.id, right, T0 + MIN);
    const repick = await repo.pickOption(state.session.id, attempt.id, optionIndex(state, false), T0 + MIN);
    expect(repick!.session.attempt!.picked).toBe(right); // the first pick stands

    const result = await repo.commitQuickCheck(state.session.id, attempt.id, T0 + 2 * MIN);
    if (result.status !== 'committed') throw new Error(`expected commit, got ${result.status}`);
    expect(result.review).toMatchObject({
      mode: 'quick-check',
      rating: null,
      response: '',
      quickCheck: { options: attempt.options, picked: right, correct: true },
    });
    expect(result.state.session.results[0]).toMatchObject({ outcome: 'reviewed', rating: null });

    const retry = await repo.commitQuickCheck(state.session.id, attempt.id, T0 + 3 * MIN);
    expect(retry.status).toBe('duplicate');
    const ws = await repo.loadWorkspace();
    expect(ws.reviews).toHaveLength(1);
    expect(ws.schedules[0]).toMatchObject({
      dueAt: T0 + 2 * MIN + DAY_MS,
      intervalDays: 0,
      ease: 2.5,
      reviewCount: 0,
      quickChecksSinceRecall: 1,
      stateVersion: 1,
    });
  });

  it('AC23: a missed quick check is applied as Again', async () => {
    const repo = freshRepo();
    await repo.addCards([withChoices('Q1')], T0);
    const result = await pickAndSave(repo, await quickState(repo), false, T0);
    if (result.status !== 'committed') throw new Error('expected commit');
    expect(result.review.mode === 'quick-check' && result.review.quickCheck.correct).toBe(false);
    const [s] = (await repo.loadWorkspace()).schedules;
    expect(s).toMatchObject({ dueAt: T0 + 10 * MIN, ease: 2.3, reviewCount: 1, lapseCount: 1, quickChecksSinceRecall: 1 });
  });

  it('AC24: after two quick checks in a row a card needs a full recall, which resets the count', async () => {
    const repo = freshRepo();
    await repo.addCards([withChoices('Q1')], T0);
    await pickAndSave(repo, await quickState(repo, T0), true, T0);
    await pickAndSave(repo, await quickState(repo, T0 + DAY_MS), true, T0 + DAY_MS);
    expect((await repo.loadWorkspace()).schedules[0]!.quickChecksSinceRecall).toBe(2);

    const later = T0 + 3 * DAY_MS;
    expect((await repo.startSession({ topics: null, size: 20, now: later, mode: 'quick-check' })).status).toBe('empty');
    const recall = await startedState(repo, later);
    const rated = await revealAndRate(repo, recall, 3, later);
    if (rated.status !== 'committed') throw new Error('expected commit');
    const [s] = (await repo.loadWorkspace()).schedules;
    expect(s).toMatchObject({ quickChecksSinceRecall: 0, reviewCount: 1, intervalDays: 1 });
    expect((await quickState(repo, later + 2 * DAY_MS)).session.queue).toHaveLength(1);
  });

  it('each mode refuses the other mode’s actions', async () => {
    const repo = freshRepo();
    await repo.addCards([withChoices('Q1')], T0);
    const quick = await quickState(repo);
    const qa = quick.session.attempt!;
    await expect(repo.reveal(quick.session.id, qa.id, { response: 'x', confidence: null }, T0)).rejects.toThrow(/quick check/);
    await expect(repo.commitQuickCheck(quick.session.id, qa.id, T0)).rejects.toThrow(/Pick an option/);
    await expect(repo.pickOption(quick.session.id, qa.id, 7, T0)).rejects.toThrow(/Choose one of the options/);
    await repo.pickOption(quick.session.id, qa.id, 0, T0);
    await expect(repo.commitReview(quick.session.id, qa.id, 3, T0)).rejects.toThrow(/no self-rating/);
    await repo.endSession(quick.session.id, T0);

    const recall = await startedState(repo);
    const ra = recall.session.attempt!;
    expect(ra.options).toBeNull();
    await expect(repo.pickOption(recall.session.id, ra.id, 0, T0)).rejects.toThrow(/full recall/);
    await repo.reveal(recall.session.id, ra.id, { response: '', confidence: null }, T0);
    await expect(repo.commitQuickCheck(recall.session.id, ra.id, T0)).rejects.toThrow(/full recall/);
    expect((await repo.loadWorkspace()).reviews).toHaveLength(0);
  });

  it('editing options mid-attempt makes the pick stale; the fresh attempt uses the new options', async () => {
    const repo = freshRepo();
    await repo.addCards([withChoices('Q1')], T0);
    const state = await quickState(repo);
    const attempt = state.session.attempt!;
    await repo.pickOption(state.session.id, attempt.id, optionIndex(state, true), T0);
    const edited = { ...withChoices('Q1'), choices: { correct: 'New right', distractors: ['New wrong'] } };
    await repo.updateCard(state.card!.id, edited, T0 + MIN);
    const result = await repo.commitQuickCheck(state.session.id, attempt.id, T0 + MIN);
    expect(result.status === 'stale' && result.reason).toBe('edited');
    const fresh = await repo.refreshAttempt(state.session.id, attempt.id, T0 + MIN);
    expect([...fresh!.session.attempt!.options!].sort()).toEqual(['New right', 'New wrong']);
    expect(fresh!.session.attempt!.picked).toBeNull();
  });

  it('a queued card whose options are removed before its turn is skipped as recall-only', async () => {
    const repo = freshRepo();
    await repo.addCards([withChoices('Q1'), withChoices('Q2')], T0);
    const state = await quickState(repo);
    const second = state.session.queue[1]!;
    await repo.updateCard(second, { ...withChoices('Q2'), choices: null }, T0);
    const result = await pickAndSave(repo, state, true, T0);
    if (result.status !== 'committed') throw new Error('expected commit');
    expect(result.state.session.status).toBe('completed');
    expect(result.state.session.results.map((r) => [r.outcome, r.reason])).toEqual([
      ['reviewed', null],
      ['skipped', 'recall-only'],
    ]);
  });
});

describe('repository: show options in a full-recall session', () => {
  const blank = { response: 'Something about…', confidence: 'unsure' as const };

  it('switches the current attempt to shuffled options, keeps the draft, and saves a quick check', async () => {
    const repo = freshRepo();
    await repo.addCards([withChoices('Q1'), withChoices('Q2')], T0);
    const state = await startedState(repo);
    const attempt = state.session.attempt!;
    expect(attempt.options).toBeNull();

    const switched = await repo.showOptions(state.session.id, attempt.id, blank);
    if (switched.status !== 'switched') throw new Error(`expected switched, got ${switched.status}`);
    const after = switched.state.session.attempt!;
    expect(after).toMatchObject({ id: attempt.id, ...blank, revealed: false, picked: null });
    expect([...after.options!].sort()).toEqual([state.card!.choices!.correct, ...state.card!.choices!.distractors].sort());
    expect(switched.state.session.mode).toBe('recall');

    // Idempotent: a retry or a reload keeps the order already shown, and the draft is frozen.
    const again = await repo.showOptions(state.session.id, attempt.id, { response: 'changed', confidence: null });
    expect(again.status === 'switched' && again.state.session.attempt).toMatchObject({ options: after.options, ...blank });
    expect((await repo.ensureAttempt(state.session.id, T0 + MIN))!.session.attempt!.options).toEqual(after.options);
    expect(await repo.saveDraft(state.session.id, attempt.id, { response: 'late flush', confidence: null })).toBe(false);

    // One way: no reveal or self-rating once the options are showing.
    await expect(repo.reveal(state.session.id, attempt.id, blank, T0)).rejects.toThrow(/quick check/);
    const right = after.options!.indexOf(state.card!.choices!.correct);
    await repo.pickOption(state.session.id, attempt.id, right, T0 + MIN);
    await expect(repo.commitReview(state.session.id, attempt.id, 3, T0 + MIN)).rejects.toThrow(/no self-rating/);

    const result = await repo.commitQuickCheck(state.session.id, attempt.id, T0 + 2 * MIN);
    if (result.status !== 'committed') throw new Error(`expected commit, got ${result.status}`);
    expect(result.review).toMatchObject({
      id: attempt.id,
      mode: 'quick-check',
      rating: null,
      sessionId: state.session.id,
      ...blank,
      quickCheck: { options: after.options, picked: right, correct: true },
    });
    expect((await repo.commitQuickCheck(state.session.id, attempt.id, T0 + 3 * MIN)).status).toBe('duplicate');

    // The session stays a full recall: the next card has no options until asked.
    expect(result.state.session).toMatchObject({ mode: 'recall', index: 1 });
    expect(result.state.session.attempt!.options).toBeNull();
    const ws = await repo.loadWorkspace();
    expect(ws.reviews).toHaveLength(1);
    expect(ws.schedules.find((s) => s.cardId === state.card!.id)).toMatchObject({
      dueAt: T0 + 2 * MIN + DAY_MS,
      intervalDays: 0,
      ease: 2.5,
      reviewCount: 0,
      quickChecksSinceRecall: 1,
    });
  });

  it('a missed pick after switching is applied as Again', async () => {
    const repo = freshRepo();
    await repo.addCards([withChoices('Q1')], T0);
    const state = await startedState(repo);
    const attempt = state.session.attempt!;
    const switched = await repo.showOptions(state.session.id, attempt.id, { response: '', confidence: null });
    if (switched.status !== 'switched') throw new Error('expected switched');
    const result = await pickAndSave(repo, switched.state, false, T0);
    if (result.status !== 'committed') throw new Error('expected commit');
    expect(result.review.mode === 'quick-check' && result.review.quickCheck.correct).toBe(false);
    const [s] = (await repo.loadWorkspace()).schedules;
    expect(s).toMatchObject({ dueAt: T0 + 10 * MIN, ease: 2.3, lapseCount: 1, quickChecksSinceRecall: 1 });
  });

  it('is refused for a card without options, a revealed answer, or a card at the quick-check limit', async () => {
    const repo = freshRepo();
    await repo.addCards([card('plain')], T0);
    const plain = await startedState(repo);
    const pa = plain.session.attempt!;
    await expect(repo.showOptions(plain.session.id, pa.id, blank)).rejects.toThrow(/no multiple-choice options/);
    await repo.reveal(plain.session.id, pa.id, blank, T0);
    await expect(repo.showOptions(plain.session.id, pa.id, blank)).rejects.toThrow(/already showing/);
    await repo.endSession(plain.session.id, T0);

    // One quick check from a quick-check session and one switch reach the limit together.
    const limited = freshRepo();
    await limited.addCards([withChoices('Q1')], T0);
    await pickAndSave(limited, await quickState(limited, T0), true, T0);
    const recall = await startedState(limited, T0 + DAY_MS);
    const switched = await limited.showOptions(recall.session.id, recall.session.attempt!.id, blank);
    if (switched.status !== 'switched') throw new Error('expected switched');
    await pickAndSave(limited, switched.state, true, T0 + DAY_MS);
    expect((await limited.loadWorkspace()).schedules[0]!.quickChecksSinceRecall).toBe(2);

    const later = T0 + 3 * DAY_MS;
    expect((await limited.startSession({ topics: null, size: 20, now: later, mode: 'quick-check' })).status).toBe('empty');
    const needsRecall = await startedState(limited, later);
    const na = needsRecall.session.attempt!;
    await expect(limited.showOptions(needsRecall.session.id, na.id, blank)).rejects.toThrow(/needs a full recall/);
    expect((await limited.ensureAttempt(needsRecall.session.id, later))!.session.attempt!.options).toBeNull();
    const rated = await revealAndRate(limited, needsRecall, 3, later);
    expect(rated.status).toBe('committed');
    expect((await limited.loadWorkspace()).schedules[0]!.quickChecksSinceRecall).toBe(0);
  });

  it('is guarded like a commit: edited, reviewed elsewhere, paused, deleted, or a changed session', async () => {
    const repo = freshRepo();
    await repo.addCards([withChoices('Q1'), withChoices('Q2'), withChoices('Q3'), withChoices('Q4')], T0);
    const state = await startedState(repo);
    const sid = state.session.id;
    const [first, second, third, fourth] = state.session.queue as [string, string, string, string];
    const attemptId = async () => (await repo.ensureAttempt(sid, T0))!.session.attempt!.id;

    // Edited: nothing switches; the fresh attempt on the updated card can switch.
    const a1 = await attemptId();
    await repo.updateCard(first, { ...withChoices('Q1'), answer: 'Reworded' }, T0);
    const edited = await repo.showOptions(sid, a1, blank);
    expect(edited.status === 'stale' && edited.reason).toBe('edited');
    expect((await repo.ensureAttempt(sid, T0))!.session.attempt).toMatchObject({ id: a1, options: null });
    const fresh = await repo.refreshAttempt(sid, a1, T0);
    expect((await repo.showOptions(sid, fresh!.session.attempt!.id, blank)).status).toBe('switched');
    await pickAndSave(repo, (await repo.ensureAttempt(sid, T0))!, true, T0);

    // Reviewed elsewhere: the schedule moved on after the attempt began.
    const a2 = await attemptId();
    await repo.setPaused(second, true, T0);
    await repo.setPaused(second, false, T0);
    const elsewhere = await repo.showOptions(sid, a2, blank);
    expect(elsewhere.status === 'stale' && elsewhere.reason).toBe('reviewed-elsewhere');
    await repo.skipCurrent(sid, a2, 'reviewed-elsewhere', T0);

    const a3 = await attemptId();
    await repo.setPaused(third, true, T0);
    const paused = await repo.showOptions(sid, a3, blank);
    expect(paused.status === 'ineligible' && paused.reason).toBe('paused');
    await repo.skipCurrent(sid, a3, 'paused', T0);

    const a4 = await attemptId();
    expect((await repo.ensureAttempt(sid, T0))!.session.attempt!.cardId).toBe(fourth);
    await repo.deleteCard(fourth, T0);
    const deleted = await repo.showOptions(sid, a4, blank);
    expect(deleted.status === 'ineligible' && deleted.reason).toBe('deleted');

    await repo.endSession(sid, T0);
    const ended = await repo.showOptions(sid, a4, blank);
    expect(ended.status === 'stale' && ended.reason).toBe('session-changed');
    expect((await repo.loadWorkspace()).reviews).toHaveLength(1);
  });

  it('a switched card edited after the switch gets a fresh quick check with the draft kept', async () => {
    const repo = freshRepo();
    await repo.addCards([withChoices('Q1')], T0);
    const state = await startedState(repo);
    const attempt = state.session.attempt!;
    await repo.showOptions(state.session.id, attempt.id, blank);
    await repo.updateCard(state.card!.id, { ...withChoices('Q1'), choices: { correct: 'New', distractors: ['Old'] } }, T0);
    const fresh = await repo.refreshAttempt(state.session.id, attempt.id, T0 + MIN);
    expect(fresh!.session.attempt).toMatchObject({ ...blank, picked: null });
    expect([...fresh!.session.attempt!.options!].sort()).toEqual(['New', 'Old']);

    // If the edit removes the options, the fresh attempt falls back to full recall.
    await repo.updateCard(state.card!.id, { ...withChoices('Q1'), choices: null }, T0 + MIN);
    const recall = await repo.refreshAttempt(state.session.id, fresh!.session.attempt!.id, T0 + 2 * MIN);
    expect(recall!.session.attempt).toMatchObject({ ...blank, options: null });
  });

  it('a quick check inside a full-recall session passes sync validation once the session finishes', async () => {
    const repo = freshRepo();
    await repo.addCards([withChoices('Q1'), withChoices('Q2')], T0);
    await repo.connectSync(
      { url: 'https://sync.example.test/', key: 'test-key', deviceId: 'dev-a', serverId: 'server-1', connectedAt: T0 },
      'upload',
      T0,
    );
    const state = await startedState(repo);
    const queued = async () => (await repo.readOutbox(100)).items.map((i) => i.change);
    const before = await queued();

    const switched = await repo.showOptions(state.session.id, state.session.attempt!.id, blank);
    if (switched.status !== 'switched') throw new Error('expected switched');
    expect(await queued()).toEqual(before); // the active session stays on this device
    const committed = await pickAndSave(repo, switched.state, true, T0 + MIN);
    if (committed.status !== 'committed') throw new Error('expected commit');
    await repo.endSession(state.session.id, T0 + 2 * MIN);

    const changes = await queued();
    for (const change of changes) expect(validateChange(change)).toMatchObject({ ok: true });
    expect(changes.find((c) => c.store === 'reviews')!.value).toMatchObject({ mode: 'quick-check', ...blank });
    expect(changes.find((c) => c.store === 'sessions')!.value).toMatchObject({
      mode: 'recall',
      status: 'ended',
      results: [{ outcome: 'reviewed', rating: null }],
    });
  });

  it('a backup accepts a quick-check review, and a switched attempt, inside a full-recall session', async () => {
    const source = freshRepo();
    await source.addCards([withChoices('Q1'), withChoices('Q2')], T0);
    const state = await startedState(source);
    const switched = await source.showOptions(state.session.id, state.session.attempt!.id, blank);
    if (switched.status !== 'switched') throw new Error('expected switched');
    const committed = await pickAndSave(source, switched.state, true, T0 + MIN);
    if (committed.status !== 'committed') throw new Error('expected commit');
    // The second card is left mid-switch.
    await source.showOptions(state.session.id, committed.state.session.attempt!.id, { response: '', confidence: null });
    const data = await source.exportWorkspace();
    expect(data.sessions[0]).toMatchObject({ mode: 'recall', status: 'active' });
    expect(data.sessions[0]!.attempt!.options).not.toBeNull();
    expect(data.reviews[0]!.mode).toBe('quick-check');

    const parsed = parseBackupText(JSON.stringify(buildBackup(data, T0 + 2 * MIN)));
    if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
    const target = freshRepo();
    await target.replaceWorkspace(parsed.data);
    const restored = await target.exportWorkspace();
    expect(restored.reviews).toEqual(data.reviews);
    expect(restored.sessions).toEqual(data.sessions);
  });
});

describe('repository: backups and deletion', () => {
  async function populated(): Promise<Repository> {
    const repo = freshRepo();
    await repo.addCards([card('Q1', 'A'), card('Q2', 'B'), card('Q3', 'A')], T0);
    const state = await startedState(repo);
    await revealAndRate(repo, state, 3, T0 + MIN);
    await repo.addReflection('Index trade-offs still feel shaky.', state.session.id, T0 + 2 * MIN);
    await repo.savePreferences(
      {
        schemaVersion: 1,
        timezone: 'Europe/Berlin',
        readingSize: 'large',
        sessionSize: 10,
        aiMode: 'disabled',
      },
      T0,
    );
    await repo.setPaused(state.session.queue[2]!, true, T0);
    return repo;
  }

  it('AC12: a full backup restored into a clean workspace matches exactly', async () => {
    const source = await populated();
    const data = await source.exportWorkspace();
    const text = JSON.stringify(buildBackup(data, T0 + 3 * MIN));

    const parsed = parseBackupText(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.counts).toMatchObject({ cards: 3, reviews: 1, reflections: 1, sessions: 1 });

    const target = freshRepo();
    await target.replaceWorkspace(parsed.data);
    const restored = await target.exportWorkspace();
    const sortById = <T extends { id?: string; cardId?: string }>(xs: T[]) =>
      [...xs].sort((a, b) => String(a.id ?? a.cardId).localeCompare(String(b.id ?? b.cardId)));
    expect(sortById(restored.cards)).toEqual(sortById(data.cards));
    expect(sortById(restored.schedules)).toEqual(sortById(data.schedules));
    expect(sortById(restored.reviews)).toEqual(sortById(data.reviews));
    expect(sortById(restored.sessions)).toEqual(sortById(data.sessions));
    expect(restored.reflections).toEqual(data.reflections);
    expect(restored.preferences).toEqual(data.preferences);
  });

  it('AC13: malformed or future-version backups are rejected and the workspace is unchanged', async () => {
    const repo = await populated();
    const before = await repo.exportWorkspace();
    const good = buildBackup(before, T0);

    const future = validateBackup({ ...good, formatVersion: BACKUP_FORMAT_VERSION + 1 });
    expect(future.ok).toBe(false);
    if (!future.ok) expect(future.errors[0]).toMatch(/newer than this app supports/);

    const badCard = structuredClone(good);
    (badCard.data.cards[0] as unknown as Record<string, unknown>).kind = 'flashcard';
    delete (badCard.data.schedules[1] as unknown as Record<string, unknown>).ease;
    const malformed = validateBackup(badCard);
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) {
      expect(malformed.errors.some((e) => e.includes('cards[0].kind'))).toBe(true);
      expect(malformed.errors.some((e) => e.includes('schedules[1].ease'))).toBe(true);
    }

    const orphan = structuredClone(good);
    orphan.data.schedules.push({ ...orphan.data.schedules[0]!, cardId: 'missing' });
    expect(validateBackup(orphan).ok).toBe(false);

    expect(parseBackupText('not json').ok).toBe(false);
    expect(validateBackup({ format: 'recall-v1', cards: [] }).ok).toBe(false);

    expect(await repo.exportWorkspace()).toEqual(before);
  });

  it('AC12: backups carry options, quick-check reviews, and the quick-check counter', async () => {
    const source = freshRepo();
    await source.addCards([withChoices('Q1'), withChoices('Q2')], T0);
    const state = await quickState(source);
    await pickAndSave(source, state, false, T0 + MIN); // the second card stays mid-attempt
    const data = await source.exportWorkspace();
    expect(data.reviews[0]!.mode).toBe('quick-check');

    const parsed = parseBackupText(JSON.stringify(buildBackup(data, T0 + 2 * MIN)));
    if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
    const target = freshRepo();
    await target.replaceWorkspace(parsed.data);
    const restored = await target.exportWorkspace();
    const byId = <T extends { id?: string; cardId?: string }>(xs: T[]) =>
      [...xs].sort((a, b) => String(a.id ?? a.cardId).localeCompare(String(b.id ?? b.cardId)));
    expect(byId(restored.cards)).toEqual(byId(data.cards));
    expect(byId(restored.schedules)).toEqual(byId(data.schedules));
    expect(restored.reviews).toEqual(data.reviews);
    expect(restored.sessions).toEqual(data.sessions);
  });

  it('rejects malformed quick-check data in a backup', async () => {
    const repo = freshRepo();
    await repo.addCards([withChoices('Q1')], T0);
    await pickAndSave(repo, await quickState(repo), true, T0);
    const good = buildBackup(await repo.exportWorkspace(), T0);
    expect(validateBackup(good).ok).toBe(true);

    const bad = structuredClone(good) as unknown as {
      data: { cards: Record<string, unknown>[]; schedules: Record<string, unknown>[]; reviews: Record<string, unknown>[] };
    };
    bad.data.cards[0]!.choices = { correct: 'Right', distractors: [] };
    bad.data.schedules[0]!.quickChecksSinceRecall = 3;
    bad.data.reviews[0]!.rating = 3;
    const result = validateBackup(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('cards[0].choices.distractors'))).toBe(true);
      expect(result.errors.some((e) => e.includes('schedules[0].quickChecksSinceRecall'))).toBe(true);
      expect(result.errors.some((e) => e.includes('reviews[0].rating'))).toBe(true);
    }
  });

  it('AC25: opening a version 1 database upgrades every record, and an attempt in progress still commits', async () => {
    const name = `recall-v1-${Date.now()}-${counter++}`;
    await seedVersion1Database(name);
    const repo = createRepository(name);
    repos.push(repo);

    const ws = await repo.loadWorkspace();
    expect(ws.cards.map((c) => c.choices)).toEqual([null, null]);
    expect(ws.schedules.find((s) => s.cardId === 'c1')).toEqual({
      ...V1.schedules[0],
      schedulerVersion: 'recall-sm2-v2',
      quickChecksSinceRecall: 0,
    });
    expect(ws.reviews[0]).toEqual({
      ...V1.reviews[0],
      mode: 'recall',
      quickCheck: null,
      snapshot: { ...V1.reviews[0]!.snapshot, choices: null },
    });
    expect(ws.reviews[0]!.schedulerVersion).toBe('recall-sm2-v1'); // history keeps the scheduler that computed it
    expect(ws.activeSession).toMatchObject({ mode: 'recall', attempt: { id: 'att-1', options: null, picked: null } });

    const state = (await repo.ensureAttempt('s1', T0))!;
    expect(state.session.attempt!.id).toBe('att-1');
    const result = await revealAndRate(repo, state, 3, T0);
    expect(result.status).toBe('committed');
  });

  it('AC25: a version 1 backup is upgraded on restore and matches an upgraded version 1 database', async () => {
    const name = `recall-v1-${Date.now()}-${counter++}`;
    await seedVersion1Database(name);
    const migrated = createRepository(name);
    repos.push(migrated);
    const fromDb = await migrated.exportWorkspace();

    const v1Backup = {
      format: 'recall-backup',
      formatVersion: 1,
      exportedAt: new Date(T0).toISOString(),
      schedulerVersion: 'recall-sm2-v1',
      data: { ...V1, reflections: [], rubrics: [], assessments: [], preferences: null },
    };
    const parsed = parseBackupText(JSON.stringify(v1Backup));
    if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
    const target = freshRepo();
    await target.replaceWorkspace(parsed.data);
    const fromBackup = await target.exportWorkspace();
    const byId = <T extends { id?: string; cardId?: string }>(xs: T[]) =>
      [...xs].sort((a, b) => String(a.id ?? a.cardId).localeCompare(String(b.id ?? b.cardId)));
    expect(byId(fromBackup.cards)).toEqual(byId(fromDb.cards));
    expect(byId(fromBackup.schedules)).toEqual(byId(fromDb.schedules));
    expect(fromBackup.reviews).toEqual(fromDb.reviews);
    expect(fromBackup.sessions).toEqual(fromDb.sessions);
  });

  it('AC22: deleting all data returns to the fresh state', async () => {
    const repo = await populated();
    await repo.deleteAllData();
    const ws = await repo.loadWorkspace();
    expect(ws.cards).toEqual([]);
    expect(ws.schedules).toEqual([]);
    expect(ws.reviews).toEqual([]);
    expect(ws.reflections).toEqual([]);
    expect(ws.activeSession).toBeNull();
    expect(ws.preferences.readingSize).toBe('standard');
    const exported = await repo.exportWorkspace();
    expect(exported.sessions).toEqual([]);
    expect(exported.preferences).toBeNull();
  });
});
