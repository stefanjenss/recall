import { useId, useState, type ReactNode } from 'react';
import { charCount, LIMITS, MAX_DISTRACTORS, type CardField, type FieldError } from '../../domain/limits';
import { CARD_KINDS, KIND_DESCRIPTIONS, KIND_LABELS, type CardContent } from '../../domain/types';
import { CharCount, Markdown, OptionText } from './common';

export interface ChoiceFormValues {
  correct: string;
  /** At least three fields; more only when imported content had more (validation then asks to remove some). */
  distractors: string[];
}

export interface CardFormValues {
  topic: string;
  question: string;
  answer: string;
  kind: string;
  source: string;
  /** Left blank, the card has no options; validation turns blank options into `null`. */
  choices: ChoiceFormValues;
}

const blankDistractors = () => Array.from({ length: MAX_DISTRACTORS }, () => '');

export const EMPTY_CARD_FORM: CardFormValues = {
  topic: '',
  question: '',
  answer: '',
  kind: 'recall',
  source: '',
  choices: { correct: '', distractors: blankDistractors() },
};

export function formValuesFrom(content: Partial<Record<keyof CardContent, unknown>>): CardFormValues {
  const s = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'string' ? v : String(v));
  const kind = s(content.kind).trim().toLowerCase();
  const raw = content.choices;
  const choices = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const distractors = Array.isArray(choices.distractors) ? choices.distractors.map(s) : [];
  return {
    topic: s(content.topic),
    question: s(content.question),
    answer: s(content.answer),
    kind: kind || 'recall',
    source: s(content.source),
    choices: {
      correct: s(choices.correct),
      distractors: [...distractors, ...blankDistractors()].slice(0, Math.max(MAX_DISTRACTORS, distractors.length)),
    },
  };
}

function hasAnyChoice(c: ChoiceFormValues): boolean {
  return c.correct.trim() !== '' || c.distractors.some((d) => d.trim() !== '');
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
  const [showChoices, setShowChoices] = useState(() => hasAnyChoice(values.choices));
  const errorFor = (field: CardField) => (showErrors ? errors.find((e) => e.field === field)?.message : undefined);
  const set = (field: Exclude<keyof CardFormValues, 'choices'>) => (e: { target: { value: string } }) =>
    onChange({ ...values, [field]: e.target.value });
  const choiceErrors = showErrors ? errors.filter((e) => e.field === 'choices') : [];
  const choicesOpen = showChoices || choiceErrors.length > 0;
  const setChoices = (patch: Partial<ChoiceFormValues>) => onChange({ ...values, choices: { ...values.choices, ...patch } });
  const choiceCount = hasAnyChoice(values.choices) ? 1 + values.choices.distractors.filter((d) => d.trim() !== '').length : 0;
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
      <div className="card-fields__choices">
        <button
          type="button"
          className="button button--quiet"
          aria-expanded={choicesOpen}
          aria-controls={`${id}-choices`}
          onClick={() => setShowChoices((v) => !v)}
        >
          {choicesOpen ? 'Hide multiple-choice options' : 'Multiple-choice options'}
          <span className="muted"> · {choiceCount > 0 ? `${choiceCount} options` : 'optional'}</span>
        </button>
        {choicesOpen ? (
          <fieldset
            id={`${id}-choices`}
            className={`choice-fields${choiceErrors.length ? ' has-error' : ''}`}
            aria-describedby={[`${id}-choices-hint`, choiceErrors.length ? `${id}-choices-error` : ''].filter(Boolean).join(' ')}
          >
            <legend className="field__label">Multiple-choice options</legend>
            <p id={`${id}-choices-hint`} className="field__hint">
              Used by Quick check. Give a one-line correct option and up to {MAX_DISTRACTORS} plausible wrong ones of a similar
              length. Leave all blank to keep this card recall-only.
            </p>
            <ChoiceInput
              id={`${id}-choice-correct`}
              label="Correct option"
              value={values.choices.correct}
              invalid={choiceErrors.length > 0}
              onChange={(correct) => setChoices({ correct })}
            />
            {values.choices.distractors.map((d, i) => (
              <ChoiceInput
                key={i}
                id={`${id}-choice-wrong-${i}`}
                label={`Wrong option ${i + 1}`}
                value={d}
                invalid={choiceErrors.length > 0}
                onChange={(next) => setChoices({ distractors: values.choices.distractors.map((x, j) => (j === i ? next : x)) })}
              />
            ))}
            {choiceErrors.length ? (
              <div id={`${id}-choices-error`}>
                {choiceErrors.map((e) => (
                  <p key={e.message} className="field__error">
                    {e.message}
                  </p>
                ))}
              </div>
            ) : null}
          </fieldset>
        ) : null}
      </div>
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
            {choiceCount > 0 ? (
              <>
                <p className="eyebrow">Options</p>
                <ul className="card-preview__choices">
                  {[values.choices.correct, ...values.choices.distractors]
                    .filter((o) => o.trim() !== '')
                    .map((o, i) => (
                      <li key={i}>
                        <OptionText source={o.trim()} />
                        {i === 0 && values.choices.correct.trim() ? <span className="muted"> (correct)</span> : null}
                      </li>
                    ))}
                </ul>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ChoiceInput({
  id,
  label,
  value,
  invalid,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  invalid: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="field">
      <div className="field__label-row">
        <label htmlFor={id} className="field__label">
          {label}
        </label>
        <CharCount count={charCount(value)} limit={LIMITS.choice} />
      </div>
      <textarea
        id={id}
        rows={2}
        className="choice-fields__input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        {...(invalid ? { 'aria-invalid': true as const } : {})}
      />
    </div>
  );
}
