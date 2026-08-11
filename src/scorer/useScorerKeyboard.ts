/**
 * The one keyboard listener the scoresheet has.
 *
 * # Why one, and not one per feature
 *
 * Because the interesting behaviour is the *interaction* between shortcuts, and two listeners cannot
 * agree about it. Space was already guarded against firing while a button had focus; undo was already
 * guarded against firing inside a dialog. Adding a second listener for seat keys would have meant a
 * second copy of both guards, and the copies would have drifted the first time either was corrected.
 * So the existing shortcuts moved in here unchanged in behaviour, and everything shares one answer to
 * "is this keystroke ours".
 *
 * # What is deliberately not here
 *
 * Any decision about what a ruling is worth. This hook resolves a keystroke to a seat and a role, asks
 * `KeyboardScoring` what that role means in the live format, and then calls the same callbacks the
 * buttons call. It cannot record an event the buttons could not, because it does not know how to record
 * an event at all.
 *
 * The bonus is not here either. Its choices are computed and held by `BonusPrompt`, and a shortcut for
 * them belongs where they are — see the digit handling there. Reaching across for that state would have
 * meant lifting it, and a keyboard feature is not a good reason to move a component's state up.
 */
import { useEffect, useRef } from 'react';
import { LeftOrRight } from '../scoring/types';
import { IScorekeeperAnswerType, IScorekeeperFormat } from '../scoring/ScorekeeperFormat';
import {
  activationKeyBelongsToControl,
  keyboardSeatCount,
  keystrokeBelongsToControl,
  roleForModifiers,
  rulingForRole,
  seatForCode,
} from './KeyboardScoring';

export interface IScorerKeyboardInput {
  /** The whole seat layer, off unless the scorekeeper asked for it. Space and undo work regardless. */
  keyboardEnabled: boolean;
  format: IScorekeeperFormat;
  /** True only while a tossup is live and not blocked. Nothing scores otherwise. */
  scoringEnabled: boolean;
  /** Whether a neg is a legal ruling on this tossup. The same flag the buttons use for the −5 column. */
  negsAvailable: boolean;
  /** Whether this side may still answer. A key aimed at an ineligible team does nothing. */
  eligible: (side: LeftOrRight) => boolean;
  /** Who is in each seat right now, in the room's own order. Substitutions move names, not keys. */
  seatedPlayers: Record<LeftOrRight, readonly string[]>;
  /** True while any of the scorer's own dialogs is open. */
  dialogOpen: boolean;
  /** True when a tossup may be recorded as unanswered. Preserves the existing Space behaviour. */
  noBuzzAllowed: boolean;
  onBuzz: (side: LeftOrRight, playerName: string, answerType: IScorekeeperAnswerType) => void;
  onWrongNoPenalty: (side: LeftOrRight, playerName: string) => void;
  onNoBuzz: () => void;
  onUndo: () => void;
  onRedo: () => void;
  /** Say what just landed, so the affected seat can be flashed. Never a toast. */
  onEcho?: (echo: { side: LeftOrRight; seat: number; playerName: string; label: string }) => void;
}

export default function useScorerKeyboard(input: IScorerKeyboardInput): void {
  /**
   * The live inputs, in a ref.
   *
   * The listener is attached once and reads through this, rather than being torn down and rebuilt on
   * every render. A scoresheet re-renders on every keystroke, and re-registering a document listener
   * that often is both wasteful and a way to lose a keystroke that arrives mid-swap.
   */
  const latest = useRef(input);
  latest.current = input;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const current = latest.current;

      // A held key. The browser repeats it, and a scorekeeper resting a finger on `D` must not record
      // eleven tossups. Checked before anything else, because it applies to every shortcut here
      // including undo — holding Cmd+Z through a game's history is not an undo anybody asked for.
      if (event.repeat) return;
      if (keystrokeBelongsToControl(event)) return;

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && !current.dialogOpen) {
        event.preventDefault();
        if (event.shiftKey) current.onRedo();
        else current.onUndo();
        return;
      }

      // Space records an unanswered tossup. Unchanged, including its own extra guard: with focus on a
      // button, Space *is* that button, and stealing it would score the wrong thing.
      if (event.key === ' ') {
        if (activationKeyBelongsToControl(event)) return;
        if (current.dialogOpen || !current.noBuzzAllowed) return;
        event.preventDefault();
        current.onNoBuzz();
        return;
      }

      if (!current.keyboardEnabled || current.dialogOpen || !current.scoringEnabled) return;

      const seatKey = seatForCode(event.code);
      if (!seatKey || seatKey.seat >= keyboardSeatCount) return;
      if (!current.eligible(seatKey.side)) return;

      const role = roleForModifiers(event);
      if (role === null) return;
      const ruling = rulingForRole(current.format, role, current.negsAvailable);
      // A modifier with nothing behind it in this format. Deliberately silent: falling back to an
      // adjacent ruling is how a keyboard records +10 for a power that does not exist.
      if (ruling === null) return;

      const playerName = current.seatedPlayers[seatKey.side][seatKey.seat];
      // A seat nobody is sitting in. Common: a team playing three.
      if (playerName === undefined) return;

      // Claimed only once everything above has agreed. Until this point the keystroke may still belong
      // to the browser — Ctrl+D is a bookmark — and preventing it early would break shortcuts for a
      // ruling this format does not have.
      event.preventDefault();

      if (ruling.kind === 'no-penalty') {
        current.onWrongNoPenalty(seatKey.side, playerName);
        current.onEcho?.({ ...seatKey, playerName, label: '0' });
        return;
      }
      current.onBuzz(seatKey.side, playerName, ruling.answerType);
      current.onEcho?.({ ...seatKey, playerName, label: ruling.answerType.shortLabel });
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);
}
