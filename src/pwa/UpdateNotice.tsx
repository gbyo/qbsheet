/**
 * The offer to update, made only where accepting it is free.
 *
 * This component renders on the screens where nothing is at stake: the front door and the room screen
 * between rounds. It is deliberately not rendered over a live scoresheet — that case is a sentence in
 * the banner strip saying the update will happen afterwards, with nothing to press. See
 * `updateDeferredAlert`.
 *
 * The copy avoids urgency. Nothing here is more important than the next round, and a scorekeeper who
 * ignores this until five o'clock has done nothing wrong.
 */
import { useEffect, useState } from 'react';
import { IScorerAlert } from '../scorer/ConnectionStatus';
import { appUpdates } from './AppUpdate';
import { useAppUpdate } from './useAppUpdate';

/** Persist only the presentation choice; the waiting worker remains available until it is applied. */
export const updateNoticeDismissalKey = 'qbsheet:update-notice-dismissed';

function wasUpdateNoticeDismissed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(updateNoticeDismissalKey) === '1';
  } catch {
    return false;
  }
}

export type UpdateNoticePresentation = 'compact' | 'hero';

export default function UpdateNotice({
  presentation = 'compact',
}: {
  presentation?: UpdateNoticePresentation;
}) {
  const { available, applying } = useAppUpdate();
  const [dismissed, setDismissed] = useState(wasUpdateNoticeDismissed);

  useEffect(() => {
    // A fresh worker means the old dismissal has served its purpose. Clearing here lets the next
    // update announce itself without requiring a user to clear site data.
    if (available) return;
    // Defer the local presentation reset by a tick so the update watcher remains the source of
    // truth without making the availability transition pay for a synchronous cascading render.
    const reset = window.setTimeout(() => setDismissed(false), 0);
    try {
      window.localStorage.removeItem(updateNoticeDismissalKey);
    } catch {
      // Private browsing and locked-down school profiles may deny storage; the notice still works.
    }
    return () => window.clearTimeout(reset);
  }, [available]);

  if (!available) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(updateNoticeDismissalKey, '1');
    } catch {
      // A dismissal for this render is still useful even when it cannot persist across reloads.
    }
  };

  const showDetails = () => {
    setDismissed(false);
    try {
      window.localStorage.removeItem(updateNoticeDismissalKey);
    } catch {
      // Reopening still works for this render when storage cannot be changed.
    }
  };

  if (dismissed) {
    return (
      <section
        className="shell-section update-notice update-notice-quiet"
        data-update-presentation="quiet"
        role="status"
      >
        <span className="update-notice-quiet-copy">Update available</span>
        <button
          type="button"
          className="shell-button shell-button-quiet"
          disabled={applying}
          onClick={() => appUpdates.apply()}
        >
          {applying ? 'Updating…' : 'Update now'}
        </button>
        <button type="button" className="shell-button shell-button-quiet" onClick={showDetails}>
          Show details
        </button>
      </section>
    );
  }

  const hero = presentation === 'hero';

  return (
    <section
      className={`shell-section update-notice${hero ? ' update-notice-hero' : ''}`}
      data-update-presentation={presentation}
      role="status"
    >
      <div>
        <p className="update-notice-title">A new version of QBSheet is ready on this device.</p>
        <p className="update-notice-copy">
          Updating reloads the app. Saved games, the paired room, and anything in progress are kept.
        </p>
      </div>
      <div className="update-notice-actions">
        <button
          type="button"
          className={`shell-button${hero ? ' is-primary' : ''}`}
          disabled={applying}
          onClick={() => {
            appUpdates.apply();
          }}
        >
          {applying ? 'Updating…' : 'Update now'}
        </button>
        <button type="button" className="shell-button shell-button-quiet" onClick={dismiss}>
          {hero ? 'Not now' : 'Dismiss'}
        </button>
      </div>
    </section>
  );
}

/**
 * What a live scoresheet says about a waiting update.
 *
 * An alert rather than its own element so it goes through the same banner strip as everything else the
 * room is told, in the same order, and so a game scored from a file — which has no connected runtime
 * and therefore no alerts of its own — still gets it.
 *
 * `info` is the quietest tone there is, which is the correct volume: this is not a problem, and the
 * only reason to mention it mid-game is so that a scorekeeper who has heard "everyone update" from the
 * director knows that this device has the new build and is holding it until the buzzer.
 */
export function updateDeferredAlert(): IScorerAlert {
  return {
    id: 'app-update-deferred',
    tone: 'info',
    title: 'Update available — will apply after this game',
    body: 'A newer version of QBSheet is ready on this device. It will not replace the scoresheet while a game is open. Finish and submit this game, then update from the home or room screen.',
  };
}
