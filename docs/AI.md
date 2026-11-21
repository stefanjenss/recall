# AI feedback

Recall can ask a model to compare a typed answer with a card's reference answer and rubric, and say what was right,
missing, or wrong. It is optional, off by default, and never rates a card: it suggests a rating, and the rating you
choose is the only thing that schedules anything. The spec is [PRD](PRD.md) section 9; the design reasoning is in
[DECISIONS.md](DECISIONS.md#ai-feedback-november-2026).

**Status: built, not yet verified against a real model.** Everything around the model is tested (see
[ACCEPTANCE.md](ACCEPTANCE.md)), but until the fixture run below has been done against the provider you use, treat its
judgments as untested.

## How it works

- The app never talks to a model provider and never holds a provider key. It asks your [sync server](SYNC.md), which
  holds the key in its environment and forwards one request.
- A request carries one card's question, reference answer, and rubric, plus the one answer you typed. Nothing else is
  sent, and nothing is sent until you choose **Get AI feedback** on a revealed answer (or **Draft with AI** in a card's
  rubric editor, which sends that card's question and answer).
- The model reports, per rubric criterion, met / partial / missing with a quote, and lists wrong claims. Recall checks
  every field of that reply, computes the coverage score, label, and suggested rating itself, and discards a reply that
  doesn't pass. A discarded reply, a timeout, or an unreachable server shows a message; the self-rating buttons work
  throughout.
- Each device turns it on separately under Settings → AI feedback. The setting isn't synced or backed up. It needs the
  device to be connected to the sync server.
- A card needs a rubric that you have saved. Add one in the card's editor, by hand or from a draft.

Settings → AI feedback also offers **Copy a prompt**, which needs no server: after a reveal, a button copies the
question, reference answer, rubric, and your answer for you to paste into an assistant. Recall sends nothing itself and
doesn't record the reply.

## Set up the server

Set these in the server's environment. With Docker, put them in `.env` next to the compose file (Git ignores it); both
compose files pass them through.

| Variable                | Default            | Meaning                                                                                             |
| ----------------------- | ------------------ | --------------------------------------------------------------------------------------------------- |
| `RECALL_AI_PROVIDER`    | (off)              | `anthropic` or `openai-compatible`. Unset or `off` means no AI feedback.                            |
| `ANTHROPIC_API_KEY`     |                    | Required for `anthropic`.                                                                           |
| `RECALL_AI_MODEL`       | `claude-haiku-5-5` | The model. Required for `openai-compatible`.                                                        |
| `RECALL_AI_BASE_URL`    |                    | Required for `openai-compatible`: the API root, ending in `/v1` for most servers.                   |
| `RECALL_AI_API_KEY`     |                    | The key for an `openai-compatible` provider. Leave unset for a local model.                         |
| `RECALL_AI_TIMEOUT_MS`  | `60000`            | How long to wait for the model. A local model on a CPU needs more, such as `180000`.                |
| `RECALL_AI_DAILY_LIMIT` | `300`              | Provider requests allowed per UTC day, so a bug can't run up a bill. The count resets on a restart. |

The server's startup log says which model it will use, or that AI feedback is off. A misconfiguration (a provider with
no key, say) stops the server at startup with a message.

### Claude (Anthropic API)

```bash
RECALL_AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-…
```

Create the key at [console.anthropic.com](https://console.anthropic.com). This is pay-per-use API billing, separate
from a Claude.ai subscription. A graded answer is roughly 1,500 tokens in and up to 1,000 out; at Claude Haiku 5.5's
list price ($0.10 / $0.50 per million tokens) that is well under a tenth of a cent, so 20 graded answers a day comes to
less than $0.50 a month. Set `RECALL_AI_MODEL=claude-sonnet-5-5` or `claude-opus-5-5` for a stronger and costlier
model. Check current prices before relying on these figures.

### A local model (Ollama)

```bash
RECALL_AI_PROVIDER=openai-compatible
RECALL_AI_BASE_URL=http://<address of the machine running Ollama>:11434/v1
RECALL_AI_MODEL=<a model you have pulled>
RECALL_AI_TIMEOUT_MS=180000
```

Free, and nothing leaves your network. Expect it to be slow on a machine without a GPU, and expect weaker judgments
from small models; run the fixtures below before trusting it. From inside Docker, `127.0.0.1` is the container, not
the host: use the host's LAN or tailnet address, and make sure Ollama listens on it (`OLLAMA_HOST=0.0.0.0`).

### A hosted open-model provider

Any provider with an OpenAI-compatible Chat Completions endpoint (OpenRouter, Together, Groq, Fireworks, and others):

```bash
RECALL_AI_PROVIDER=openai-compatible
RECALL_AI_BASE_URL=https://<provider's API root>/v1
RECALL_AI_API_KEY=<that provider's key>
RECALL_AI_MODEL=<model name as that provider spells it>
```

The server asks for a strict JSON-schema reply and falls back to plain JSON mode if the provider refuses the schema.
Either way the reply goes through the same checks.

Then rebuild or restart the server (`docker compose up -d --build`), and on each device choose Settings → AI feedback →
**Through my sync server**. It should say **Ready** and name the model.

## Verify it with your provider

The automated tests use a scripted stand-in for the model. To see what your real model does with a small curated set
(correct paraphrases, an omission, a contradiction, an alternative explanation, an ambiguous reference, and two prompt
injections), run this on any machine with the repository and the same settings as the server:

```bash
RECALL_AI_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-… npm run test:ai-real
```

It makes nine provider requests, prints each result, and fails any fixture whose label a sound evaluator wouldn't
give. Record the outcome in [ACCEPTANCE.md](ACCEPTANCE.md) (AC19, AC20).

## Privacy and security

- The provider key exists only in the server's environment. It isn't in the app, in browser storage, in backups, in
  the repository, or in the server's log.
- The AI routes need the sync key, like the sync routes. The server doesn't store or log card text or answers; its log
  records only that a request happened, how long it took, and whether it failed.
- With a hosted provider, the question, reference answer, rubric, and typed answer of each card you ask about go to
  that provider under its terms. With a local model they stay on your network.
- Card text and answers are sent to the model as data, and the model is given no tools. An answer that tries to
  instruct the grader earns no credit, and whatever the model replies still has to pass Recall's checks.

## What is stored

Rubrics and assessments are ordinary records: they sync, and full backups include them. An assessment keeps the
criterion results, the computed score and label, the suggested rating, the model and prompt version, the rubric as it
was graded against, and, once you rate the card, your rating and any reason you gave for rating differently. Formats
are in [DATA.md](DATA.md).

## Limits

- One model per server; every device uses it.
- AI feedback covers full-recall attempts with a typed answer. Quick checks and spoken answers aren't graded.
- A rubric saved during an attempt applies from the next attempt, so a rubric can't be written to fit an answer.
- Rubrics are written one card at a time. Drafting them in bulk for an existing collection isn't built.
- In-app card generation (PRD section 9, "Embedded generation") isn't built.
