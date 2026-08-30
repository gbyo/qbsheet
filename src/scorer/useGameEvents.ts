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
import { IScorekeeperFormat } from '../scoring/ScorekeeperFormat';
import { IRoomProcedure } from '../scoring/RoomProcedure';
import { applyScoreEvents, ScoreEventEscape } from '../scoring/canApplyScoreEvent';
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
  /**
   * Take back the most recent action.
   *
   * @returns the events it removed, oldest first, or null if there was nothing to take back.
   *
   * The frame is returned so the screen can say what it just undid. It is feedback and nothing more:
   * the stack above is still the authority on what happened, this is a copy of what came off it, and
   * a caller that ignores it changes nothing. Nothing waits for whatever is done with it either —
   * the events are already gone by the time it is handed over.
   */
  undo: () => ScoreEvent[] | null;
  /**
   * Put back what undo took.
   *
   * @returns the events it restored, oldest first, or null if there was nothing to put back.
   */
  redo: () => ScoreEvent[] | null;
  /** Replace an event in place, for correcting an earlier question. */
  replace: (id: string, next: ScoreEvent) => void;
  /** Remove an event outright. */
  remove: (id: string) => void;
  /** Replace one question atomically after validating its complete proposed cycle. */
  replaceQuestion: (questionNumber: number, question: IEditableQuestion) => boolean;
  /** Replace the game from a verified recovery file. */
  restore: (restored: ScoreEvent[]) => void;
  /**
   * Replace the whole history with a corrected one, if it is coherent.
   *
   * For the corrections that are not about a single question and not about the game's definition —
   * striking out an overtime a protest has just made unnecessary is the one that exists. Validated
   * as a whole through `validateCorrectedHistory` rather than through `canApplyScoreEvent`, for the
   * reason `replaceQuestion` is: this is editing what happened, and no forward transition allows it.
   *
   * @returns whether it was accepted. `rejection` says why when it was not.
   */
  correctHistory: (next: ScoreEvent[]) => boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** False when the last write to local storage was refused, so nothing promises the game is safe. */
  saved: boolean;
  /** When this device last accepted a write of this game, or null if it never has. */
  savedAt: number | null;
  /** Why the last action was refused, if it was. Cleared by the next accepted one. */
  rejection: string;
  /**
   * The configured rule behind the refusal, when a setting caused it.
   *
   * The seam that lets a dead end become a door: the scorer renders one quiet secondary action
   * beside the refusal, and only for the refusals that name a rule somebody could have been told
   * wrong. See `ScoreEventEscape`.
   */
  rejectionEscape?: ScoreEventEscape;
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
  const [rejectionEscape, setRejectionEscape] = useState<ScoreEventEscape | undefined>(undefined);
  /** The authority. State follows it; it never follows state. See the note at the top of the file. */
  const current = useRef<ScoreEvent[]>(initialEvents);
  /** Sizes of the actions that can be undone, oldest first. */
  const undoStack = useRef<UndoFrame[]>([]);
  /** Events taken off by undo, newest action last, so redo can put them back. */
  const redoStack = useRef<ScoreEvent[][]>([]);
  /** Both halves of a refusal go together: an escape route with no refusal beside it is noise. */
  const clearRejectionState = useCallback(() => {
    setRejection('');
    setRejectionEscape(undefined);
  }, []);
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
        setRejectionEscape(result.escape);
        return false;
      }
      clearRejectionState();
      undoStack.current.push(added.length);
      redoStack.current = [];
      commit(result.events);
      return true;
    },
    [clearRejectionState, commit, format, procedure, setup],
  );

  const undo = useCallback(() => {
    const frame = undoStack.current.pop();
    if (frame === undefined) return null;
    const existing = current.current;
    const cut = Math.max(0, existing.length - frame);
    const removed = existing.slice(cut);
    redoStack.current.push(removed);
    clearRejectionState();
    commit(existing.slice(0, cut));
    return removed;
  }, [clearRejectionState, commit]);

  const redo = useCallback(() => {
    const frame = redoStack.current.pop();
    if (frame === undefined) return null;
    undoStack.current.push(frame.length);
    clearRejectionState();
    commit(current.current.concat(frame));
    return frame;
  }, [clearRejectionState, commit]);

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
      clearRejectionState();
      commit(current.current.map((event) => (event.id === id ? nextEvent : event)));
    },
    [clearRejectionState, commit],
  );

  const replaceQuestion = useCallback(
    (questionNumber: number, question: IEditableQuestion) => {
      const currentGame = deriveGame(format, setup, current.current);
      const questionErrors = validateEditableQuestion(format, currentGame, question);
      if (questionErrors.length > 0) {
        setRejection(questionErrors[0]);
        setRejectionEscape(undefined);
        return false;
      }
      const proposed = replaceQuestionEvents(
        current.current,
        questionNumber,
        eventsFromEditableQuestion(question),
      );
      const validation = validateCorrectedHistory(format, setup, proposed, procedure);
      if (validation.blockers.length > 0) {
        setRejection(validation.blockers[0].message);
        setRejectionEscape(undefined);
        return false;
      }
      undoStack.current = [];
      redoStack.current = [];
      clearRejectionState();
      commit(proposed);
      return true;
    },
    [clearRejectionState, commit, format, procedure, setup],
  );

  const remove = useCallback(
    (id: string) => {
      undoStack.current = [];
      redoStack.current = [];
      clearRejectionState();
      commit(current.current.filter((event) => event.id !== id));
    },
    [clearRejectionState, commit],
  );

  const correctHistory = useCallback(
    (next: ScoreEvent[]) => {
      const validation = validateCorrectedHistory(format, setup, next, procedure);
      if (validation.blockers.length > 0) {
        setRejection(validation.blockers[0].message);
        setRejectionEscape(undefined);
        return false;
      }
      undoStack.current = [];
      redoStack.current = [];
      clearRejectionState();
      commit(next.map((event) => ({ ...event })));
      return true;
    },
    [clearRejectionState, commit, format, procedure, setup],
  );

  const restore = useCallback(
    (restored: ScoreEvent[]) => {
      undoStack.current = [];
      redoStack.current = [];
      clearRejectionState();
      commit(restored.map((event) => ({ ...event })));
    },
    [clearRejectionState, commit],
  );

  const clearRejection = clearRejectionState;

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
      correctHistory,
      canUndo: history.canUndo,
      canRedo: history.canRedo,
      saved,
      savedAt,
      rejection,
      rejectionEscape,
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
      correctHistory,
      history,
      saved,
      savedAt,
      rejection,
      rejectionEscape,
      clearRejection,
    ],
  );
}
