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
 *
 * # Why the list lives in a ref as well as in state
 *
 * Because `append` has to see what the last `append` did, and React state does not work that way
 * inside one event loop turn. Two clicks fifty milliseconds apart both run against the render that
 * was on screen when the first one started; both read the same `events`, both pass the same checks,
 * and the game gains an answer nobody gave. The ref is the authority and the state is what renders
 * from it, so every append is judged against everything already recorded.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { ScoreEvent } from '../scoring/ScoreEvents';
import deriveGame, { IGameSetup } from '../scoring/deriveGame';
import { IScorekeeperFormat } from '../../renderer/Services/ScorekeeperFormat';
import { IRoomProcedure } from '../../renderer/Services/RoomProcedure';
import { applyScoreEvents } from '../scoring/canApplyScoreEvent';
import {
  IEditableQuestion,
  eventsFromEditableQuestion,
  replaceQuestionEvents,
  validateEditableQuestion,
} from '../scoring/questionCorrection';
import { validateCorrectedHistory } from '../scoring/validateScoresheet';
import { saveGame } from './GameSession';

export interface IGameEventsApi {
  events: ScoreEvent[];
  /**
   * Record something new. Clears anything that had been undone.
   *
   * All of the events or none of them, and nothing at all if the engine says the transition is
   * impossible — in which case `rejection` says why.
   *
   * @returns whether it was accepted
   */
  append: (...added: ScoreEvent[]) => boolean;
  /** Take back the most recent action. */
  undo: () => void;
  /** Put back what undo took. */
  redo: () => void;
  /** Replace an event in place, for correcting an earlier question. */
  replace: (id: string, next: ScoreEvent) => void;
  /** Remove an event outright. */
  remove: (id: string) => void;
  /** Replace one question atomically after validating its complete proposed cycle. */
  replaceQuestion: (questionNumber: number, question: IEditableQuestion) => boolean;
  /** Replace the game from a verified recovery file. */
  restore: (restored: ScoreEvent[]) => void;
  canUndo: boolean;
  canRedo: boolean;
  /** False when the last write to local storage was refused, so nothing promises the game is safe. */
  saved: boolean;
  /** When this device last accepted a write of this game, or null if it never has. */
  savedAt: number | null;
  /** Why the last action was refused, if it was. Cleared by the next accepted one. */
  rejection: string;
  clearRejection: () => void;
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
  format: IScorekeeperFormat,
  setup: IGameSetup,
  initialEvents: ScoreEvent[] = [],
  procedure: IRoomProcedure | undefined = undefined,
): IGameEventsApi {
  const [events, setEvents] = useState<ScoreEvent[]>(initialEvents);
  const [saved, setSaved] = useState(true);
  /**
   * When local storage last accepted this game.
   *
   * Kept so the connection detail can say "saved just now" as a fact rather than as a reassurance:
   * a scorekeeper deciding whether it is safe to reload deserves a timestamp we can prove.
   */
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [history, setHistory] = useState({ canUndo: false, canRedo: false });
  const [rejection, setRejection] = useState('');
  /** The authority. State follows it; it never follows state. See the note at the top of the file. */
  const current = useRef<ScoreEvent[]>(initialEvents);
  /** Sizes of the actions that can be undone, oldest first. */
  const undoStack = useRef<UndoFrame[]>([]);
  /** Events taken off by undo, newest action last, so redo can put them back. */
  const redoStack = useRef<ScoreEvent[][]>([]);
  const syncHistory = useCallback(() => {
    setHistory({ canUndo: undoStack.current.length > 0, canRedo: redoStack.current.length > 0 });
  }, []);

  const commit = useCallback(
    (next: ScoreEvent[]) => {
      current.current = next;
      setEvents(next);
      const written = saveGame(gameKey, setup, next);
      setSaved(written);
      if (written) setSavedAt(Date.now());
      syncHistory();
    },
    [gameKey, setup, syncHistory],
  );

  const append = useCallback(
    (...added: ScoreEvent[]) => {
      if (added.length === 0) return true;
      const result = applyScoreEvents({ format, setup, procedure }, current.current, added);
      if (!result.ok) {
        setRejection(result.reason);
        return false;
      }
      setRejection('');
      undoStack.current.push(added.length);
      redoStack.current = [];
      commit(result.events);
      return true;
    },
    [commit, format, procedure, setup],
  );

  const undo = useCallback(() => {
    const frame = undoStack.current.pop();
    if (frame === undefined) return;
    const existing = current.current;
    const cut = Math.max(0, existing.length - frame);
    redoStack.current.push(existing.slice(cut));
    setRejection('');
    commit(existing.slice(0, cut));
  }, [commit]);

  const redo = useCallback(() => {
    const frame = redoStack.current.pop();
    if (frame === undefined) return;
    undoStack.current.push(frame.length);
    setRejection('');
    commit(current.current.concat(frame));
  }, [commit]);

  /**
   * Editing an earlier question is not undoable in the same sense — there is no "before" to step
   * back to that would make sense after later questions have been scored — so it clears both stacks
   * rather than pretending otherwise.
   *
   * Corrections are not put through `canApplyScoreEvent`. That function says what could happen next
   * in a game being played forwards, and a correction is explicitly not that: fixing question six
   * after question twenty has been scored is a legitimate act that no forward transition allows.
   */
  const replace = useCallback(
    (id: string, nextEvent: ScoreEvent) => {
      undoStack.current = [];
      redoStack.current = [];
      setRejection('');
      commit(current.current.map((event) => (event.id === id ? nextEvent : event)));
    },
    [commit],
  );

  const replaceQuestion = useCallback(
    (questionNumber: number, question: IEditableQuestion) => {
      const currentGame = deriveGame(format, setup, current.current);
      const questionErrors = validateEditableQuestion(format, currentGame, question);
      if (questionErrors.length > 0) {
        setRejection(questionErrors[0]);
        return false;
      }
      const proposed = replaceQuestionEvents(current.current, questionNumber, eventsFromEditableQuestion(question));
      const validation = validateCorrectedHistory(format, setup, proposed, procedure);
      if (validation.blockers.length > 0) {
        setRejection(validation.blockers[0].message);
        return false;
      }
      undoStack.current = [];
      redoStack.current = [];
      setRejection('');
      commit(proposed);
      return true;
    },
    [commit, format, procedure, setup],
  );

  const remove = useCallback(
    (id: string) => {
      undoStack.current = [];
      redoStack.current = [];
      setRejection('');
      commit(current.current.filter((event) => event.id !== id));
    },
    [commit],
  );

  const restore = useCallback(
    (restored: ScoreEvent[]) => {
      undoStack.current = [];
      redoStack.current = [];
      setRejection('');
      commit(restored.map((event) => ({ ...event })));
    },
    [commit],
  );

  const clearRejection = useCallback(() => setRejection(''), []);

  return useMemo(
    () => ({
      events,
      append,
      undo,
      redo,
      replace,
      remove,
      replaceQuestion,
      restore,
      canUndo: history.canUndo,
      canRedo: history.canRedo,
      saved,
      savedAt,
      rejection,
      clearRejection,
    }),
    [
      events,
      append,
      undo,
      redo,
      replace,
      remove,
      replaceQuestion,
      restore,
      history,
      saved,
      savedAt,
      rejection,
      clearRejection,
    ],
  );
}
