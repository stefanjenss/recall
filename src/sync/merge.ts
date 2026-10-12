// Conflict rules, applied by the server when a pushed record meets a stored one.
// Pure and deterministic: the result depends only on the two versions.
//
// - The version with the later clock stamp wins.
// - Reviews never change once written: the first stored copy stays.
// - Deleting a card wins over an edit made elsewhere before the two synced.
//   The surviving card keeps the newer content, marked deleted.

import type { Card } from '../domain/types';
import { compareHlc } from './hlc';
import type { SyncStore } from './protocol';

export interface Versioned {
  hlc: string;
  value: unknown;
}

export interface MergeResult extends Versioned {
  outcome: 'stored' | 'incoming' | 'merged';
}

export function mergeRecord(store: SyncStore, stored: Versioned, incoming: Versioned): MergeResult {
  if (store === 'reviews') return { outcome: 'stored', ...stored };
  const incomingWins = compareHlc(incoming.hlc, stored.hlc) > 0;
  const winner = incomingWins ? incoming : stored;
  const loser = incomingWins ? stored : incoming;
  if (store === 'cards') {
    const w = winner.value as Card;
    const l = loser.value as Card;
    if (w.deletedAt === null && l.deletedAt !== null) {
      const value: Card = { ...w, deletedAt: l.deletedAt, updatedAt: Math.max(w.updatedAt, l.deletedAt) };
      return { outcome: 'merged', hlc: winner.hlc, value };
    }
  }
  return { outcome: incomingWins ? 'incoming' : 'stored', ...winner };
}
