# Recall Product Requirements Document

**Version:** 1.1  
**Date:** October 9, 2026; revised October 15, 2026 to add quick checks (§7, §8)  
**Owner:** Stefan Jenss  
**Purpose:** Build a standalone version of Recall outside ChatGPT Sites.  
**Status:** Ready for implementation planning. Existing requirements and proposed implementation defaults are distinguished below.

## 1. Product intent

Recall is a personal learning workspace that turns concepts, terms, and notes into durable knowledge through active recall, spaced repetition, mixed practice, and reflection. It should feel like a quiet, thoughtfully designed study studio. The central experience is answering a good question from memory, checking understanding, and returning at an appropriate time.

The initial user is a working professional studying Python, SQL, algorithms, data engineering, and AI systems. Sessions should fit into a short evening practice and work comfortably on a computer, iPhone, or iPad. The app must support other subjects without embedding technical-interview assumptions into its data model.

The owner wants an Anki-like review mechanism with a substantially more readable, modern interface, inspired by the learning principles in *Make It Stick*. He likes the existing theme and explicitly dislikes a UI dominated by rounded bubble boxes. He has also requested AI feedback that identifies what an answer gets right, misses, or misunderstands.

**Primary outcome:** The learner can produce and apply knowledge after time has passed, rather than merely recognize familiar text. Review counts, streaks, and model scores are supporting signals, not proof of mastery.

## 2. Requirements provenance and defaults

### Confirmed owner requirements

- Accept concepts and terms and turn them into reviewable flashcards, including cards prepared by an external AI assistant.
- Support spaced repetition, interleaving, active recall, and other relevant principles from *Make It Stick*.
- Preserve the existing cream-and-green visual identity and improve reading comfort.
- Use large, well-spaced text for prompts, responses, answers, and feedback.
- Avoid a generic rounded-card dashboard aesthetic.
- Define AI answer grading with clear feedback about correct and missing aspects.
- Produce a standalone app that is independent of ChatGPT Sites.
- Offer an optional, lighter multiple-choice "quick check" mode that counts for less than full recall and can't stand in for it indefinitely (requested October 2026).

**AI access constraint:** In the earlier discussion, the owner preferred not to use a paid API. This PRD therefore makes manual study and external-assistant workflows complete without paid inference. Embedded AI remains a separately enabled capability. The builder must not assume a consumer AI subscription grants an external app programmatic inference access; validate the chosen provider's documented integration before promising it. Do not obtain credentials, incur inference charges, or add a paid dependency without a new owner decision.

### Proposed implementation defaults

These are decisions for an efficient first build, not additional requests already approved by the owner:

- A private, single-user, browser-based app with local persistence for the first release.
- React and TypeScript with Vite, IndexedDB storage, and a versioned JSON backup format.
- Retain the existing simple adaptive scheduler for initial parity; isolate it so a different scheduler can be adopted later.
- Keep the four main destinations: Today, Collection, Progress, and The method. Add Settings for preferences and backups.
- Default sessions to 20 due cards. Support smaller session sizes.
- Make the AI experience optional and provider-independent.

The implementation agent may change a technical default with a short documented rationale, provided it preserves product behavior, portability, cost constraints, and acceptance criteria.

## 3. Existing app baseline

Reference: [Recall — A learning practice](https://recall-study-studio.jenss-9700.chatgpt.site). The reference is private and may require the owner's session. This PRD is sufficient to build without access to that session.

The source inspected for this PRD was commit `a44adde7a180d283a7742e839350dea61ffe1f2d`; the Site reports saved version 3. Source inspection confirms implementation paths, not a live test of the owner's stored collection.

| Area | Existing implementation | Standalone requirement |
| --- | --- | --- |
| Navigation | Today, Collection, Progress, The method | Preserve structure and intent |
| Cards | Topic, question, answer, kind, optional source | Preserve and extend with optional rubric |
| Card kinds | Recall, Apply, Compare, Explain | Preserve |
| Practice | Typed or spoken recall, optional confidence, reveal, four ratings | Preserve; add optional grading |
| Scheduling | Adaptive SM-2-inspired rules, 10-minute retries | Preserve initial behavior |
| Mixing | Alternates topics where possible, up to 20 cards | Preserve mixing; enforce due-before-new priority explicitly |
| Collection | Search, topic/status filters, edit, pause/resume, delete | Preserve |
| Import | JSON array or object with cards; TSV; preview; 100 cards per batch | Preserve compatibility and add stronger validation |
| Export | Content-only JSON using recall-v1 | Preserve; add full backup and restore |
| Progress | Review activity, self-ratings, longer intervals, streaks, reflections | Preserve honest metric labels |
| AI generation | Instructions to use ChatGPT and import generated JSON | Preserve a provider-neutral copy/import workflow |
| AI grading | No grading implementation in inspected source | New optional capability |
| Agent integration | Prepared MCP routes for listing and adding cards; UI reports access restrictions | Optional later integration; not required for MVP |
| Persistence | Cloudflare D1, scoped to ChatGPT identity | Replace with standalone storage; do not copy Sites identity plumbing |

The existing content export omits scheduling and review history. A content-only migration must explicitly start imported cards as new. Do not imply that an exported deck contains history it does not contain.

## 4. Scope and release priorities

| Priority | Deliverable | Release gate |
| --- | --- | --- |
| P0 | Independent app shell and design system | Runs without Sites libraries, ChatGPT sign-in, or inference credentials |
| P0 | Manual card authoring and external AI import workflow | A learner can create useful cards without embedded AI |
| P0 | Collection management | Search, filter, edit, pause/resume, delete |
| P0 | Recall loop and scheduler | Attempt, confidence, reveal, rate, schedule, persist |
| P0 | Local persistence, session recovery, full backups | Reloads do not erase work; backups restore schedules and history |
| P0 | Progress, reflections, method explanation | Metrics derive from real saved reviews |
| P0 | Responsive, accessible study interface | Desktop and touch-device acceptance checks pass |
| P1 | Structured rubrics and embedded AI grading | Requires a verified inference route and owner approval of its cost/access |
| P1 | Embedded AI card generation | Preview and edit before saving; same access gate as grading |
| P2 | Account-backed sync across devices | Separate architecture and conflict-handling work |
| P2 | FSRS scheduling, related-card burial, reminders, agent/MCP integration | Separate enhancements after the core loop is stable |

**MVP excludes:** social feeds, public deck marketplaces, subscriptions, leaderboards, native mobile apps, arbitrary code execution, document crawling, PDF ingestion, voice transcription, and enterprise administration. Code examples may be displayed and answered as text; no sandbox is required.

An MVP without embedded AI is complete for P0. It must not be described as fulfilling the owner's embedded grading request until P1 grading works with a real, verified provider.

## 5. Learning behavior

| Principle | Product behavior |
| --- | --- |
| Retrieval | Show the question before the answer; give room to type or answer aloud |
| Spacing | Persist a per-card due time and adaptive interval |
| Interleaving | Mix topics and problem types rather than repeatedly showing identical exercises |
| Generation | Include application scenarios and attempts before explanations |
| Elaboration | Encourage a useful connection, example, or explanation in the learner's own words |
| Calibration | Capture confidence before feedback; keep confidence distinct from performance |
| Reflection | Offer a brief optional note after practice |

Mixed-topic order alone is not a guarantee of improved learning. The question set should include related comparisons and varied applications that require selecting an approach. Avoid enforcing artificial percentages of card kinds regardless of the subject.

Use accurate, self-contained cards with one primary learning objective. Break broad prompts into several focused questions. A concise answer should state the key idea and use an example where helpful. Show supplied sources and distinguish generated examples from sourced facts. AI-generated content must remain editable and reviewable.

## 6. Main user journeys

### 6.1 Add knowledge

1. The learner opens Add knowledge.
2. Chooses Write a card or Import from assistant/file. Embedded generation appears only if configured.
3. Enters or imports card content, with a topic and question kind.
4. Previews imported/generated cards, edits or removes drafts, and resolves errors.
5. Saves the accepted cards. They become due immediately with initial scheduling state.

The external-assistant path supplies a copyable prompt with a JSON schema, then a paste/file import step. It must work with any assistant able to return the schema. It must not depend on linking the app to a particular chat account.

### 6.2 Daily review

1. Today shows how many cards are due, the estimated session size, and a clear Start review button.
2. The session presents one question, its topic/kind, and progress through the queue.
3. The learner types an answer or answers aloud and optionally selects Unsure, Somewhat, or Confident.
4. The learner reveals the answer or requests evaluation if enabled.
5. The app shows the reference answer, source, and any applicable feedback.
6. The learner chooses Again, Hard, Good, or Easy and sees the next interval before committing.
7. The rating and scheduling update save together. Only then does the next card appear.
8. The session ends with a factual summary and optional reflection.

A typed answer is not required for self-rating. A meaningful nonblank typed answer is required for AI grading. Once revealed, the submitted answer and confidence are frozen for that attempt; edits require a fresh attempt and cannot retroactively improve the saved result.

### 6.3 Manage the collection

Search questions, answers, and topics; filter by topic and All cards, Due now, New, or Paused. Open a card to edit it or inspect its schedule. Pause excludes the card from practice. Resume preserves its due time and history; an overdue resumed card is immediately eligible. Delete requires a clear confirmation and retains historical review snapshots for progress unless the learner chooses full data deletion.

### 6.4 Continue after interruption

An interrupted session restores the current card, answer draft, confidence, reveal state, and remaining queue. Persist drafts locally with a brief debounce and on navigation where possible. Completed reviews remain committed even if the browser closes. Leaving a session offers Resume or End session later; it must not silently submit a rating.

### 6.5 Review progress and reflect

Progress shows review counts, 14-day activity, self-rated Good/Easy share, cards with intervals of at least 21 days, and saved reflections. Later, AI results appear in a separately labeled view. Low scores should lead to useful next steps, such as revising a confusing card, rather than punitive copy.

## 7. Functional requirements

### Cards and topics

- Required question and answer; topic defaults to General; kind defaults to Recall.
- Limits: topic 100 characters, question 3,000, answer 10,000, source 1,000, response 10,000, reflection 5,000.
- Reject over-limit inputs with a field-specific message. Do not silently truncate authored learning content.
- New cards start with interval 0, ease 2.5, review count 0, lapse count 0, not paused, and due now.
- Ordinary wording/source edits preserve scheduling. A separate Reset learning progress action requires confirmation. Increment the content version on edits so old attempts retain the content they answered.
- The MVP may derive topic lists from cards. No separate deck hierarchy is necessary.
- Support safe Markdown paragraphs, lists, inline code, and fenced code in prompts and answers. Disable raw HTML and unsafe link protocols. Code blocks can scroll horizontally without making the whole page scroll.

### Imports and exports

- Accept .json, .tsv, and .txt files or pasted text. Limit content-import files to 2 MB and batches to 100 cards.
- Accept a bare JSON array and an object containing cards, including the existing recall-v1 format.
- TSV columns are question, answer, optional topic. Document this order; do not silently swap fields.
- Validate the whole batch before committing. Show row-specific errors and duplicate warnings. No partial writes for an invalid batch.
- Let the learner skip, edit, or deliberately keep duplicate content. Repeated clicking or retrying one import request must not add the same batch twice.
- Export content-only JSON and a full versioned backup. Clearly explain the difference.
- A full backup includes cards, schedules, reviews, reflections, sessions, rubrics, assessments, and preferences. It excludes secrets, provider credentials, and runtime caches.
- The 2 MB and 100-card limits apply to content imports, not full backups. Accept full backups up to 50 MB for MVP; validate size before parsing and show an explicit error above that limit.
- Full restore uses a dry-run validation and a confirmation showing record counts. MVP restore replaces the workspace atomically; offer an export of current data first. Merge restore is outside MVP.
- Keep a visible backup reminder and warn that local browser data may be lost if the user clears site storage. Request persistent browser storage where supported; handle denial gracefully.

### Sessions and ratings

- Session sizes: 5, 10, or 20; default 20. Only eligible due cards enter scheduled practice.
- Allow all-topic practice and a selected-topic practice. Explain when a filter leaves no due cards.
- Capture the queue at session start. Do not reorder cards while the learner is answering.
- Do not show a card twice in the same session. An Again rating makes it available after 10 minutes in a subsequent session; show that time honestly.
- Show interval previews from the same scheduler used when committing. If time has changed, compute the due timestamp from commit time.
- Support Space to reveal and 1–4 to rate, only in the appropriate state. Shortcuts must not fire while typing, inside dialogs, or during a pending save.
- Save failure keeps the learner on the card with the draft intact and a retry option. Duplicate retry returns the already committed review rather than creating another one.
- No due cards: show a caught-up state, the next scheduled time if known, and an option to add knowledge. Do not advance future due times for engagement.

### Quick checks (multiple choice)

The owner often studies with an assistant that gives each question both a flashcard form and a four-option multiple-choice form, and wants a lighter mode for low-energy days. Multiple choice tests recognition, which is weaker evidence than recall (§1), so quick checks supplement full recall and are weighted less.

- Cards may carry optional `choices`: one correct option (a one-line form of the answer) and one to three plausible wrong options, each up to 500 characters. The full reference answer remains the card's answer. Options are trimmed; blank wrong options are dropped; options must differ from each other.
- Authoring, editing, import (JSON), content export, and the assistant prompt all support options. TSV import does not.
- Today offers Full recall or Quick check for the session. A quick-check session takes only due cards that have options and are under the quick-check limit. Explain how many due cards qualify and why the others don't.
- The options appear in an order shuffled once per attempt, so a reload keeps the order. The first pick counts and is frozen like a revealed answer. The result shows the correct option and the learner's pick with text and a mark, not color alone, followed by the full reference answer. Continue saves the result. Keys 1–4 pick and Space continues, under the same rules as recall shortcuts.
- Scheduling follows §8's quick-check rule: a correct pick never lengthens the interval; a wrong pick is applied as Again; after two quick checks in a row the card needs a full recall.
- Progress reports quick checks separately ("picked correctly, recognition, not recall"). They are excluded from self-rating shares and calibration. Activity, totals, and streaks count them as reviews.
- The method page explains the rules and the limit, plainly.

## 8. Scheduler specification

Use a pure function taking a card, a rating, and a supplied current timestamp. Store timestamps in UTC milliseconds and intervals in days. This implementation is identified as recall-sm2-v2: the recall-sm2-v1 rating rules below, unchanged, plus the quick-check rule. It is an app-specific heuristic, not Anki compatibility or a prescription from *Make It Stick*.

Let I be the previous interval, E the previous ease, and R the completed review count. Calculate with the previous values before incrementing counts.

| Rating | New interval in days | New ease |
| --- | --- | --- |
| Again, 1 | 10 / 1440 | max(1.3, E − 0.20) |
| Hard, 2 | 1 if R = 0 or I < 1; otherwise max(1, round(I × 1.2)) | max(1.3, E − 0.15) |
| Good, 3 | 1 if R = 0 or I < 1; otherwise max(I + 1, round(I × E)) | E |
| Easy, 4 | 4 if R = 0 or I < 1; otherwise max(I + 1, round(I × E × 1.3)) | min(3.5, E + 0.15) |

Cap the resulting interval at 3,650 days. Increment R once for every committed review; increment lapses only for Again. The due timestamp is commit time plus round(interval × 86,400,000). A card is due when dueAt <= now and it is neither paused nor deleted.

**Quick-check rule (added in v2).** Let Q be the number of quick checks since the card's last full-recall review.

| Quick-check outcome | Due | Interval, ease, R, lapses | Q |
| --- | --- | --- | --- |
| Correct pick | commit time + min(2, max(1, floor(I))) days | unchanged | Q + 1 |
| Wrong pick | exactly as Again | exactly as Again | Q + 1 |
| Any full-recall rating | per the table above | per the table above | 0 |

A card is eligible for a quick check only when it has options and Q < 2. A correct pick therefore can't push a card out further, change its ease, or move it out of "new"; the next full recall continues from the real interval. v1 schedules migrate to v2 unchanged with Q = 0.

Queue construction must first use previously reviewed due cards, then new cards. Within each group, sort by oldest due time and a stable ID tie-breaker, then choose a different topic from the preceding card when one is available in that group. A single-topic group remains valid. Fill up to the selected session size.

**Intentional improvement over the inspected source:** Existing mixing can pull a new card ahead of an established due card to alternate topics. The standalone requirement makes due-before-new priority strict. This is a behavior change, not a claim about existing behavior.

When replacing the scheduler later, version it and define a migration. Do not silently reinterpret historical intervals or claim an FSRS implementation while running these rules.

## 9. Optional AI grading

### User experience

Grade an open-ended answer against the card's explicit reference and rubric. Recognize correct paraphrases rather than requiring exact wording. Show:

- Correct, Partially correct, Incorrect, or Unable to assess.
- What the learner got right, with a short quote or reference to the submitted answer.
- What was missing, separated from statements that were wrong.
- A concise corrected explanation and the reference answer.
- A suggested scheduling rating, which the learner may override.

AI evaluation never commits a scheduling update. The learner's confirmed rating remains authoritative. Store suggested and final ratings separately, including an optional override reason.

### Rubrics and assessment rules

A rubric contains a version, 1–8 criteria, positive weights, required concepts, acceptable alternatives, and optional critical misconceptions. The learner can edit it. Cards without a rubric remain fully usable manually; AI grading requires a reviewed rubric or a reviewed draft created from the answer before the attempt begins.

For each criterion, the evaluator returns met, partial, or missing, with evidence. The app computes weighted coverage using values 1, 0.5, and 0. The model separately identifies incorrect claims and critical misconceptions. Validate all IDs, enums, numeric ranges, and response lengths before displaying the result.

Proposed label rules: a critical misconception or a material factual contradiction makes the result Incorrect. Otherwise coverage >= 0.85 is Correct, 0.40–0.849 is Partially correct, and < 0.40 is Incorrect. If the reference is ambiguous, internally contradictory, or insufficient, return Unable to assess with a reason and no score. These thresholds are product defaults, not validated measurements of mastery.

Suggest Again for Incorrect, Hard for Partially correct, and Good for Correct. Never infer Easy from a single graded response; the learner may choose it. For Unable to assess, do not suggest a rating; allow reference-based self-rating.

Suggested provider-neutral response contract:

```json
{
  "attemptId": "uuid",
  "cardId": "uuid",
  "cardVersion": 3,
  "rubricVersion": 1,
  "status": "assessed",
  "criteria": [
    {"id": "preserve-left", "result": "met", "evidence": "keeps all customers"},
    {"id": "unmatched-null", "result": "missing", "evidence": ""}
  ],
  "incorrectClaims": [],
  "criticalMisconceptions": [],
  "correctAspects": ["Explains preservation of left-table rows."],
  "missingAspects": ["Unmatched right-side columns are NULL."],
  "explanation": "Your main idea is correct. Also describe the unmatched rows.",
  "uncertaintyReason": null
}
```

Compute the score, correctness label, and suggested rating in application code from validated outputs. Store provider/model identifiers, rubric and prompt versions, timestamps, and the raw validated criterion results so a result can be traced to the content used.

An assessed response must contain exactly one result for every rubric criterion, no unknown IDs, and no duplicate IDs. An unable-to-assess response uses status unable_to_assess, supplies uncertaintyReason, and produces no computed score. Bind results to the attempt and content versions; reject stale results instead of attaching them to a newer card or answer.

### Access and reliability

- Implement an evaluator interface with disabled, manual external-assistant, and configured provider modes.
- External mode can copy the question, reference, rubric, and response into a grading prompt. Feedback returned through this manual path is not automatically trusted or recorded as a validated embedded assessment.
- Possible future inference routes include a documented local model service or an owner-approved hosted provider. Verify compatibility rather than implying all subscriptions/providers support this.
- Hosted secrets stay on a backend or controlled proxy, never in browser bundles, local backups, source control, or logs.
- Treat prompts, sources, and learner answers as untrusted data. They must not override evaluator instructions or invoke tools.
- Explicitly show when answer content will be sent to a provider; send only the current card, rubric, and response by default.
- No network request on every keystroke. Evaluate only after explicit submission. Cache by attempt/content/rubric/provider versions; repeated clicks must not create repeated charges.
- Timeout, unavailable service, malformed result, or provider refusal leads to a clear message and manual self-rating. It must not erase the attempt or update the schedule.
- Do not substitute keyword matching for semantic evaluation and label it AI grading.

### Embedded generation

If enabled, accept concepts or pasted notes, desired topics, and a bounded card count. Generate drafts with focused questions, answers, kind, optional source, and optional rubric. Preview before saving; allow per-card edit/reject. Do not fabricate citations or silently save generated content. Unclear material should produce a clarification or uncertainty note rather than invented facts.

## 10. Visual and interaction requirements

Preserve the existing editorial direction: warm paper, forest green, muted olive, pale lime accents, fine separators, generous space, a serif for display headings, and a legible sans serif for study content. Use the lowercase recall. wordmark and understated stacked-card motif. Illustration is optional; reading is the priority.

| Token | Reference value |
| --- | --- |
| Background | #F8F8F3 |
| Paper | #FFFFFA |
| Main text | #282F28 |
| Secondary text | #606C59 |
| Divider | #DDDFD5 |
| Primary green | #344738 |
| Lime accent | #DCE5AC |
| Display font | Libre Caslon Display or a suitable serif fallback |
| Reading font | DM Sans or a suitable sans serif fallback |

Treat palette values as the starting point; adjust pairings when contrast tests fail. Bundle fonts where licensing permits, with functional fallbacks.

- Default study body text: 18 px minimum, using scalable rem units. Answers/feedback: 20 px default. Inputs: 18 px. Question text: 26–34 px depending on viewport. Secondary metadata: at least 14 px.
- Study body line height: approximately 1.7–1.85. Limit answers and feedback to roughly 55–70 characters per line. Avoid excessive tracking in reading content.
- Use the sans serif for prompts, answers, input, explanations, and code-adjacent content. Reserve the decorative serif for short display copy.
- Rectangular panels and rows, minimal rounding (typically 0–6 px), few shadows, no pervasive pills or bubbly dashboard tiles.
- Desktop: approximately 256 px sidebar with navigation and topics; main workspace with a compact top bar.
- Mobile/tablet: compact navigation without losing destinations; single-column reading; rating controls in a clear 2×2 grid when needed; no hover-only actions.
- Focus attention on one question. Do not hide essential text behind animation or require flipping a decorative 3D card.
- Provide reading-size preferences and persist them. Content must remain usable at 200% zoom and reflow at 320 CSS px. Only intrinsically wide code/table content may scroll horizontally within its own region.
- Use at least 44×44 px touch targets as a product standard, visible keyboard focus, proper labels, semantic landmarks, and modal focus management. Rating states and errors must not rely on color alone.
- Target WCAG 2.2 AA, including normal-text contrast of 4.5:1, appropriate large-text contrast, and reduced-motion support. Passing automated checks alone is insufficient.

## 11. Screens and states

| Screen | Required content and states |
| --- | --- |
| Today | Due count, reviewed today, streak, collection size, primary review action, topic rows, learning note; loading, empty, caught-up, error states |
| Collection | Search, topic/status filters, content export, import, card list and editor; no matching results state |
| Add knowledge | Write, import, optional generate; editable preview, validation and duplicate warnings |
| Practice | Question, draft, optional confidence, reveal/evaluate, answer/feedback, ratings with intervals, save/error states |
| Session complete | Actual committed reviews, ratings summary, optional reflection, return/resume actions |
| Progress | 14-day activity, review totals, clearly labeled self-report metrics, longer intervals, reflections; optional AI view |
| The method | Brief learning principles, scheduler explanation, honest limits and book attribution |
| Settings | Reading size, timezone, session size, backups/restore, AI availability and data deletion |

Empty states should offer a small starter collection rather than show invented activity. Include six editable sample cards across learning science and data systems. Loading the same starter collection twice should show an already-added warning or skip identical samples.

## 12. Data and architecture

### Proposed MVP architecture

Use a React/TypeScript frontend built with Vite, a dedicated domain module for scheduling and queue building, and a repository layer backed by IndexedDB. Put content validation and import/export logic outside visual components. Local persistence is a deliberate MVP simplification, not cross-device sync.

A static deployment lets the learner open the app on multiple devices, but each browser has its own collection. Say this clearly in Settings. Full backups provide manual transfer. Shared, automatic sync requires the P2 account/backend work; do not imply it already exists.

Keep inference behind a separate adapter. A hosted provider later requires a backend or proxy; a static client must not embed a service API key. If the builder chooses a server-backed initial implementation instead, document authentication, storage, backups, running cost, and the reason for that scope change before enabling hosting.

### Minimum logical entities

| Entity | Important fields |
| --- | --- |
| Card | ID, topic, question, answer, kind, source, optional multiple-choice options, contentVersion, createdAt, updatedAt, deletedAt |
| Schedule | cardId, dueAt, intervalDays, ease, reviewCount, lapseCount, paused, schedulerVersion, stateVersion, quick checks since last recall |
| Rubric | ID, cardId, version, criteria, weights, acceptable alternatives, critical misconceptions |
| Session | ID, mode (full recall or quick check), selected topics/size, queue IDs, current index, status, startedAt, endedAt, current draft/reveal state or shown options and pick |
| Review | ID/idempotency key, cardId/version, sessionId, mode, response, confidence, final rating (full recall) or options, pick, and correctness (quick check), before/after schedule, committedAt, topic/content snapshot |
| Assessment | ID, attemptId, card/rubric versions, validated feedback, computed label/score, suggestion, provider/model/prompt versions, createdAt |
| Reflection | ID, sessionId, body, createdAt |
| Preferences | schema version, timezone, reading size, session size, AI mode; no secrets |

The storage schema may combine tables/stores if the logical responsibilities remain clear. Use schema migrations and a backup format version. Reject unsupported future backup versions with a helpful message rather than dropping fields.

Review insertion and schedule advancement must be one atomic transaction. Use stateVersion for optimistic concurrency and a unique review idempotency key. If two tabs review the same version, one succeeds and the other refreshes without writing a second review. Do not rely on disabled buttons alone.

If a card is edited, deleted, paused, or reviewed elsewhere during a session, refresh its state before commit. Reject stale or ineligible commits and explain what changed. Preserve the draft for recovery.

## 13. Time, metrics, and privacy

- Store event timestamps in UTC. Set the learner's timezone from the browser initially and let the learner change it in Settings.
- Calendar-day statistics and streaks use the selected IANA timezone. Day arithmetic must handle daylight-saving transitions rather than subtracting 24 hours to identify yesterday.
- A streak counts consecutive days with at least one committed review, ending today or yesterday. Imported content and reflections alone do not extend it.
- Reviewed today counts committed review events; label it reviews rather than unique cards.
- Good/Easy share uses self-ratings and must explicitly say self-reported. Longer intervals means cards scheduled >=21 days apart, not mastered cards.
- Use complete stored history for aggregates. If a view intentionally limits its date range, label the range; do not display a truncated history count as lifetime total.
- AI labels and confidence comparisons are experimental study feedback, not objective ability scores. Exclude Unable to assess from scored aggregates and show sample sizes.
- Local-only MVP makes no external analytics calls by default. Persist only what the product uses. Data deletion must remove cards, reviews, assessments, sessions, reflections, and preferences after confirmation.
- If account sync is added, enforce ownership for every read/write and test isolation. Never reuse Sites owner identifiers as standalone authentication credentials.

## 14. Migration from the existing Recall app

1. Use the existing app's content export as the supported initial migration path.
2. Import recall-v1 without changing topic, question, answer, kind, or source. Preserve Unicode, code, and multiline answers.
3. Display that content-only imports start new schedules and do not carry review history.
4. If the owner later supplies an authorized full data export, build a separate adapter for cards, schedules, reviews, and reflections. Map legacy due/interval/ease/reps/lapses/suspended fields explicitly and validate timestamps and relationships.
5. Do not attempt to extract private production data through copied credentials or scrape the sign-in session. The read-only source reference is useful for behavior, not a substitute for an authorized data export.
6. Keep the current Site available during the rebuild. This PRD does not authorize changing, deleting, or redeploying it.

## 15. Acceptance criteria

| ID | Scenario | Passing result |
| --- | --- | --- |
| AC01 | Fresh install with no credentials | Learner adds cards and completes a persisted session without Sites or AI access |
| AC02 | Import a valid existing recall-v1 export | Every card's content is preserved; new schedules start due now |
| AC03 | Import contains one invalid row | No cards are added; the row and error are identified |
| AC04 | Retry a successful import request | The batch is not added twice |
| AC05 | Review queue contains due established cards, new cards, and paused cards | Established due cards precede new cards; topics alternate where possible; paused/future cards are excluded |
| AC06 | New card rated Again/Hard/Good/Easy at a fixed time | Due times are +10 minutes/+1 day/+1 day/+4 days respectively |
| AC07 | Established card has I=10, E=2.5 | Hard gives 12 days/ease 2.35; Good gives 25 days/ease 2.5; Easy gives 33 days/ease 2.65 |
| AC08 | Learner refreshes mid-attempt | Current card, draft, confidence, reveal state, and remaining queue restore |
| AC09 | Review save fails or response is retried | Draft remains; exactly one committed event and schedule transition occur |
| AC10 | Two tabs commit the same schedule version | One commit succeeds; the other reports stale state without a second update |
| AC11 | Card is paused, resumed, edited, or deleted | Eligibility and version rules hold; ordinary edits preserve scheduling |
| AC12 | Full backup restored into a clean workspace | IDs, content, due times, schedules, history, reflections, and preferences match |
| AC13 | Malformed/future-version backup supplied | Existing workspace is unchanged; unsupported data is reported |
| AC14 | Practice at phone, tablet, desktop widths and zoom | Reading/control sizes hold; no clipped essential content; keyboard and touch flows work |
| AC15 | User types Space or 1–4 in an answer | Text input works; shortcuts do not reveal or rate the card |
| AC16 | Review crosses midnight or DST transition | UTC due times remain stable; day statistics follow the selected timezone |
| AC17 | Progress displayed after real reviews | Counts and denominators match stored events; no mastery claims from self-ratings |
| AC18 | AI disabled or unavailable | Full manual study works; UI does not imply a grading service is active |
| AC19 | Configured evaluator gets a correct paraphrase, partial answer, wrong claim, or ambiguous reference | Rubric-based results distinguish all cases; uncertainty does not receive a fabricated score |
| AC20 | Grading returns malformed data, times out, or includes injected instructions in learner content | No schedule changes; safe error/fallback; untrusted instructions are ignored |
| AC21 | Learner overrides an AI suggestion | Final learner rating drives scheduling; suggestion remains separately recorded |
| AC22 | User deletes all data | All workspace records disappear; app returns to the fresh state |
| AC23 | Quick check on a new card and on an established card with I=10, E=2.5 | Correct: due +1 day and +2 days, interval/ease/R unchanged; wrong: identical to Again |
| AC24 | A card is quick-checked twice in a row | It's excluded from quick-check sessions until a full-recall review, which resets the count |
| AC25 | A version 1 database is opened, or a version 1 backup restored | Every record is kept; cards have no options; schedules become recall-sm2-v2 with unchanged intervals; past reviews are recall reviews |
| AC26 | Progress after quick checks | Quick checks are reported separately and excluded from self-rating shares |

AC01–18 and AC22 gate P0. AC23–26 gate quick checks. AC19–21 gate P1 embedded grading. Verify accessibility manually as well as with automated tooling. Proposed responsiveness target: ordinary local navigation/filtering remains under 200 ms with 5,000 cards on a modern desktop; test and report the device/data conditions rather than treating this as a proven benchmark.

For AI grading, use a small curated fixture set covering correct paraphrases, omissions, contradictions, alternative valid explanations, ambiguous references, and prompt injection. Inspect actual provider results in addition to schema/mocked tests. A provider's happy-path demo is insufficient to declare grading ready.

## 16. Implementation milestones and agent handoff

### Milestone 1: Foundation and reading interface

Create the standalone repository, domain types, storage migrations, navigation, design tokens, and six starter cards. Show a recognizable Today and Practice screen with the required reading sizes. Document chosen dependencies and how to run locally.

### Milestone 2: Complete manual learning loop

Implement authoring/import, collection management, queue/scheduling, confidence/reveal/rating, committed review events, session recovery, reflections, and progress. Test scheduling and concurrency with fixed times.

### Milestone 3: Portability and release verification

Implement full backup/restore, recall-v1 migration, preferences, and data deletion. Verify the acceptance matrix, responsive views, keyboard use, persistence, and timezone behavior. Deliver a runnable P0 app before expanding AI scope.

### Milestone 4: Optional AI experience

After the owner chooses and authorizes an inference route, add rubric authoring, grading adapter, structured feedback, failures/retries, and optional card generation. Record what was tested with a real provider. Keep manual study available throughout.

### Required implementation deliverables

- Runnable source repository outside Sites, with dependency lockfile and concise setup instructions.
- Modular domain, storage, import/export, and view code rather than a monolithic page component.
- Documented storage/backup schema and migrations.
- Tests for scheduling boundaries, queue priority, transactional/idempotent reviews, import validation, backup round-trip, timezone behavior, and configured grading boundaries.
- A completed acceptance checklist stating pass, fail, or untested; no fabricated test results.
- Screenshots of Today, Practice, answer/feedback, Collection, and Progress at desktop and mobile widths.
- Deployment instructions, data-location explanation, and recovery procedure. Choose hosting separately; do not create paid accounts or publish without an owner request.

### Copyable instruction for the receiving agent

> Build Recall according to this PRD. Treat confirmed requirements as binding and proposed defaults as the initial implementation plan. Start by reading the entire document, then present a brief milestone plan and record material technical choices. Implement the complete P0 workflow before optional AI features. Preserve the cream-and-green editorial theme, large readable study text, and restrained rectangular layouts. The app must run without ChatGPT Sites or inference credentials. Keep scheduling pure, reviews atomic and idempotent, and data portable. Do not claim cross-device sync, AI grading, Anki compatibility, or completed checks unless those capabilities actually work and have been verified. For embedded AI, first establish an owner-approved, documented inference route; retain the manual fallback. Deliver the runnable repository, setup instructions, tests, screenshots, and acceptance checklist.

## 17. References and open decisions

Product reference: [Existing Recall app](https://recall-study-studio.jenss-9700.chatgpt.site), inspected source and published version 3. Owner requests establish visual preferences, the learning workflow, and the desired grading capability.

Learning rationale: [Make It Stick learning strategies](https://www.makeitstick.com/learning-strategies). Retrieval, spacing, mixed problem practice, and explanation inform the product; scheduler intervals, rubric thresholds, and UI defaults are app design choices.

Accessibility reference: [WCAG 2.2](https://www.w3.org/TR/WCAG22/). The 44 px touch-target requirement is a product choice beyond relying on the AA minimum target-size rule.

Frontend reference: [Vite getting started](https://vite.dev/guide/), which offers a React/TypeScript scaffold. Pin supported versions during implementation and verify runtime requirements in current official documentation.

Decisions that do not block P0: whether automatic device sync is worth a backend; which inference route, if any, the owner will authorize; whether to adopt FSRS after parity; and whether direct agent-to-app card saving should be added. Do not turn these into required setup questions before delivering the manual learning loop.
