import { useEffect, useId, useState } from 'react';
import { AiClientError } from '../../ai/client';
import { useAi } from '../../app/ai';
import { useFlash } from '../../app/flash';
import { useWorkspace } from '../../app/workspace';
import { RUBRIC_LIMITS, sameRubricContent, validateRubricContent, type RubricContent } from '../../domain/grading';
import { formatDateTime } from '../../domain/time';
import type { Card, Rubric } from '../../domain/types';
import { Notice } from './common';

interface CriterionForm {
  /** Empty for a criterion that hasn't been saved yet. */
  id: string;
  description: string;
  weight: number;
  requiredConcepts: string;
  acceptableAlternatives: string;
}

interface RubricForm {
  criteria: CriterionForm[];
  criticalMisconceptions: string;
}

const lines = (text: string) => text.split('\n');
const joined = (items: string[]) => items.join('\n');

function formFrom(content: RubricContent | null): RubricForm {
  if (!content) return { criteria: [], criticalMisconceptions: '' };
  return {
    criteria: content.criteria.map((c) => ({
      id: c.id,
      description: c.description,
      weight: c.weight,
      requiredConcepts: joined(c.requiredConcepts),
      acceptableAlternatives: joined(c.acceptableAlternatives),
    })),
    criticalMisconceptions: joined(content.criticalMisconceptions),
  };
}

function contentFrom(form: RubricForm) {
  return {
    criteria: form.criteria.map((c) => ({
      id: c.id,
      description: c.description,
      weight: c.weight,
      requiredConcepts: lines(c.requiredConcepts),
      acceptableAlternatives: lines(c.acceptableAlternatives),
    })),
    criticalMisconceptions: lines(form.criticalMisconceptions),
  };
}

const blank = (): CriterionForm => ({ id: '', description: '', weight: 2, requiredConcepts: '', acceptableAlternatives: '' });

const WEIGHTS = [
  { value: 1, label: '1 · a detail' },
  { value: 2, label: '2 · supporting idea' },
  { value: 3, label: '3 · the main idea' },
  { value: 4, label: '4' },
  { value: 5, label: '5' },
];

/**
 * A card's rubric: what a complete answer must convey. AI feedback grades a
 * typed answer against it. A draft (blank or from the model) is only a form
 * until the learner saves it; saving is what marks it reviewed.
 */
export function RubricEditor({ card }: { card: Card }) {
  const ws = useWorkspace();
  const ai = useAi();
  const { show } = useFlash();
  const id = useId();
  const tz = ws.preferences.timezone;
  const [saved, setSaved] = useState<Rubric | null>(null);
  const [form, setForm] = useState<RubricForm | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState<'save' | 'draft' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [drafted, setDrafted] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void ws.repo.getRubric(card.id).then((r) => {
      if (cancelled) return;
      setSaved(r);
      setForm(formFrom(r));
    });
    return () => {
      cancelled = true;
    };
  }, [ws.repo, card.id]);

  if (!form) return null;

  const checked = validateRubricContent(contentFrom(form));
  const dirty = saved
    ? !checked.value || !sameRubricContent(checked.value, saved)
    : form.criteria.length > 0 || form.criticalMisconceptions.trim() !== '';
  const setCriterion = (i: number, patch: Partial<CriterionForm>) =>
    setForm({ ...form, criteria: form.criteria.map((c, j) => (j === i ? { ...c, ...patch } : c)) });

  async function save() {
    if (!checked.value) {
      setErrors(checked.errors);
      return;
    }
    setBusy('save');
    setProblem(null);
    setErrors([]);
    try {
      const rubric = await ws.repo.saveRubric(card.id, checked.value, Date.now());
      setSaved(rubric);
      setForm(formFrom(rubric));
      setDrafted(null);
      await ws.refresh();
      show('Rubric saved. AI feedback uses it from the next attempt on this card.');
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function draft() {
    if (!ai.client || ai.availability.state !== 'ready') return;
    setBusy('draft');
    setProblem(null);
    setErrors([]);
    try {
      const result = await ai.client.draftRubric(
        { question: card.question, referenceAnswer: card.answer },
        ai.availability.info.timeoutMs,
      );
      const draftCheck = validateRubricContent(result.rubric);
      if (!draftCheck.value) throw new AiClientError('ai-malformed', 'The draft didn’t pass Recall’s checks.');
      // A draft replaces the form, not the saved rubric. Its criteria are new, so they get new IDs on save.
      setForm(formFrom({ ...draftCheck.value, criteria: draftCheck.value.criteria.map((c) => ({ ...c, id: '' })) }));
      setDrafted(typeof result.model === 'string' ? result.model : 'the model');
    } catch (err) {
      setProblem(`${err instanceof Error ? err.message : String(err)} Nothing was changed; you can write the rubric yourself.`);
    } finally {
      setBusy(null);
    }
  }

  const canDraft = ai.mode === 'server' && ai.availability.state === 'ready';

  return (
    <section className="rubric" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="section__title">
        Rubric for AI feedback <span className="muted">(optional)</span>
      </h2>
      <p className="muted">
        What a complete answer must convey, in any wording. AI feedback checks a typed answer against these criteria. The card
        works the same without one: you compare and rate yourself.
        {saved ? ` Saved rubric: version ${saved.version}, ${formatDateTime(saved.updatedAt, tz, { year: 'numeric' })}.` : ''}
      </p>

      {drafted ? (
        <Notice tone="info" title="Draft to review">
          <p>
            Drafted by {drafted} from this card’s question and answer. Read it, change what’s off, and save it. Until you save,
            {saved ? ' the saved rubric stays in use.' : ' this card has no rubric.'}
          </p>
        </Notice>
      ) : null}
      {problem ? (
        <Notice tone="error" onDismiss={() => setProblem(null)}>
          <p>{problem}</p>
        </Notice>
      ) : null}
      {errors.length > 0 ? (
        <Notice tone="error" title="The rubric can’t be saved yet">
          <ul>
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {form.criteria.map((c, i) => (
        <fieldset className="rubric__criterion" key={i}>
          <legend>Criterion {i + 1}</legend>
          <div className="field">
            <label htmlFor={`${id}-d${i}`} className="field__label">
              A complete answer…
            </label>
            <input
              id={`${id}-d${i}`}
              type="text"
              value={c.description}
              maxLength={RUBRIC_LIMITS.description}
              placeholder="says that unmatched rows keep NULLs on the right side"
              onChange={(e) => setCriterion(i, { description: e.target.value })}
            />
          </div>
          <div className="field rubric__weight">
            <label htmlFor={`${id}-w${i}`} className="field__label">
              Weight
            </label>
            <select id={`${id}-w${i}`} value={c.weight} onChange={(e) => setCriterion(i, { weight: Number(e.target.value) })}>
              {WEIGHTS.map((w) => (
                <option key={w.value} value={w.value}>
                  {w.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${id}-r${i}`} className="field__label">
              Must get across <span className="muted">(optional, one per line)</span>
            </label>
            <textarea
              id={`${id}-r${i}`}
              rows={2}
              value={c.requiredConcepts}
              onChange={(e) => setCriterion(i, { requiredConcepts: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor={`${id}-a${i}`} className="field__label">
              Also accept <span className="muted">(optional, one per line)</span>
            </label>
            <textarea
              id={`${id}-a${i}`}
              rows={2}
              value={c.acceptableAlternatives}
              onChange={(e) => setCriterion(i, { acceptableAlternatives: e.target.value })}
            />
          </div>
          <button
            type="button"
            className="button button--quiet button--small"
            onClick={() => setForm({ ...form, criteria: form.criteria.filter((_, j) => j !== i) })}
          >
            Remove criterion {i + 1}
          </button>
        </fieldset>
      ))}

      {form.criteria.length > 0 ? (
        <div className="field">
          <label htmlFor={`${id}-m`} className="field__label">
            Critical misconceptions <span className="muted">(optional, one per line)</span>
          </label>
          <p id={`${id}-m-hint`} className="field__hint">
            A wrong belief that makes an answer incorrect even if it mentions the right terms.
          </p>
          <textarea
            id={`${id}-m`}
            rows={2}
            aria-describedby={`${id}-m-hint`}
            value={form.criticalMisconceptions}
            onChange={(e) => setForm({ ...form, criticalMisconceptions: e.target.value })}
          />
        </div>
      ) : null}

      <div className="button-row">
        <button
          type="button"
          className="button button--secondary"
          disabled={busy !== null || form.criteria.length >= RUBRIC_LIMITS.maxCriteria}
          onClick={() => setForm({ ...form, criteria: [...form.criteria, blank()] })}
        >
          Add a criterion
        </button>
        {canDraft ? (
          <button type="button" className="button button--secondary" disabled={busy !== null} onClick={() => void draft()}>
            {busy === 'draft' ? 'Drafting…' : 'Draft with AI'}
          </button>
        ) : null}
        <button type="button" className="button button--primary" disabled={busy !== null || !dirty} onClick={() => void save()}>
          Save rubric
        </button>
        {dirty && saved ? (
          <button
            type="button"
            className="button button--quiet"
            disabled={busy !== null}
            onClick={() => {
              setForm(formFrom(saved));
              setDrafted(null);
              setErrors([]);
            }}
          >
            Discard rubric changes
          </button>
        ) : null}
      </div>
      {canDraft && ai.availability.state === 'ready' ? (
        <p className="muted small">
          Draft with AI sends this card’s saved question and answer through your sync server to {ai.availability.info.destination}{' '}
          ({ai.availability.info.model}). Nothing is sent until you choose it.
        </p>
      ) : null}
    </section>
  );
}
