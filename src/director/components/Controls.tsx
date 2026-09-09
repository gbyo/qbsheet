import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

/**
 * Director's action vocabulary.
 *
 * # When to use which
 *
 *   `primary`      One per surface: the thing the operator came here to do.
 *                  Start Round 4. Save. Create tournament.
 *   `secondary`    Ordinary actions sitting beside it. The default.
 *   `quiet`        Low-emphasis actions, dense toolbars, row actions.
 *   `danger`       Destructive or tournament-altering. Outlined.
 *   `danger-solid` Only the confirm button inside a destructive confirmation.
 *
 * Anything that *navigates* is a `Link`, not a quiet button. Anything that only
 * reports state is a `Badge`, not a control. A row with more than one visible
 * action wants an `ActionMenu`, not a toolbar.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger' | 'danger-solid';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  icon?: IconName;
  /** Trailing icon, for menu triggers and disclosure-style actions. */
  iconAfter?: IconName;
  size?: 'sm' | 'md' | 'lg';
  block?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    children,
    variant = 'secondary',
    icon,
    iconAfter,
    size = 'md',
    block = false,
    className = '',
    type = 'button',
    disabled = false,
    ...buttonProps
  },
  ref,
) {
  return (
    <button
      {...buttonProps}
      ref={ref}
      type={type}
      className={[
        'director-button',
        `director-button-${variant}`,
        size !== 'md' ? `director-button-${size}` : '',
        block ? 'director-button-block' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      disabled={disabled}
    >
      {icon && <Icon name={icon} size={size === 'sm' ? 14 : 15} />}
      {children != null && children !== false && <span>{children}</span>}
      {iconAfter && <Icon name={iconAfter} size={size === 'sm' ? 13 : 14} />}
    </button>
  );
});

/**
 * An icon-only control. The accessible name is required, not optional — an
 * unlabelled icon button is unusable with a screen reader and ambiguous with a
 * pointer.
 */
export const IconButton = forwardRef<
  HTMLButtonElement,
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
    icon: IconName;
    label: string;
    tone?: 'default' | 'danger';
    size?: 'sm' | 'md';
  }
>(function IconButton({ icon, label, tone = 'default', size = 'md', className = '', ...rest }, ref) {
  return (
    <button
      {...rest}
      ref={ref}
      type={rest.type ?? 'button'}
      className={[
        'director-icon-button',
        size === 'sm' ? 'director-icon-button-sm' : '',
        tone === 'danger' ? 'director-icon-button-danger' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      aria-label={label}
      title={rest.title ?? label}
    >
      <Icon name={icon} size={size === 'sm' ? 15 : 17} />
    </button>
  );
});

/**
 * Real navigation, styled as navigation. Replaces the tiny blue text labels and
 * bare `director-inline-action` buttons that used to stand in for both links
 * and controls.
 */
export function Link({
  children,
  onClick,
  disabled,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      type="button"
      className={`director-link ${className}`.trim()}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

/** A row of actions. `align="end"` right-aligns; `split` pushes the first child left. */
export function Actions({
  children,
  align = 'start',
  split = false,
  className = '',
}: {
  children: ReactNode;
  align?: 'start' | 'end';
  split?: boolean;
  className?: string;
}) {
  return (
    <div
      className={[
        'director-actions',
        align === 'end' ? 'director-actions-end' : '',
        split ? 'director-actions-split' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </div>
  );
}

type PanelRegionProps = { children: ReactNode; className?: string };

/** The normal inset content region for a Director panel. */
export function PanelBody({ children, className = '' }: PanelRegionProps) {
  return <div className={`director-panel-body ${className}`.trim()}>{children}</div>;
}

/** The action region for a Director panel, kept separate from its content inset. */
export function PanelFooter({ children, className = '' }: PanelRegionProps) {
  return <div className={`director-panel-footer ${className}`.trim()}>{children}</div>;
}

export type EmptyStateVariant = 'standalone' | 'contained' | 'inline';

/**
 * One empty-state language.
 *
 * An empty state names what belongs here and offers the action that puts it
 * there. It does not explain that data is stored locally, and it is not a
 * second copy of the page description. The `Get started` eyebrow that used to
 * sit above every one of these is gone — it was true of exactly none of the
 * cases where a list had simply been filtered to nothing.
 */
export function EmptyState({
  title,
  description,
  children,
  variant = 'standalone',
  className = '',
}: {
  title: string;
  description?: string;
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
      <h2>{title}</h2>
      {description && <p>{description}</p>}
      {children && <div className="director-empty-actions">{children}</div>}
    </section>
  );
}

/* ------------------------------------------------------------------ Status
 * Re-exported here because `Controls` is the historical import site for
 * `StateLabel`. The status model itself lives in `Status.tsx`.
 */
export { StateLabel, statusTone, type StatusTone } from './Status';

/** @deprecated Use `Field` from `Fields.tsx`, which supports hints and errors. */
export function FormField({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="director-form-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
