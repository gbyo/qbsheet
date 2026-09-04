/**
 * The one keyboard listener the scoresheet has.
 *
 * Tossup scoring is a two-key sequence: a number chooses the seat and C/P/N/0 chooses the ruling.
 * Keeping the pending seat here means the listener can apply the same focus, dialog, eligibility,
 * repeat, and format guards to both halves of the sequence. Space and undo remain available exactly
 * as before, including while the opt-in seat layer is off.
 */
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { LeftOrRight } from '../scoring/types';
import { IScorekeeperAnswerType, IScorekeeperFormat } from '../scoring/ScorekeeperFormat';
import {
  actionForKey,
  activationKeyBelongsToControl,
  KeyboardAction,
  keystrokeBelongsToControl,
  numberForCode,
  rulingForAction,
  seatForNumber,
} from './KeyboardScoring';

export interface IScorerKeyboardInput {
  /** The seat/action layer, off unless the scorekeeper asked for it. Space and undo work regardless. */
  keyboardEnabled: boolean;
  format: IScorekeeperFormat;
  /** True only while a tossup is live and not blocked. Nothing scores otherwise. */
  scoringEnabled: boolean;
  /** Whether a neg is legal for the selected side on this tossup. The buttons use the same query. */
  negsAvailable: (side: LeftOrRight) => boolean;
  /** Whether this side may still answer. A key aimed at an ineligible team does nothing. */
  eligible: (side: LeftOrRight) => boolean;
  /** Who is in each seat right now, in the room's own order. */
  seatedPlayers: Record<LeftOrRight, readonly string[]>;
  /** True while any of the scorer's own dialogs is open. */
  dialogOpen: boolean;
  /** True when a tossup may be recorded as unanswered. Preserves the existing Space behaviour. */
  noBuzzAllowed: boolean;
  /**
   * Identity of the visible seat layout. A pending seat belongs to one layout and must not survive
   * a presentation-only reordering (for example, swapping the teams on screen).
   */
  seatLayoutKey?: string;
  onBuzz: (side: LeftOrRight, playerName: string, answerType: IScorekeeperAnswerType) => void;
  /** Record a wrong answer that costs nothing and still uses the player's chance. */
  onWrongNoPenalty: (side: LeftOrRight, playerName: string) => void;
  onNoBuzz: () => void;
  onUndo: () => void;
  onRedo: () => void;
  /** Optional hidden command surface; shares every typing/dialog guard above. */
  onCommands?: () => void;
  /**
   * A seat is chosen and the sequence is waiting on its action key.
   *
   * Reported because half a sequence is a state a scorekeeper can be in and cannot otherwise see. The
   * number they pressed and the person it addresses are both here: confirming the seat is the whole
   * point, and a seat number read back on its own only confirms that the key arrived.
   */
  onSeatArmed?: (seat: IPendingSeat) => void;
  /** The waiting seat went away without scoring — it timed out, was abandoned, or the tossup ended. */
  onSequenceCleared?: () => void;
  /**
   * Say what just landed, so the affected seat can be flashed and the sequence read back.
   *
   * The ruling travels as the format's own answer type rather than as a rendered string, so callers
   * name it however they display it and this file keeps its promise not to know what a tossup is
   * worth. Null for the no-penalty wrong answer, which resolves to no ruling at all.
   */
  onEcho?: (
    echo: IPendingSeat & { action: KeyboardAction; answerType: IScorekeeperAnswerType | null },
  ) => void;
}

export interface IPendingSeat {
  side: LeftOrRight;
  seat: number;
  number: number;
  playerName: string;
}

const pendingSeatLifetimeMs = 2000;

export default function useScorerKeyboard(input: IScorerKeyboardInput): void {
  /**
   * The live inputs, in a ref. The listener is attached once and reads through this, rather than being
   * torn down and rebuilt on every render. A scoresheet re-renders on every ruling, and a sequence must
   * remain coherent across those renders.
   */
  const latest = useRef(input);
  useLayoutEffect(() => {
    latest.current = input;
  }, [input]);

  const pending = useRef<IPendingSeat | null>(null);
  const pendingTimer = useRef<number | null>(null);

  /**
   * Drop a half-finished sequence.
   *
   * Announced by default, because a waiting seat that disappears is exactly the thing a scorekeeper
   * has to be told about. Silent when something is taking its place in the same keystroke — a new
   * seat or a ruling — so the readout is never told to clear and then immediately told what to say.
   *
   * Stable, so both the listener and the guard below clear a sequence the same way.
   */
  const clearPending = useCallback((announce = true) => {
    const wasArmed = pending.current !== null;
    pending.current = null;
    if (pendingTimer.current !== null) window.clearTimeout(pendingTimer.current);
    pendingTimer.current = null;
    if (wasArmed && announce) latest.current.onSequenceCleared?.();
  }, []);

  useEffect(() => {
    if (input.dialogOpen || !input.scoringEnabled || !input.keyboardEnabled) clearPending();
  }, [input.dialogOpen, input.scoringEnabled, input.keyboardEnabled, clearPending]);

  useLayoutEffect(() => {
    clearPending();
  }, [input.seatLayoutKey, clearPending]);

  useEffect(() => {
    const armPending = (seat: IPendingSeat) => {
      clearPending(false);
      pending.current = seat;
      pendingTimer.current = window.setTimeout(clearPending, pendingSeatLifetimeMs);
      latest.current.onSeatArmed?.(seat);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const current = latest.current;

      // A held key. The browser repeats it, and a resting finger must not record multiple actions.
      if (event.repeat || event.isComposing || event.defaultPrevented) return;
      if (keystrokeBelongsToControl(event)) {
        clearPending();
        return;
      }

      if (
        event.key === '?' &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !current.dialogOpen &&
        current.onCommands
      ) {
        clearPending();
        event.preventDefault();
        current.onCommands();
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && !current.dialogOpen) {
        clearPending();
        event.preventDefault();
        if (event.shiftKey) current.onRedo();
        else current.onUndo();
        return;
      }

      // Space records an unanswered tossup. With focus on a button, Space is that button and must not
      // be stolen. This shortcut is independent of the opt-in seat/action layer.
      if (event.key === ' ') {
        clearPending();
        if (activationKeyBelongsToControl(event)) return;
        if (current.dialogOpen || !current.noBuzzAllowed) return;
        event.preventDefault();
        current.onNoBuzz();
        return;
      }

      if (!current.keyboardEnabled || current.dialogOpen || !current.scoringEnabled) {
        clearPending();
        return;
      }

      // Modifier chords are not part of the sequence. Leave browser/OS shortcuts alone and avoid
      // turning a shifted action into an accidental uppercase variant.
      if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
        clearPending();
        return;
      }

      const seatNumber = numberForCode(event.code);
      if (seatNumber !== null) {
        const seatKey = seatForNumber(seatNumber);
        if (!seatKey || !current.eligible(seatKey.side)) {
          clearPending();
          return;
        }
        const playerName = current.seatedPlayers[seatKey.side][seatKey.seat];
        // A seat nobody is sitting in. Common: a team playing three.
        if (playerName === undefined) {
          clearPending();
          return;
        }
        event.preventDefault();
        armPending({ ...seatKey, playerName });
        return;
      }

      const selected = pending.current;
      if (selected === null) return;

      const action = actionForKey(event.key);
      if (action === null) {
        // A printable key after a seat is not a valid action. Do not let a stale seat combine with a
        // later action, but leave navigation/function keys harmlessly available to the browser.
        if (event.key.length === 1) clearPending();
        return;
      }

      event.preventDefault();

      if (!current.eligible(selected.side)) {
        clearPending();
        return;
      }
      if (action === 'wrong') {
        clearPending(false);
        current.onWrongNoPenalty(selected.side, selected.playerName);
        current.onEcho?.({ ...selected, action, answerType: null });
        return;
      }

      const ruling = rulingForAction(current.format, action, current.negsAvailable(selected.side));
      // An action with nothing behind it in this format is deliberately silent. Falling back to an
      // adjacent ruling is how a keyboard records the wrong thing.
      if (ruling === null) {
        clearPending();
        return;
      }

      clearPending(false);
      current.onBuzz(selected.side, selected.playerName, ruling.answerType);
      current.onEcho?.({ ...selected, action, answerType: ruling.answerType });
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      // Silent: the scoresheet is going away, so there is nobody left to tell.
      clearPending(false);
    };
  }, [clearPending]);
}
