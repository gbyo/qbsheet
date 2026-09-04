/**
 * Whether the homepage still offers the arcade, and the one bit of storage that decides it.
 *
 * # Why this is a preference and not a notice
 *
 * The banner is an advertisement for the least important thing QBSheet does. Somebody who has said
 * "no" to it has said it about a feature, not about a message, so the answer is kept the way the
 * other device preferences are kept -- one key, written once, read on every load -- rather than
 * queued, expired or re-offered. Nothing else in the application reads this: dismissing the promo
 * takes the banner off the homepage and changes nothing about the arcade itself, which the
 * scoresheet's Game menu still opens.
 *
 * # Why the key is versioned
 *
 * `.v1` so a later, genuinely different promotion can decide to be seen once by everybody by
 * bumping it, without needing a second key or a migration. It is deliberately arcade-specific: this
 * is not the beginning of an announcement framework, and a general "dismissed messages" store is the
 * thing this file exists to not become.
 *
 * # A device that cannot store it is not an error
 *
 * A locked-down school profile that refuses `localStorage` gets the banner back on the next load.
 * That is the same degradation `arcadeScores` and `keyboardPreference` accept, and the failure mode
 * is a repeated suggestion rather than anything a scorekeeper can lose.
 */

export const arcadePromoDismissedStorageKey = 'qbsheet.arcade-promo.dismissed.v1';

function storage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function readArcadePromoDismissed(): boolean {
  try {
    return storage()?.getItem(arcadePromoDismissedStorageKey) === '1';
  } catch {
    return false;
  }
}

/** Remember the dismissal, reporting whether it stuck. Nothing depends on it having done. */
export function writeArcadePromoDismissed(): boolean {
  const target = storage();
  if (!target) return false;
  try {
    target.setItem(arcadePromoDismissedStorageKey, '1');
    return true;
  } catch {
    return false;
  }
}

/** Offer it again. For tests, and for anything that ever restores device preferences. */
export function clearArcadePromoDismissed(): void {
  try {
    storage()?.removeItem(arcadePromoDismissedStorageKey);
  } catch {
    // Nothing depends on this succeeding.
  }
}
