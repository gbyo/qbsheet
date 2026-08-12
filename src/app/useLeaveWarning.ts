/**
 * The browser's "Leave site?" dialog, and the narrow set of things it is allowed to be about.
 *
 * # It is the second line of defence, not the first
 *
 * Recovery is what actually protects a room: a reload puts the game back at the exact question with
 * the score, the lineups, the protests and the clock intact, without the server being involved. The
 * warning exists for the moment before that is proven — and for the case where it is not true,
 * because this browser refused to write anything.
 *
 * That ordering decides how aggressive it should be. A dialog that appears every time anybody
 * closes a tab is a dialog rooms learn to dismiss, and a room that dismisses this one by habit is a
 * room that dismisses it on the day it mattered. So it appears for three things and nothing else:
 *
 *   1. A game still being scored.
 *   2. A device that could not save, whatever else is true.
 *   3. A finished game whose backup has not been handed over.
 *
 * And it stops appearing the moment none of those hold — a finished game, saved, downloaded and
 * acknowledged, is a tab somebody is entitled to close without being asked about it.
 *
 * # What can never install or remove it
 *
 * Anything about the network. Whether tournament control is reachable is not a fact about whether
 * this device is holding something it would lose, and a warning that flickers with the Wi-Fi is
 * noise. Crucially, nothing in this file ever navigates: the browser dialog is the *only* effect,
 * so a server failure can never produce it indirectly.
 *
 * Chrome, Firefox and Safari all show their own fixed wording. There is no text to customize and
 * none is attempted.
 */
import { useEffect } from 'react';

export interface ILeaveWarningState {
  /** A game is on screen and has not been submitted. */
  gameInProgress: boolean;
  /** This browser refused the last local write. True here overrides everything else. */
  localSaveFailed: boolean;
  /** A finished game whose QBJ has not been downloaded and acknowledged. */
  handoffOutstanding: boolean;
  /** The hand-entered game setup has unsaved fields. */
  setupDirty?: boolean;
}

export function shouldWarnBeforeLeaving(state: ILeaveWarningState): boolean {
  return state.gameInProgress || state.localSaveFailed || state.handoffOutstanding || state.setupDirty === true;
}

export default function useLeaveWarning(state: ILeaveWarningState): void {
  const { gameInProgress, localSaveFailed, handoffOutstanding, setupDirty = false } = state;
  useEffect(() => {
    if (!shouldWarnBeforeLeaving({ gameInProgress, localSaveFailed, handoffOutstanding, setupDirty })) {
      return undefined;
    }
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Set for the browsers that still require a truthy returnValue to show the dialog at all.
      event.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [gameInProgress, localSaveFailed, handoffOutstanding, setupDirty]);
}
