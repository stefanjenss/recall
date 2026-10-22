import { useEffect, useId, useMemo, useRef, type CSSProperties, type ReactNode } from 'react';
import { isHttpUrl, renderInlineMarkdown, renderMarkdown, renderOptionMarkdown } from '../markdown';

export function PageHeader({ title, kicker, children }: { title: string; kicker?: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-header">
      <div className="page-header__text">
        {kicker ? <p className="page-header__kicker">{kicker}</p> : null}
        <h1 tabIndex={-1}>{title}</h1>
      </div>
      {children ? <div className="page-header__actions">{children}</div> : null}
    </header>
  );
}

export function Notice({
  tone = 'info',
  title,
  children,
  onDismiss,
  live = true,
}: {
  tone?: 'info' | 'success' | 'warn' | 'error';
  title?: string;
  children?: ReactNode;
  onDismiss?: () => void;
  live?: boolean;
}) {
  const label = { info: 'Note', success: 'Done', warn: 'Heads up', error: 'Problem' }[tone];
  return (
    <div className={`notice notice--${tone}`} role={live ? (tone === 'error' ? 'alert' : 'status') : undefined}>
      <div className="notice__body">
        <p className="notice__label">{title ?? label}</p>
        {children ? <div className="notice__content">{children}</div> : null}
      </div>
      {onDismiss ? (
        <button type="button" className="notice__dismiss" onClick={onDismiss} aria-label="Dismiss message">
          ×
        </button>
      ) : null}
    </div>
  );
}

export function Markdown({ source, className = '' }: { source: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  return <div className={`prose ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** A multiple-choice option: inline code and emphasis, no links (options can sit inside buttons). */
export function OptionText({ source, className }: { source: string; className?: string }) {
  const html = useMemo(() => renderOptionMarkdown(source), [source]);
  return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function SourceLine({ source }: { source: string | null }) {
  if (!source) return null;
  return (
    <p className="source-line">
      <span className="source-line__label">Source</span>{' '}
      {isHttpUrl(source) ? (
        <a href={source.trim()} target="_blank" rel="noopener noreferrer">
          {source.trim()}
        </a>
      ) : (
        <span dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(source) }} />
      )}
    </p>
  );
}

export interface SegmentedOption<T extends string | number> {
  value: T;
  label: string;
  hint?: string;
}

/** A rectangular radio group. Native radios keep keyboard and screen-reader behavior. */
export function Segmented<T extends string | number>({
  legend,
  options,
  value,
  onChange,
  name,
  hideLegend = false,
  disabled = false,
  allowClear = false,
}: {
  legend: ReactNode;
  options: SegmentedOption<T>[];
  value: T | null;
  onChange: (value: T | null) => void;
  name?: string;
  hideLegend?: boolean;
  disabled?: boolean;
  allowClear?: boolean;
}) {
  const autoName = useId();
  return (
    <fieldset className="segmented" disabled={disabled}>
      <legend className={hideLegend ? 'visually-hidden' : 'segmented__legend'}>{legend}</legend>
      <div className="segmented__options" style={{ '--options': options.length } as CSSProperties}>
        {options.map((opt) => {
          const checked = opt.value === value;
          return (
            <label key={String(opt.value)} className={`segmented__option${checked ? ' is-checked' : ''}`}>
              <input
                type="radio"
                name={name ?? autoName}
                value={String(opt.value)}
                checked={checked}
                onChange={() => onChange(opt.value)}
                onClick={() => {
                  if (allowClear && checked) onChange(null);
                }}
              />
              <span className="segmented__mark" aria-hidden="true" />
              <span className="segmented__text">
                {opt.label}
                {opt.hint ? <span className="segmented__hint">{opt.hint}</span> : null}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export function StatList({
  items,
  className = '',
}: {
  items: Array<{ label: string; value: ReactNode; note?: ReactNode }>;
  className?: string;
}) {
  return (
    <dl className={`stat-list ${className}`}>
      {items.map((item) => (
        <div className="stat-list__item" key={item.label}>
          <dt>{item.label}</dt>
          <dd>
            <span className="stat-list__value">{item.value}</span>
            {item.note ? <span className="stat-list__note">{item.note}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Modal dialog built on <dialog>: the browser handles focus containment,
 * inert background, and Escape. Focus returns to the opener on close.
 */
export function Dialog({
  open,
  title,
  onClose,
  children,
  actions,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  actions: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      opener.current = document.activeElement;
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const onClosed = () => {
      if (opener.current instanceof HTMLElement && opener.current.isConnected) opener.current.focus();
    };
    dialog.addEventListener('close', onClosed);
    return () => dialog.removeEventListener('close', onClosed);
  }, []);

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <h2 id={titleId} className="dialog__title">
        {title}
      </h2>
      <div className="dialog__body">{children}</div>
      <div className="dialog__actions">{actions}</div>
    </dialog>
  );
}

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  tone = 'default',
  busy = false,
  confirmDisabled = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  tone?: 'default' | 'danger';
  busy?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog
      open={open}
      title={title}
      onClose={onCancel}
      actions={
        <>
          <button type="button" className="button button--secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={`button ${tone === 'danger' ? 'button--danger' : 'button--primary'}`}
            onClick={onConfirm}
            disabled={busy || confirmDisabled}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}

export function CharCount({ count, limit }: { count: number; limit: number }) {
  const over = count > limit;
  const near = count > limit * 0.9;
  if (!near) return null;
  return (
    <span className={`char-count${over ? ' is-over' : ''}`}>
      {count.toLocaleString()} / {limit.toLocaleString()}
      {over ? ' — over the limit' : ''}
    </span>
  );
}

export function Wordmark() {
  return (
    <span className="wordmark">
      <svg className="wordmark__motif" viewBox="0 0 28 24" aria-hidden="true" focusable="false">
        <rect x="7.5" y="1.5" width="19" height="13" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.45" />
        <rect x="4.5" y="4.5" width="19" height="13" fill="var(--paper)" stroke="currentColor" strokeWidth="1.2" opacity="0.75" />
        <rect x="1.5" y="7.5" width="19" height="13" fill="var(--lime)" stroke="currentColor" strokeWidth="1.4" />
      </svg>
      <span className="wordmark__text">
        recall<span className="wordmark__dot">.</span>
      </span>
    </span>
  );
}
