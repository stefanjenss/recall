import { useId, useState, type ReactNode } from 'react';
import { charCount, LIMITS, type CardField, type FieldError } from '../../domain/limits';
import { CARD_KINDS, KIND_DESCRIPTIONS, KIND_LABELS, type CardContent } from '../../domain/types';
import { CharCount, Markdown } from './common';

export interface CardFormValues {
  topic: string;
  question: string;
  answer: string;
  kind: string;
  source: string;
}

export const EMPTY_CARD_FORM: CardFormValues = { topic: '', question: '', answer: '', kind: 'recall', source: '' };

export function formValuesFrom(content: Partial<Record<keyof CardContent, unknown>>): CardFormValues {
  const s = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'string' ? v : String(v));
  const kind = s(content.kind).trim().toLowerCase();
  return {
    topic: s(content.topic),
    question: s(content.question),
    answer: s(content.answer),
    kind: kind || 'recall',
    source: s(content.source),
  };
}

export function CardFields({
  values,
  onChange,
  errors,
  topics,
  showErrors = true,
}: {
  values: CardFormValues;
  onChange: (next: CardFormValues) => void;
  errors: FieldError[];
  topics: string[];
  showErrors?: boolean;
}) {
  const id = useId();
  const [preview, setPreview] = useState(false);
  const errorFor = (field: CardField) => (showErrors ? errors.find((e) => e.field === field)?.message : undefined);
  const set = (field: keyof CardFormValues) => (e: { target: { value: string } }) =>
    onChange({ ...values, [field]: e.target.value });
  const knownKind = (CARD_KINDS as readonly string[]).includes(values.kind);

  const field = (
    name: CardField,
    label: string,
    control: (props: { id: string; 'aria-invalid'?: true; 'aria-describedby'?: string }) => ReactNode,
    opts: { hint?: string; limit?: number; value?: string } = {},
  ) => {
    const err = errorFor(name);
    const controlId = `${id}-${name}`;
    const describedBy = [opts.hint ? `${controlId}-hint` : '', err ? `${controlId}-error` : ''].filter(Boolean).join(' ');
    return (
      <div className={`field${err ? ' has-error' : ''}`}>
        <div className="field__label-row">
          <label htmlFor={controlId} className="field__label">
            {label}
          </label>
          {opts.limit !== undefined && opts.value !== undefined ? (
            <CharCount count={charCount(opts.value)} limit={opts.limit} />
          ) : null}
        </div>
        {opts.hint ? (
          <p id={`${controlId}-hint`} className="field__hint">
            {opts.hint}
          </p>
        ) : null}
        {control({
          id: controlId,
          ...(err ? { 'aria-invalid': true as const } : {}),
          ...(describedBy ? { 'aria-describedby': describedBy } : {}),
        })}
        {err ? (
          <p id={`${controlId}-error`} className="field__error">
            {err}
          </p>
        ) : null}
      </div>
    );
  };

  return (
    <div className="card-fields">
      <div className="card-fields__row">
        {field(
          'topic',
          'Topic',
          (p) => (
            <>
              <input
                {...p}
                type="text"
                value={values.topic}
                onChange={set('topic')}
                list={`${id}-topics`}
                placeholder="General"
                autoComplete="off"
              />
              <datalist id={`${id}-topics`}>
                {topics.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </>
          ),
          { limit: LIMITS.topic, value: values.topic },
        )}
        {field('kind', 'Kind', (p) => (
          <select {...p} value={values.kind} onChange={set('kind')}>
            {!knownKind ? <option value={values.kind}>Unknown: {values.kind}</option> : null}
            {CARD_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]} — {KIND_DESCRIPTIONS[k].toLowerCase()}
              </option>
            ))}
          </select>
        ))}
      </div>
      {field(
        'question',
        'Question',
        (p) => (
          <textarea {...p} rows={3} value={values.question} onChange={set('question')} />
        ),
        {
          hint: 'One focused learning objective. Markdown works: lists, `inline code`, and fenced code blocks.',
          limit: LIMITS.question,
          value: values.question,
        },
      )}
      {field(
        'answer',
        'Answer',
        (p) => (
          <textarea {...p} rows={6} value={values.answer} onChange={set('answer')} />
        ),
        {
          hint: 'State the key idea first, then a short example if it helps.',
          limit: LIMITS.answer,
          value: values.answer,
        },
      )}
      {field(
        'source',
        'Source (optional)',
        (p) => (
          <input {...p} type="text" value={values.source} onChange={set('source')} />
        ),
        {
          hint: 'A citation or URL. Leave empty for your own notes or generated examples.',
          limit: LIMITS.source,
          value: values.source,
        },
      )}
      <div className="card-fields__preview">
        <button type="button" className="button button--quiet" aria-expanded={preview} onClick={() => setPreview((p) => !p)}>
          {preview ? 'Hide preview' : 'Preview formatting'}
        </button>
        {preview ? (
          <div className="card-preview">
            <p className="eyebrow">Question</p>
            {values.question.trim() ? (
              <Markdown source={values.question} className="card-preview__question" />
            ) : (
              <p className="muted">Nothing yet.</p>
            )}
            <p className="eyebrow">Answer</p>
            {values.answer.trim() ? (
              <Markdown source={values.answer} className="card-preview__answer" />
            ) : (
              <p className="muted">Nothing yet.</p>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
