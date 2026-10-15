# Technical decisions

Choices made while building the P0 release from [`PRD.md`](PRD.md), and the reasoning behind them. Where this
implementation differs from the PRD's proposed defaults, it says so.

## Stack

| Area       | Choice                                                        | Why                                                                                                                                                                                                    |
| ---------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| UI         | React 19 + TypeScript 5.9 (strict)                            | The PRD default. TypeScript 7 (the native compiler) was available but is new; 5.9 is the conservative choice.                                                                                          |
| Build      | Vite 7                                                        | The PRD default. Vite 8 was available, but 7.x is a maintained line I can vouch for.                                                                                                                   |
| Storage    | IndexedDB via [`idb`](https://github.com/jakearchibald/idb) 8 | The PRD default. `idb` is a ~1 kB promise wrapper; transactions remain explicit.                                                                                                                       |
| Markdown   | `markdown-it` 14, `html: false`, images disabled              | Escapes raw HTML by design, so no HTML sanitizer is needed. Link protocols are restricted to http(s), mailto, and relative links. Images are disabled so card content never triggers network requests. |
| Fonts      | DM Sans and Libre Caslon Display, bundled via `@fontsource`   | Both are SIL Open Font License. Self-hosting means no Google Fonts requests, keeping the "no external calls" promise.                                                                                  |
| Routing    | Hand-written hash router (`src/app/router.ts`)                | Seven routes don't justify a dependency, and hash routing works on any static host without rewrites.                                                                                                   |
| Unit tests | Vitest 3.2 + `fake-indexeddb`                                 | Vitest 4 hit an npm resolver bug (`Cannot read properties of null (reading 'edgesOut')`) through its optional peers; 3.2 installs cleanly and supports Vite 7.                                         |
| E2E tests  | Playwright 1.56 + `@axe-core/playwright`                      | Pinned to match the Chromium build in the development container. A package `override` keeps axe on the same `playwright-core`.                                                                         |
| Formatting | Prettier                                                      | No ESLint yet: strict TypeScript catches most of what lint would, and fewer tools means less to maintain. Easy to add later.                                                                           |

All dependency versions are pinned exactly in `package.json`, and `package-lock.json` is committed.

## Architecture

- **The domain is pure.** `src/domain` has no I/O. The scheduler takes `(schedule, rating, now)` and returns a new
  schedule, so the interval previews on the rating buttons and the committed result come from the same function.
- **One storage module.** Only `src/storage/repository.ts` touches IndexedDB. Screens call repository methods and then
  `refresh()` the in-memory workspace.
- **Cards and schedules are separate stores.** Content edits never touch scheduling state, and the schedule's
  `stateVersion` works as a clean optimistic-concurrency token.
- **Atomic, idempotent reviews.** `commitReview` inserts the review, advances the schedule, and moves the session
  forward in a single readwrite transaction. The review ID _is_ the attempt ID, and it's inserted with `add` (not
  `put`), so a retry can never create a second event. A retried commit returns the review that already exists.
- **Concurrency.** A commit is rejected as stale when the schedule's `stateVersion` or the card's `contentVersion`
  differs from what the attempt started with, or when the card has since been paused or deleted. The learner sees what
  changed and can load the updated card (their draft is kept), skip it, or reload the session. IndexedDB serializes
  overlapping readwrite transactions, so the check and the write can't interleave across tabs.
- **One active session.** Starting a second session while one is active is refused; Today offers Resume or End
  instead. The queue is captured at start, and cards that become ineligible before their turn are skipped and recorded
  in the session results.
- **Cross-tab freshness.** A `BroadcastChannel` tells other tabs to reload after each write. Practice notices when
  another tab has moved the session on and asks the learner to reload rather than letting them rate a stale card.
- **Drafts.** The in-progress answer and confidence are saved to the session record 400 ms after typing stops, and
  again on `pagehide` and when the tab is hidden. Revealing freezes them; later draft writes for that attempt are
  ignored.

## Product decisions within the PRD's latitude

- **Queue mixing follows PRD §8 literally.** Within the established-due group, then the new group, cards are sorted by
  due time (ID tie-break) and each pick prefers a topic different from the previous card, searching the whole group.
  With a large single-topic backlog, a less-overdue card from another topic can therefore enter the session ahead of
  older same-topic cards. That trade favors interleaving, and every due card is still reached in later sessions.
- **Ease is rounded to two decimals** after each change, so repeated adjustments don't drift (2.5 − 0.15 is exactly
  2.35, not 2.3499999…). Intervals follow the PRD's rounding rules exactly.
- **Soft delete.** Deleting a card sets `deletedAt`; it disappears from every learner-facing view, but its review
  history and snapshots stay for Progress, as the PRD requires. "Delete all data" removes everything.
- **Duplicate detection** compares normalized question text (trimmed, whitespace collapsed, case-insensitive).
  Duplicates are skipped by default; the learner can keep each one deliberately.
- **Large imports** are reviewed and committed in batches of 100, as the PRD requires, rather than rejected outright.
  Each batch gets its own idempotency key when it's previewed.
- **Topic and source are trimmed; question and answer are never modified.** A blank topic becomes "General".
- **Character limits count Unicode code points**, so an emoji counts as one character.
- **Reading size** scales the root font size (100%, 112.5%, 125%). The whole interface scales, not just study text.
- **Persistent storage** is requested automatically once the collection has a card, and on demand from Settings.
  Denial is reported plainly.
- **Mobile navigation** is a top bar with a Menu disclosure (not a modal drawer), so every destination stays one tap
  away without trapping focus.
- **Spelling** is American English.

## Quick checks (October 2026)

The owner asked for a "lazy mode": answer a multiple-choice version of a card instead of recalling it, weighted less, and
usable only once or twice in a row. PRD §7 and §8 have the spec; these are the calls made while building it.

- **Name.** The UI calls it "Quick check", described as "Multiple choice · recognition, not recall". The copy rules favor
  plain honesty over a self-deprecating label.
- **One mode per session.** Today offers Full recall or Quick check before starting. A per-card "show options" escape
  hatch inside a full-recall attempt wasn't built; it would mix two scoring rules in one session and needs its own
  design.
- **The weighting.** A correct pick leaves interval, ease, and review count alone and brings the card back in
  min(2, max(1, floor(I))) days: never sooner than a day, never later than the card's current interval or 2 days. A
  wrong pick is a full Again, ease penalty and lapse included, because missing with the answer on screen is strong
  evidence. After 2 quick checks in a row the card is recall-only until a full review.
- **Pick, then continue.** Picking freezes the attempt (like Reveal) and shows the result; Continue commits. This reuses
  the existing commit path, so idempotency, stale-version checks, and draft recovery behave exactly as in full recall,
  and the result survives a reload. Option buttons pick on the first click with no separate Check step; "your first
  pick counts" is stated on screen.
- **Correctness is decided at commit**, against the card, after the `contentVersion` check, so an edit made in another
  tab can't produce a wrong verdict.
- **Shuffling** happens once, when the attempt is created, and the order is stored on the attempt. The domain helper
  takes an injected random function; the repository passes `Math.random`.
- **Options:** one correct and one to three wrong, each up to 500 characters. The editor shows three wrong-option
  fields and drops blank ones. Options render as inline Markdown (code, emphasis) without links, because they sit
  inside buttons.
- **Scheduler version.** The rating rules didn't change, but due times no longer always equal last review plus
  interval, and schedules gained a counter, so this is `recall-sm2-v2` with a relabel-only migration, per the project
  rule. `Review.schedulerVersion` is typed as a string because older reviews correctly keep `recall-sm2-v1`.
- **Metrics.** Quick checks count toward activity, totals, and the streak (they are practice), and are reported on their
  own line in Progress. They are excluded from the self-rated Good/Easy share and the confidence table.

## Performance

`scripts/perf-check.mjs` restores a synthetic backup of 5,000 cards and 20,000 reviews, then times interactions end to
end, Playwright overhead included. Measured in the development container (4 vCPU Intel Xeon @ 2.1 GHz, headless Chromium
141, Linux):

| Interaction                                  | Time          |
| -------------------------------------------- | ------------- |
| Navigate Today → Collection (first 100 rows) | 99 ms         |
| Search the collection                        | 36 ms         |
| Clear search (all 5,000 match)               | 54 ms         |
| Filter by topic / by status                  | 61 ms / 36 ms |
| Navigate to Progress                         | 76 ms         |
| Start a 20-card session                      | 224 ms        |
| Reveal + rate → next card                    | 132 ms        |
| Cold page load to Today                      | 889 ms        |
| Validate a backup (dry run)                  | 417 ms        |
| Restore 25,000 records                       | 14.4 s        |

Ordinary navigation and filtering stay under the PRD's proposed 200 ms target. Starting a session and a cold load are
above it. That's acceptable for occasional actions, but it's measured and noted rather than claimed as met. A restore
this large is a one-off; the dialog warns that big restores can take up to a minute. A phone will be slower than this
container.

Changes made because of these measurements: restores queue all inserts at once instead of awaiting each; calendar-day
lookups are cached in 15-minute buckets; review history is read in its own transaction so it never delays session
writes; and Practice refreshes the workspace only after its first card is on screen.

## Not done, on purpose

- No service worker or offline cache yet. The app works offline once loaded, but a fresh load needs the host. Adding a
  service worker brings update and versioning concerns; worth a separate change.
- No dark mode. The PRD centers the cream-and-green identity; a dark variant should be designed, not inverted.
- No AI. The Settings page says so plainly. See the README roadmap.
