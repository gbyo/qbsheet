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
import { useRef, useState } from 'react';
import { IStoredGameRecord, gameRequiresHandoff, isDelivered, needsHandoff } from '../game/GameStore';
import { isManualGame } from '../game/GameDefinition';
import { gamePackageLabel } from '../game/GamePackage';
import { downloadExcelScoresheet } from '../integrations/file/ExcelDownload';
import { downloadFile, qbjFileContents, qbjFileName } from '../integrations/file/QbjDownload';

function timeOfDay(iso: string | undefined): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return '';
  return at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export default function CompletionScreen(props: {
  record: IStoredGameRecord;
  onUpdate: (recordId: string, change: Partial<IStoredGameRecord>) => boolean | void | Promise<boolean | void>;
  /** What leaving this screen is called. A connected room is going back to its room, not home. */
  continueLabel?: string;
  /** Reopen the saved game in the scorer so the result can be checked or corrected. */
  onBackToScorekeeper: () => void | Promise<void>;
  onHome: () => void | Promise<void>;
  /** Start another local game with the same manual setup, when this was a manual game. */
  onRematch?: () => void | Promise<void>;
  /** True only on the navigation caused by a server-accepted submission. */
  acceptedJustNow?: boolean;
}) {
  const {
    record,
    onUpdate,
    continueLabel = 'Done',
    onBackToScorekeeper,
    onHome,
    onRematch,
    acceptedJustNow = false,
  } = props;
  const [writeFailed, setWriteFailed] = useState(false);
  const [qbjRecordFailed, setQbjRecordFailed] = useState(false);
  const [qbjRecordPending, setQbjRecordPending] = useState(false);
  const [qbjAttemptAt, setQbjAttemptAt] = useState<string | undefined>(record.qbjDownloadedAt);
  const [excelDownloaded, setExcelDownloaded] = useState(false);
  const [rematchFailed, setRematchFailed] = useState(false);
  const [handoffPending, setHandoffPending] = useState(false);
  const [handoffFailed, setHandoffFailed] = useState(false);
  const [rematching, setRematching] = useState(false);
  const rematchInFlight = useRef(false);
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

  const recordQbjDownload = async (at: string) => {
    setQbjRecordPending(true);
    setQbjRecordFailed(false);
    try {
      const persisted = await onUpdate(record.id, { qbjDownloadedAt: at });
      if (persisted === false) setQbjRecordFailed(true);
    } catch {
      setQbjRecordFailed(true);
    } finally {
      setQbjRecordPending(false);
    }
  };

  const download = () => {
    if (!record.finalQbj) return;
    const written = downloadFile(qbjFileContents(record.finalQbj), qbjFileName(record.package));
    setWriteFailed(!written);
    if (written) {
      const at = new Date().toISOString();
      setQbjAttemptAt(at);
      void recordQbjDownload(at);
    }
  };

  const downloadExcel = () => {
    const written = downloadExcelScoresheet(record);
    setWriteFailed(!written);
    setExcelDownloaded(written);
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
              Tournament control has not received the result yet. It is saved on this device, and QBSheet
              will keep trying automatically while it is open. You can also retry from Recent Games or hand
              over the QBJ file.
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
          <button type="button" className="shell-button" onClick={downloadExcel}>
            {excelDownloaded ? 'Download Excel again' : 'Download Excel scoresheet'}
          </button>
        </div>

        <p className="shell-hint">
          Excel is a readable scoresheet for review. QBJ remains the portable result used for tournament
          handoff and recovery.
        </p>

        {excelDownloaded && (
          <p className="final-ok" role="status">
            Excel scoresheet downloaded.
          </p>
        )}

        {writeFailed && (
          <p className="shell-warning" role="alert">
            This browser would not save the file. Try again, or use the browser&apos;s own download settings.
          </p>
        )}

        {record.qbjDownloadedAt && (
          <div className="final-handoff">
            <p className="shell-hint">Downloaded at {timeOfDay(record.qbjDownloadedAt)}</p>
            {optionalCopy ? (
              <p className="final-ok" role="status">A copy of this result is in your downloads.</p>
            ) : !requiresHandoffAcknowledgement ? (
              <p className="final-ok" role="status">The QBJ is ready to hand over.</p>
            ) : record.handoffAcknowledgedAt ? (
              <p className="final-ok" role="status">Handoff confirmed at {timeOfDay(record.handoffAcknowledgedAt)}</p>
            ) : (
              <>
                <p>After you upload the file:</p>
                <button
                  type="button"
                  className="shell-button"
                  disabled={handoffPending}
                  onClick={async () => {
                    if (handoffPending) return;
                    setHandoffPending(true);
                    setHandoffFailed(false);
                    try {
                      const persisted = await onUpdate(record.id, {
                        handoffAcknowledgedAt: new Date().toISOString(),
                      });
                      if (persisted === false) setHandoffFailed(true);
                    } catch {
                      setHandoffFailed(true);
                    } finally {
                      setHandoffPending(false);
                    }
                  }}
                >
                  {handoffPending ? 'Saving…' : 'I uploaded the result'}
                </button>
                {handoffFailed && (
                  <p className="shell-warning" role="alert">
                    QBSheet could not save that confirmation. Try again; finishing remains locked until it is recorded.
                  </p>
                )}
              </>
            )}
          </div>
        )}
        {qbjRecordPending && <p className="shell-hint" role="status">Recording the QBJ download…</p>}
        {qbjRecordFailed && (
          <div className="shell-warning" role="alert">
            <p>The QBJ was downloaded, but QBSheet could not record that durable backup.</p>
            {qbjAttemptAt && (
              <button type="button" className="shell-button" onClick={() => void recordQbjDownload(qbjAttemptAt)}>
                Retry recording the download
              </button>
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
        <button type="button" className="shell-button" onClick={() => void onBackToScorekeeper()}>
          Back to scorekeeper
        </button>
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
            disabled={rematching}
            onClick={() => {
              if (rematchInFlight.current) return;
              rematchInFlight.current = true;
              setRematchFailed(false);
              setRematching(true);
              void Promise.resolve(onRematch())
                .catch(() => setRematchFailed(true))
                .finally(() => {
                  rematchInFlight.current = false;
                  setRematching(false);
                });
            }}
          >
            {rematching ? 'Starting…' : 'Rematch'}
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
