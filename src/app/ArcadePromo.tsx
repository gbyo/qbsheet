/**
 * The arcade banner, and the one bit of storage that decides whether it is offered at all.
 *
 * # Where it appears, and where it must not
 *
 * Two idle screens show it: the homepage with nothing unfinished on it, and a paired room waiting
 * for its next assignment. Both are somebody with time on their hands. It is deliberately absent
 * from every screen that is not -- an unfinished game, a startable assignment, a room being told
 * something by tournament control -- because an animated advertisement beside a Resume button is the
 * application competing with the scorekeeper's actual problem.
 *
 * The hosts hold `ArcadeLauncher` rather than this component, which matters more than it looks: a
 * room polls, and an assignment arriving while somebody is mid-game would otherwise unmount the
 * banner and take the arcade down with it.
 *
 * # Why dismissal is a preference and not a notice
 *
 * The banner is an advertisement for the least important thing QBSheet does. Somebody who has said
 * "no" to it has said it about a feature, not about a message, so the answer is kept the way the
 * other device preferences are kept -- one key, written once, read on every load -- rather than
 * queued, expired or re-offered. Nothing else in the application reads this: dismissing the promo
 * takes the banner off both screens and changes nothing about the arcade itself, which the
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

import { useState } from 'react';

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

/**
 * The banner itself.
 *
 * A plain `section` with no `role` and no live region: this is promotional content, and opening a
 * screen should not make a screen reader read out an advertisement. Two real buttons, and the banner
 * is not one of them -- a whole clickable card would make the dismiss control a trap.
 */
export default function ArcadePromo(props: { onPlay: () => void }) {
  /** Read once at mount: a scorekeeper who dismissed this should not see it flash on every load. */
  const [dismissed, setDismissed] = useState(() => readArcadePromoDismissed());
  if (dismissed) return null;
  return (
    <section className="arcade-promo" aria-labelledby="arcade-promo-heading">
      <span className="arcade-promo-decoration" aria-hidden="true" />
      <div className="arcade-promo-copy">
        <h2 id="arcade-promo-heading" className="arcade-promo-heading">
          Want a break?
        </h2>
        <p className="arcade-promo-detail">QBBird and Snake are waiting.</p>
      </div>
      <div className="arcade-promo-controls">
        <button type="button" className="arcade-promo-action" onClick={props.onPlay}>
          Play Arcade
        </button>
        <button
          type="button"
          className="arcade-promo-dismiss"
          aria-label="Dismiss Arcade suggestion"
          onClick={() => {
            setDismissed(true);
            writeArcadePromoDismissed();
          }}
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
    </section>
  );
}
