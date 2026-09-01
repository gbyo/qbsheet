/**
 * Showing a lineup change instead of just performing one.
 *
 * # Why a row has to move
 *
 * The starting lineup is a numbered list, and the numbers are load-bearing: seat 3 is the key the
 * scorekeeper presses and the row the tossups-heard count is kept in. So a reorder is a structural
 * change to something the room has already memorised, and when two rows swap in a single frame there
 * is nothing on screen that says which of them the scorekeeper actually moved. They pressed an arrow,
 * two names changed places, and the only way to check the press did what they meant is to read both
 * names again. That is a cost per press, and it is paid in the ninety seconds before question one when
 * there is least time to pay it.
 *
 * Moving the row answers it without a word: the thing that slid is the thing that moved, and where it
 * stopped is where it now is.
 *
 * # Why this is FLIP and not an ordering of its own
 *
 * The lineup state is the truth and it changes immediately — `onMove` is not delayed, debounced, or
 * held back until an animation finishes. What happens here is only the interpolation between the
 * layout React just replaced and the layout React just committed: measure where the rows were, let
 * the real update land, measure where they are now, put them back where they were with a transform,
 * and release it. At every point in that sequence the DOM says the correct seat order, which matters
 * because a scorekeeper who presses Start game mid-animation must get the lineup they can see.
 *
 * Rows are keyed by player name rather than by seat, which is what lets the same mechanism carry a
 * player between Starting and Bench: the name is on exactly one row at a time, so a player who leaves
 * the bench for seat 3 is one key whose position changed a long way, and everybody who closed up
 * behind them is a key whose position changed a little.
 *
 * # Why the measurement is visual rather than settled
 *
 * `getBoundingClientRect` reports where a row *appears*, transform included. A scorekeeper pressing
 * the arrow twice in half a second interrupts a transition that is still running, and starting the
 * new animation from the row's painted position is what makes the second press continue the first
 * instead of jumping back to re-run it. The settled positions are read only after the in-flight
 * transforms have been cleared, so the two halves of the subtraction are never mixed up.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/** How long a row takes to travel. Short enough to be over before the next press, long enough to see. */
export const lineupMoveMs = 200;

/** How long the moved row keeps its background after it arrives, before fading back. */
export const lineupSettleMs = 250;

/** On the rows currently travelling. Carries the transform transition. */
export const lineupMovingClass = 'is-moving';

/** On the one row the scorekeeper asked for. Carries the background emphasis. */
export const lineupMovedClass = 'is-moved';

/** A sub-pixel difference is rounding, not a move, and animating it only costs a paint. */
const smallestVisibleShift = 1;

/**
 * How far each row has to be pushed back to appear not to have moved yet.
 *
 * Positive is towards the end of the axis, matching the transform the caller applies. A name in only
 * one of the two measurements is a row that appeared or disappeared rather than moved, and has no
 * previous position to travel from.
 */
export function rowShifts(
  before: ReadonlyMap<string, number>,
  after: ReadonlyMap<string, number>,
): Map<string, number> {
  const shifts = new Map<string, number>();
  for (const [name, top] of after) {
    const was = before.get(name);
    if (was === undefined) continue;
    const shift = was - top;
    if (Math.abs(shift) >= smallestVisibleShift) shifts.set(name, shift);
  }
  return shifts;
}

/**
 * Whether this device has asked not to be moved around.
 *
 * Read at the moment of the move rather than once at mount, because the preference can be changed
 * while the prompt is open and the answer is only ever needed here.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    // A browser that cannot answer gets the animation; a broken media query is not a reason to
    // withhold the only cue that says what just moved.
    return false;
  }
}

/**
 * Which way the rows are laid out.
 *
 * A lineup is a list and moves vertically; a table is a row of seats and moves horizontally. The
 * mechanism is identical either way, and it is the same mechanism deliberately — a seat travelling
 * across the table means what a row travelling down the list means, and two implementations of one
 * idea would be free to disagree about its timing.
 */
export type LineupAxis = 'x' | 'y';

export interface ILineupMotion {
  /** Attach to each animatable row. Same key across a reorder, so the row can be recognised. */
  rowRef: (name: string) => (element: HTMLElement | null) => void;
  /** The class name for a row, given the player it is showing. */
  rowClassName: (name: string, base: string) => string;
  /** Call in the click handler, immediately before the lineup state is changed. */
  beginMove: (name: string) => void;
}

function measure(rows: ReadonlyMap<string, HTMLElement>, axis: LineupAxis): Map<string, number> {
  const positions = new Map<string, number>();
  for (const [name, element] of rows) {
    if (!element.isConnected) continue;
    const box = element.getBoundingClientRect();
    positions.set(name, axis === 'x' ? box.left : box.top);
  }
  return positions;
}

export function useLineupMotion(options: { axis?: LineupAxis } = {}): ILineupMotion {
  const axis = options.axis ?? 'y';
  const rows = useRef(new Map<string, HTMLElement>());
  const refs = useRef(new Map<string, (element: HTMLElement | null) => void>());
  const before = useRef<Map<string, number> | null>(null);
  const travelling = useRef(new Map<HTMLElement, number>());
  const settle = useRef<number | undefined>(undefined);
  const [moved, setMoved] = useState<string | null>(null);

  /**
   * Put every travelling row back under the layout's control.
   *
   * Called before the new positions are read, so that what gets measured is where the rows have been
   * laid out and not where a half-finished transition happens to be painting them.
   */
  const settleTravelling = useCallback(() => {
    for (const [element, timer] of travelling.current) {
      window.clearTimeout(timer);
      element.classList.remove(lineupMovingClass);
      element.style.transform = '';
      element.style.transition = '';
    }
    travelling.current.clear();
  }, []);

  const travel = useCallback(
    (element: HTMLElement, shift: number) => {
      // Offset first with transitions off, so the row is painted where it used to be rather than
      // sliding to where it used to be.
      element.style.transition = 'none';
      element.style.transform = axis === 'x' ? `translateX(${shift}px)` : `translateY(${shift}px)`;
      // Reading a layout property is what makes the offset a starting point rather than a no-op the
      // browser coalesces with the release below.
      void element.offsetHeight;
      element.classList.add(lineupMovingClass);
      element.style.transition = '';
      element.style.transform = '';
      travelling.current.set(
        element,
        window.setTimeout(() => {
          travelling.current.delete(element);
          element.classList.remove(lineupMovingClass);
        }, lineupMoveMs),
      );
    },
    [axis],
  );

  const beginMove = useCallback(
    (name: string) => {
      // The painted positions, transforms and all: an interrupted move continues from where the eye
      // last saw the row rather than from where it was going.
      before.current = measure(rows.current, axis);
      setMoved(name);
      window.clearTimeout(settle.current);
      settle.current = window.setTimeout(() => setMoved(null), lineupMoveMs + lineupSettleMs);
    },
    [axis],
  );

  useLayoutEffect(() => {
    const previous = before.current;
    before.current = null;
    if (!previous) return;
    if (prefersReducedMotion()) {
      settleTravelling();
      return;
    }
    settleTravelling();
    for (const [name, shift] of rowShifts(previous, measure(rows.current, axis))) {
      const element = rows.current.get(name);
      if (element) travel(element, shift);
    }
  });

  useEffect(
    () => () => {
      window.clearTimeout(settle.current);
      for (const timer of travelling.current.values()) window.clearTimeout(timer);
      travelling.current.clear();
    },
    [],
  );

  const rowRef = useCallback((name: string) => {
    const existing = refs.current.get(name);
    if (existing) return existing;
    const ref = (element: HTMLElement | null) => {
      if (element) {
        rows.current.set(name, element);
        return;
      }
      // A player crossing between Starting and Bench is one name on two different rows, and React is
      // free to attach the new one before detaching the old. Dropping the entry only when what is
      // stored has actually left the document keeps the name pointing at the row it is really on.
      const stored = rows.current.get(name);
      if (stored && !stored.isConnected) rows.current.delete(name);
    };
    refs.current.set(name, ref);
    return ref;
  }, []);

  const rowClassName = useCallback(
    (name: string, base: string) => (name === moved ? `${base} ${lineupMovedClass}` : base),
    [moved],
  );

  return { rowRef, rowClassName, beginMove };
}
