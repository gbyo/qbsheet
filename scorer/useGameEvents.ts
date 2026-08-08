/**
 * The scorer's state: an event list, plus the ways a scorekeeper changes it.
 *
 * Undo is the reason this is a list and not a set of totals. Dropping the last event is exact — it
 * cannot leave a team's score and a player's answer counts disagreeing, because there is only one
 * copy of either. Redo is the same in reverse, and correcting question 6 is replacing one entry.
 *
 * # Why redo is discarded on a new action
 *
 * Standard undo-stack behaviour, and it matters more here than in a text editor. A scorekeeper who
 * undoes a mis-recorded buzz and then records the right one must not be able to reach forward and
 * re-apply the wrong one; the game would gain a buzz nobody made.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { ScoreEvent } from '../scoring/ScoreEvents';
import { IGameSetup } from '../scoring/deriveGame';
import { saveGame } from './GameSession';

export interface IGameEventsApi {
  events: ScoreEvent[];
  /** Record something new. Clears anything that had been undone. */
  append: (...added: ScoreEvent[]) => void;
  /** Take back the most recent action. */
  undo: () => void;
  /** Put back what undo took. */
  redo: () => void;
  /** Replace an event in place, for correcting an earlier question. */
  replace: (id: string, next: ScoreEvent) => void;
  /** Remove an event outright. */
  remove: (id: string) => void;
  /** Replace the game from a verified recovery file. */
  restore: (restored: ScoreEvent[]) => void;
  canUndo: boolean;
  canRedo: boolean;
  /** False when the last write to local storage was refused, so nothing promises the game is safe. */
  saved: boolean;
}

/**
 * How many events one action produced, newest first.
 *
 * Undo is per *action*, not per event, because some actions are more than one: recording a bonus on
 * a tossup that was converted in the same click is two events, and a scorekeeper pressing undo means
 * "take back what I just did", not "take back half of it".
 */
type UndoFrame = number;

let sequence = 0;

/** A fresh event id. Monotonic within a page; the game key is what makes it unique across devices. */
export function newEventId(): string {
  sequence += 1;
  return `ev-${sequence}-${Math.floor(performance.now() * 1000)}`;
}

export default function useGameEvents(
  gameKey: string,
  setup: IGameSetup,
  initialEvents: ScoreEvent[] = [],
): IGameEventsApi {
  const [events, setEvents] = useState<ScoreEvent[]>(initialEvents);
  const [saved, setSaved] = useState(true);
  /** Sizes of the actions that can be undone, oldest first. */
  const undoStack = useRef<UndoFrame[]>([]);
  /** Events taken off by undo, newest action last, so redo can put them back. */
  const redoStack = useRef<ScoreEvent[][]>([]);

  const persist = useCallback(
    (next: ScoreEvent[]) => {
      setSaved(saveGame(gameKey, setup, next));
    },
    [gameKey, setup],
  );

  const append = useCallback(
    (...added: ScoreEvent[]) => {
      if (added.length === 0) return;
      undoStack.current.push(added.length);
      redoStack.current = [];
      setEvents((current) => {
        const next = current.concat(added);
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const undo = useCallback(() => {
    const frame = undoStack.current.pop();
    if (frame === undefined) return;
    setEvents((current) => {
      const next = current.slice(0, Math.max(0, current.length - frame));
      redoStack.current.push(current.slice(Math.max(0, current.length - frame)));
      persist(next);
      return next;
    });
  }, [persist]);

  const redo = useCallback(() => {
    const frame = redoStack.current.pop();
    if (frame === undefined) return;
    undoStack.current.push(frame.length);
    setEvents((current) => {
      const next = current.concat(frame);
      persist(next);
      return next;
    });
  }, [persist]);

  /**
   * Editing an earlier question is not undoable in the same sense — there is no "before" to step
   * back to that would make sense after later questions have been scored — so it clears both stacks
   * rather than pretending otherwise.
   */
  const replace = useCallback(
    (id: string, nextEvent: ScoreEvent) => {
      undoStack.current = [];
      redoStack.current = [];
      setEvents((current) => {
        const next = current.map((event) => (event.id === id ? nextEvent : event));
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const remove = useCallback(
    (id: string) => {
      undoStack.current = [];
      redoStack.current = [];
      setEvents((current) => {
        const next = current.filter((event) => event.id !== id);
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const restore = useCallback(
    (restored: ScoreEvent[]) => {
      undoStack.current = [];
      redoStack.current = [];
      const next = restored.map((event) => ({ ...event }));
      setEvents(next);
      persist(next);
    },
    [persist],
  );

  return useMemo(
    () => ({
      events,
      append,
      undo,
      redo,
      replace,
      remove,
      restore,
      canUndo: undoStack.current.length > 0,
      canRedo: redoStack.current.length > 0,
      saved,
    }),
    [events, append, undo, redo, replace, remove, restore, saved],
  );
}
