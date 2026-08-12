/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import MotionNumber from '../src/scorer/ScoringMotion';

afterEach(cleanup);

describe('shared scoring motion primitives', () => {
  test('the numeric token appears only when the value changes and carries direction', () => {
    const view = render(<MotionNumber value={12} />);
    const counter = () => view.container.querySelector('.qbsheet-motion-number') as HTMLElement;

    expect(counter().dataset.motionDirection).toBeUndefined();
    view.rerender(<MotionNumber value={12} />);
    expect(counter().dataset.motionDirection).toBeUndefined();
    view.rerender(<MotionNumber value={13} />);
    expect(counter()).toHaveAttribute('data-motion-direction', 'forward');
    expect(counter()).toHaveAttribute('data-previous-value', '12');
    view.rerender(<MotionNumber value={11} />);
    expect(counter()).toHaveAttribute('data-motion-direction', 'backward');
    expect(counter()).toHaveAttribute('data-previous-value', '13');
  });

  test('reduced motion explicitly removes every travel, scale, sweep, ring, and ghost layer', () => {
    const css = readFileSync('src/app/motion.css', 'utf8');
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));

    expect(reduced).toContain('.qbsheet-motion-number[data-motion-direction]::before');
    expect(reduced).toContain('.scorer-no-buzz-sweep');
    expect(reduced).toContain('.scorer-bonus-exit');
    expect(reduced).toContain('.scorer-conn.is-recovered .scorer-dot::after');
    expect(reduced).toContain('.scorer-rail-item.is-motion-ghost');
    expect(reduced).toContain('transform: none !important');
  });
});
