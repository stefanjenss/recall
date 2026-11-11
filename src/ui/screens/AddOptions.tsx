import { useMemo, useRef, useState } from 'react';
import { href } from '../../app/router';
import { useWorkspace } from '../../app/workspace';
import { buildOptionsPrompt } from '../../content/assistantPrompt';
import { checkImportText } from '../../content/import';
import {
  cardsWithoutOptions,
  checkOptions,
  isIncluded,
  OPTIONS_FORMAT,
  parseOptionsText,
  planOptions,
  type OptionsCheck,
  type OptionsRow,
} from '../../content/optionsImport';
import { newId } from '../../domain/ids';
import { IMPORT_MAX_CARDS, MAX_DISTRACTORS } from '../../domain/limits';
import type { CardChoices } from '../../domain/types';
import { Notice, OptionText } from '../components/common';
import { plainExcerpt } from '../markdown';

const ALL = '';
const DEFAULT_PROMPT_SIZE = 25;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

interface Parsed {
  rows: OptionsRow[];
  /** Idempotency key for saving this preview, created when it's built. */
  batchId: string;
  /** The learner's say: leave a ready entry out, or replace options a card already has. */
  included: Record<string, boolean>;
}

/** Add knowledge → Add options: give existing cards multiple-choice options through an assistant. */
export function AddOptions() {
  const ws = useWorkspace();
  const [topic, setTopic] = useState(ALL);
  const [size, setSize] = useState(DEFAULT_PROMPT_SIZE);
  const [copied, setCopied] = useState(false);
  const [text, setText] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const applying = useRef(false);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const resultBox = useRef<HTMLDivElement>(null);

  const missing = useMemo(() => cardsWithoutOptions(ws.activeCards), [ws.activeCards]);
  const topics = useMemo(() => {
    const counts = new Map<string, number>();
    for (const card of missing) counts.set(card.topic, (counts.get(card.topic) ?? 0) + 1);
    return [...counts].map(([name, count]) => ({ name, count }));
  }, [missing]);
  // Once every card in the chosen topic has options, fall back to all topics.
  const selectedTopic = topics.some((t) => t.name === topic) ? topic : ALL;
  const inTopic = useMemo(
    () => (selectedTopic ? missing.filter((c) => c.topic === selectedTopic) : missing),
    [missing, selectedTopic],
  );
  const limit = Math.max(1, Math.min(IMPORT_MAX_CARDS, Math.round(size) || DEFAULT_PROMPT_SIZE));
  const exported = useMemo(() => inTopic.slice(0, limit), [inTopic, limit]);
  const prompt = useMemo(() => buildOptionsPrompt(exported), [exported]);
  const where = selectedTopic ? ` in ${selectedTopic}` : '';

  const rows = parsed?.rows;
  const checks = useMemo(() => (rows ? checkOptions(rows, ws.cards) : []), [rows, ws.cards]);
  const plan = planOptions(checks, parsed?.included ?? {});

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 3000);
    } catch {
      const el = document.getElementById('options-prompt') as HTMLTextAreaElement | null;
      el?.select();
    }
  }

  function preview() {
    setResult(null);
    const sizeError = checkImportText(text);
    const res = sizeError ? null : parseOptionsText(text);
    if (!res || !res.ok) {
      setParseError(sizeError ?? (res && !res.ok ? res.error : null));
      setParsed(null);
      return;
    }
    setParseError(null);
    setParsed({ rows: res.rows, batchId: newId(), included: {} });
    window.setTimeout(() => previewHeading.current?.focus(), 0);
  }

  function setIncluded(key: string, value: boolean) {
    setParsed((p) => (p ? { ...p, included: { ...p.included, [key]: value } } : p));
  }

  async function apply() {
    if (!parsed || plan.updates.length === 0 || applying.current) return;
    applying.current = true;
    setBusy(true);
    try {
      const res = await ws.repo.applyOptions(plan.updates, Date.now(), parsed.batchId);
      await ws.refresh();
      let msg: string;
      let changed = 0;
      if (res.status === 'already-applied') {
        msg = 'These options were already saved; nothing was changed twice.';
      } else {
        const saved = res.cardIds.length;
        changed = res.skipped.filter((s) => s.reason !== 'unchanged').length;
        msg =
          saved > 0
            ? `Saved options for ${plural(saved, 'card')}. ${saved === 1 ? 'It' : 'They'} can now appear in quick checks.`
            : 'No options were saved.';
        if (changed > 0) {
          msg += ` ${plural(changed, 'card')} ${changed === 1 ? 'was' : 'were'} edited or deleted since the preview and left alone; preview the reply again to check ${changed === 1 ? 'it' : 'them'}.`;
        }
      }
      setParsed(null);
      if (changed === 0) setText('');
      setResult(msg);
      window.setTimeout(() => resultBox.current?.focus(), 0);
    } catch (err) {
      setParseError(`Nothing was saved: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      applying.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="add__import">
      <section className="panel step" aria-labelledby="options-step1">
        <h2 id="options-step1" className="step__title">
          <span className="step__number">1</span> Copy your cards for an assistant
        </h2>
        <p>
          Quick checks need multiple-choice options. Copy a prompt with the cards that have none into any assistant that can
          return JSON, then paste its reply in step 2. Recall doesn’t call any AI service. Only the options change: questions,
          answers, and schedules stay as they are.
        </p>
        {ws.activeCards.length === 0 ? (
          <Notice tone="info" title="No cards yet" live={false}>
            <p>
              <a href={href('add')}>Write a card</a> or <a href={href('add/import')}>import some</a> first.
            </p>
          </Notice>
        ) : missing.length === 0 ? (
          <Notice tone="success" title="Every card has options" live={false}>
            <p>All {plural(ws.activeCards.length, 'card')} already have multiple-choice options.</p>
          </Notice>
        ) : (
          <>
            <p className="import-summary">
              <strong>{missing.length}</strong> of {plural(ws.activeCards.length, 'card')} {missing.length === 1 ? 'has' : 'have'}{' '}
              no multiple-choice options.
            </p>
            <div className="step__grid">
              <div className="field">
                <label htmlFor="options-topic" className="field__label">
                  Topic
                </label>
                <select id="options-topic" value={selectedTopic} onChange={(e) => setTopic(e.target.value)}>
                  <option value={ALL}>All topics ({missing.length})</option>
                  {topics.map((t) => (
                    <option key={t.name} value={t.name}>
                      {t.name} ({t.count})
                    </option>
                  ))}
                </select>
              </div>
              <div className="step__side">
                <div className="field">
                  <label htmlFor="options-size" className="field__label">
                    Cards per prompt
                  </label>
                  <input
                    id="options-size"
                    type="number"
                    min={1}
                    max={IMPORT_MAX_CARDS}
                    value={size}
                    onChange={(e) => setSize(Number(e.target.value))}
                    aria-describedby="options-size-hint"
                  />
                </div>
              </div>
            </div>
            <p id="options-size-hint" className="field__hint">
              {exported.length === inTopic.length
                ? `This prompt has ${inTopic.length === 1 ? 'the one card' : `all ${inTopic.length} cards`} without options${where}.`
                : `This prompt has the first ${exported.length} of the ${inTopic.length} cards without options${where}. Once you’ve saved theirs, copy the prompt again for the next ones.`}{' '}
              Up to {IMPORT_MAX_CARDS} per prompt; smaller prompts are easier for an assistant to answer in full.
            </p>
            <details className="disclosure">
              <summary>Show the prompt</summary>
              <label htmlFor="options-prompt" className="visually-hidden">
                Options prompt
              </label>
              <textarea id="options-prompt" className="code-text" readOnly rows={14} value={prompt} />
            </details>
            <div className="button-row">
              <button type="button" className="button button--primary" onClick={copyPrompt}>
                Copy prompt
              </button>
              <span role="status" className="muted">
                {copied ? 'Copied. Paste it into your assistant.' : ''}
              </span>
            </div>
          </>
        )}
      </section>

      <section className="panel step" aria-labelledby="options-step2">
        <h2 id="options-step2" className="step__title">
          <span className="step__number">2</span> Paste the assistant’s reply
        </h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            preview();
          }}
        >
          <div className="field">
            <label htmlFor="options-text" className="field__label">
              Options as JSON
            </label>
            <textarea
              id="options-text"
              className="code-text"
              rows={8}
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-describedby="options-help"
              spellCheck={false}
            />
          </div>
          <details className="disclosure" id="options-help">
            <summary>Accepted format</summary>
            <ul>
              <li>
                An object with <code>"format": "{OPTIONS_FORMAT}"</code> and an <code>options</code> list, up to{' '}
                {IMPORT_MAX_CARDS} entries.
              </li>
              <li>
                Each entry has a card’s <code>id</code> and its <code>choices</code>: a <code>correct</code> option and one to{' '}
                {MAX_DISTRACTORS} wrong ones in <code>distractors</code>, or <code>null</code> to leave the card as it is.
              </li>
              <li>Entries are matched to cards by ID. Questions and answers in the reply are ignored.</li>
            </ul>
          </details>
          <div className="button-row">
            <button type="submit" className="button button--primary" disabled={!text.trim()}>
              Preview options
            </button>
          </div>
        </form>
        {parseError ? (
          <Notice tone="error" title="Can’t use this yet">
            <p>{parseError}</p>
          </Notice>
        ) : null}
        {result ? (
          <div ref={resultBox} tabIndex={-1} className="options__result">
            <Notice tone="success" onDismiss={() => setResult(null)}>
              <p>{result}</p>
              <p>
                <a href={href('')}>Go to Today</a> or <a href={href('collection')}>see the collection</a>.
              </p>
            </Notice>
          </div>
        ) : null}
      </section>

      {parsed ? (
        <section className="panel step" aria-labelledby="options-step3">
          <h2 id="options-step3" className="step__title" ref={previewHeading} tabIndex={-1}>
            <span className="step__number">3</span> Review before saving
          </h2>
          <p className="import-summary" role="status">
            <strong>{plan.updates.length}</strong> {plan.updates.length === 1 ? 'card' : 'cards'} to update
            {plan.replacing ? <> · {plan.replacing} replacing current options</> : null}
            {plan.keeping ? <> · {plan.keeping} keeping current options</> : null}
            {plan.leftOut ? <> · {plan.leftOut} left out</> : null}
            {plan.errors ? (
              <>
                {' '}
                · <strong className="text-error">{plan.errors}</strong> with errors
              </>
            ) : null}
            {plan.skipped ? <> · {plan.skipped} skipped</> : null}
          </p>
          <p className="muted">
            Entries with errors, or that don’t match a card, are skipped; the rest are saved together. The assistant wrote these
            options, so check that each wrong one really is wrong. Nothing is saved until you confirm.
          </p>
          <ol className="draft-list">
            {checks.map((check) => (
              <OptionsEntry
                key={check.key}
                check={check}
                included={isIncluded(check, parsed.included)}
                onInclude={(value) => setIncluded(check.key, value)}
              />
            ))}
          </ol>
          <div className="button-row">
            <button type="button" className="button button--primary" onClick={apply} disabled={busy || plan.updates.length === 0}>
              {busy ? 'Saving…' : `Save options for ${plural(plan.updates.length, 'card')}`}
            </button>
            <button
              type="button"
              className="button button--secondary"
              onClick={() => {
                setParsed(null);
                setResult(null);
              }}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function OptionsEntry({
  check,
  included,
  onInclude,
}: {
  check: OptionsCheck;
  included: boolean;
  onInclude: (value: boolean) => void;
}) {
  const { status, card } = check;
  const [tone, label] = ((): [string, string] => {
    switch (status) {
      case 'ready':
        return included ? ['ok', 'Ready'] : ['removed', 'Left out'];
      case 'replace':
        return included ? ['kept', 'Replacing current options'] : ['duplicate', 'Has options · keeping them'];
      case 'unchanged':
        return ['skipped', 'Same options · skipped'];
      case 'none':
        return ['skipped', 'No options · skipped'];
      case 'error':
        return ['error', 'Error · skipped'];
      case 'unknown':
        return ['skipped', 'Unknown card · skipped'];
      case 'deleted':
        return ['skipped', 'Deleted card · skipped'];
      case 'repeat':
        return ['skipped', 'Repeat · skipped'];
    }
  })();

  return (
    <li className={`draft draft--${tone}`}>
      <div className="draft__head">
        <span className="draft__label">{check.label}</span>
        <span className="draft__status">{label}</span>
      </div>
      {card ? (
        <>
          <p className="draft__question">{plainExcerpt(card.question, 220)}</p>
          <p className="draft__meta">{card.topic}</p>
        </>
      ) : null}
      {status === 'unknown' ? (
        <p className="draft__dup">
          No card has the ID <code>{check.cardId}</code>. The assistant may have changed it; IDs must be copied exactly.
        </p>
      ) : null}
      {status === 'deleted' ? <p className="draft__dup">This card was deleted.</p> : null}
      {status === 'repeat' ? (
        <p className="draft__dup">{check.repeatOf} already has options for this card; only the first is used.</p>
      ) : null}
      {status === 'none' ? <p className="draft__dup">The reply has no options for this card, so it stays as it is.</p> : null}
      {status === 'unchanged' ? <p className="draft__dup">The card already has exactly these options.</p> : null}
      {check.errors.length > 0 ? (
        <ul className="draft__errors">
          {check.errors.map((message) => (
            <li key={message} className="field__error">
              {message}
            </li>
          ))}
        </ul>
      ) : null}
      {check.choices && status !== 'unchanged' ? (
        <ChoiceList title={status === 'replace' ? 'Proposed options' : 'Options'} choices={check.choices} />
      ) : null}
      {status === 'replace' && card?.choices ? <ChoiceList title="Current options" choices={card.choices} /> : null}
      {status === 'replace' ? (
        <label className="inline-check">
          <input type="checkbox" checked={included} onChange={(e) => onInclude(e.target.checked)} /> Replace the current options
        </label>
      ) : null}
      {status === 'ready' ? (
        <div className="draft__actions">
          <button type="button" className="button button--quiet button--small" onClick={() => onInclude(!included)}>
            {included ? 'Leave out' : 'Include'}
          </button>
        </div>
      ) : null}
    </li>
  );
}

function ChoiceList({ title, choices }: { title: string; choices: CardChoices }) {
  return (
    <div className="option-preview">
      <p className="option-preview__title">{title}</p>
      <ul>
        <li>
          <span className="option-preview__mark">Correct</span> <OptionText source={choices.correct} />
        </li>
        {choices.distractors.map((d, i) => (
          <li key={i}>
            <span className="option-preview__mark">Wrong</span> <OptionText source={d} />
          </li>
        ))}
      </ul>
    </div>
  );
}
