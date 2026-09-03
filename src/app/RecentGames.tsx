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
 * Nothing here deletes a game. `Download QBJ` stays available for as long as the record does,
 * because the second most common thing that goes wrong with a downloads folder is that somebody
 * cleared it. It is a repeat action on a list, so it is drawn quietly; the screen's own primary
 * actions are the ones above this section.
 */
import { IStoredGameRecord, isDelivered, retentionMsFor } from '../game/GameStore';
import { gamePackageLabel, gamePackageMatchup } from '../game/GamePackage';
import { isManualGame } from '../game/GameDefinition';
import { useState } from 'react';
import ControlIcon from '../scorer/ControlIcon';
import { downloadStoredGameQbj } from './FinishedGameDownload';

function timeOfDay(iso: string | undefined): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return '';
  return at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function completedLabel(iso: string | undefined): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return '';
  const time = timeOfDay(iso);
  const today = new Date();
  const sameDay =
    at.getFullYear() === today.getFullYear() &&
    at.getMonth() === today.getMonth() &&
    at.getDate() === today.getDate();
  return sameDay
    ? `today at ${time}`
    : `${at.toLocaleDateString([], {
        month: 'short',
        day: 'numeric',
        ...(at.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
      })} at ${time}`;
}

function attemptText(count: number): string {
  return `${count} attempt${count === 1 ? '' : 's'}`;
}

function primaryState(record: IStoredGameRecord): { label: string; tone: 'success' | 'warning' | 'local' } {
  if (record.serverDelivery === 'none' || isManualGame(record.package)) {
    return { label: 'Local only', tone: 'local' };
  }
  if (isDelivered(record)) return { label: 'Delivered', tone: 'success' };
  return { label: 'Needs attention', tone: 'warning' };
}

function retentionDate(record: IStoredGameRecord): string {
  const completed = new Date(record.completedAt ?? '').getTime();
  if (!Number.isFinite(completed)) return '';
  return new Date(completed + retentionMsFor(record.package)).toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
  });
}

function serverStatus(record: IStoredGameRecord): { title: string; detail?: string; secondary?: string } {
  const ledger = record.serverDeliveryLedger;
  if (record.serverDelivery === 'none') return { title: 'Not connected' };
  if (record.serverDelivery === 'sent') {
    const title = ledger?.reviewRequired
      ? 'Received · Review needed'
      : ledger?.acceptedAsDuplicate
        ? 'Already received'
        : 'Accepted';
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
      ? [attemptText(ledger.attemptCount), ledger.lastFailureDetail].filter(Boolean).join(' · ')
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
  onDownload?: (record: IStoredGameRecord) => boolean;
  /** Compatibility for callers that only need to open a record; new callers should download directly. */
  onOpen?: (record: IStoredGameRecord) => void;
  onRetry?: (record: IStoredGameRecord) => void | Promise<void>;
  canRetry?: (record: IStoredGameRecord) => boolean;
}) {
  const { records, onDownload, onOpen, onRetry, canRetry } = props;
  const download = (record: IStoredGameRecord) => {
    if (onDownload) return onDownload(record);
    if (onOpen) {
      onOpen(record);
      return true;
    }
    return downloadStoredGameQbj(record);
  };
  const [retrying, setRetrying] = useState<ReadonlySet<string>>(() => new Set());
  const [downloadErrors, setDownloadErrors] = useState<Readonly<Record<string, string>>>({});
  if (records.length === 0) return null;

  return (
    <section className="shell-section" style={{ marginTop: '-1px', backgroundColor: 'var(--room-surface)' }}>
      <h2 className="shell-heading">Recent</h2>
      <ul className="recent-list">
        {records.map((record) => (
          <li key={record.id} className="recent-item">
            <div className="recent-main">
              <p className="recent-context">{gamePackageLabel(record.package)}</p>
              <p className="recent-primary">
                <span className={`recent-state is-${primaryState(record).tone}`}>
                  {primaryState(record).label}
                </span>
                <span className="recent-primary-separator">·</span>
                <ScoreLine record={record} />
              </p>
              <p className="recent-when">
                Completed {completedLabel(record.completedAt)}
                {retentionDate(record) && <> · Kept on this device until {retentionDate(record)}</>}
              </p>
            </div>
            <details className="recent-details">
              <summary>Receipts and attempts</summary>
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
                          {status.secondary && (
                            <small className="recent-status-secondary">{status.secondary}</small>
                          )}
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
                  <dd>
                    {record.qbjDownloadedAt
                      ? `Downloaded · ${timeOfDay(record.qbjDownloadedAt)}`
                      : 'Not downloaded'}
                  </dd>
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
            </details>
            <div className="recent-actions">
              {onRetry && canRetry?.(record) && (
                <button
                  type="button"
                  className="shell-button is-primary"
                  disabled={retrying.has(record.id)}
                  onClick={async () => {
                    setRetrying((prev) => new Set(prev).add(record.id));
                    try {
                      await onRetry(record);
                    } finally {
                      setRetrying((prev) => {
                        if (!prev.has(record.id)) return prev;
                        const next = new Set(prev);
                        next.delete(record.id);
                        return next;
                      });
                    }
                  }}
                >
                  {retrying.has(record.id)
                    ? 'Trying…'
                    : record.serverDelivery === 'pending'
                      ? 'Retry sending result'
                      : 'Try again'}
                </button>
              )}
              <button
                type="button"
                className="recent-download"
                onClick={() => {
                  let ok = false;
                  try {
                    ok = download(record);
                  } catch {
                    ok = false;
                  }
                  setDownloadErrors((prev) => {
                    if (ok) {
                      if (!(record.id in prev)) return prev;
                      const next = { ...prev };
                      delete next[record.id];
                      return next;
                    }
                    if (prev[record.id] === 'That QBJ file could not be produced.') return prev;
                    return { ...prev, [record.id]: 'That QBJ file could not be produced.' };
                  });
                }}
              >
                <ControlIcon name="download" />
                Download QBJ
              </button>
              {downloadErrors[record.id] && (
                <p className="recent-status-detail" role="alert">
                  {downloadErrors[record.id]}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
