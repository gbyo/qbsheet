import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export function Button({
  children,
  onClick,
  variant = 'secondary',
  icon,
  className = '',
  type = 'button',
  disabled = false,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
  icon?: IconName;
  className?: string;
  type?: 'button' | 'submit';
  disabled?: boolean;
}) {
  return (
    <button
      type={type}
      className={`director-button director-button-${variant} ${className}`}
      onClick={onClick}
      disabled={disabled}
    >
      {icon && <Icon name={icon} size={15} />}
      <span>{children}</span>
    </button>
  );
}

export function EmptyState({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <section className="director-empty-state">
      <p className="director-eyebrow">Get started</p>
      <h2>{title}</h2>
      <p>{description}</p>
      {children && <div className="director-empty-actions">{children}</div>}
    </section>
  );
}

export function StateLabel({ state, label }: { state: string; label?: string }) {
  return (
    <span className={`director-state director-state-${state}`}>
      <span className="director-state-dot" aria-hidden="true" />
      {label ?? state}
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
