import { describe, expect, it } from 'vitest';
import {
  AGAIN_INTERVAL_DAYS,
  applyQuickCheck,
  applyRating,
  DAY_MS,
  formatInterval,
  initialSchedule,
  nextSchedulingState,
  previewQuickCheck,
  previewRatings,
  QUICK_CHECK_LIMIT,
  quickCheckDelayDays,
} from '../../src/domain/scheduler';
import type { Rating, Schedule } from '../../src/domain/types';

const NOW = Date.UTC(2026, 9, 12, 18, 0, 0);

function established(intervalDays: number, ease: number, reviewCount = 5): Schedule {
  return { ...initialSchedule('c1', NOW), intervalDays, ease, reviewCount, stateVersion: 7 };
}

describe('recall-sm2-v2 scheduler: ratings (unchanged from v1)', () => {
  it('AC06: new card rated Again/Hard/Good/Easy is due in 10 min / 1 day / 1 day / 4 days', () => {
    const fresh = initialSchedule('c1', NOW);
    const due = (r: Rating) => applyRating(fresh, r, NOW).dueAt - NOW;
    expect(due(1)).toBe(10 * 60_000);
    expect(due(2)).toBe(DAY_MS);
    expect(due(3)).toBe(DAY_MS);
    expect(due(4)).toBe(4 * DAY_MS);
  });

  it('AC07: established card with I=10, E=2.5', () => {
    const s = established(10, 2.5);
    const hard = nextSchedulingState(s, 2);
    const good = nextSchedulingState(s, 3);
    const easy = nextSchedulingState(s, 4);
    expect([hard.intervalDays, hard.ease]).toEqual([12, 2.35]);
    expect([good.intervalDays, good.ease]).toEqual([25, 2.5]);
    expect([easy.intervalDays, easy.ease]).toEqual([33, 2.65]);
  });

  it('Again resets to 10 minutes, lowers ease, and counts a lapse', () => {
    const next = nextSchedulingState(established(30, 2.5), 1);
    expect(next.intervalDays).toBe(AGAIN_INTERVAL_DAYS);
    expect(next.ease).toBe(2.3);
    expect(next.lapseCount).toBe(1);
    expect(next.reviewCount).toBe(6);
  });

  it('after a lapse (I < 1) Good returns to 1 day and Easy to 4 days', () => {
    const lapsed = established(AGAIN_INTERVAL_DAYS, 2.3);
    expect(nextSchedulingState(lapsed, 2).intervalDays).toBe(1);
    expect(nextSchedulingState(lapsed, 3).intervalDays).toBe(1);
    expect(nextSchedulingState(lapsed, 4).intervalDays).toBe(4);
  });

  it('keeps ease within [1.3, 3.5]', () => {
    expect(nextSchedulingState(established(5, 1.35), 1).ease).toBe(1.3);
    expect(nextSchedulingState(established(5, 1.3), 2).ease).toBe(1.3);
    expect(nextSchedulingState(established(5, 3.45), 4).ease).toBe(3.5);
  });

  it('Good always grows by at least one day, Hard never drops below one day', () => {
    expect(nextSchedulingState(established(1, 1.3), 3).intervalDays).toBe(2);
    expect(nextSchedulingState(established(1, 1.3), 2).intervalDays).toBe(1);
  });

  it('caps intervals at 3650 days', () => {
    expect(nextSchedulingState(established(3000, 3.5), 4).intervalDays).toBe(3650);
  });

  it('only Again increments lapses; every rating increments review count once', () => {
    for (const r of [2, 3, 4] as Rating[]) {
      const next = nextSchedulingState(established(10, 2.5), r);
      expect(next.lapseCount).toBe(0);
      expect(next.reviewCount).toBe(6);
    }
  });

  it('applyRating computes due from commit time and bumps stateVersion', () => {
    const s = established(10, 2.5);
    const later = NOW + 5 * 60_000;
    const next = applyRating(s, 3, later);
    expect(next.dueAt).toBe(later + 25 * DAY_MS);
    expect(next.stateVersion).toBe(8);
    expect(next.lastReviewedAt).toBe(later);
    expect(next.schedulerVersion).toBe('recall-sm2-v2');
  });

  it('previews match what commit would produce', () => {
    const s = established(10, 2.5);
    for (const p of previewRatings(s, NOW)) {
      expect(p.intervalDays).toBe(applyRating(s, p.rating, NOW).intervalDays);
      expect(p.dueAt).toBe(applyRating(s, p.rating, NOW).dueAt);
    }
  });

  it('formats intervals for people', () => {
    expect(formatInterval(AGAIN_INTERVAL_DAYS)).toBe('10 min');
    expect(formatInterval(1)).toBe('1 day');
    expect(formatInterval(25)).toBe('25 days');
    expect(formatInterval(120)).toBe('3.9 months');
    expect(formatInterval(800)).toBe('2.2 years');
  });
});

describe('recall-sm2-v2 scheduler: quick checks', () => {
  it('AC23: a correct pick on a new card brings it back in 1 day and changes nothing else', () => {
    const fresh = initialSchedule('c1', NOW);
    const next = applyQuickCheck(fresh, true, NOW);
    expect(next.dueAt - NOW).toBe(DAY_MS);
    expect(next).toMatchObject({ intervalDays: 0, ease: 2.5, reviewCount: 0, lapseCount: 0, quickChecksSinceRecall: 1 });
    expect(next.stateVersion).toBe(fresh.stateVersion + 1);
    expect(next.lastReviewedAt).toBe(NOW);
    expect(next.schedulerVersion).toBe('recall-sm2-v2');
  });

  it('AC23: a correct pick on I=10, E=2.5 brings it back in 2 days without growing the interval', () => {
    const s = established(10, 2.5, 3);
    const next = applyQuickCheck(s, true, NOW);
    expect(next.dueAt - NOW).toBe(2 * DAY_MS);
    expect(next).toMatchObject({ intervalDays: 10, ease: 2.5, reviewCount: 3, lapseCount: 0 });
  });

  it('never brings a card back later than its current interval, or sooner than a day', () => {
    expect(quickCheckDelayDays(0)).toBe(1);
    expect(quickCheckDelayDays(AGAIN_INTERVAL_DAYS)).toBe(1);
    expect(quickCheckDelayDays(1)).toBe(1);
    expect(quickCheckDelayDays(2)).toBe(2);
    expect(quickCheckDelayDays(400)).toBe(2);
  });

  it('AC23: a wrong pick is applied exactly as Again, and still counts as a quick check', () => {
    const s = established(10, 2.5, 3);
    const missed = applyQuickCheck(s, false, NOW);
    expect(missed).toEqual({ ...applyRating(s, 1, NOW), quickChecksSinceRecall: 1 });
  });

  it('any full-recall rating resets the quick-check count', () => {
    const afterTwo = applyQuickCheck(applyQuickCheck(initialSchedule('c1', NOW), true, NOW), true, NOW + DAY_MS);
    expect(afterTwo.quickChecksSinceRecall).toBe(QUICK_CHECK_LIMIT);
    for (const r of [1, 2, 3, 4] as const) expect(applyRating(afterTwo, r, NOW).quickChecksSinceRecall).toBe(0);
  });

  it('previews come from the same function as the commit', () => {
    const s = established(10, 2.5, 3);
    expect(previewQuickCheck(s, true, NOW)).toBe(2);
    expect(previewQuickCheck(s, false, NOW)).toBeCloseTo(AGAIN_INTERVAL_DAYS, 10);
  });
});
