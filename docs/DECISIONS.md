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
- **Sync.** Quick checks change record shapes that the sync server validates, and the sync design never resends a
  record the server rejected. A server without quick-check support would reject new schedules and quick-check reviews
  for good. So the sync protocol moved to 2, and the version is in the API path: a device and a server on different
  versions refuse each other's requests before any record moves, with a message saying what to update, and the device
  keeps its changes. The server's SQLite migration and devices' pulls apply the same record upgrades as IndexedDB and
  backup restore. Storage became schema 3, since sync had already taken schema 2 for its outbox.
- **Metrics.** Quick checks count toward activity, totals, and the streak (they are practice), and are reported on their
  own line in Progress. They are excluded from the self-rated Good/Easy share and the confidence table.

## Options for existing cards (October 2026)

The owner's collection predates options, so quick checks couldn't use any of it, and options could only be added one
card at a time in the editor. A content import can't help: it always creates cards, and matching questions are skipped
as duplicates. Add knowledge → Add options fills the gap. DATA.md has the format.

- **Matched by ID, not by question.** The prompt carries each card's ID and the reply must copy it back. IDs survive
  edits and duplicate questions; matching on question text would break on either. The prompt also carries the topic,
  which helps the assistant pick plausible wrong options.
- **The same guidance.** The option-writing rules are one block shared by the card prompt and the options prompt, so
  they can't drift apart. The card prompt's text didn't change.
- **The same validation.** Each entry is validated with `validateCardInput` against the card's current content, the
  path a single edit takes, so bulk and one-at-a-time options follow identical rules.
- **Valid entries save; invalid ones are skipped.** Unlike a content import, an error doesn't block the batch: these
  entries add to existing cards rather than create content, the bad ones are listed with their reason, and asking the
  assistant again for those cards is the natural fix. Inline editing of entries wasn't built; the card editor is there.
- **Replacing is opt-in.** The export lists only cards without options, but a card can gain options between export and
  paste (in another tab, or on another device). Overwriting options the learner wrote is the riskier mistake, so a
  card's own options stay unless the learner ticks "Replace the current options". This matches content import, where
  duplicates are skipped unless kept.
- **A content edit.** Adding options bumps `contentVersion`, the same as saving the card editor, so an attempt in
  progress goes stale and reloads with the new content instead of committing against a version it didn't show.
  Schedules and review history are untouched; options don't change what the learner knows.
- **One transaction, guarded by version.** Every included card is written together, or none. Each update names the
  `contentVersion` the preview showed; a card edited or deleted since then is skipped and reported rather than
  overwritten. The idempotency key reuses `importBatches`, which already plays this role for content imports.
- **Up to 100 per prompt, 25 by default.** Assistants answer smaller batches in full more reliably. After a save, the
  next prompt automatically holds the next cards without options.
- **Today links to it** when due cards are left out of a quick check for lack of options.

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

## Hosting and offline

- **GitHub Pages**, deployed by `.github/workflows/deploy.yml` on every push to `main` after `npm run check` passes. The
  app is static and the data lives in each browser, so it needs no server of its own. The home server (the owner's
  Ubuntu box with Docker and Tailscale) runs the optional sync server (see [Sync](#sync)) and is the planned place for
  any P1 inference service.
- **A hand-written service worker** instead of `vite-plugin-pwa`/Workbox. It's about 60 lines, adds no dependencies, and
  does one thing. A small Vite plugin in `vite.config.ts` writes `dist/sw.js` after each build, listing every output file
  (except legacy `.woff` fonts; every browser with service workers uses `.woff2`) and a version hash of their contents.
- **Precache everything, serve cache-first, update on request.** Each build gets its own cache (`recall-<hash>`).
  Install fetches with `cache: 'reload'` so a new version never stores a stale `index.html` from the HTTP cache. A new
  worker waits until the learner clicks **Reload now**. Swapping versions on its own could change the app in the middle
  of a session. Old caches are deleted on activation.
- **`index.html` is cache-first too, not network-first.** Network-first would make every load wait on the host, and on
  a phone whose home server is asleep or whose Tailscale link is half up that wait can last until a timeout. It would
  also mix a new `index.html` with the old worker's cached files. A cache-first shell isn't stale for long: the browser
  checks `sw.js` on every load, bypassing the HTTP cache, and the app checks again when it comes back to the
  foreground after 30 minutes.
- **Only the app's own files go through the worker.** It answers navigations (always `index.html`, since routing is by
  hash) and files in this build's precache list. Everything else goes to the network untouched, including other
  origins and the sync server's API (`api/` next to the app, or `/api/` at the root). Opening `/api/health` in a tab
  still reaches the server rather than the cached app.
- **Secure contexts only.** Browsers allow service workers only on HTTPS and `localhost`, so a plain-HTTP address
  (such as a tailnet IP without Tailscale Serve) works online but not offline. Settings says so instead of blaming the
  browser.
- **`ignoreVary` on cache lookups.** Some servers send `Vary: Origin`, and Vite's module script and stylesheet tags
  are requested with an `Origin` header the precache requests didn't have. Without it, offline loads failed. The
  end-to-end test caught this.
- Registered only in production builds, so `npm run dev` is never served stale code.

## Sync

Added after P0 as the PRD's P2 "sync across devices", scoped to one person with their own server. Setup and behavior
are in [SYNC.md](SYNC.md), formats in [DATA.md](DATA.md#sync). The PRD asks that a server-backed scope change document
authentication, storage, backups, running cost, and the reason; those are covered here and in SYNC.md.

- **Why a self-hosted server.** The goal is one person's phone and laptop sharing one collection, and the learner
  already runs a home server. A server they own keeps the "nothing goes to anyone else" promise, has no hosting cost
  beyond the machine that's already on, and needs no accounts. Hosted multi-user sync stays out of scope.
- **Offline first.** IndexedDB remains the source of truth on each device; the app works the same with the server
  down. Sync copies records between full replicas instead of moving storage to the server.
- **Record-level last-writer-wins, decided by the server.** Each record travels whole with a hybrid logical clock stamp.
  The server applies a few pure rules (`src/sync/merge.ts`): the later stamp wins, reviews never change once stored, and
  a delete beats a concurrent edit. Devices accept whatever the server stores unless they hold a newer local change.
  The server is the single place conflicts are resolved, so devices converge even when the rules combine fields. That
  rules out per-field merging (for example, a pause on one device and a review on another: the later schedule wins
  whole). For one person, conflicting edits need two devices changing the same card while one is offline, so whole
  records are an acceptable trade for a much simpler design.
- **Hybrid logical clock, not plain timestamps.** Wall clocks on two devices can differ by seconds. The HLC makes any
  change made after seeing another device's change sort later, regardless of skew. The server refuses stamps more than a
  day ahead of its clock, so a device with a badly wrong date can't override everything.
- **Outbox in the same transaction.** Every repository write that changes a synced record also queues it in `outbox`
  in the same IndexedDB transaction, so a crash can't lose a change or sync a change that didn't commit. All writes
  already go through `repository.ts`, so this needed no changes in screens. The outbox is only written while connected;
  connecting queues every existing record, stamped with when it last changed.
- **Active sessions stay local.** A session in progress holds a draft and a queue built on one device; syncing it would
  mean two devices sharing one "active session" and breaking the at-most-one-active rule. Reviews sync as they happen;
  the session record follows when it ends.
- **Pull by sequence number, without echoes.** Every write on the server gets the next sequence number, so a device
  pulls "everything since N" and never misses a change. Rows remember which device wrote them as-is; that device isn't
  sent them back, which keeps a first upload of a large collection from downloading it all again. Because of this, a
  device gets a fresh ID on every connection.
- **Joining is explicit.** When both the device and the server have data, the learner chooses: take the server's copy
  (the usual way to add a device), combine, or replace the server's copy. Replacing makes the server save a JSON backup
  first and changes its ID, so other devices stop and ask to reconnect rather than silently mixing old and new data.
  Restoring a backup on a device disconnects it for the same reason.
- **Server stack.** Node's built-in `node:sqlite` and `node:http`, bundled with Vite into one file with no runtime
  dependencies, so the home server needs only Node 22.13+ or Docker. `node:sqlite` still prints an experimental
  warning; it's stable enough for a single-user store and is suppressed in the provided start commands. The server
  reuses `src/content/backup.ts` to validate every incoming record and to write backups in the format the app restores.
- **Auth.** One random 256-bit key, compared in constant time and sent only in a header. That's enough for a
  single-user server reachable only on a private tailnet. It is not per-device: revoking one device means changing the
  key on all of them.
- **Same-origin by default.** The server serves the built app as well as the API, which avoids CORS, mixed-content
  blocking, and Chrome's private-network prompts, and lets the app ship a strict Content Security Policy. The service
  worker caches that copy too, so it still opens when the server is unreachable. The GitHub Pages copy can sync as well
  once its origin is allowed with `RECALL_ALLOWED_ORIGINS`.
- **Not done:** per-device keys, pairing by QR code, end-to-end encryption of the server copy, and automatic
  server-side backup rotation (the `backup` command plus cron covers it).

## Not done, on purpose

- No dark mode. The PRD centers the cream-and-green identity; a dark variant should be designed, not inverted.
- No AI. The Settings page says so plainly. See the README roadmap.
