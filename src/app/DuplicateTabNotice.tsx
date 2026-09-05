/**
 * The same game, open twice on the same device.
 *
 * Two tabs writing to one journal is a quiet failure: the last write wins and half the questions
 * disappear without anybody being told. So the second tab stands down.
 *
 * It stands down without deleting anything, and it offers a read-only view rather than nothing,
 * because the case where this appears wrongly — the other tab was closed a moment ago and its
 * heartbeat had not stopped — must not leave a room stuck. See `TabClaim` for why this is a
 * convenience rather than a lock.
 */
import { useState } from 'react';
import { IStoredGameRecord } from '../game/GameStore';
import { gamePackageLabel, gamePackageMatchup } from '../game/GamePackage';
import { progressLabel } from './WelcomeScreen';

const recoveryViewId = 'duplicate-tab-recovery-view';

export default function DuplicateTabNotice(props: {
  record: IStoredGameRecord;
  onHome: () => void | Promise<void>;
}) {
  const { record, onHome } = props;
  const [showing, setShowing] = useState(false);

  return (
    <main className="shell shell-centered">
      <h1 className="shell-title">This game is already open in another tab.</h1>
      <p className="shell-hint">
        {gamePackageLabel(record.package)} · {gamePackageMatchup(record.package)}
      </p>
      <p>Score it there. Two tabs scoring one game will lose questions.</p>

      <div className="shell-actions">
        <button type="button" className="shell-button is-primary" onClick={() => void onHome()}>
          Return to home
        </button>
        <button
          type="button"
          className="shell-button"
          aria-expanded={showing}
          aria-controls={recoveryViewId}
          onClick={() => setShowing((open) => !open)}
        >
          {showing ? 'Hide recovery view' : 'Open read-only recovery view'}
        </button>
      </div>

      {showing && (
        <section id={recoveryViewId} className="shell-section">
          <h2 className="shell-heading">Recovery view</h2>
          <p className="shell-hint">
            What this device has saved for this game. Nothing here can be edited, and opening it changes
            nothing in the tab that is scoring.
          </p>
          <dl className="recent-status">
            <div>
              <dt>Progress</dt>
              <dd>{progressLabel(record)}</dd>
            </div>
            <div>
              <dt>Events recorded</dt>
              <dd>{record.events.length}</dd>
            </div>
            <div>
              <dt>Last saved</dt>
              <dd>
                {new Date(record.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
              </dd>
            </div>
          </dl>
        </section>
      )}
    </main>
  );
}
