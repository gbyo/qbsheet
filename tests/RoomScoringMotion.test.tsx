/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import MotionNumber, { numberMotionMs } from '../src/scorer/ScoringMotion';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('shared scoring motion primitives', () => {
  test('the numeric token appears only when the value changes and carries direction', () => {
    vi.useFakeTimers();
    const view = render(<MotionNumber value={12} />);
    const counter = () => view.container.querySelector('.qbsheet-motion-number') as HTMLElement;

    expect(counter().dataset.motionDirection).toBeUndefined();
    view.rerender(<MotionNumber value={12} />);
    expect(counter().dataset.motionDirection).toBeUndefined();
    view.rerender(<MotionNumber value={13} />);
    expect(counter()).toHaveAttribute('data-motion-direction', 'forward');
    expect(counter()).toHaveAttribute('data-previous-value', '12');
    act(() => vi.advanceTimersByTime(numberMotionMs));
    expect(counter().dataset.motionDirection).toBeUndefined();
    view.rerender(<MotionNumber value={11} />);
    expect(counter()).toHaveAttribute('data-motion-direction', 'backward');
    expect(counter()).toHaveAttribute('data-previous-value', '13');
  });

  test('reduced motion explicitly removes every travel, scale, sweep, ring, and ghost layer', () => {
    const css = readFileSync(new URL('../src/app/motion.css', String(import.meta.url)), 'utf8');
    const reducedStart = css.indexOf('@media (prefers-reduced-motion: reduce)');
    const blockStart = css.indexOf('{', reducedStart);
    let depth = 0;
    let reducedEnd = css.length;
    for (let index = blockStart; index < css.length; index += 1) {
      if (css[index] === '{') depth += 1;
      if (css[index] !== '}') continue;
      depth -= 1;
      if (depth === 0) {
        reducedEnd = index + 1;
        break;
      }
    }
    const reduced = css.slice(reducedStart, reducedEnd);

    expect(reduced).toContain('.qbsheet-motion-number[data-motion-direction]::before');
    expect(reduced).toContain('.scorer-no-buzz-sweep');
    expect(reduced).toContain('.scorer-bonus-exit');
    expect(reduced).toContain('.scorer-conn.is-recovered .scorer-dot::after');
    expect(reduced).toContain('.scorer-rail-item.is-motion-ghost');
    expect(reduced).toContain('transform: none !important');
  });
});
