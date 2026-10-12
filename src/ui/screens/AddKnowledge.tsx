import { useMemo, useRef, useState } from 'react';
import { useFlash } from '../../app/flash';
import { href } from '../../app/router';
import { useWorkspace } from '../../app/workspace';
import { buildAssistantPrompt } from '../../content/assistantPrompt';
import {
  batchRanges,
  checkDrafts,
  checkImportFile,
  checkImportText,
  parseImportText,
  planImport,
  toDrafts,
  type DraftCheck,
  type ImportDraft,
} from '../../content/import';
import { STARTER_CARDS } from '../../content/starter';
import { newId } from '../../domain/ids';
import { duplicateKey, IMPORT_MAX_CARDS, validateCardInput } from '../../domain/limits';
import { KIND_LABELS } from '../../domain/types';
import { CardFields, EMPTY_CARD_FORM, formValuesFrom, type CardFormValues } from '../components/CardFields';
import { Notice, PageHeader } from '../components/common';
import { plainExcerpt } from '../markdown';

export function AddKnowledge({ mode }: { mode: 'write' | 'import' }) {
  return (
    <div className="screen add">
      <PageHeader title="Add knowledge" />
      <nav className="tabs" aria-label="Ways to add cards">
        <a className="tabs__tab" href={href('add')} aria-current={mode === 'write' ? 'page' : undefined}>
          Write a card
        </a>
        <a className="tabs__tab" href={href('add/import')} aria-current={mode === 'import' ? 'page' : undefined}>
          Import from an assistant or file
        </a>
      </nav>
      {mode === 'write' ? <WriteCard /> : <ImportCards />}
    </div>
  );
}

function useTopics(): string[] {
  const ws = useWorkspace();
  return useMemo(() => [...new Set(ws.activeCards.map((c) => c.topic))].sort((a, b) => a.localeCompare(b)), [ws.activeCards]);
}

// ---------------------------------------------------------------------------

function WriteCard() {
  const ws = useWorkspace();
  const { show } = useFlash();
  const topics = useTopics();
  const [values, setValues] = useState<CardFormValues>(EMPTY_CARD_FORM);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDuplicate, setConfirmDuplicate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formTop = useRef<HTMLDivElement>(null);

  const { value, errors } = validateCardInput(values);
  const duplicate = value ? ws.activeCards.find((c) => duplicateKey(c.question) === duplicateKey(value.question)) : undefined;

  async function save() {
    setSubmitted(true);
    if (!value) return;
    if (duplicate && !confirmDuplicate) {
      setConfirmDuplicate(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await ws.repo.addCards([value], Date.now());
      await ws.refresh();
      setValues({ ...EMPTY_CARD_FORM, topic: values.topic, kind: values.kind });
      setSubmitted(false);
      setConfirmDuplicate(false);
      show('Card added. It’s due now.');
      formTop.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function addStarter() {
    const { added, skipped } = await ws.repo.addMissingCards(STARTER_CARDS, Date.now());
    await ws.refresh();
    show(
      added === 0
        ? 'The starter cards are already in your collection.'
        : `Added ${added} starter card${added === 1 ? '' : 's'}${skipped ? ` (${skipped} already there)` : ''}.`,
      added === 0 ? 'info' : 'success',
    );
  }

  return (
    <div className="add__write" ref={formTop}>
      <form
        className="panel"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        noValidate
      >
        <CardFields
          values={values}
          onChange={(v) => {
            setValues(v);
            setConfirmDuplicate(false);
          }}
          errors={errors}
          topics={topics}
          showErrors={submitted || errors.some((e) => e.message.includes('limit'))}
        />
        {confirmDuplicate && duplicate ? (
          <Notice tone="warn" title="Possible duplicate">
            <p>
              A card with this question is already in <strong>{duplicate.topic}</strong>.{' '}
              <a href={href(`collection/${duplicate.id}`)}>Open it</a>, or save anyway to keep both.
            </p>
          </Notice>
        ) : null}
        {error ? (
          <Notice tone="error">
            <p>{error}</p>
          </Notice>
        ) : null}
        <div className="button-row">
          <button type="submit" className="button button--primary" disabled={busy}>
            {confirmDuplicate ? 'Save anyway' : 'Save card'}
          </button>
          {submitted && errors.length > 0 ? (
            <p className="field__error" role="alert">
              Fix the highlighted field{errors.length === 1 ? '' : 's'} to save.
            </p>
          ) : null}
        </div>
      </form>
      <aside className="add__tips">
        <h2 className="section__title">Writing good cards</h2>
        <ul>
          <li>One idea per card. Split broad prompts into several focused questions.</li>
          <li>Ask for production, not recognition: “Explain…”, “When would you…”, “What’s the difference…”.</li>
          <li>Mix kinds. Apply and Compare cards make you choose an approach, not just recall a definition.</li>
          <li>Keep answers short enough to check in a glance; add an example where it helps.</li>
        </ul>
        <p>
          Want examples first?{' '}
          <button type="button" className="button button--quiet" onClick={addStarter}>
            Add the six starter cards
          </button>
        </p>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface Parsed {
  drafts: ImportDraft[];
  notes: string[];
  source: string;
  batchIndex: number;
  /** One idempotency key per batch, created when the preview is built. */
  batchIds: string[];
  committed: number[];
}

function ImportCards() {
  const ws = useWorkspace();
  const { show } = useFlash();
  const [promptMaterial, setPromptMaterial] = useState('');
  const [promptTopic, setPromptTopic] = useState('');
  const [promptCount, setPromptCount] = useState(10);
  const [copied, setCopied] = useState(false);
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | undefined>();
  const [parseError, setParseError] = useState<string | null>(null);
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const prompt = buildAssistantPrompt({ material: promptMaterial, topic: promptTopic, count: promptCount });

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 3000);
    } catch {
      const el = document.getElementById('assistant-prompt') as HTMLTextAreaElement | null;
      el?.select();
    }
  }

  function preview(source: string, name?: string) {
    setResult(null);
    const sizeError = checkImportText(source);
    if (sizeError) {
      setParseError(sizeError);
      setParsed(null);
      return;
    }
    const res = parseImportText(source, name);
    if (!res.ok) {
      setParseError(res.error);
      setParsed(null);
      return;
    }
    setParseError(null);
    const drafts = toDrafts(res.rows);
    const notes = [...res.notes];
    const batches = batchRanges(drafts.length);
    if (batches.length > 1) {
      notes.push(
        `This file has ${drafts.length} cards. Recall imports up to ${IMPORT_MAX_CARDS} at a time, so you’ll review it in ${batches.length} batches.`,
      );
    }
    setParsed({ drafts, notes, source, batchIndex: 0, batchIds: batches.map(() => newId()), committed: [] });
    window.setTimeout(() => previewHeading.current?.focus(), 0);
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    const err = checkImportFile(file.name, file.size);
    if (err) {
      setParseError(err);
      setParsed(null);
      return;
    }
    const content = await file.text();
    setFileName(file.name);
    setText(content);
    preview(content, file.name);
  }

  const range = parsed ? batchRanges(parsed.drafts.length)[parsed.batchIndex] : undefined;
  const batchDrafts = parsed && range ? parsed.drafts.slice(range.start, range.end) : [];
  const checks = useMemo(() => checkDrafts(batchDrafts, ws.activeCards), [batchDrafts, ws.activeCards]);
  const plan = planImport(batchDrafts, checks);

  function updateDraft(key: string, patch: Partial<ImportDraft>) {
    setParsed((p) => (p ? { ...p, drafts: p.drafts.map((d) => (d.key === key ? { ...d, ...patch } : d)) } : p));
  }

  async function commit() {
    if (!parsed || !plan.ready) return;
    const batchId = parsed.batchIds[parsed.batchIndex]!;
    setBusy(true);
    try {
      const res = await ws.repo.addCards(plan.toAdd, Date.now(), batchId);
      await ws.refresh();
      const total = batchRanges(parsed.drafts.length).length;
      const added = res.status === 'added' ? res.cardIds.length : 0;
      const msg =
        res.status === 'already-imported'
          ? 'This batch was already imported; nothing was added twice.'
          : `Added ${added} card${added === 1 ? '' : 's'}${plan.skippedDuplicates ? `, skipped ${plan.skippedDuplicates} duplicate${plan.skippedDuplicates === 1 ? '' : 's'}` : ''}. They start as new and are due now.`;
      if (parsed.batchIndex + 1 < total) {
        setParsed({ ...parsed, batchIndex: parsed.batchIndex + 1, committed: [...parsed.committed, parsed.batchIndex] });
        setResult(`${msg} Next: batch ${parsed.batchIndex + 2} of ${total}.`);
        window.setTimeout(() => previewHeading.current?.focus(), 0);
      } else {
        setParsed(null);
        setText('');
        setFileName(undefined);
        setResult(msg);
        show(msg);
      }
    } catch (err) {
      setResult(null);
      setParseError(`Nothing was imported: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="add__import">
      <section className="panel step" aria-labelledby="step1">
        <h2 id="step1" className="step__title">
          <span className="step__number">1</span> Ask an assistant <span className="muted">(optional)</span>
        </h2>
        <p>
          Recall doesn’t call any AI service. Copy this prompt into any assistant that can return JSON, then paste its reply in
          step 2. Review every generated card before you import it.
        </p>
        <div className="step__grid">
          <div className="field">
            <label htmlFor="prompt-material" className="field__label">
              Concepts, terms, or notes
            </label>
            <textarea id="prompt-material" rows={5} value={promptMaterial} onChange={(e) => setPromptMaterial(e.target.value)} />
          </div>
          <div className="step__side">
            <div className="field">
              <label htmlFor="prompt-topic" className="field__label">
                Topic (optional)
              </label>
              <input id="prompt-topic" type="text" value={promptTopic} onChange={(e) => setPromptTopic(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="prompt-count" className="field__label">
                About how many cards
              </label>
              <input
                id="prompt-count"
                type="number"
                min={1}
                max={IMPORT_MAX_CARDS}
                value={promptCount}
                onChange={(e) => setPromptCount(Number(e.target.value))}
              />
            </div>
          </div>
        </div>
        <details className="disclosure">
          <summary>Show the prompt</summary>
          <label htmlFor="assistant-prompt" className="visually-hidden">
            Assistant prompt
          </label>
          <textarea id="assistant-prompt" className="code-text" readOnly rows={14} value={prompt} />
        </details>
        <div className="button-row">
          <button type="button" className="button button--primary" onClick={copyPrompt}>
            Copy prompt
          </button>
          <span role="status" className="muted">
            {copied ? 'Copied. Paste it into your assistant.' : ''}
          </span>
        </div>
      </section>

      <section className="panel step" aria-labelledby="step2">
        <h2 id="step2" className="step__title">
          <span className="step__number">2</span> Paste or upload cards
        </h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            preview(text, fileName);
          }}
        >
          <div className="field">
            <label htmlFor="import-text" className="field__label">
              Cards as JSON or tab-separated text
            </label>
            <textarea
              id="import-text"
              className="code-text"
              rows={8}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setFileName(undefined);
              }}
              aria-describedby="import-help"
              spellCheck={false}
            />
          </div>
          <div className="field">
            <label htmlFor="import-file" className="field__label">
              Or choose a file (.json, .tsv, .txt — up to 2 MB)
            </label>
            <input
              id="import-file"
              type="file"
              accept=".json,.tsv,.txt,application/json,text/plain,text/tab-separated-values"
              onChange={(e) => void onFile(e.target.files?.[0])}
            />
          </div>
          <details className="disclosure" id="import-help">
            <summary>Accepted formats</summary>
            <ul>
              <li>
                <strong>JSON:</strong> an array of cards, or an object with a <code>cards</code> array (including Recall’s{' '}
                <code>recall-v1</code> export). Each card has <code>question</code> and <code>answer</code>, and optionally{' '}
                <code>topic</code> (default General), <code>kind</code> (recall, apply, compare, explain), and <code>source</code>
                .
              </li>
              <li>
                <strong>Tab-separated text:</strong> one card per line, columns in this order: <code>question</code>,{' '}
                <code>answer</code>, optional <code>topic</code>. A header row with those names is skipped.
              </li>
              <li>Content imports never include review history: every imported card starts as new.</li>
            </ul>
          </details>
          <div className="button-row">
            <button type="submit" className="button button--primary" disabled={!text.trim()}>
              Preview import
            </button>
          </div>
        </form>
        {parseError ? (
          <Notice tone="error" title="Can’t import this yet">
            <p>{parseError}</p>
          </Notice>
        ) : null}
        {result ? (
          <Notice tone="success" onDismiss={() => setResult(null)}>
            <p>{result}</p>
            {!parsed ? (
              <p>
                <a href={href('')}>Start a review</a> or <a href={href('collection')}>see the collection</a>.
              </p>
            ) : null}
          </Notice>
        ) : null}
      </section>

      {parsed && range ? (
        <section className="panel step" aria-labelledby="step3">
          <h2 id="step3" className="step__title" ref={previewHeading} tabIndex={-1}>
            <span className="step__number">3</span> Review before saving
            {batchRanges(parsed.drafts.length).length > 1
              ? ` · batch ${parsed.batchIndex + 1} of ${batchRanges(parsed.drafts.length).length} (cards ${range.start + 1}–${range.end})`
              : ''}
          </h2>
          {parsed.notes.map((n) => (
            <p key={n} className="muted">
              {n}
            </p>
          ))}
          <p className="import-summary" role="status">
            <strong>{plan.toAdd.length}</strong> to add
            {plan.errorRows ? (
              <>
                {' '}
                · <strong className="text-error">{plan.errorRows}</strong> with errors
              </>
            ) : null}
            {plan.skippedDuplicates ? (
              <>
                {' '}
                · {plan.skippedDuplicates} duplicate{plan.skippedDuplicates === 1 ? '' : 's'} skipped
              </>
            ) : null}
            {plan.keptDuplicates ? (
              <>
                {' '}
                · {plan.keptDuplicates} duplicate{plan.keptDuplicates === 1 ? '' : 's'} kept
              </>
            ) : null}
            {plan.removed ? <> · {plan.removed} removed</> : null}
          </p>
          <p className="muted">Imported cards start as new and become due now. Nothing is saved until you confirm.</p>

          <ol className="draft-list">
            {batchDrafts.map((draft, i) => (
              <DraftRow key={draft.key} draft={draft} check={checks[i]!} onChange={(patch) => updateDraft(draft.key, patch)} />
            ))}
          </ol>

          <div className="button-row">
            <button type="button" className="button button--primary" onClick={commit} disabled={busy || !plan.ready}>
              {busy ? 'Adding…' : `Add ${plan.toAdd.length} card${plan.toAdd.length === 1 ? '' : 's'}`}
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
            {!plan.ready && plan.errorRows > 0 ? (
              <p className="field__error">
                Fix or remove {plan.errorRows} card{plan.errorRows === 1 ? '' : 's'} with errors to continue. Nothing from this
                batch is saved until every card is valid.
              </p>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function DraftRow({
  draft,
  check,
  onChange,
}: {
  draft: ImportDraft;
  check: DraftCheck;
  onChange: (patch: Partial<ImportDraft>) => void;
}) {
  const topics = useTopics();
  const [editing, setEditing] = useState(false);
  const hasError = !!check.rowError || check.errors.length > 0;
  const values = formValuesFrom(draft.input);
  const status = draft.removed
    ? 'removed'
    : hasError
      ? 'error'
      : check.duplicate
        ? draft.keepDuplicate
          ? 'kept'
          : 'duplicate'
        : 'ok';

  return (
    <li className={`draft draft--${status}`}>
      <div className="draft__head">
        <span className="draft__label">{draft.label}</span>
        <span className="draft__status">
          {status === 'removed'
            ? 'Removed'
            : status === 'error'
              ? 'Needs a fix'
              : status === 'duplicate'
                ? 'Duplicate · skipped'
                : status === 'kept'
                  ? 'Duplicate · keeping'
                  : 'Ready'}
        </span>
      </div>
      <p className="draft__question">
        {values.question.trim() ? plainExcerpt(values.question, 220) : <em className="muted">No question</em>}
      </p>
      <p className="draft__meta">
        {values.topic.trim() || 'General'} · {KIND_LABELS[values.kind as keyof typeof KIND_LABELS] ?? values.kind}
        {values.source.trim() ? ' · has source' : ''}
      </p>
      {!draft.removed && check.rowError ? <p className="field__error">{check.rowError}</p> : null}
      {!draft.removed && check.errors.length > 0 ? (
        <ul className="draft__errors">
          {check.errors.map((e) => (
            <li key={e.field + e.message} className="field__error">
              {e.message}
            </li>
          ))}
        </ul>
      ) : null}
      {!draft.removed && check.duplicate ? (
        <p className="draft__dup">
          {check.duplicate.kind === 'existing' ? (
            <>
              Already in your collection under <strong>{check.duplicate.topic}</strong>.
            </>
          ) : (
            <>Repeats {check.duplicate.label} in this import.</>
          )}{' '}
          <label className="inline-check">
            <input
              type="checkbox"
              checked={draft.keepDuplicate}
              onChange={(e) => onChange({ keepDuplicate: e.target.checked })}
            />{' '}
            Keep it anyway
          </label>
        </p>
      ) : null}
      <div className="draft__actions">
        {draft.removed ? (
          <button type="button" className="button button--quiet button--small" onClick={() => onChange({ removed: false })}>
            Restore
          </button>
        ) : (
          <>
            <button
              type="button"
              className="button button--quiet button--small"
              aria-expanded={editing}
              onClick={() => setEditing((e) => !e)}
            >
              {editing ? 'Done editing' : 'Edit'}
            </button>
            <button type="button" className="button button--quiet button--small" onClick={() => onChange({ removed: true })}>
              Remove
            </button>
          </>
        )}
      </div>
      {editing && !draft.removed ? (
        <div className="draft__editor">
          <CardFields
            values={values}
            onChange={(v) => onChange({ input: { ...v, source: v.source || null }, rowError: null })}
            errors={check.errors}
            topics={topics}
          />
        </div>
      ) : null}
    </li>
  );
}
