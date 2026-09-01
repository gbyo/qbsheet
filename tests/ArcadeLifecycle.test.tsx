/**
 * @vitest-environment jsdom
 */

/**
 * That nothing survives a closed arcade.
 *
 * This is the file the whole feature is justified by. A scoresheet is open on a Chromebook for a
 * whole tournament day, and a frame callback, a listener or a timer left behind by a dialog somebody
 * closed between rounds is a battery that does not last the afternoon and a fault nobody would ever
 * connect back to a game of Snake. So the animation frame is a fake here, and the tests below assert
 * the negative directly: after an unmount there is nothing scheduled, and running the frame queue
 * again does nothing at all.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import useArcadeLoop from '../src/arcade/useArcadeLoop';
import QBBird from '../src/arcade/QBBird';
import Snake from '../src/arcade/Snake';
import ArcadeDialog from '../src/arcade/ArcadeDialog';
import { stubArcadeCanvas } from './arcadeCanvas';

/**
 * The animation frame, under the test's control.
 *
 * Real frames never arrive in jsdom, and a loop that is only ever asserted to have *started* is a
 * loop nobody has checked stops. This queue can be run by hand, so "one more frame after unmount"
 * is a thing a test can actually try.
 */
function controllableFrames() {
  let nextId = 1;
  const pending = new Map<number, FrameRequestCallback>();
  const cancelled: number[] = [];

  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    const id = nextId;
    nextId += 1;
    pending.set(id, callback);
    return id;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    cancelled.push(id);
    pending.delete(id);
  });

  return {
    get outstanding(): number {
      return pending.size;
    },
    cancelled,
    /** Deliver one frame to everything waiting, letting each reschedule as it would in a browser. */
    run(now: number): void {
      const due = [...pending.values()];
      pending.clear();
      act(() => {
        due.forEach((callback) => callback(now));
      });
    },
  };
}

/** How many `visibilitychange` listeners the document is holding. */
function visibilityListeners(): { added: number; removed: number } {
  return { added: addedVisibility, removed: removedVisibility };
}

let addedVisibility = 0;
let removedVisibility = 0;

function countVisibilityListeners() {
  addedVisibility = 0;
  removedVisibility = 0;
  const add = document.addEventListener.bind(document);
  const remove = document.removeEventListener.bind(document);
  vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => {
    if (type === 'visibilitychange') addedVisibility += 1;
    add(type, listener, options);
  });
  vi.spyOn(document, 'removeEventListener').mockImplementation((type, listener, options) => {
    if (type === 'visibilitychange') removedVisibility += 1;
    remove(type, listener, options);
  });
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

beforeEach(() => {
  stubArcadeCanvas();
  countVisibilityListeners();
  setVisibility('visible');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Probe(props: { running: boolean; onStep: (seconds: number) => void; onHidden?: () => void }) {
  useArcadeLoop({ running: props.running, step: props.onStep, onHidden: props.onHidden });
  return null;
}

describe('the loop, on its own', () => {
  test('a loop that is not running schedules nothing and listens to nothing', () => {
    const frames = controllableFrames();
    const step = vi.fn();
    render(<Probe running={false} onStep={step} />);

    expect(frames.outstanding).toBe(0);
    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
    expect(visibilityListeners().added).toBe(0);
    expect(step).not.toHaveBeenCalled();
  });

  test('the first frame sets the clock and the second one advances the game', () => {
    const frames = controllableFrames();
    const step = vi.fn();
    render(<Probe running onStep={step} />);

    frames.run(1000);
    // Nothing is advanced by the frame that only established where time starts.
    expect(step).not.toHaveBeenCalled();

    frames.run(1016);
    expect(step).toHaveBeenCalledTimes(1);
    expect(step.mock.calls[0][0]).toBeCloseTo(0.016, 3);
  });

  test('a long stall is clamped rather than played through in one step', () => {
    const frames = controllableFrames();
    const step = vi.fn();
    render(<Probe running onStep={step} />);

    frames.run(1000);
    frames.run(31000);
    expect(step).toHaveBeenCalledTimes(1);
    // Two 60Hz frames at most, whatever the wall clock says. See `maxArcadeStepSeconds`.
    expect(step.mock.calls[0][0]).toBeLessThanOrEqual(1 / 30);
  });

  test('unmounting cancels the outstanding frame and removes the listener', () => {
    const frames = controllableFrames();
    const step = vi.fn();
    const view = render(<Probe running onStep={step} />);

    frames.run(1000);
    expect(frames.outstanding).toBe(1);

    view.unmount();

    expect(frames.outstanding).toBe(0);
    expect(frames.cancelled.length).toBeGreaterThan(0);
    expect(visibilityListeners().removed).toBe(visibilityListeners().added);

    // The whole point, stated directly: there is nothing left that another frame could run.
    frames.run(2000);
    expect(step).toHaveBeenCalledTimes(0);
  });

  test('stopping without unmounting also leaves nothing scheduled', () => {
    const frames = controllableFrames();
    const step = vi.fn();
    const view = render(<Probe running onStep={step} />);
    frames.run(1000);
    frames.run(1016);
    expect(step).toHaveBeenCalledTimes(1);

    view.rerender(<Probe running={false} onStep={step} />);

    expect(frames.outstanding).toBe(0);
    frames.run(2000);
    expect(step).toHaveBeenCalledTimes(1);
  });

  test('a hidden document stops the loop and says so', () => {
    const frames = controllableFrames();
    const step = vi.fn();
    const hidden = vi.fn();
    render(<Probe running onStep={step} onHidden={hidden} />);
    frames.run(1000);
    frames.run(1016);
    expect(step).toHaveBeenCalledTimes(1);

    setVisibility('hidden');

    expect(hidden).toHaveBeenCalledTimes(1);
    expect(frames.outstanding).toBe(0);
    frames.run(2000);
    expect(step).toHaveBeenCalledTimes(1);
  });

  test('coming back on screen resumes a loop nobody stopped, without playing the gap', () => {
    const frames = controllableFrames();
    const step = vi.fn();
    render(<Probe running onStep={step} />);
    frames.run(1000);
    setVisibility('hidden');
    expect(frames.outstanding).toBe(0);

    setVisibility('visible');
    expect(frames.outstanding).toBe(1);

    // The first frame back measures nothing, so a minute spent hidden is not a minute of falling.
    frames.run(61000);
    expect(step).not.toHaveBeenCalled();
    frames.run(61016);
    expect(step.mock.calls[0][0]).toBeCloseTo(0.016, 3);
  });
});

describe('QBBird', () => {
  test('nothing is scheduled until somebody starts it, and nothing survives the unmount', () => {
    const frames = controllableFrames();
    const view = render(<QBBird />);

    expect(frames.outstanding).toBe(0);
    expect(visibilityListeners().added).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(frames.outstanding).toBe(1);
    expect(visibilityListeners().added).toBe(1);

    frames.run(1000);
    frames.run(1016);
    expect(frames.outstanding).toBe(1);

    view.unmount();

    expect(frames.outstanding).toBe(0);
    expect(visibilityListeners().removed).toBe(1);
  });

  test('a hidden screen pauses the game rather than flying it into an obstacle', () => {
    const frames = controllableFrames();
    render(<QBBird />);
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    frames.run(1000);

    setVisibility('hidden');

    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument();
    expect(frames.outstanding).toBe(0);
  });
});

describe('Snake', () => {
  test('nothing is scheduled until somebody starts it, and nothing survives the unmount', () => {
    const frames = controllableFrames();
    const view = render(<Snake />);

    expect(frames.outstanding).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(frames.outstanding).toBe(1);
    expect(visibilityListeners().added).toBe(1);

    frames.run(1000);
    frames.run(1200);

    view.unmount();

    expect(frames.outstanding).toBe(0);
    expect(visibilityListeners().removed).toBe(1);
  });
});

describe('the dialog around them', () => {
  test('returning to the picker unmounts the game that was running', () => {
    const frames = controllableFrames();
    render(<ArcadeDialog onClose={() => undefined} />);

    fireEvent.click(screen.getByRole('button', { name: /QBBird/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(frames.outstanding).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Back to Arcade' }));

    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
    expect(frames.outstanding).toBe(0);
    expect(visibilityListeners().removed).toBe(visibilityListeners().added);
  });

  test('closing the arcade leaves no loop behind', () => {
    const frames = controllableFrames();
    const view = render(<ArcadeDialog onClose={() => undefined} />);

    fireEvent.click(screen.getByRole('button', { name: /Snake/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    frames.run(1000);
    expect(frames.outstanding).toBe(1);

    view.unmount();

    expect(frames.outstanding).toBe(0);
    expect(visibilityListeners().removed).toBe(visibilityListeners().added);
  });
});
