import { describe, expect, it } from 'vitest';
import { addDays, currentStreak, dayKey, lastNDays } from '../../src/domain/time';
import { applyRating, initialSchedule } from '../../src/domain/scheduler';

const NY = 'America/New_York';

describe('calendar days in a chosen timezone', () => {
  it('derives the local calendar day from a UTC instant', () => {
    // 03:30 UTC on Oct 13 is still Oct 12 in New York (UTC-4).
    const ts = Date.UTC(2026, 9, 13, 3, 30);
    expect(dayKey(ts, 'UTC')).toBe('2026-10-13');
    expect(dayKey(ts, NY)).toBe('2026-10-12');
    expect(dayKey(ts, 'Asia/Tokyo')).toBe('2026-10-13');
  });

  it('does civil-date arithmetic across month, year, and DST boundaries', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2026-03-09', -1)).toBe('2026-03-08'); // US spring-forward day
    expect(addDays('2026-11-02', -1)).toBe('2026-11-01'); // US fall-back day
    expect(lastNDays('2026-10-12', 3)).toEqual(['2026-10-10', '2026-10-11', '2026-10-12']);
  });

  it('AC16: a streak spans the spring-forward day (a 23-hour day) without breaking', () => {
    // One review each evening at 21:00 New York time, Mar 7–9 2026. DST starts Mar 8.
    const reviews = [
      Date.UTC(2026, 2, 8, 2, 0), // Mar 7 21:00 EST
      Date.UTC(2026, 2, 9, 1, 0), // Mar 8 21:00 EDT
      Date.UTC(2026, 2, 10, 1, 0), // Mar 9 21:00 EDT
    ];
    const now = Date.UTC(2026, 2, 10, 2, 0); // Mar 9 22:00 EDT
    expect(currentStreak(reviews, now, NY)).toBe(3);
  });

  it('AC16: a streak spans the fall-back day (a 25-hour day) without double counting', () => {
    const reviews = [
      Date.UTC(2026, 9, 31, 13, 0), // Oct 31 09:00 EDT
      Date.UTC(2026, 10, 1, 4, 30), // Nov 1 00:30 EDT (before the repeated hour)
      Date.UTC(2026, 10, 2, 4, 30), // Nov 1 23:30 EST
    ];
    const now = Date.UTC(2026, 10, 2, 15, 0); // Nov 2 10:00 EST, no review yet today
    expect(dayKey(reviews[1]!, NY)).toBe('2026-11-01');
    expect(dayKey(reviews[2]!, NY)).toBe('2026-11-01');
    expect(currentStreak(reviews, now, NY)).toBe(2);
  });

  it('a streak ends today or yesterday; a gap resets it', () => {
    const day = (d: number) => Date.UTC(2026, 9, d, 16, 0);
    expect(currentStreak([day(10), day(11), day(12)], day(12), 'UTC')).toBe(3);
    expect(currentStreak([day(10), day(11)], day(12), 'UTC')).toBe(2);
    expect(currentStreak([day(9), day(10)], day(12), 'UTC')).toBe(0);
    expect(currentStreak([], day(12), 'UTC')).toBe(0);
  });

  it('a review just before local midnight counts for that local day, not the UTC day', () => {
    const lateNight = Date.UTC(2026, 9, 13, 3, 55); // Oct 12 23:55 in New York
    const morning = Date.UTC(2026, 9, 13, 13, 0); // Oct 13 09:00 in New York
    expect(currentStreak([lateNight], morning, NY)).toBe(1);
    expect(currentStreak([lateNight], morning, 'Asia/Tokyo')).toBe(1);
  });

  it('AC16: due times are UTC offsets from commit time, unaffected by DST', () => {
    const beforeSpringForward = Date.UTC(2026, 2, 8, 4, 0); // Mar 7 23:00 EST
    const next = applyRating(initialSchedule('c', beforeSpringForward), 3, beforeSpringForward);
    expect(next.dueAt - beforeSpringForward).toBe(86_400_000);
  });
});
