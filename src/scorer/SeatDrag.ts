/**
 * Dragging a player into the chair they are actually sitting in.
 *
 * # Why this is a drag and not a pair of arrows
 *
 * The table exists because a scorekeeper watching a room thinks in positions: "Maycie is sitting
 * second, the screen has her third." The repair for that thought is to move her — one gesture,
 * ending where she belongs. Expressed as arrows it becomes arithmetic: work out the distance, press
 * that many times, check. The arrows are still here for anybody who cannot drag (see the fallback in
 * `TableView`), but they are the second answer now rather than the only one.
 *
 * This is still not a floor plan. There are two fixed tables and one linear order along each of
 * them; what a drag changes is a player's place in that order, and nothing else in this view can be
 * moved at all.
 *
 * # Pointer events, not the HTML5 drag API
 *
 * `draggable` gives a desktop mouse a reasonable time and everybody else a bad one: no touch support
 * without a polyfill, a drag image nobody asked for, and a Chromebook trackpad that reports its
 * gestures perfectly well as pointer events. This listens to pointers, so a finger, a stylus, a
 * trackpad and a mouse are one code path.
 *
 * # Why the DOM does not reorder until the drop
 *
 * The seats are laid out in one row of equal columns, so "everybody between here and there steps
 * aside by exactly one seat" is a transform on each of them and needs no relayout. Reordering the
 * elements under the pointer instead would make the browser recompute the strip on every frame of
 * every drag, and would fight the pointer capture that keeps the gesture alive. So the preview is
 * transforms; the order changes once, when the drop resolves and the real seating preference is
 * written.
 *
 * That is also why nothing here is persisted per frame: a drag is a question, and only the drop is
 * an answer.
 */
import { PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from 'react';

/**
 * How far a pointer travels before this is a drag rather than a press.
 *
 * Large enough that a thumb resting on a tile does not shove it sideways, small enough that a
 * deliberate move starts where the hand expects. It also leaves a horizontal scroll flick on a
 * crowded table to the strip: below the threshold nothing has been claimed.
 */
export const seatDragThresholdPx = 6;

export interface ISeatDragState {
  /** Where the dragged player started. */
  from: number;
  /** Where they would land if the pointer were lifted now. */
  to: number;
  /** How far the dragged tile has been carried, for the transform that follows the pointer. */
  deltaX: number;
  /** One seat's worth of travel, so everybody stepping aside steps aside by exactly one. */
  pitch: number;
}

/**
 * Which seat a carried tile has reached.
 *
 * Rounding rather than a midpoint scan: the seats are equal columns, so the distance travelled is
 * the number of seats crossed, and half a seat of travel is the point at which the eye already reads
 * the tile as belonging to the next one.
 */
export function seatDropIndex(from: number, deltaX: number, pitch: number, count: number): number {
  if (count <= 1 || pitch <= 0) return from;
  const moved = Math.round(deltaX / pitch);
  return Math.min(count - 1, Math.max(0, from + moved));
}

/**
 * How far the seat at `index` has to step aside, in whole seats.
 *
 * Everybody between the seat a player left and the seat they are over closes up behind them; nobody
 * else moves at all. Negative is towards the head of the table, matching `translateX`.
 */
export function seatShift(index: number, from: number, to: number): -1 | 0 | 1 {
  if (index === from) return 0;
  if (from < to && index > from && index <= to) return -1;
  if (to < from && index >= to && index < from) return 1;
  return 0;
}

/**
 * The number a seat is showing while a drag is in flight.
 *
 * Positional, as it is the rest of the time: the number says where on the table this is, so during a
 * preview it has to say where on the table this *would* be. One-based, like the seats themselves.
 */
export function previewSeatNumber(index: number, drag: ISeatDragState | null): number {
  if (!drag) return index + 1;
  if (index === drag.from) return drag.to + 1;
  return index + seatShift(index, drag.from, drag.to) + 1;
}

export interface ISeatDragApi {
  /** The drag in flight, or null. Everything the strip draws during one comes from here. */
  drag: ISeatDragState | null;
  /** Attach to each seat, in the order they are drawn, so the pitch can be measured. */
  seatRef: (index: number) => (element: HTMLElement | null) => void;
  /** Attach to the seat's drag handle. */
  onPointerDown: (index: number) => (event: ReactPointerEvent<HTMLElement>) => void;
}

/**
 * The gesture, as state the strip can render.
 *
 * `onDrop` is called once, with the two positions, and only when they differ. Everything else — an
 * abandoned drag, Escape, a cancelled pointer, a gesture that never passed the threshold — resolves
 * to nothing at all, which is what makes a cancelled drag leave the stored order untouched.
 */
export function useSeatDrag(count: number, onDrop: (from: number, to: number) => void): ISeatDragApi {
  const seats = useRef<Array<HTMLElement | null>>([]);
  const refs = useRef(new Map<number, (element: HTMLElement | null) => void>());
  /** The press that may become a drag: recorded on pointerdown, promoted once it travels far enough. */
  const pending = useRef<{ pointerId: number; startX: number; from: number } | null>(null);
  const [drag, setDrag] = useState<ISeatDragState | null>(null);
  /**
   * The same drag, for the window listeners.
   *
   * They are attached once and would otherwise close over whatever `drag` was when they were built.
   * Written beside every `setDrag` rather than synced from a render, so the two never disagree
   * within one gesture.
   */
  const live = useRef<ISeatDragState | null>(null);
  const onDropRef = useRef(onDrop);
  useEffect(() => {
    onDropRef.current = onDrop;
  }, [onDrop]);

  const clear = useCallback(() => {
    pending.current = null;
    live.current = null;
    setDrag(null);
  }, []);

  /** One seat's width including the gap, measured from the seats themselves rather than assumed. */
  const measurePitch = useCallback((): number => {
    const boxes = seats.current.filter((seat): seat is HTMLElement => seat !== null);
    if (boxes.length < 2) return boxes[0]?.getBoundingClientRect().width ?? 0;
    const first = boxes[0].getBoundingClientRect();
    const second = boxes[1].getBoundingClientRect();
    return Math.abs(second.left - first.left) || first.width;
  }, []);

  const onPointerDown = useCallback(
    (index: number) => (event: ReactPointerEvent<HTMLElement>) => {
      // A secondary button is a context menu, and one seat has nowhere to be dragged to.
      if (event.button !== 0 || count < 2) return;
      pending.current = { pointerId: event.pointerId, startX: event.clientX, from: index };
      // Keeps the gesture alive when the pointer leaves the tile, which it does immediately.
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    [count],
  );

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const waiting = pending.current;
      if (!waiting || event.pointerId !== waiting.pointerId) return;
      const deltaX = event.clientX - waiting.startX;
      const started = live.current;
      if (!started) {
        // Below the threshold this is still a press, and a horizontal flick still belongs to the
        // strip's own scrolling.
        if (Math.abs(deltaX) < seatDragThresholdPx) return;
        const pitch = measurePitch();
        if (pitch <= 0) return;
        // The seat this has already reached, not the seat it left: a pointer can cross the threshold
        // and a seat boundary in one report, and a first frame that ignored the distance would draw
        // the gesture a seat behind the finger making it.
        const next = {
          from: waiting.from,
          to: seatDropIndex(waiting.from, deltaX, pitch, count),
          deltaX,
          pitch,
        };
        live.current = next;
        setDrag(next);
        return;
      }
      const next = {
        ...started,
        deltaX,
        to: seatDropIndex(started.from, deltaX, started.pitch, count),
      };
      live.current = next;
      setDrag(next);
    };

    const onPointerUp = (event: PointerEvent) => {
      const waiting = pending.current;
      if (!waiting || event.pointerId !== waiting.pointerId) return;
      const finished = live.current;
      clear();
      // A press that never travelled is not a drop, and a drop where it started changes nothing. A
      // lineup change during the gesture leaves a stale index behind; the caller reorders the names
      // it is actually showing, so an index that no longer addresses anybody reorders nothing.
      if (finished && finished.to !== finished.from) onDropRef.current(finished.from, finished.to);
    };

    const onPointerCancel = () => clear();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || live.current === null) return;
      // The order goes back to what it was, because nothing has been written yet.
      event.preventDefault();
      clear();
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [clear, count, measurePitch]);

  const seatRef = useCallback((index: number) => {
    const existing = refs.current.get(index);
    if (existing) return existing;
    const ref = (element: HTMLElement | null) => {
      seats.current[index] = element;
    };
    refs.current.set(index, ref);
    return ref;
  }, []);

  return { drag, seatRef, onPointerDown };
}
