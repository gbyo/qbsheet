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

  /**
   * The bonus, whose motion is now progress through a list rather than a panel changing sides.
   *
   * Two things are checked because both are load-bearing. The travel has to be behind
   * `no-preference`, so a scorekeeper who has asked for no motion gets none. And the state — which
   * part is active, which outcome was chosen — has to live outside every motion query, because with
   * the animation removed that state is the only thing left saying where the bonus has got to.
   */
  test('the part cues animate only by preference, while the state they describe is unconditional', () => {
    const css = readFileSync(new URL('../src/app/motion.css', String(import.meta.url)), 'utf8');
    const preferred = css.slice(
      css.indexOf('.scorer-choice.is-part-recorded'),
      css.indexOf('.scorer-clock-digits {'),
    );

    // Every animation and transition on the part rows is inside the no-preference block.
    const noPreference = preferred.slice(preferred.indexOf('@media (prefers-reduced-motion: no-preference)'));
    expect(noPreference).toContain('.scorer-part-row.is-part-set');
    expect(noPreference).toContain('transition:');
    expect(preferred.indexOf('.scorer-part-row.is-part-set')).toBeGreaterThan(
      preferred.indexOf('@media (prefers-reduced-motion: no-preference)'),
    );

    /*
     * Nothing about the bonus panel travels.
     *
     * Emphasis moving down the parts is a change of weight and rule, never a change of position:
     * the row a finger is already on its way to must not shift under it, and a few pixels of rise
     * three times a bonus is a tic somebody at this table all day would come to feel.
     */
    expect(preferred).not.toContain('translate');

    // The state itself is plain layout, in the procedure sheet, under no motion query at all.
    const procedure = readFileSync(
      new URL('../src/scorer/scorer-procedure.css', String(import.meta.url)),
      'utf8',
    );
    const bonusRegion = procedure.slice(
      procedure.indexOf('/*\n * The live bonus, part by part.'),
      procedure.indexOf('/* #endregion */', procedure.indexOf('.scorer-bonus-typed input')),
    );
    expect(bonusRegion).not.toContain('prefers-reduced-motion');
    for (const rule of [
      '.scorer-part-row.is-active {',
      '.scorer-part-row .scorer-choice.is-selected',
      '.scorer-part-row:not(.is-active):not(.is-answered) .scorer-choice:not(.is-selected) {',
    ]) {
      expect(bonusRegion).toContain(rule);
    }
  });

  /**
   * The handoff is gone, and so is the motion that described it.
   *
   * Keeping an animation with no caller is keeping a claim about how the screen behaves that is no
   * longer true, and the next person to read this file would have to work out which of two bonus
   * metaphors it belongs to.
   */
  test('no bounceback-handoff animation survives the flow that used it', () => {
    const css = readFileSync(new URL('../src/app/motion.css', String(import.meta.url)), 'utf8');

    for (const dead of [
      'scorer-bounceback-handoff',
      'qbsheet-bounce-in-left',
      'qbsheet-bounce-out-left',
      'qbsheet-bounce-in-right',
      'qbsheet-bounce-out-right',
      '.scorer-prompt-content.is-outgoing',
    ]) {
      expect(css).not.toContain(dead);
    }
  });
});
