/**
 * What happens after the last question.
 *
 * # Two copies, and which one the room is made to produce
 *
 * A connected game has two independent result paths: the submission tournament control received,
 * and the file somebody carries. They fail independently — a server can accept a result and then be
 * restored from a backup, a laptop can be reimaged, a submission can be filed against the wrong
 * game — so the backup is always offered, always available, and never deleted.
 *
 * What changed is when it is *demanded*. A result tournament control has accepted has arrived, and
 * requiring a download, a manual upload and a confirmation on top of that is asking a room to
 * deliver the same game twice, eleven times a day. The predictable result is a scorekeeper who
 * presses "I uploaded the result" without uploading anything, which costs the acknowledgement the
 * only thing it was worth. So the handoff is required exactly where delivery did not happen or the
 * tournament asked for the file by name: a pending or refused submission, a game with no
 * tournament control behind it, or an assignment carrying its own handoff instruction.
 *
 * # A game nobody is waiting for
 *
 * The one case where nothing is demanded at all is a game created on this device: a practice, a
 * scrimmage, a pickup game. There is no tournament at the other end of it, so there is no delivery
 * to insist on and no second copy anybody needs. The result is saved, it is in Recent Games, and the
 * QBJ is offered for whoever wants to keep or share one — which is a different sentence from "hand
 * this result over", and is written as one. `needsHandoff` is still the only thing that decides
 * whether the screen may be left; this file asks it rather than reasoning alongside it.
 *
 * # And the acknowledgement is not proof
 *
 * The button records that the room says it uploaded the file. This application has no way to check
 * a shared drive, a folder or an email, and it does not pretend otherwise: the wording is about what
 * the scorekeeper did, not about what arrived. Claiming verification we do not have is worse than
 * claiming nothing, because it is the claim a director would rely on.
 *
 * # Nothing is deleted here
 *
 * Not on send, not on download, not on acknowledgement. `Download QBJ again` stays for as long as
 * the record does, because the second most common thing that goes wrong with a downloads folder is
 * that somebody cleared it.
 */
import { useState } from 'react';
import { IStoredGameRecord, gameRequiresHandoff, isDelivered, needsHandoff } from '../game/GameStore';
import { isManualGame } from '../game/GameDefinition';
import { gamePackageLabel } from '../game/GamePackage';
import { downloadFile, qbjFileContents, qbjFileName } from '../integrations/file/QbjDownload';

function timeOfDay(iso: string | undefined): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return '';
  return at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export default function CompletionScreen(props: {
  record: IStoredGameRecord;
  onUpdate: (recordId: string, change: Partial<IStoredGameRecord>) => void | Promise<void>;
  /** What leaving this screen is called. A connected room is going back to its room, not home. */
  continueLabel?: string;
  onHome: () => void | Promise<void>;
  /** Start another local game with the same manual setup, when this was a manual game. */
  onRematch?: () => void | Promise<void>;
  /** True only on the navigation caused by a server-accepted submission. */
  acceptedJustNow?: boolean;
}) {
  const { record, onUpdate, continueLabel = 'Done', onHome, onRematch, acceptedJustNow = false } = props;
  const [writeFailed, setWriteFailed] = useState(false);
  const [rematchFailed, setRematchFailed] = useState(false);
  const score = record.finalScore;
  const connected = record.serverDelivery !== 'none';
  /** Tournament control has it, and did not ask for anything else. */
  const delivered = isDelivered(record);
  const requiresHandoffAcknowledgement =
    !delivered && (connected || Boolean(record.package.handoffInstruction));
  /** Nobody is owed this result. The copy stops calling the download a handoff. */
  const optionalCopy = !gameRequiresHandoff(record);
  const backupDownloaded = record.qbjDownloadedAt !== undefined;
  const canLeave = !needsHandoff(record);

  const download = () => {
    if (!record.finalQbj) return;
    const written = downloadFile(qbjFileContents(record.finalQbj), qbjFileName(record.package));
    setWriteFailed(!written);
    if (written) void onUpdate(record.id, { qbjDownloadedAt: new Date().toISOString() });
  };

  return (
    <main className="shell">
      <header className="shell-header">
        <h1 className="shell-title">Final</h1>
        <p className="shell-subtitle">{gamePackageLabel(record.package)}</p>
      </header>

      <section className="shell-section final-score">
        <div className="final-row">
          <span className="final-team">{record.package.left.name}</span>
          <span className="final-points">{score ? score.left : '—'}</span>
        </div>
        <div className="final-row">
          <span className="final-team">{record.package.right.name}</span>
          <span className="final-points">{score ? score.right : '—'}</span>
        </div>
      </section>

      {connected && (
        <section className="shell-section">
          <h2 className="shell-heading">Tournament control</h2>
          {record.serverDelivery === 'sent' && (
            <p
              className={`final-ok final-accepted${acceptedJustNow ? ' is-newly-accepted' : ''}`}
              data-acceptance-motion={acceptedJustNow ? 'new' : undefined}
            >
              <svg className="final-accepted-mark" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                <path d="m4 10 4 4 8-9" />
              </svg>
              {record.serverDeliveryLedger?.acceptedAsDuplicate ? 'Result already on record' : 'Result sent'}
              <span className="visually-hidden"> ✓</span>
            </p>
          )}
          {record.serverDelivery === 'pending' && (
            <p className="final-pending">
              Tournament control did not receive the result yet. It is saved on this device; retry it from
              Recent Games when control is available.
            </p>
          )}
          {record.serverDelivery === 'rejected' && (
            <p className="shell-warning">
              Tournament control did not accept the result. {record.serverDeliveryDetail ?? ''} The result is
              saved on this device — hand the file over and speak to tournament control.
            </p>
          )}
        </section>
      )}

      <section className="shell-section">
        <h2 className="shell-heading">
          {optionalCopy ? 'Save a copy' : delivered ? 'Back up this result' : 'Hand this result over'}
        </h2>
        {optionalCopy ? (
          <p className="shell-hint">
            This result is saved on this device. Download a QBJ if you want to keep or share a portable
            copy.
          </p>
        ) : delivered ? (
          <p className="shell-hint">
            Tournament control has this game. A copy stays on this device, and downloading one is always
            worth doing when there is a moment for it.
          </p>
        ) : (
          connected && (
            <ol className="final-steps">
              <li>Download the QBJ.</li>
              <li>Upload it using the instructions provided for this room.</li>
            </ol>
          )
        )}
        {record.package.handoffInstruction && (
          <p className="final-instruction">{record.package.handoffInstruction}</p>
        )}

        <div className="shell-actions">
          {/* Optional means secondary. Done is the action on this screen for a game nobody is
              waiting for, and two primary buttons would say otherwise. */}
          <button type="button" className={`shell-button${optionalCopy ? '' : ' is-primary'}`} onClick={download}>
            {record.qbjDownloadedAt
              ? 'Download QBJ again'
              : optionalCopy
                ? 'Download QBJ copy'
                : delivered
                  ? 'Download QBJ backup'
                  : 'Download QBJ'}
          </button>
        </div>

        {writeFailed && (
          <p className="shell-warning" role="alert">
            This browser would not save the file. Try again, or use the browser&apos;s own download settings.
          </p>
        )}

        {record.qbjDownloadedAt && (
          <div className="final-handoff">
            <p className="shell-hint">Downloaded at {timeOfDay(record.qbjDownloadedAt)}</p>
            {optionalCopy ? (
              <p className="final-ok">A copy of this result is in your downloads.</p>
            ) : !requiresHandoffAcknowledgement ? (
              <p className="final-ok">The QBJ is ready to hand over.</p>
            ) : record.handoffAcknowledgedAt ? (
              <p className="final-ok">Handoff confirmed at {timeOfDay(record.handoffAcknowledgedAt)}</p>
            ) : (
              <>
                <p>After you upload the file:</p>
                <button
                  type="button"
                  className="shell-button"
                  onClick={() => void onUpdate(record.id, { handoffAcknowledgedAt: new Date().toISOString() })}
                >
                  I uploaded the result
                </button>
              </>
            )}
          </div>
        )}
      </section>

      <div className="shell-actions">
        {!canLeave && (
          <p className="shell-hint">
            {backupDownloaded
              ? 'Confirm the handoff before finishing.'
              : `Download the QBJ${requiresHandoffAcknowledgement ? ' and confirm the handoff' : ''} before finishing.`}
          </p>
        )}
        <button
          type="button"
          className={`shell-button${canLeave ? ' is-primary' : ''}`}
          disabled={!canLeave}
          onClick={() => void onHome()}
        >
          {continueLabel}
        </button>
        {onRematch && isManualGame(record.package) && (
          <button
            type="button"
            className="shell-button"
            onClick={() => {
              setRematchFailed(false);
              void Promise.resolve(onRematch()).catch(() => setRematchFailed(true));
            }}
          >
            Rematch
          </button>
        )}
      </div>
      {rematchFailed && (
        <p className="shell-warning" role="alert">
          The rematch could not be saved locally. The finished result is still here.
        </p>
      )}
    </main>
  );
}
