# Recall — notes for Claude Code

Personal spaced-repetition study app. Static React + TypeScript + Vite site, with data in browser IndexedDB. The product
spec is `docs/PRD.md`; read the relevant section before changing behavior.

## Commands

- `npm run dev`: dev server on :5173
- `npm test`: Vitest unit tests (fake-indexeddb)
- `npm run test:e2e`: Playwright (builds, then serves on :4173; reuses a server that's already running there). The
  sync spec starts its own sync servers on :4300+
- `npm run build:server` / `npm run server`: bundle and run the sync server (`server/`, on :8787, data in `./data`)
- `npm run check`: typecheck + prettier check + unit tests + both builds (what CI runs)
- `npm run format`: Prettier

## Architecture rules

- `src/domain/` is pure: no I/O, no `Date.now()`. Callers pass `now`.
- Only `src/storage/repository.ts` talks to IndexedDB. Multi-record changes go in one `run([...stores], 'readwrite', …)`
  transaction. Never await non-IDB promises inside a transaction callback, or the transaction auto-commits early.
- Review commits are atomic and idempotent: review ID = attempt ID, inserted with `add`; `Schedule.stateVersion` and
  `Card.contentVersion` guard against stale commits.
- After a write, screens call `ws.refresh()`, which reloads the workspace and notifies other tabs over a
  BroadcastChannel.
- Schema changes: bump `DB_VERSION` in `src/storage/db.ts`, add an `if (oldVersion < N)` block, and update
  `docs/DATA.md`. A backup format change bumps `BACKUP_FORMAT_VERSION` and needs a migration path.
- Scheduler changes need a new `schedulerVersion` and a migration. Never silently reinterpret `recall-sm2-v1` data.
- Sync (`docs/SYNC.md`, `docs/DATA.md#sync`): any repository write that changes a synced record must call
  `markChanged` in the same transaction, which needs `'meta'` and `'outbox'` in its store list. `src/sync/` (except
  `client.ts` and `engine.ts`) is shared with the server and must stay pure. Conflict rules live only in
  `src/sync/merge.ts` and run only on the server. Wire format changes bump `SYNC_PROTOCOL`.

## UI conventions

- Design tokens live in `src/ui/styles/tokens.css`. Rectangular panels (2px radius), fine rules, no pervasive pills or
  shadows, 44px minimum touch targets, and rem units throughout. Study text: 18px body and inputs, 20px answers, 26–34px
  questions.
- Never show state by color alone; pair it with text or shape.
- Keep copy honest: self-ratings are "self-reported", long intervals are "spacing, not mastery", and there's no AI in P0.
- American English.

## Verifying UI changes

Run `npm run test:e2e`; it includes axe accessibility checks and a 320px reflow check on every screen. For visual
review, run `node scripts/screenshots.mjs` against a running preview and look at `docs/screenshots/`.
