/**
 * A short status message attached to a surface.
 *
 * Deliberately plain markup: this is text in a box, and an ARIA role on it would be a claim the
 * element does not need. The one thing it does carry is a tone word, so the meaning does not
 * depend on the colour — a red box that also says nothing is a red box to somebody who cannot
 * see red.
 */

import type { ReactNode } from 'react';

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

/** The word shown beside a tone. Colour is never the only carrier of meaning. */
const toneLabel: Record<Tone, string | null> = {
  neutral: null,
  info: null,
  success: 'Done',
  warning: 'Check',
  danger: 'Problem',
};

export interface NoticeProps {
  tone?: Tone;
  children?: ReactNode;
  /**
   * How assistive technology should treat an arriving message.
   *
   * `polite` for a result that appeared, `assertive` for a failure the operator has to act on,
   * and omitted entirely for a notice that is simply part of the page. Anything that rerenders
   * on a timer must omit it, or a screen reader narrates the poll loop.
   */
  live?: 'polite' | 'assertive';
  className?: string;
}

export function Notice({ tone = 'neutral', children, live, className }: NoticeProps) {
  const label = toneLabel[tone];
  return (
    <div
      className={['qbs-notice', `qbs-notice--${tone}`, className].filter(Boolean).join(' ')}
      {...(live ? { role: live === 'assertive' ? 'alert' : 'status', 'aria-live': live } : {})}
    >
      {label ? <span className="qbs-notice__label">{label}:</span> : null}
      <span>{children}</span>
    </div>
  );
}
