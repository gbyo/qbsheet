/**
 * What happens after the last question.
 *
 * # A receipt, not a toolbox
 *
 * A scorekeeper who has just submitted a result is holding three questions and no others: what was
 * the final, did tournament control get it, am I free to go back to my room. This screen answers
 * those three in that order and then stops. An ordinary accepted game is four lines, one button and
 * a quiet way into everything else; it is deliberately the least interesting screen in the
 * application, because it is the one a room sees eleven times a day.
 *
 * Everything that is real but not part of finishing a game — the player lines, the Excel scoresheet,
 * a spare QBJ, a rematch, the door back into the scoresheet — is behind `Game details`. See
 * `CompletionDetails`. Problems add controls; success does not.
 *
 * # Two copies, and which one the room is made to produce
 *
 * A connected game has two independent result paths: the submission tournament control received,
 * and the file somebody carries. They fail independently — a server can accept a result and then be
 * restored from a backup, a laptop can be reimaged, a submission can be filed against the wrong
 * game — so the backup is always offered, always available, and never deleted.
 *
 * What changed is when it is *demanded*. A result tournament control has accepted has arrived, and
 * requiring a download, a manual handoff and a confirmation on top of that is asking a room to
 * deliver the same game twice, eleven times a day. The predictable result is a scorekeeper who
 * presses the acknowledgement without handing anything over, which costs it the only thing it was
 * worth. So the handoff is required exactly where delivery did not happen or the tournament asked
 * for the file by name: a pending or refused submission, a game with no tournament control behind
 * it, or an assignment carrying its own handoff instruction.
 *
 * # A game nobody is waiting for
 *
 * The one case where nothing is demanded at all is a game created on this device: a practice, a
 * scrimmage, a pickup game. There is no tournament at the other end of it, so there is no delivery
 * to insist on and no second copy anybody needs. The result is saved, it is in Recent Games, and the
 * QBJ is in Game details for whoever wants one. `needsHandoff` is still the only thing that decides
 * whether the screen may be left; this file asks it rather than reasoning alongside it.
 *
 * # And the acknowledgement is not proof
 *
 * The button records that the room says it handed the file over — by drive, by folder, by email, by
 * whatever the tournament actually uses, which is why it does not say "uploaded". This application
 * has no way to check any of those and does not pretend otherwise: the wording is about what the
 * scorekeeper did, not about what arrived. Claiming verification we do not have is worse than
 * claiming nothing, because it is the claim a director would rely on.
 *
 * # Nothing is deleted here
 *
 * Not on send, not on download, not on acknowledgement. The QBJ stays downloadable for as long as
 * the record does, because the second most common thing that goes wrong with a downloads folder is
 * that somebody cleared it.
 *
 * # Exactly one primary action
 *
 * At every stage there is one blue button and it is the thing to do next: `Back to Room 3`, `Done`,
 * `Download QBJ`, `I handed off the result`. A disabled continuation sitting beside the action that
 * would enable it is two targets for one decision, so the locked states simply do not draw one.
 */
import { useMemo, useRef, useState } from 'react';
import { IStoredGameRecord, gameRequiresHandoff, isDelivered, needsHandoff } from '../game/GameStore';
import { isManualGame } from '../game/GameDefinition';
import { gamePackageLabel } from '../game/GamePackage';
import { downloadExcelScoresheet } from '../integrations/file/ExcelDownload';
import { downloadFile, qbjFileContents, qbjFileName } from '../integrations/file/QbjDownload';
import deriveGame from '../scoring/deriveGame';
import { serializeDerivedStats } from '../scoring/statsSheet';
import CompletionDetails, { deliveryHeadline, deliverySubline, timeOfDay } from './CompletionDetails';

/**
 * Which step of the completion workflow the room is on.
 *
 * This translates the canonical `GameStore` facts into UI only: `needsHandoff` still decides
 * whether leaving is allowed, `gameRequiresHandoff` still decides whether anybody is owed the
 * result, and `isDelivered` still decides whether tournament control has it. Deriving one stage
 * up front keeps the status, the primary button and the explanatory copy from contradicting each
 * other further down.
 */
type CompletionStage =
  'delivered' | 'needs-download' | 'needs-handoff-confirmation' | 'handoff-complete' | 'manual-complete';

export default function CompletionScreen(props: {
  record: IStoredGameRecord;
  onUpdate: (
    recordId: string,
    change: Partial<IStoredGameRecord>,
  ) => boolean | void | Promise<boolean | void>;
  /**
   * What leaving this screen is called.
   *
   * A connected room goes back to its room, not home — and it is called `Back to Room 3` rather
   * than `Next game in Room 3` because at this moment nothing knows there is a next game. The room
   * screen is where an assignment appears, or where waiting is shown honestly.
   */
  continueLabel?: string;
  /** Reopen the saved game in the scorer so the result can be corrected. */
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
  const [qbjWriteFailed, setQbjWriteFailed] = useState(false);
  const [qbjRecordFailed, setQbjRecordFailed] = useState(false);
  const [qbjRecordPending, setQbjRecordPending] = useState(false);
  const [qbjAttemptAt, setQbjAttemptAt] = useState<string | undefined>(record.qbjDownloadedAt);
  const [excelWriteFailed, setExcelWriteFailed] = useState(false);
  const [excelDownloaded, setExcelDownloaded] = useState(false);
  const [rematchFailed, setRematchFailed] = useState(false);
  const [handoffPending, setHandoffPending] = useState(false);
  const [handoffFailed, setHandoffFailed] = useState(false);
  const [rematching, setRematching] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const rematchInFlight = useRef(false);
  const score = record.finalScore;
  /**
   * The finished game, for the one place that shows the player lines.
   *
   * Derived through the ordinary pipeline from the record's own setup and events, so nothing here
   * is a second calculation, and derived for every game rather than only for a standalone one:
   * there is one canonical presentation of the final statistics and it is in Game details. A record
   * the engine cannot read still gets the rest of the screen.
   */
  const stats = useMemo(() => {
    try {
      const format = record.package.scorekeeperFormat;
      if (!format) return null;
      const game = deriveGame(format, record.setup, record.events);
      return {
        format,
        game,
        tsv: serializeDerivedStats(format, game, { gameLabel: gamePackageLabel(record.package) }),
      };
    } catch {
      return null;
    }
  }, [record.events, record.package, record.setup]);
  const connected = record.serverDelivery !== 'none';
  /** Tournament control has it, and did not ask for anything else. */
  const delivered = isDelivered(record);
  /** Somebody beyond this device is owed this result. */
  const requiresHandoff = gameRequiresHandoff(record);
  const requiresHandoffAcknowledgement =
    !delivered && (connected || Boolean(record.package.handoffInstruction));
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
  /** The download is what the room owes right now, so it is the primary action and lives nowhere else. */
  const qbjIsRequired = !canLeave && !downloaded;

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
    setQbjWriteFailed(!written);
    if (written) {
      const at = new Date().toISOString();
      setQbjAttemptAt(at);
      void recordQbjDownload(at);
    }
  };

  const downloadExcel = () => {
    const written = downloadExcelScoresheet(record);
    setExcelWriteFailed(!written);
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

  const startRematch = () => {
    if (!onRematch || rematchInFlight.current) return;
    rematchInFlight.current = true;
    setRematchFailed(false);
    setRematching(true);
    void Promise.resolve(onRematch())
      .catch(() => setRematchFailed(true))
      .finally(() => {
        rematchInFlight.current = false;
        setRematching(false);
      });
  };

  const accepted = record.serverDelivery === 'sent';
  const rejected = record.serverDelivery === 'rejected';
  /** Accepted, or saved somewhere nobody is waiting on: the states that earn a check mark. */
  const settled = accepted || stage === 'manual-complete';
  const headline = deliveryHeadline(record);
  const subline = deliverySubline(record);

  /**
   * The delivery line, directly under the score, inside one polite live region.
   *
   * A pending result that is accepted while the scorekeeper is still standing here has to change
   * this text and unlock continuation without taking focus off whatever they were reaching for, so
   * the region wraps the whole status rather than any one sentence inside it.
   */
  const deliveryStatus = (
    <div className="completion-status" role="status">
      <p
        className={[
          'completion-headline',
          settled ? 'final-ok' : rejected ? 'completion-rejected' : 'final-pending',
          // `final-accepted` is the server's own receipt and carries its motion. It stays off every
          // other state on purpose: a screen that has never spoken to tournament control must not
          // be able to grow the class that means tournament control accepted this.
          accepted ? 'final-accepted' : '',
          accepted && acceptedJustNow ? 'is-newly-accepted' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        data-acceptance-motion={accepted && acceptedJustNow ? 'new' : undefined}
      >
        {settled && (
          <svg className="final-accepted-mark" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
            <path d="m4 10 4 4 8-9" />
          </svg>
        )}
        {headline}
        {settled && <span className="visually-hidden"> ✓</span>}
      </p>
      {/*
        Whatever tournament control actually said, verbatim and above our own sentence. A room
        explaining a refusal to a director needs the specific reason — "Round 6 has already been
        closed" — and a generic apology in its place is the difference between sorting it out at
        the table and walking to the control room to ask.
      */}
      {rejected && record.serverDeliveryDetail && (
        <p className="completion-status-detail">{record.serverDeliveryDetail}</p>
      )}
      {subline && <p className="shell-hint">{subline}</p>}
    </div>
  );

  /**
   * The failure and retry surface for the QBJ, rendered beside whichever button writes it.
   *
   * There is only ever one such button — the required primary action, or the one in Game details —
   * so this never appears twice, and a refused write is never reported somewhere other than where
   * it was asked for.
   */
  const qbjRecovery = (
    <>
      {qbjWriteFailed && (
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
    </>
  );

  /**
   * What the room still has to do, between the status and the button that does it.
   *
   * Empty on a successful game, which is the point: the tournament's own instruction, the receipt
   * for a file already written, and the recovery for a write that failed are all things that only
   * exist when something is outstanding or went wrong.
   */
  const outstanding = stage === 'needs-download' || stage === 'needs-handoff-confirmation';
  const showInstruction = outstanding && Boolean(record.package.handoffInstruction);
  const showDownloadReceipt = (outstanding || stage === 'handoff-complete') && downloaded;
  // The QBJ's own failures follow its button. That button is either the required primary action
  // above, or the one in Game details; the dialog is modal, so rendering here whenever it is closed
  // puts exactly one copy of the message on screen and keeps it there after the dialog is dismissed.
  const showQbjRecovery =
    (qbjIsRequired || !detailsOpen) && (qbjWriteFailed || qbjRecordPending || qbjRecordFailed);
  const hasHandoffNote =
    showInstruction || showDownloadReceipt || acknowledged || showQbjRecovery || handoffFailed;

  const handoffNote = hasHandoffNote ? (
    <section className="completion-handoff" aria-label="Result handoff">
      {showInstruction && <p className="final-instruction">{record.package.handoffInstruction}</p>}
      {showDownloadReceipt && (
        <p className="final-ok">✓ QBJ downloaded · {timeOfDay(record.qbjDownloadedAt)}</p>
      )}
      {acknowledged && (
        <p className="final-ok">
          ✓ Result handed off
          {record.handoffAcknowledgedAt ? ` · ${timeOfDay(record.handoffAcknowledgedAt)}` : ''}
        </p>
      )}
      {showQbjRecovery && qbjRecovery}
      {handoffFailed && (
        <p className="shell-warning" role="alert">
          QBSheet could not save that confirmation. Try again; finishing remains locked until it is recorded.
        </p>
      )}
    </section>
  ) : null;

  /**
   * The single visually primary action for the current stage.
   *
   * Whether leaving is allowed comes from `needsHandoff` alone; the stage only decides which
   * handoff step is primary while the gate is locked. Nothing else on this screen carries the
   * primary treatment, and no disabled continuation is drawn beside a locked gate.
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
        {handoffPending ? 'Saving…' : 'I handed off the result'}
      </button>
    )
  ) : (
    <button type="button" className="shell-button is-primary" onClick={() => void onHome()}>
      {continueLabel}
    </button>
  );

  const qbjDetailLabel = downloaded
    ? 'Download QBJ again'
    : requiresHandoff
      ? 'Download QBJ backup'
      : 'Download QBJ copy';

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
        {deliveryStatus}
      </section>

      {handoffNote}

      <div className="shell-actions completion-primary">{primaryAction}</div>

      <div className="completion-secondary">
        <button
          type="button"
          className="shell-button shell-button-quiet completion-details-open"
          aria-haspopup="dialog"
          aria-expanded={detailsOpen}
          onClick={() => setDetailsOpen(true)}
        >
          Game details
        </button>
      </div>

      {/*
        The one place the optional tools live, and never the place the required QBJ lives: when the
        download is what the room owes, it is the primary action above and is withheld from here so
        there is exactly one button that writes the file.
      */}
      {detailsOpen && (
        <CompletionDetails
          record={record}
          stats={stats}
          onCorrect={() => void onBackToScorekeeper()}
          onDownloadQbj={qbjIsRequired ? undefined : download}
          qbjLabel={qbjDetailLabel}
          qbjRecovery={qbjRecovery}
          onDownloadExcel={downloadExcel}
          excelDownloaded={excelDownloaded}
          excelWriteFailed={excelWriteFailed}
          onRematch={onRematch && isManualGame(record.package) ? startRematch : undefined}
          rematching={rematching}
          rematchFailed={rematchFailed}
          onClose={() => setDetailsOpen(false)}
        />
      )}

      {/*
        A rematch that could not be saved is reported here as well as in the dialog, because a
        successful rematch navigates away and a failed one may have closed the dialog behind it.
      */}
      {rematchFailed && !detailsOpen && (
        <p className="shell-warning" role="alert">
          The rematch could not be saved locally. The finished result is still here.
        </p>
      )}
    </main>
  );
}
