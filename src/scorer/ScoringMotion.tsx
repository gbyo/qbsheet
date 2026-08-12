/**
 * Small presentation-only motion primitives shared by scoring surfaces.
 *
 * The current value is always the only text in the DOM. The outgoing value is carried in a data
 * attribute and painted by CSS, so animation never duplicates an accessible number or changes the
 * text callers and tests read. State changes immediately; the timer only removes the old paint.
 */
import { CSSProperties, useLayoutEffect, useRef, useState } from 'react';

export type MotionDirection = 'forward' | 'backward';

export interface INumberMotion {
  from: number;
  to: number;
  direction: MotionDirection;
  token: number;
}

export function numberMotion(from: number, to: number, token = 1): INumberMotion | null {
  if (from === to) return null;
  return { from, to, direction: to > from ? 'forward' : 'backward', token };
}

export const numberMotionMs = 180;
export const noBuzzAcknowledgementMotionMs = 170;
export const bonusExitMotionMs = 180;
export const recentMotionMs = 200;
export const connectionRecoveryMotionMs = 320;

export default function MotionNumber(props: {
  value: number;
  className?: string;
  /** Keeps a counter's column stable when the number of digits changes. */
  minimumDigits?: number;
  /** A semantic label when the surrounding copy does not already provide one. */
  'aria-label'?: string;
}) {
  const { value, className = '', minimumDigits, 'aria-label': ariaLabel } = props;
  const previous = useRef(value);
  const sequence = useRef(0);
  const [motion, setMotion] = useState<INumberMotion | null>(null);

  useLayoutEffect(() => {
    const from = previous.current;
    previous.current = value;
    sequence.current += 1;
    const next = numberMotion(from, value, sequence.current);
    setMotion(next);
    if (!next) return undefined;
    const timer = window.setTimeout(() => setMotion((current) => (current?.token === next.token ? null : current)), numberMotionMs);
    return () => window.clearTimeout(timer);
  }, [value]);

  return (
    <span
      className={`qbsheet-motion-number${className ? ` ${className}` : ''}`}
      data-motion-direction={motion?.direction}
      data-motion-token={motion?.token}
      data-previous-value={motion?.from}
      aria-label={ariaLabel}
      style={minimumDigits ? ({ '--qbsheet-number-digits': minimumDigits } as CSSProperties) : undefined}
    >
      <span className="qbsheet-motion-number-current">{value}</span>
    </span>
  );
}
