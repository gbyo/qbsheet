/**
 * One word about the state of something, in a tone.
 *
 * The dot is decorative and the word is the status. That ordering is the whole point: a badge
 * whose meaning lives in its colour is a badge that means nothing in a screenshot printed in
 * black and white, to a colour-blind operator, or under Forced Colors.
 */

import type { ReactNode } from 'react';
import type { Tone } from './Notice';

export interface StatusBadgeProps {
  tone?: Tone;
  children?: ReactNode;
  className?: string;
}

export function StatusBadge({ tone = 'neutral', children, className }: StatusBadgeProps) {
  return (
    <span className={['qbs-badge', `qbs-badge--${tone}`, className].filter(Boolean).join(' ')}>
      <span className="qbs-badge__dot" aria-hidden="true" />
      {children}
    </span>
  );
}
