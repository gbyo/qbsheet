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
 *
 * # One result, one status, one primary action
 *
 * The screen answers three questions in order: the final score, whether the result reached where it
 * needs to go, and the one thing to do next. Delivery state lives directly under the score rather
 * than in its own section, the handoff reveals only its current step, and exactly one button at a
 * time carries the primary treatment. Everything else — reviewing the score, a rematch, exports —
 * sits quietly underneath.
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

/**
 * Which step of the completion workflow the room is on.
 *
 * This translates the canonical `GameStore` facts into UI only: `needsHandoff` still decides
 * whether leaving is allowed, `gameRequiresHandoff` still decides whether anybody is owed the
 * result, and `isDelivered` still decides whether tournament control has it. Deriving one stage
 * up front keeps the score status, the primary button and the explanatory copy from
 * contradicting each other further down.
 */
type CompletionStage =
  'delivered' | 'needs-download' | 'needs-handoff-confirmation' | 'handoff-complete' | 'manual-complete';

export default function CompletionScreen(props: {
  record: IStoredGameRecord;
  onUpdate: (
    recordId: string,
    change: Partial<IStoredGameRecord>,
  ) => boolean | void | Promise<boolean | void>;
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
  /** Somebody beyond this device is owed this result. */
  const requiresHandoff = gameRequiresHandoff(record);
  const requiresHandoffAcknowledgement =
    !delivered && (connected || Boolean(record.package.handoffInstruction));
  /** Nobody is owed this result. The copy stops calling the download a handoff. */
  const optionalCopy = !requiresHandoff;
  const downloaded = record.qbjDownloadedAt !== undefined;
  const acknowledged = record.handoffAcknowledgedAt !== undefined;
  const canLeave = !needsHandoff(record);

  let stage: CompletionStage;
  if (delivered) {
    stage = 'delivered';
  } else if (!requiresHandoff) {
    stage = 'manual-complete';
  } else if (!downloaded) {
    stage = 'needs-download';
  } else if (requiresHandoffAcknowledgement && !acknowledged) {
    stage = 'needs-handoff-confirmation';
  } else {
    stage = 'handoff-complete';
  }
  const handoffActive = stage === 'needs-download' || stage === 'needs-handoff-confirmation';

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

  const acknowledgeHandoff = async () => {
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
  };

  const acceptedCopy = record.serverDeliveryLedger?.reviewRequired
    ? 'Result received for director review'
    : record.serverDeliveryLedger?.acceptedAsDuplicate
      ? 'Result already on record'
      : 'Result sent';

  const acceptedStatus = (
    <p
      className={`final-ok final-accepted${acceptedJustNow ? ' is-newly-accepted' : ''}`}
      data-acceptance-motion={acceptedJustNow ? 'new' : undefined}
    >
      <svg className="final-accepted-mark" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <path d="m4 10 4 4 8-9" />
      </svg>
      {acceptedCopy}
      <span className="visually-hidden"> ✓</span>
    </p>
  );

  /** The one concise delivery line that sits directly under the score. */
  const deliveryStatus = (
    <>
      {record.serverDelivery === 'sent' && acceptedStatus}
      {record.serverDelivery === 'pending' && (
        <>
          <p className="final-pending">Tournament control hasn&apos;t received this result yet.</p>
          <p className="shell-hint">QBSheet will keep trying automatically while it is open.</p>
        </>
      )}
      {record.serverDelivery === 'rejected' && (
        <>
          <p className="shell-warning" role="alert">
            Tournament control did not accept this result.
          </p>
          {record.serverDeliveryDetail && <p className="shell-hint">{record.serverDeliveryDetail}</p>}
        </>
      )}
      {record.serverDelivery === 'none' &&
        (requiresHandoff ? (
          <p className="final-pending">This result needs to be handed over.</p>
        ) : (
          <p className="completion-saved">Saved on this device</p>
        ))}
    </>
  );

  const qbjContextLabel = downloaded
    ? 'Download QBJ again'
    : optionalCopy
      ? 'Download QBJ copy'
      : delivered
        ? 'Download QBJ backup'
        : 'Download QBJ';

  const excelButton = (
    <button type="button" className="shell-button" onClick={downloadExcel}>
      {excelDownloaded ? 'Download Excel again' : 'Download Excel scoresheet'}
    </button>
  );

  /**
   * Recovery for the file the handoff step just tried to write. This lives with the handoff
   * rather than at the bottom of the page so a failure reads next to the action that failed.
   */
  const handoffRecovery = (
    <>
      {writeFailed && (
        <p className="shell-warning" role="alert">
          This browser would not save the file. Try again, or use the browser&apos;s own download settings.
        </p>
      )}
      {qbjRecordPending && (
        <p className="shell-hint" role="status">
          Recording the QBJ download…
        </p>
      )}
      {qbjRecordFailed && (
        <div className="shell-warning" role="alert">
          <p>The QBJ was downloaded, but QBSheet could not record that durable backup.</p>
          {qbjAttemptAt && (
            <button
              type="button"
              className="shell-button"
              onClick={() => void recordQbjDownload(qbjAttemptAt)}
            >
              Retry recording the download
            </button>
          )}
        </div>
      )}
      {handoffFailed && (
        <p className="shell-warning" role="alert">
          QBSheet could not save that confirmation. Try again; finishing remains locked until it is recorded.
        </p>
      )}
    </>
  );

  /**
   * The single visually primary action for the current stage. Whether leaving is allowed comes
   * from `needsHandoff` alone; the stage only decides which handoff step is primary while the
   * gate is locked.
   */
  const primaryAction = !canLeave ? (
    !downloaded ? (
      <button type="button" className="shell-button is-primary" onClick={download}>
        Download QBJ
      </button>
    ) : (
      <button
        type="button"
        className="shell-button is-primary"
        disabled={handoffPending}
        onClick={() => void acknowledgeHandoff()}
      >
        {handoffPending ? 'Saving…' : 'I uploaded the result'}
      </button>
    )
  ) : (
    <button type="button" className="shell-button is-primary" onClick={() => void onHome()}>
      {continueLabel}
    </button>
  );

  // While leaving is blocked the one required action above is the only primary button: no
  // redundant disabled duplicate of it. The unmet requirement stays as concise status text.
  const lockedContinuation = !canLeave ? (
    <div className="completion-locked">
      <p className="shell-hint" role="status">
        {stage === 'needs-download'
          ? `Download the QBJ${requiresHandoffAcknowledgement ? ' and confirm the handoff' : ''} before finishing.`
          : 'Confirm the handoff before finishing.'}
      </p>
    </div>
  ) : null;

  const handoffStep =
    stage === 'needs-download' ? (
      <section className="shell-section completion-handoff" aria-label="Result handoff">
        {record.package.handoffInstruction ? (
          <p className="final-instruction">{record.package.handoffInstruction}</p>
        ) : (
          connected && (
            <p className="shell-hint">Upload the QBJ using the instructions provided for this room.</p>
          )
        )}
        {handoffRecovery}
      </section>
    ) : stage === 'needs-handoff-confirmation' ? (
      <section className="shell-section completion-handoff" aria-label="Result handoff">
        <p className="final-pending">Waiting for handoff</p>
        <p className="final-ok" role="status">
          ✓ QBJ downloaded · {timeOfDay(record.qbjDownloadedAt)}
        </p>
        {record.package.handoffInstruction && (
          <p className="final-instruction">{record.package.handoffInstruction}</p>
        )}
        {handoffRecovery}
      </section>
    ) : stage === 'handoff-complete' ? (
      <section className="shell-section completion-handoff" aria-label="Result handoff">
        {acknowledged ? (
          <p className="final-ok" role="status">
            ✓ Result handoff confirmed
            {record.handoffAcknowledgedAt ? ` · ${timeOfDay(record.handoffAcknowledgedAt)}` : ''}
          </p>
        ) : (
          <p className="final-ok" role="status">
            ✓ QBJ downloaded · {timeOfDay(record.qbjDownloadedAt)}
          </p>
        )}
      </section>
    ) : null;

  /**
   * Everything exportable stays in one disclosure, closed by default. While a handoff is owed,
   * the QBJ the handoff needs is the primary action above instead of hiding in here; once the
   * requirement is satisfied, re-downloads live here with Excel.
   */
  const exportsDisclosure = (
    <details className="shell-section final-copy-details completion-exports">
      <summary className="shell-heading">Files &amp; exports</summary>
      <div className="final-copy-content">
        <p className="shell-hint">
          {optionalCopy
            ? 'This result is saved on this device. Download a QBJ if you want to keep or share a portable copy.'
            : 'Tournament control has this game. A copy stays on this device, and downloading one is available whenever there is a moment for it.'}
        </p>
        <div className="shell-actions">
          {(!handoffActive || downloaded) && (
            <button type="button" className="shell-button" onClick={download}>
              {qbjContextLabel}
            </button>
          )}
          {excelButton}
        </div>
        {(stage === 'delivered' || stage === 'manual-complete') && downloaded && (
          <p className="final-ok" role="status">
            ✓ QBJ downloaded · {timeOfDay(record.qbjDownloadedAt)}
          </p>
        )}
        <p className="shell-hint">
          Excel is a readable scoresheet for review. QBJ remains the portable result used for tournament
          handoff and recovery.
        </p>
        {excelDownloaded && (
          <p className="final-ok" role="status">
            ✓ Excel downloaded
          </p>
        )}
        {!handoffActive && (
          <>
            {writeFailed && (
              <p className="shell-warning" role="alert">
                This browser would not save the file. Try again, or use the browser&apos;s own download
                settings.
              </p>
            )}
            {qbjRecordPending && (
              <p className="shell-hint" role="status">
                Recording the QBJ download…
              </p>
            )}
            {qbjRecordFailed && (
              <div className="shell-warning" role="alert">
                <p>The QBJ was downloaded, but QBSheet could not record that durable backup.</p>
                {qbjAttemptAt && (
                  <button
                    type="button"
                    className="shell-button"
                    onClick={() => void recordQbjDownload(qbjAttemptAt)}
                  >
                    Retry recording the download
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </details>
  );

  return (
    <main className="shell">
      <section className="shell-section completion-result" aria-label="Final result">
        <h1 className="shell-title">Final</h1>
        <p className="shell-subtitle">{gamePackageLabel(record.package)}</p>
        <div className="final-score">
          <div className="final-row">
            <span className="final-team">{record.package.left.name}</span>
            <span className="final-points">{score ? score.left : '—'}</span>
          </div>
          <div className="final-row">
            <span className="final-team">{record.package.right.name}</span>
            <span className="final-points">{score ? score.right : '—'}</span>
          </div>
        </div>
        <div className="completion-status">{deliveryStatus}</div>
      </section>

      <div className="shell-actions completion-primary">
        {primaryAction}
        {lockedContinuation}
      </div>

      {handoffStep}

      <div className="completion-secondary">
        <button
          type="button"
          className="shell-button shell-button-quiet"
          onClick={() => void onBackToScorekeeper()}
        >
          Review score
        </button>
        {onRematch && isManualGame(record.package) && (
          <button
            type="button"
            className="shell-button shell-button-quiet"
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
        {exportsDisclosure}
      </div>
      {rematchFailed && (
        <p className="shell-warning" role="alert">
          The rematch could not be saved locally. The finished result is still here.
        </p>
      )}
    </main>
  );
}
