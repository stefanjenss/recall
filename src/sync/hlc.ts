// Hybrid logical clock. Every synced change is stamped with one, and the most
// recent stamp wins a conflict. A stamp is wall-clock milliseconds, a counter
// for changes within the same millisecond, and the device ID as a tie-break.
// Seeing a remote stamp moves the local clock past it, so an edit made after a
// sync always outranks what that sync brought in, even if this device's clock
// runs a little behind. Pure: callers pass `now`.

export interface Hlc {
  ms: number;
  counter: number;
  node: string;
}

const HLC_PATTERN = /^(\d{15})\.(\d{6,})\.([A-Za-z0-9-]{1,64})$/;

export function formatHlc({ ms, counter, node }: Hlc): string {
  return `${String(ms).padStart(15, '0')}.${String(counter).padStart(6, '0')}.${node}`;
}

export function parseHlc(value: string): Hlc | null {
  const m = HLC_PATTERN.exec(value);
  if (!m) return null;
  const ms = Number(m[1]);
  const counter = Number(m[2]);
  if (!Number.isSafeInteger(ms) || !Number.isSafeInteger(counter)) return null;
  return { ms, counter, node: m[3]! };
}

export function isHlc(value: unknown): value is string {
  return typeof value === 'string' && parseHlc(value) !== null;
}

function must(value: string): Hlc {
  const h = parseHlc(value);
  if (!h) throw new Error(`Malformed clock value ${JSON.stringify(value)}`);
  return h;
}

/** Negative when a is older than b, positive when newer, 0 when identical. */
export function compareHlc(a: string, b: string): number {
  const x = must(a);
  const y = must(b);
  if (x.ms !== y.ms) return x.ms < y.ms ? -1 : 1;
  if (x.counter !== y.counter) return x.counter < y.counter ? -1 : 1;
  return x.node < y.node ? -1 : x.node > y.node ? 1 : 0;
}

export function maxHlc(a: string, b: string): string {
  return compareHlc(a, b) >= 0 ? a : b;
}

/** A stamp for a fact that happened at `ms` (used when a device first uploads existing records). */
export function hlcAt(ms: number, node: string): string {
  return formatHlc({ ms: Math.max(0, Math.floor(ms)), counter: 0, node });
}

/** The next stamp for a local change: later than `last` and no earlier than `now`. */
export function tickHlc(last: string | null, now: number, node: string): string {
  const wall = Math.max(0, Math.floor(now));
  if (!last) return formatHlc({ ms: wall, counter: 0, node });
  const prev = must(last);
  if (wall > prev.ms) return formatHlc({ ms: wall, counter: 0, node });
  return formatHlc({ ms: prev.ms, counter: prev.counter + 1, node });
}

/** Advance the local clock after seeing a remote stamp, keeping this device's ID. */
export function observeHlc(last: string, remote: string): string {
  if (compareHlc(remote, last) <= 0) return last;
  const r = must(remote);
  return formatHlc({ ms: r.ms, counter: r.counter, node: must(last).node });
}
