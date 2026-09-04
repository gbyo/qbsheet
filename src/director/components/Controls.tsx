import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

type PanelRegionProps = {
  children: ReactNode;
  className?: string;
};

function panelRegionClass(base: string, className: string): string {
  return [base, className].filter(Boolean).join(' ');
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
  icon?: IconName;
};

export function Button({
  children,
  variant = 'secondary',
  icon,
  className = '',
  type = 'button',
  disabled = false,
  ...buttonProps
}: ButtonProps) {
  return (
    <button
      {...buttonProps}
      type={type}
      className={`director-button director-button-${variant} ${className}`}
      disabled={disabled}
    >
      {icon && <Icon name={icon} size={15} />}
      <span>{children}</span>
    </button>
  );
}

/** The normal inset content region for a Director panel. */
export function PanelBody({ children, className = '' }: PanelRegionProps) {
  return <div className={panelRegionClass('director-panel-body', className)}>{children}</div>;
}

/** The action region for a Director panel, kept separate from its content inset. */
export function PanelFooter({ children, className = '' }: PanelRegionProps) {
  return <div className={panelRegionClass('director-panel-footer', className)}>{children}</div>;
}

export type EmptyStateVariant = 'standalone' | 'contained' | 'inline';

export function EmptyState({
  title,
  description,
  children,
  variant = 'standalone',
  className = '',
}: {
  title: string;
  description: string;
  children?: ReactNode;
  variant?: EmptyStateVariant;
  className?: string;
}) {
  const variantClasses =
    variant === 'inline'
      ? ['director-empty-state-contained', 'director-empty-state-inline']
      : [`director-empty-state-${variant}`];
  return (
    <section
      className={['director-empty-state', ...variantClasses, className].filter(Boolean).join(' ')}
      data-variant={variant}
    >
      <p className="director-eyebrow">Get started</p>
      <h2>{title}</h2>
      <p>{description}</p>
      {children && <div className="director-empty-actions">{children}</div>}
    </section>
  );
}

type StateTone = 'positive' | 'info' | 'warning' | 'negative' | 'neutral';

const stateTones: Record<string, StateTone> = {
  accepted: 'positive',
  available: 'positive',
  closed: 'positive',
  complete: 'positive',
  confirmed: 'positive',
  connected: 'positive',
  finished: 'positive',
  healthy: 'positive',
  live: 'info',
  paired: 'positive',
  ready: 'positive',
  ruled: 'positive',
  active: 'info',
  assigned: 'info',
  current: 'info',
  info: 'info',
  'in-progress': 'info',
  prepared: 'info',
  released: 'info',
  submitted: 'info',
  help: 'warning',
  recommendation: 'warning',
  received: 'warning',
  review: 'warning',
  'result-received': 'warning',
  waitlist: 'warning',
  waiting: 'neutral',
  abandoned: 'negative',
  blocker: 'negative',
  cancelled: 'negative',
  dropped: 'negative',
  error: 'negative',
  failed: 'negative',
  'no-show': 'negative',
  offline: 'negative',
  rejected: 'negative',
  withdrawn: 'negative',
  archived: 'neutral',
  draft: 'neutral',
  'not-started': 'neutral',
  open: 'neutral',
  pending: 'neutral',
  planned: 'neutral',
  scheduled: 'neutral',
};

function normalizeState(state: string): string {
  return (
    state
      .trim()
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'neutral'
  );
}

function toneForState(state: string): StateTone {
  const directTone = stateTones[state];
  if (directTone) return directTone;
  if (/(?:error|offline|blocker|dropped|rejected|failed|abandoned|cancelled|withdrawn)/.test(state)) {
    return 'negative';
  }
  if (/(?:warning|review|help|waiting|recommendation|waitlist)/.test(state)) return 'warning';
  if (/(?:live|ready|accepted|confirmed|available|connected|finished|complete|healthy|paired)/.test(state)) {
    return 'positive';
  }
  if (/(?:active|current|info|assigned|prepared|released|submitted)/.test(state)) return 'info';
  return 'neutral';
}

function humanizeState(state: string): string {
  return state.replaceAll('-', ' ').replace(/\b\w/g, (character) => character.toLocaleUpperCase());
}

export function StateLabel({ state, label }: { state: string; label?: string }) {
  const normalizedState = normalizeState(state);
  const tone = toneForState(normalizedState);
  return (
    <span className={`director-state director-state-${tone}`} data-state={normalizedState} data-tone={tone}>
      <span className="director-state-dot" aria-hidden="true" />
      {label ?? humanizeState(normalizedState)}
    </span>
  );
}

export function FormField({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="director-form-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
