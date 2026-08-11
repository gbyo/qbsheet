/**
 * Games this device has finished, and what became of each copy of them.
 *
 * # Three claims, kept separate
 *
 * A finished game has up to three independent copies: the one this device is holding, the one
 * tournament control received, and the file somebody handed over. The list says which of the three
 * are true, individually, because they fail independently and a summary that collapsed them would
 * hide exactly the case that matters — a result the server accepted whose file never reached the
 * folder it was supposed to.
 *
 * Nothing here deletes a game. `Download QBJ again` stays available for as long as the record does,
 * because the second most common thing that goes wrong with a downloads folder is that somebody
 * cleared it.
 */
import { IStoredGameRecord } from '../game/GameStore';
import { gamePackageLabel, gamePackageMatchup } from '../game/GamePackage';
import { useState } from 'react';

function timeOfDay(iso: string | undefined): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return '';
  return at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function attemptText(count: number): string {
  return `${count} attempt${count === 1 ? '' : 's'}`;
}

function serverStatus(record: IStoredGameRecord): { title: string; detail?: string; secondary?: string } {
  const ledger = record.serverDeliveryLedger;
  if (record.serverDelivery === 'none') return { title: 'Not connected' };
  if (record.serverDelivery === 'sent') {
    const title = ledger?.acceptedAsDuplicate ? 'Already received' : 'Accepted';
    const acceptedAt = timeOfDay(ledger?.acceptedAt);
    const secondary = ledger
      ? [attemptText(ledger.attemptCount), ledger.matchId ? `Match ${ledger.matchId}` : undefined]
          .filter(Boolean)
          .join(' · ')
      : undefined;
    return { title: acceptedAt ? `${title} · ${acceptedAt}` : title, secondary };
  }
  if (record.serverDelivery === 'pending') {
    const lastTried = timeOfDay(ledger?.lastAttemptedAt);
    const secondary = ledger
      ? [attemptText(ledger.attemptCount), ledger.lastFailureDetail]
          .filter(Boolean)
          .join(' · ')
      : undefined;
    return {
      title: lastTried ? `Not delivered yet · Last tried ${lastTried}` : 'Not delivered yet',
      secondary,
    };
  }
  const detail = ledger?.lastFailureDetail ?? record.serverDeliveryDetail ?? 'This result was refused.';
  const secondary = ledger
    ? [attemptText(ledger.attemptCount), ledger.matchId ? `Match ${ledger.matchId}` : undefined]
        .filter(Boolean)
        .join(' · ')
    : undefined;
  return { title: 'Rejected', detail, secondary };
}

export function ScoreLine(props: { record: IStoredGameRecord }) {
  const { record } = props;
  const { finalScore, package: gamePackage } = record;
  if (!finalScore) return <span className="recent-matchup">{gamePackageMatchup(gamePackage)}</span>;
  return (
    <span className="recent-matchup">
      {gamePackage.left.name} {finalScore.left}–{finalScore.right} {gamePackage.right.name}
    </span>
  );
}

export default function RecentGames(props: {
  records: IStoredGameRecord[];
  onOpen: (record: IStoredGameRecord) => void;
  onRetry?: (record: IStoredGameRecord) => void | Promise<void>;
  canRetry?: (record: IStoredGameRecord) => boolean;
}) {
  const { records, onOpen, onRetry, canRetry } = props;
  const [retrying, setRetrying] = useState<string | null>(null);
  if (records.length === 0) return null;

  return (
    <section className="shell-section">
      <h2 className="shell-heading">Recent</h2>
      <ul className="recent-list">
        {records.map((record) => (
          <li key={record.id} className="recent-item">
            <div className="recent-main">
              <p className="recent-context">{gamePackageLabel(record.package)}</p>
              {record.attempt > 1 && <p className="recent-attempt">Attempt {record.attempt}</p>}
              <p className="recent-score">
                <ScoreLine record={record} />
              </p>
              <p className="recent-when">Completed {timeOfDay(record.completedAt)}</p>
            </div>
            <dl className="recent-status">
              <div>
                <dt>Server</dt>
                <dd>
                  {(() => {
                    const status = serverStatus(record);
                    return (
                      <>
                        <span>{status.title}</span>
                        {status.detail && <small className="recent-status-detail">{status.detail}</small>}
                        {status.secondary && <small className="recent-status-secondary">{status.secondary}</small>}
                        {record.serverDeliveryLedger?.fingerprint && (
                          <details className="recent-receipt">
                            <summary>Receipt details</summary>
                            <span>Fingerprint {record.serverDeliveryLedger.fingerprint}</span>
                          </details>
                        )}
                      </>
                    );
                  })()}
                </dd>
              </div>
              <div>
                <dt>QBJ</dt>
                <dd>{record.qbjDownloadedAt ? `Downloaded · ${timeOfDay(record.qbjDownloadedAt)}` : 'Not downloaded'}</dd>
              </div>
              <div>
                <dt>Handoff</dt>
                <dd>
                  {record.handoffAcknowledgedAt
                    ? `Confirmed · ${timeOfDay(record.handoffAcknowledgedAt)}`
                    : 'Not confirmed'}
                </dd>
              </div>
            </dl>
            <div className="recent-actions">
              {onRetry && canRetry?.(record) && (
                <button
                  type="button"
                  className="shell-button is-primary"
                  disabled={retrying === record.id}
                  onClick={async () => {
                    setRetrying(record.id);
                    try {
                      await onRetry(record);
                    } finally {
                      setRetrying(null);
                    }
                  }}
                >
                  {retrying === record.id
                    ? 'Trying…'
                    : record.serverDelivery === 'pending'
                      ? 'Retry sending result'
                      : 'Try again'}
                </button>
              )}
              <button type="button" className="shell-button" onClick={() => onOpen(record)}>
                Download QBJ again
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
