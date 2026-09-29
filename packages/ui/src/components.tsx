import { useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

export function Button({
  variant = 'secondary',
  busy = false,
  children,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; busy?: boolean }) {
  return (
    <button {...props} className={`ui-button ui-button--${variant}`} disabled={disabled || busy} aria-busy={busy || undefined}>
      {busy ? <span className="ui-spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export function TextField({
  label,
  error,
  hint,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string | null; hint?: string }) {
  const id = useId();
  const describedBy = [error ? `${id}-error` : null, hint ? `${id}-hint` : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="ui-field">
      <label htmlFor={id}>
        {label}
        {props.required ? <span className="ui-required" aria-hidden="true"> *</span> : null}
      </label>
      <input id={id} aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...props} />
      {hint ? (
        <span id={`${id}-hint`} className="ui-hint">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={`${id}-error`} className="ui-field-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const tone = ['active', 'success', 'trial'].includes(status)
    ? 'positive'
    : ['disabled', 'denied', 'failure', 'suspended', 'cancelled', 'revoked'].includes(status)
      ? 'negative'
      : 'neutral';
  return <span className={`ui-badge ui-badge--${tone}`}>{status.replaceAll('_', ' ')}</span>;
}

export function Banner({ tone = 'error', children }: { tone?: 'error' | 'warning' | 'info'; children: ReactNode }) {
  return (
    <div className={`ui-banner ui-banner--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

export function Panel({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="ui-panel" aria-label={title}>
      <header className="ui-panel__header">
        <h2>{title}</h2>
        {actions ? <div className="ui-panel__actions">{actions}</div> : null}
      </header>
      <div className="ui-panel__body">{children}</div>
    </section>
  );
}

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading,
  empty,
  rowNumbers = false,
  footerRow,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  loading?: boolean;
  empty: string;
  rowNumbers?: boolean;
  footerRow?: ReactNode;
}) {
  if (loading) {
    return <p className="ui-muted" role="status">Loadingâ€¦</p>;
  }
  if (rows.length === 0 && !footerRow) {
    return <p className="ui-muted">{empty}</p>;
  }
  return (
    <div className="ui-table-wrap">
      <table className="ui-table">
        <thead>
          <tr>
            {rowNumbers ? <th scope="col" className="ui-table__row-number">#</th> : null}
            {columns.map((column) => (
              <th key={column.key} scope="col">
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={rowKey(row)}>
              {rowNumbers ? <td className="ui-table__row-number">{index + 1}</td> : null}
              {columns.map((column) => (
                <td key={column.key}>{column.render(row)}</td>
              ))}
            </tr>
          ))}
          {footerRow}
        </tbody>
      </table>
    </div>
  );
}

export function FormWindow({
  title,
  onClose,
  footerLeft,
  footerRight,
  width,
  children,
}: {
  title: string;
  onClose?: () => void;
  footerLeft?: ReactNode;
  footerRight?: ReactNode;
  width?: number;
  children: ReactNode;
}) {
  return (
    <section className="ui-window" role="dialog" aria-label={title} style={width ? { width } : undefined}>
      <header className="ui-window__title">
        <h2>{title}</h2>
        {onClose ? (
          <button type="button" className="ui-window__close" aria-label={`Close ${title}`} onClick={onClose}>
            ×
          </button>
        ) : null}
      </header>
      <div className="ui-window__body">{children}</div>
      {footerLeft || footerRight ? (
        <footer className="ui-window__footer">
          <div className="ui-window__footer-group">{footerLeft}</div>
          <div className="ui-window__footer-group">{footerRight}</div>
        </footer>
      ) : null}
    </section>
  );
}

export function LinkArrow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="ui-link-arrow" aria-label={label} title={label} onClick={onClick}>
      <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true">
        <path d="M1 3.5h6.5V0.8L13 6l-5.5 5.2V8.5H1z" fill="var(--link-arrow)" stroke="#8a5d00" strokeWidth="0.8" />
      </svg>
    </button>
  );
}
