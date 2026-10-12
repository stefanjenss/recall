import type { Card, Schedule, SkipReason } from './types';

export interface CardWithSchedule {
  card: Card;
  schedule: Schedule;
}

export function isActive(card: Card): boolean {
  return card.deletedAt === null;
}

/** A card is due when dueAt <= now and it is neither paused nor deleted. */
export function isDue(card: Card, schedule: Schedule, now: number): boolean {
  return isActive(card) && !schedule.paused && schedule.dueAt <= now;
}

export function isNew(schedule: Schedule): boolean {
  return schedule.reviewCount === 0;
}

/** Why a queued card can no longer be practised, or null when it still can. */
export function ineligibility(
  card: Card | undefined,
  schedule: Schedule | undefined,
  now: number,
): SkipReason | null {
  if (!card || !schedule || card.deletedAt !== null) return 'deleted';
  if (schedule.paused) return 'paused';
  if (schedule.dueAt > now) return 'not-due';
  return null;
}

function byDueThenId(a: CardWithSchedule, b: CardWithSchedule): number {
  return a.schedule.dueAt - b.schedule.dueAt || (a.card.id < b.card.id ? -1 : a.card.id > b.card.id ? 1 : 0);
}

/**
 * Pick from `group` (already sorted) in order, preferring a topic different from
 * the preceding card whenever the group still has one.
 */
function interleave(group: CardWithSchedule[], previousTopic: string | null, limit: number): CardWithSchedule[] {
  const remaining = [...group];
  const picked: CardWithSchedule[] = [];
  let prev = previousTopic;
  while (remaining.length > 0 && picked.length < limit) {
    let i = remaining.findIndex((item) => item.card.topic !== prev);
    if (i === -1) i = 0;
    const [item] = remaining.splice(i, 1);
    if (!item) break;
    picked.push(item);
    prev = item.card.topic;
  }
  return picked;
}

export interface QueueOptions {
  now: number;
  size: number;
  /** null means every topic. */
  topics: string[] | null;
}

/**
 * Build a practice queue: previously reviewed due cards first, then new cards.
 * Within each group sort by oldest due time (stable ID tie-break) and alternate
 * topics where the group allows it.
 */
export function buildQueue(items: CardWithSchedule[], { now, size, topics }: QueueOptions): string[] {
  const topicSet = topics ? new Set(topics) : null;
  const eligible = items.filter(
    ({ card, schedule }) => isDue(card, schedule, now) && (!topicSet || topicSet.has(card.topic)),
  );
  const established = eligible.filter((i) => !isNew(i.schedule)).sort(byDueThenId);
  const fresh = eligible.filter((i) => isNew(i.schedule)).sort(byDueThenId);

  const first = interleave(established, null, size);
  const lastTopic = first.at(-1)?.card.topic ?? null;
  const second = interleave(fresh, lastTopic, size - first.length);
  return [...first, ...second].map((i) => i.card.id);
}
