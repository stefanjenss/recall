// Calendar-day helpers. Instants are stored in UTC; calendar days are derived
// in the learner's chosen IANA timezone. Day arithmetic operates on civil
// dates ("2026-03-08"), never by subtracting 24 hours from an instant, so
// daylight-saving transitions don't skip or repeat a day.

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = dayFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    dayFormatters.set(timeZone, f);
  }
  return f;
}

/** The calendar day (YYYY-MM-DD) containing `ts` in `timeZone`. */
export function dayKey(ts: number, timeZone: string): string {
  const parts = dayFormatter(timeZone).formatToParts(ts);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Civil-date arithmetic: "2026-03-08" + -1 → "2026-03-07". */
export function addDays(key: string, delta: number): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d + delta));
  return date.toISOString().slice(0, 10);
}

/** The `n` calendar days ending with `endKey`, oldest first. */
export function lastNDays(endKey: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => addDays(endKey, i - (n - 1)));
}

/**
 * Consecutive days with at least one committed review, ending today or
 * yesterday. Imported content and reflections don't count.
 */
export function currentStreak(reviewTimes: Iterable<number>, now: number, timeZone: string): number {
  const days = new Set<string>();
  for (const t of reviewTimes) days.add(dayKey(t, timeZone));
  const today = dayKey(now, timeZone);
  let cursor = days.has(today) ? today : addDays(today, -1);
  let streak = 0;
  while (days.has(cursor)) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function supportedTimeZones(): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  try {
    const zones = intl.supportedValuesOf?.('timeZone');
    if (zones && zones.length) return zones.includes('UTC') ? zones : ['UTC', ...zones];
  } catch {
    // fall through
  }
  return ['UTC'];
}

export function formatDateTime(ts: number, timeZone: string, opts: Intl.DateTimeFormatOptions = {}): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...opts,
  }).format(ts);
}

export function formatDay(key: string, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }): string {
  // Format a civil date without letting the viewer's timezone shift it.
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', ...opts }).format(Date.UTC(y, m - 1, d, 12));
}

/** "in 3 hours", "in 2 days", "now". */
export function formatRelative(target: number, now: number): string {
  const diff = target - now;
  if (diff <= 0) return 'now';
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'in under a minute';
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `in ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  const days = Math.round(hours / 24);
  return `in ${days} days`;
}
