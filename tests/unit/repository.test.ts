import { afterEach, describe, expect, it } from 'vitest';
import { buildBackup, parseBackupText, validateBackup } from '../../src/content/backup';
import { STARTER_CARDS } from '../../src/content/starter';
import { DAY_MS } from '../../src/domain/scheduler';
import type { CardContent } from '../../src/domain/types';
import { createRepository, type PracticeState, type Repository } from '../../src/storage/repository';

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
});

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
    const paused = await repo.setPaused(other, true);
    expect((await repo.startSession({ topics: null, size: 20, now: T0 + MIN })).status).toBe('empty');
    const resumed = await repo.setPaused(other, false);
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
    expect(restored!.session.attempt).toMatchObject({ id: attempt.id, response: 'partial thought', confidence: 'unsure', revealed: false });
    expect(restored!.card!.id).toBe(state.card!.id);
    expect(restored!.session.queue).toEqual(state.session.queue);

    await repo.reveal(state.session.id, attempt.id, { response: 'final answer', confidence: 'confident' }, T0 + 6 * MIN);
    const again = await repo.ensureAttempt(state.session.id, T0 + 7 * MIN);
    expect(again!.session.attempt).toMatchObject({ revealed: true, response: 'final answer', confidence: 'confident' });
    // Once revealed, the response is frozen.
    expect(await repo.saveDraft(state.session.id, attempt.id, { response: 'improved later', confidence: 'confident' })).toBe(false);
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
    expect(refreshed!.session.attempt).toMatchObject({ response: 'draft one', confidence: 'unsure', revealed: false, cardVersion: 2 });
    expect(refreshed!.session.attempt!.id).not.toBe(attempt.id);

    state = refreshed!;
    attempt = state.session.attempt!;
    await repo.reveal(state.session.id, attempt.id, { response: 'r', confidence: null }, T0);
    await repo.setPaused(attempt.cardId, true);
    expect(await repo.commitReview(state.session.id, attempt.id, 3, T0)).toMatchObject({ status: 'ineligible', reason: 'paused' });
    const skipped = await repo.skipCurrent(state.session.id, attempt.id, 'paused', T0);
    expect(skipped!.session.results.at(-1)).toMatchObject({ outcome: 'skipped', reason: 'paused' });

    state = skipped!;
    attempt = state.session.attempt!;
    await repo.reveal(state.session.id, attempt.id, { response: 'r', confidence: null }, T0);
    await repo.deleteCard(attempt.cardId, T0);
    expect(await repo.commitReview(state.session.id, attempt.id, 3, T0)).toMatchObject({ status: 'ineligible', reason: 'deleted' });
    expect((await repo.loadWorkspace()).reviews).toHaveLength(0);
  });

  it('queued cards paused or deleted before their turn are skipped and recorded', async () => {
    const repo = freshRepo();
    await repo.addCards([card('Q1', 'A'), card('Q2', 'B'), card('Q3', 'A')], T0);
    const state = await startedState(repo);
    const [, second, third] = state.session.queue as [string, string, string];
    await repo.setPaused(second, true);
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

describe('repository: backups and deletion', () => {
  async function populated(): Promise<Repository> {
    const repo = freshRepo();
    await repo.addCards([card('Q1', 'A'), card('Q2', 'B'), card('Q3', 'A')], T0);
    const state = await startedState(repo);
    await revealAndRate(repo, state, 3, T0 + MIN);
    await repo.addReflection('Index trade-offs still feel shaky.', state.session.id, T0 + 2 * MIN);
    await repo.savePreferences({ schemaVersion: 1, timezone: 'Europe/Berlin', readingSize: 'large', sessionSize: 10, aiMode: 'disabled' });
    await repo.setPaused(state.session.queue[2]!, true);
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

    const future = validateBackup({ ...good, formatVersion: 2 });
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
