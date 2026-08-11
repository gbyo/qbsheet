/**
 * The one keyboard listener the scoresheet has.
 *
 * Tossup scoring is a two-key sequence: a number chooses the seat and C/P/N/0 chooses the ruling.
 * Keeping the pending seat here means the listener can apply the same focus, dialog, eligibility,
 * repeat, and format guards to both halves of the sequence. Space and undo remain available exactly
 * as before, including while the opt-in seat layer is off.
 */
import { useEffect, useLayoutEffect, useRef } from 'react';
import { LeftOrRight } from '../scoring/types';
import { IScorekeeperAnswerType, IScorekeeperFormat } from '../scoring/ScorekeeperFormat';
import {
  actionForKey,
  activationKeyBelongsToControl,
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
  /** Whether a neg is a legal ruling on this tossup. The same flag the buttons use for the −5 column. */
  negsAvailable: boolean;
  /** Whether this side may still answer. A key aimed at an ineligible team does nothing. */
  eligible: (side: LeftOrRight) => boolean;
  /** Who is in each seat right now, in the room's own order. */
  seatedPlayers: Record<LeftOrRight, readonly string[]>;
  /** True while any of the scorer's own dialogs is open. */
  dialogOpen: boolean;
  /** True when a tossup may be recorded as unanswered. Preserves the existing Space behaviour. */
  noBuzzAllowed: boolean;
  onBuzz: (side: LeftOrRight, playerName: string, answerType: IScorekeeperAnswerType) => void;
  /** Record a wrong answer that costs nothing and still uses the player's chance. */
  onWrongNoPenalty: (side: LeftOrRight, playerName: string) => void;
  onNoBuzz: () => void;
  onUndo: () => void;
  onRedo: () => void;
  /** Say what just landed, so the affected seat can be flashed. Never a toast. */
  onEcho?: (echo: { side: LeftOrRight; seat: number; playerName: string; label: string }) => void;
}

interface IPendingSeat {
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

  useEffect(() => {
    if (input.dialogOpen || !input.scoringEnabled || !input.keyboardEnabled) {
      pending.current = null;
      if (pendingTimer.current !== null) window.clearTimeout(pendingTimer.current);
      pendingTimer.current = null;
    }
  }, [input.dialogOpen, input.scoringEnabled, input.keyboardEnabled]);

  useEffect(() => {
    const clearPending = () => {
      pending.current = null;
      if (pendingTimer.current !== null) window.clearTimeout(pendingTimer.current);
      pendingTimer.current = null;
    };

    const armPending = (seat: IPendingSeat) => {
      clearPending();
      pending.current = seat;
      pendingTimer.current = window.setTimeout(clearPending, pendingSeatLifetimeMs);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const current = latest.current;

      // A held key. The browser repeats it, and a resting finger must not record multiple actions.
      if (event.repeat) return;
      if (keystrokeBelongsToControl(event)) {
        clearPending();
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
      clearPending();

      if (!current.eligible(selected.side)) return;
      if (action === 'wrong') {
        current.onWrongNoPenalty(selected.side, selected.playerName);
        current.onEcho?.({ ...selected, label: '0' });
        return;
      }

      const ruling = rulingForAction(current.format, action, current.negsAvailable);
      // An action with nothing behind it in this format is deliberately silent. Falling back to an
      // adjacent ruling is how a keyboard records the wrong thing.
      if (ruling === null) return;

      current.onBuzz(selected.side, selected.playerName, ruling.answerType);
      current.onEcho?.({ ...selected, label: ruling.answerType.shortLabel });
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      clearPending();
    };
  }, []);
}
