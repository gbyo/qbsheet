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
import { IScorerAlert } from '../scorer/ConnectionStatus';
import { appUpdates } from './AppUpdate';
import { useAppUpdate } from './useAppUpdate';

export default function UpdateNotice() {
  const { available, applying } = useAppUpdate();
  if (!available) return null;
  return (
    <section className="shell-section update-notice" role="status">
      <div>
        <p className="update-notice-title">A new version of QBSheet is ready on this device.</p>
        <p className="update-notice-copy">
          Updating reloads the app. Saved games, the paired room, and anything in progress are kept.
        </p>
      </div>
      <button
        type="button"
        className="shell-button"
        disabled={applying}
        onClick={() => {
          appUpdates.apply();
        }}
      >
        {applying ? 'Updating…' : 'Update now'}
      </button>
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
