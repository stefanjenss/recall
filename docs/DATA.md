# Data, storage, and file formats

## IndexedDB schema

Database `recall`, schema version **2** (`src/storage/db.ts`). All timestamps are UTC milliseconds; intervals are days.

| Store           | Key                                      | Indexes                                | Holds                                                                                                                                                                                  |
| --------------- | ---------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cards`         | `id`                                     | —                                      | `Card`: topic, question, answer, kind, source, `choices` (multiple-choice options or null), `contentVersion`, created/updated, `deletedAt` (soft delete)                               |
| `schedules`     | `cardId`                                 | —                                      | `Schedule`: `dueAt`, `intervalDays`, `ease`, `reviewCount`, `lapseCount`, `paused`, `schedulerVersion`, `stateVersion`, `lastReviewedAt`, `quickChecksSinceRecall`                     |
| `reviews`       | `id` (= attempt ID, the idempotency key) | `byCard`, `byCommittedAt`, `bySession` | `Review`: `mode`, response, confidence, rating (full recall) or `quickCheck` (options shown, pick, correct), before/after schedule snapshots, timestamps, content snapshot             |
| `sessions`      | `id`                                     | `byStatus`                             | `Session`: `mode`, topics, size, queue (card IDs), index, status, current `attempt` (draft, confidence, reveal state; for a quick check, the shuffled `options` and `picked`), results |
| `reflections`   | `id`                                     | `byCreatedAt`                          | `Reflection`: body, optional session ID                                                                                                                                                |
| `rubrics`       | `id`                                     | `byCard`                               | Reserved for P1 grading (empty in P0)                                                                                                                                                  |
| `assessments`   | `id`                                     | `byAttempt`                            | Reserved for P1 grading (empty in P0)                                                                                                                                                  |
| `importBatches` | `id`                                     | —                                      | Import idempotency keys. A runtime cache, excluded from backups                                                                                                                        |
| `meta`          | `key`                                    | —                                      | `preferences`, `lastBackupAt`                                                                                                                                                          |

Types are defined in `src/domain/types.ts`.

### Invariants

- Every card has exactly one schedule.
- A review and its schedule transition are written in the same transaction. `reviewCount` on a schedule equals the
  number of full-recall reviews plus missed quick checks committed since the card was created or last reset. A correct
  quick check doesn't count.
- `quickChecksSinceRecall` is at most 2. A full-recall review resets it to 0.
- A review has `mode: 'recall'` with a rating 1–4 and `quickCheck: null`, or `mode: 'quick-check'` with
  `rating: null` and a `quickCheck` result.
- `stateVersion` increases on every schedule change (review, pause, resume, reset). `contentVersion` increases on
  every content edit. Attempts record both and are rejected at commit if either has moved.
- At most one session has `status: 'active'`.

### Migrations

`openRecallDb` runs `upgrade(db, oldVersion)` with one `if (oldVersion < N)` block per version. Add a new block for each
schema change; never edit a released one. If another tab opens a newer schema, this tab's connection closes itself and
the app asks the learner to reload.

| Version | Change                                                                                                                                                                                                                                                                                                                                                                        |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | Initial schema                                                                                                                                                                                                                                                                                                                                                                |
| 2       | Quick checks. No new stores or indexes; existing records are backfilled in the upgrade transaction: cards get `choices: null`; schedules get `quickChecksSinceRecall: 0` and move to `recall-sm2-v2`; reviews get `mode: 'recall'`, `quickCheck: null`, and `choices: null` in their snapshot; sessions get `mode: 'recall'` and attempts get `options: null`, `picked: null` |

The record upgrades live in `src/domain/upgrade.ts` and are shared with backup restore, so a version 1 database and a
version 1 backup end up identical.

### Scheduler versioning

Schedules record `schedulerVersion: "recall-sm2-v2"`: the `recall-sm2-v1` rating rules, unchanged, plus the quick-check
rule (PRD §8). Because v2 doesn't reinterpret any v1 value, the migration only relabels v1 schedules and sets their
quick-check counter to 0. Each review keeps the `schedulerVersion` that computed it, so older reviews still say
`recall-sm2-v1`.

A future scheduler (for example FSRS) must use a new version string and an explicit migration. It must not silently
reinterpret existing intervals. Backups with an unknown scheduler version are rejected.

## Full backup — `recall-backup` v2

Produced by Settings → Download full backup (`src/content/backup.ts`).

```json
{
  "format": "recall-backup",
  "formatVersion": 2,
  "exportedAt": "2026-10-15T18:00:00.000Z",
  "schedulerVersion": "recall-sm2-v2",
  "data": {
    "cards": [],
    "schedules": [],
    "reviews": [],
    "sessions": [],
    "reflections": [],
    "rubrics": [],
    "assessments": [],
    "preferences": {
      "schemaVersion": 1,
      "timezone": "America/New_York",
      "readingSize": "standard",
      "sessionSize": 20,
      "aiMode": "disabled"
    }
  }
}
```

It contains no secrets, credentials, or runtime caches (`importBatches`, `lastBackupAt`).

| Format version | Change                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| 1              | Initial format                                                                                           |
| 2              | Quick checks: the same record fields as storage schema 2. Version 1 backups are upgraded during restore. |

### Restore rules

1. File size is checked before parsing (50 MB maximum).
2. **Dry run:** the JSON is parsed and every record is validated: types, enums, numeric ranges, field-length limits,
   duplicate IDs, every card having a schedule, every schedule having a card, and at most one active session. Up to
   25 problems are listed.
3. A `formatVersion` newer than 2 is rejected with a message to update the app. Nothing is dropped or guessed. A
   version 1 backup is upgraded first (the same record upgrades as the storage migration) and then validated as
   version 2.
4. The learner sees record counts for the current workspace and for the backup, and can download a backup of the
   current data first.
5. On confirmation, every store is cleared and repopulated in **one** transaction. A failure leaves the previous
   workspace intact.

## Content export — `recall-v1`

Produced by Collection → Export cards and Settings → Export cards (`src/content/exportContent.ts`). It carries content
only: no schedules or history.

```json
{
  "format": "recall-v1",
  "exportedAt": "2026-10-12T18:00:00.000Z",
  "note": "Content only. Schedules and review history are not included; imported cards start as new.",
  "cards": [
    {
      "topic": "SQL",
      "kind": "apply",
      "question": "…",
      "answer": "…",
      "source": null,
      "choices": { "correct": "…", "distractors": ["…", "…", "…"] }
    }
  ]
}
```

The original Recall app's exact `recall-v1` envelope wasn't available while building this, so the importer accepts
_any_ object with a `cards` array (and a bare array). The export above follows that same shape.

## Content import

Add knowledge → Import cards (`src/content/import.ts`).

- **Sources:** pasted text, or a `.json`, `.tsv`, or `.txt` file up to 2 MB.
- **JSON:** an array of card objects, or an object with a `cards` array. Fields: `question` and `answer` (required);
  `topic` (default `General`), `kind` (`recall`, `apply`, `compare`, or `explain`, case-insensitive, default `recall`),
  `source` (string or null), and `choices` (null, or `{ "correct": "…", "distractors": ["…"] }` with one to three
  wrong options, each up to 500 characters, all different). Options are trimmed and blank wrong options dropped; an
  object with every option blank means no options. Other fields are ignored. A full backup pasted here is redirected
  to Settings.
- **TSV:** one card per line, columns in this order: `question`, `answer`, optional `topic`. TSV can't carry
  multiple-choice options; use JSON for those. A first line reading
  `question<TAB>answer[<TAB>topic]` is treated as a header and skipped. Lines with fewer than 2 or more than 3 columns
  are flagged. `.txt` and pasted text are treated as JSON when they start with `[` or `{`, and as TSV otherwise.
- **Limits:** topic 100 characters, question 3,000, answer 10,000, source 1,000. Over-limit values are errors, never
  truncated.
- **Validation is per batch** (up to 100 cards). Any error blocks the whole batch until each problem card is edited or
  removed, so there are no partial writes.
- **Duplicates** (same normalized question, either already in the collection or earlier in the batch) are flagged and
  skipped unless the learner chooses to keep them.
- **Idempotency:** each previewed batch gets a random ID. Committing records it in `importBatches` in the same
  transaction as the cards, so retrying or double-clicking returns "already imported" instead of adding the cards twice.
- Imported cards start as new and due now.
