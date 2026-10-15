import { QUICK_CHECK_LIMIT } from './scheduler';
import type { Card, CardChoices, Schedule } from './types';

/** A card can be quick-checked when it has options and hasn't reached the quick-check limit. */
export function canQuickCheck(card: Card, schedule: Schedule): boolean {
  return card.choices !== null && schedule.quickChecksSinceRecall < QUICK_CHECK_LIMIT;
}

/** The correct option and the distractors in a random order (Fisher–Yates). `random` returns [0, 1). */
export function shuffledOptions(choices: CardChoices, random: () => number): string[] {
  const options = [choices.correct, ...choices.distractors];
  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [options[i], options[j]] = [options[j]!, options[i]!];
  }
  return options;
}

export function sameChoices(a: CardChoices | null, b: CardChoices | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.correct === b.correct &&
    a.distractors.length === b.distractors.length &&
    a.distractors.every((d, i) => d === b.distractors[i])
  );
}
