/**
 * @vitest-environment jsdom
 */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import motionCss from '../src/app/motion.css?raw';
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
    const reducedStart = motionCss.indexOf('@media (prefers-reduced-motion: reduce)');
    const blockStart = motionCss.indexOf('{', reducedStart);
    let depth = 0;
    let reducedEnd = motionCss.length;
    for (let index = blockStart; index < motionCss.length; index += 1) {
      if (motionCss[index] === '{') depth += 1;
      if (motionCss[index] !== '}') continue;
      depth -= 1;
      if (depth === 0) {
        reducedEnd = index + 1;
        break;
      }
    }
    const reduced = motionCss.slice(reducedStart, reducedEnd);

    expect(reduced).toContain('.qbsheet-motion-number[data-motion-direction]::before');
    expect(reduced).toContain('.scorer-no-buzz-sweep');
    expect(reduced).toContain('.scorer-bonus-exit');
    expect(reduced).toContain('.scorer-conn.is-recovered .scorer-dot::after');
    expect(reduced).toContain('.scorer-rail-item.is-motion-ghost');
    expect(reduced).toContain('transform: none !important');
  });
});