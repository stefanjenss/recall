import { describe, expect, it } from 'vitest';
import { initialSchedule } from '../../src/domain/scheduler';
import type { Card } from '../../src/domain/types';
import { normalizeServerUrl, isBlockedMixedContent } from '../../src/sync/client';
import { compareHlc, hlcAt, observeHlc, parseHlc, tickHlc } from '../../src/sync/hlc';
import { mergeRecord } from '../../src/sync/merge';
import { validateChange } from '../../src/sync/protocol';

const T0 = Date.UTC(2026, 9, 12, 18, 0, 0);

const card = (over: Partial<Card> = {}): Card => ({
  id: 'c1',
  topic: 'SQL',
  question: 'What does an index cost?',
  answer: 'Slower writes.',
  kind: 'recall',
  source: null,
  contentVersion: 1,
  createdAt: T0,
  updatedAt: T0,
  deletedAt: null,
  ...over,
});

describe('hybrid logical clock', () => {
  it('ticks forward with wall time and counts within a millisecond', () => {
    const a = tickHlc(null, T0, 'dev-a');
    const b = tickHlc(a, T0, 'dev-a');
    const c = tickHlc(b, T0 + 5, 'dev-a');
    expect(parseHlc(a)).toEqual({ ms: T0, counter: 0, node: 'dev-a' });
    expect(parseHlc(b)).toEqual({ ms: T0, counter: 1, node: 'dev-a' });
    expect(parseHlc(c)).toEqual({ ms: T0 + 5, counter: 0, node: 'dev-a' });
    expect(compareHlc(a, b)).toBeLessThan(0);
    expect(compareHlc(c, b)).toBeGreaterThan(0);
  });

  it('never goes backwards when the wall clock does', () => {
    const a = tickHlc(null, T0, 'dev-a');
    const b = tickHlc(a, T0 - 60_000, 'dev-a');
    expect(compareHlc(b, a)).toBeGreaterThan(0);
  });

  it('an edit made after seeing a remote change outranks it, even with a slow clock', () => {
    const remote = tickHlc(null, T0 + 10_000, 'dev-b');
    const local = observeHlc(tickHlc(null, T0, 'dev-a'), remote);
    const edit = tickHlc(local, T0 + 1, 'dev-a');
    expect(compareHlc(edit, remote)).toBeGreaterThan(0);
    expect(parseHlc(edit)!.node).toBe('dev-a');
  });

  it('breaks exact ties by device ID and orders numerically, not by string length', () => {
    expect(compareHlc(hlcAt(T0, 'a'), hlcAt(T0, 'b'))).toBeLessThan(0);
    const big = '000000000000001.1000000.x';
    const small = '000000000000001.999999.x';
    expect(compareHlc(big, small)).toBeGreaterThan(0);
    expect(parseHlc('1.0.x')).toBeNull();
    expect(parseHlc('000000000000001.000000.bad node')).toBeNull();
  });
});

describe('merge rules', () => {
  const older = hlcAt(T0, 'a');
  const newer = hlcAt(T0 + 1000, 'b');

  it('keeps the version with the later stamp, whichever side it is on', () => {
    const s1 = initialSchedule('c1', T0);
    const s2 = { ...s1, intervalDays: 3, stateVersion: 1 };
    expect(mergeRecord('schedules', { hlc: older, value: s1 }, { hlc: newer, value: s2 })).toMatchObject({
      outcome: 'incoming',
      value: s2,
    });
    expect(mergeRecord('schedules', { hlc: newer, value: s2 }, { hlc: older, value: s1 })).toMatchObject({
      outcome: 'stored',
      value: s2,
    });
  });

  it('never replaces a stored review', () => {
    const r = mergeRecord('reviews', { hlc: older, value: { id: 'r1', v: 1 } }, { hlc: newer, value: { id: 'r1', v: 2 } });
    expect(r).toMatchObject({ outcome: 'stored', value: { id: 'r1', v: 1 } });
  });

  it('a delete wins over a later edit from another device, keeping the newer content', () => {
    const deleted = card({ deletedAt: T0 + 10, updatedAt: T0 + 10 });
    const edited = card({ answer: 'Slower writes and more storage.', contentVersion: 2, updatedAt: T0 + 500 });
    const fromEdit = mergeRecord('cards', { hlc: older, value: deleted }, { hlc: newer, value: edited });
    expect(fromEdit.outcome).toBe('merged');
    expect(fromEdit.hlc).toBe(newer);
    expect(fromEdit.value).toMatchObject({ answer: 'Slower writes and more storage.', deletedAt: T0 + 10, contentVersion: 2 });
    // The same result arrives in the other order.
    const fromDelete = mergeRecord('cards', { hlc: newer, value: edited }, { hlc: older, value: deleted });
    expect(fromDelete).toEqual({ ...fromEdit });
  });
});

describe('change validation', () => {
  const hlc = hlcAt(T0, 'dev-a');

  it('accepts a valid record whose key matches', () => {
    expect(validateChange({ store: 'cards', key: 'c1', hlc, value: card() }).ok).toBe(true);
    expect(validateChange({ store: 'schedules', key: 'c1', hlc, value: initialSchedule('c1', T0) }).ok).toBe(true);
  });

  it('refuses unknown stores, bad stamps, mismatched keys, invalid content, and active sessions', () => {
    const reasons = [
      validateChange({ store: 'importBatches', key: 'x', hlc, value: {} }),
      validateChange({ store: 'cards', key: 'c1', hlc: 'yesterday', value: card() }),
      validateChange({ store: 'cards', key: 'c2', hlc, value: card() }),
      validateChange({ store: 'cards', key: 'c1', hlc, value: card({ answer: '' }) }),
      validateChange({
        store: 'sessions',
        key: 's1',
        hlc,
        value: {
          id: 's1',
          topics: null,
          size: 5,
          queue: [],
          index: 0,
          status: 'active',
          startedAt: T0,
          endedAt: null,
          attempt: null,
          results: [],
        },
      }),
    ].map((r) => (r.ok ? 'ok' : r.reason));
    expect(reasons[0]).toMatch(/Unknown store/);
    expect(reasons[1]).toMatch(/clock stamp/);
    expect(reasons[2]).toMatch(/key doesn't match/);
    expect(reasons[3]).toMatch(/answer must not be empty/);
    expect(reasons[4]).toMatch(/once they finish/);
  });
});

describe('server address', () => {
  it('adds https:// and a trailing slash, and drops query and fragment', () => {
    expect(normalizeServerUrl(' thinkcentre.tail1234.ts.net ')).toEqual({
      ok: true,
      url: 'https://thinkcentre.tail1234.ts.net/',
    });
    expect(normalizeServerUrl('http://192.168.1.20:8787/recall?x=1#y')).toEqual({
      ok: true,
      url: 'http://192.168.1.20:8787/recall/',
    });
    expect(normalizeServerUrl('').ok).toBe(false);
    expect(normalizeServerUrl('ftp://box').ok).toBe(false);
    expect(normalizeServerUrl('https://me:secret@box').ok).toBe(false);
  });

  it('flags http:// servers that an https:// page would be blocked from reaching', () => {
    expect(isBlockedMixedContent('http://192.168.1.20:8787/', 'https:')).toBe(true);
    expect(isBlockedMixedContent('http://localhost:8787/', 'https:')).toBe(false);
    expect(isBlockedMixedContent('http://192.168.1.20:8787/', 'http:')).toBe(false);
    expect(isBlockedMixedContent('https://box.ts.net/', 'https:')).toBe(false);
  });
});
