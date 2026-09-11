/**
 * A QBSheet button.
 *
 * React Aria supplies the behaviour that is tedious to get right and easy to get subtly wrong —
 * pointer and keyboard activation agreeing with each other, `data-pressed` only while actually
 * pressed, `data-focus-visible` only for keyboard focus, a disabled control that is genuinely
 * unreachable rather than merely faded. QBSheet supplies every pixel: the variants below are
 * token compositions, and nothing from a third-party theme is loaded.
 */

import type { ReactNode } from 'react';
import { Button as AriaButton, type ButtonProps as AriaButtonProps } from 'react-aria-components';

export type ButtonVariant =
  /** The one action a surface is for. At most one per view. */
  | 'primary'
  /** The ordinary action. The default. */
  | 'secondary'
  /** Low-emphasis: row actions, dismissals, anything repeated many times on screen. */
  | 'quiet'
  /** Destructive and irreversible. Never the default focus of a dialog. */
  | 'danger';

export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends Omit<AriaButtonProps, 'className' | 'children'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children?: ReactNode;
}

export function Button({ variant = 'secondary', size = 'md', className, children, ...props }: ButtonProps) {
  return (
    <AriaButton
      {...props}
      className={['qbs-button', `qbs-button--${variant}`, `qbs-button--${size}`, className]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </AriaButton>
  );
}
