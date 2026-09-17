/**
 * Everything about a finished game that the scorekeeper does not need in order to leave the room.
 *
 * # Why this exists
 *
 * The completion screen answers three questions — what was the final, did tournament control get
 * it, am I free to go — and an ordinary accepted result answers all three in about four lines. Every
 * other thing a finished game can offer is real and occasionally indispensable: the player lines, a
 * spreadsheet copy, the Excel scoresheet, a second QBJ, a rematch, and the door back into the
 * scoresheet when the result turns out to be wrong. None of them is part of finishing a game, and
 * all of them used to sit on the screen a room looks at eleven times a day, competing with the one
 * button that was actually next.
 *
 * So they live here, one press away, behind a single quiet affordance. This is a drawer, not a
 * dashboard: flat sections in a scrolling surface, no cards, no second copy of the delivery status
 * as a tile.
 *
 * # It never holds the required action
 *
 * When a QBJ download is what the room owes — a file game, a refused submission, a tournament that
 * asked for the file by name — that button is the primary action on the completion screen and is
 * *not* also in here. Two buttons that write the same file, one of them hidden behind a disclosure,
 * is a scorekeeper deciding which one is the real one. The caller decides; see `CompletionScreen`.
 */
import { ReactNode } from 'react';
import NativeDialog from './NativeDialog';
import { IStoredGameRecord, gameRequiresHandoff } from '../game/GameStore';
import { IGamePackage, gamePackageMatchup } from '../game/GamePackage';
import { IScorekeeperFormat } from '../scoring/ScorekeeperFormat';
import { IDerivedGame } from '../scoring/deriveGame';
import SpreadsheetCopyPanel from '../scorer/SpreadsheetCopyPanel';
import TeamStatLines from '../scorer/TeamStatLines';

/** "4:31 PM", or nothing at all for a timestamp this build cannot read. */
export function timeOfDay(iso: string | undefined): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return '';
  return at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** "Aug 12, 4:31 PM". Used where a stamp may be read hours or days after the game. */
export function dayAndTime(iso: string | undefined): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return '';
  return at.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/**
 * The one sentence that says where this result is, in the words every surface uses for it.
 *
 * Exported because the completion screen puts it under the score and this dialog repeats it as a
 * fact in the result summary. Two independently worded answers to "was it delivered" is two chances
 * for one of them to be wrong on the day it matters.
 */
export function deliveryHeadline(record: IStoredGameRecord): string {
  if (record.serverDelivery === 'sent') {
    if (record.serverDeliveryLedger?.reviewRequired) return 'Result received';
    if (record.serverDeliveryLedger?.acceptedAsDuplicate) return 'Result already on record';
    return 'Result sent';
  }
  if (record.serverDelivery === 'pending') return 'Sending result…';
  if (record.serverDelivery === 'rejected') return 'Result was not accepted';
  return gameRequiresHandoff(record) ? 'Result needs to be handed over' : 'Saved on this device';
}

/**
 * The quieter second line, where there is one worth saying.
 *
 * Absent by design for the states whose headline is the whole story: a duplicate acceptance, a
 * saved practice game. A successful screen should be the quietest one in the application.
 */
export function deliverySubline(record: IStoredGameRecord): string | undefined {
  if (record.serverDelivery === 'sent') {
    if (record.serverDeliveryLedger?.reviewRequired) return 'Tournament control will review it.';
    if (record.serverDeliveryLedger?.acceptedAsDuplicate) return undefined;
    return 'Tournament control has this result.';
  }
  if (record.serverDelivery === 'pending') return 'QBSheet is still trying automatically.';
  if (record.serverDelivery === 'rejected') return 'Your game is still saved on this device.';
  if (gameRequiresHandoff(record)) return 'Save the tournament result file before leaving.';
  return undefined;
}

/** "Round 6 · Room 3", where the tournament named both. */
function whereAndWhen(packageValue: IGamePackage): string {
  const room = packageValue.room?.name;
  return room ? `${packageValue.round.name} · ${room}` : packageValue.round.name;
}

/** One fact. No action beside it: corrections are in their own section, named for what they do. */
function Fact(props: { label: string; value: string }) {
  return (
    <div className="completion-detail-row">
      <dt>{props.label}</dt>
      <dd>{props.value}</dd>
    </div>
  );
}

export interface ICompletionDetailsProps {
  record: IStoredGameRecord;
  /** The finished game, derived once by the caller through the ordinary pipeline. */
  stats: { format: IScorekeeperFormat; game: IDerivedGame; tsv: string } | null;
  /** Reopen the saved game in the scorer to correct the result. */
  onCorrect: () => void;
  /**
   * Write the QBJ, when it is not the completion screen's own required action.
   *
   * Absent exactly when the room still owes the file: the caller promotes the same download to the
   * primary action instead, and this dialog must not offer a second one.
   */
  onDownloadQbj?: () => void;
  /** What that button says, given whether the file has already been written. */
  qbjLabel: string;
  /** The failure and retry surface for the QBJ, rendered beside the button that produced it. */
  qbjRecovery?: ReactNode;
  onDownloadExcel: () => void;
  excelDownloaded: boolean;
  excelWriteFailed: boolean;
  /** Start another local game with the same setup. Only ever supplied for a manual game. */
  onRematch?: () => void;
  rematching?: boolean;
  rematchFailed?: boolean;
  onClose: () => void;
}

export default function CompletionDetails(props: ICompletionDetailsProps) {
  const {
    record,
    stats,
    onCorrect,
    onDownloadQbj,
    qbjLabel,
    qbjRecovery,
    onDownloadExcel,
    excelDownloaded,
    excelWriteFailed,
    onRematch,
    rematching = false,
    rematchFailed = false,
    onClose,
  } = props;
  const score = record.finalScore;
  const ledger = record.serverDeliveryLedger;

  return (
    <NativeDialog title="Game details" className="completion-details" onClose={onClose}>
      <section className="completion-detail-section" aria-labelledby="completion-details-result">
        <h3 id="completion-details-result" className="completion-detail-heading">
          Result details
        </h3>
        <dl className="completion-detail-list">
          <Fact label="Matchup" value={gamePackageMatchup(record.package)} />
          <Fact label="Tournament" value={record.package.tournament.name} />
          <Fact label="Round" value={whereAndWhen(record.package)} />
          <Fact
            label="Final score"
            value={
              score
                ? `${record.package.left.name} ${score.left} · ${record.package.right.name} ${score.right}`
                : 'Not recorded'
            }
          />
          {stats && (
            <Fact
              label="Tossups heard"
              value={
                stats.game.overtimeTossupsRead > 0
                  ? `${stats.game.tossupsRead} (${stats.game.overtimeTossupsRead} in overtime)`
                  : `${stats.game.tossupsRead}`
              }
            />
          )}
          {stats?.game.endedEarly && <Fact label="Ended early" value={stats.game.endedEarly.reason} />}
          <Fact label="Delivery" value={deliveryHeadline(record)} />
          {record.serverDeliveryDetail && (
            <Fact label="Tournament control said" value={record.serverDeliveryDetail} />
          )}
          {record.completedAt && <Fact label="Finished" value={dayAndTime(record.completedAt)} />}
          {ledger?.lastAttemptedAt && <Fact label="Last sent" value={dayAndTime(ledger.lastAttemptedAt)} />}
          {ledger?.acceptedAt && <Fact label="Accepted" value={dayAndTime(ledger.acceptedAt)} />}
          {record.qbjDownloadedAt && (
            <Fact label="QBJ downloaded" value={dayAndTime(record.qbjDownloadedAt)} />
          )}
          {record.handoffAcknowledgedAt && (
            <Fact label="Handoff confirmed" value={dayAndTime(record.handoffAcknowledgedAt)} />
          )}
        </dl>
      </section>

      {stats && (
        <section className="completion-detail-section" aria-labelledby="completion-details-stats">
          <h3 id="completion-details-stats" className="completion-detail-heading">
            Statistics
          </h3>
          <div className="scorer-check-teams">
            <TeamStatLines format={stats.format} team={stats.game.left} />
            <TeamStatLines format={stats.format} team={stats.game.right} />
          </div>
          <SpreadsheetCopyPanel
            tsv={stats.tsv}
            gameLabel={whereAndWhen(record.package)}
            idPrefix="completion-stats"
            actionLabel="Copy stats"
            guidance="plain"
            panelLabel="Stat sheet copy"
          />
        </section>
      )}

      <section className="completion-detail-section" aria-labelledby="completion-details-actions">
        <h3 id="completion-details-actions" className="completion-detail-heading">
          Actions &amp; files
        </h3>

        <div className="completion-detail-action">
          <button type="button" className="shell-button" onClick={onCorrect}>
            Correct result
          </button>
          <p className="shell-hint">
            Reopen the scoresheet to correct this result. If it was already sent, submit the corrected result
            again.
          </p>
        </div>

        {onDownloadQbj && (
          <div className="completion-detail-action">
            <button type="button" className="shell-button" onClick={onDownloadQbj}>
              {qbjLabel}
            </button>
            <p className="shell-hint">
              The portable QBSheet result. Use it to hand the game over or to recover it on another device.
            </p>
            {qbjRecovery}
          </div>
        )}

        <div className="completion-detail-action">
          <button type="button" className="shell-button" onClick={onDownloadExcel}>
            {excelDownloaded ? 'Download Excel again' : 'Download Excel scoresheet'}
          </button>
          <p className="shell-hint">A human-readable scoresheet, for review rather than for handoff.</p>
          {excelDownloaded && (
            <p className="final-ok" role="status">
              ✓ Excel downloaded
            </p>
          )}
          {excelWriteFailed && (
            <p className="shell-warning" role="alert">
              This browser would not save the file. Try again, or use the browser&apos;s own download
              settings.
            </p>
          )}
        </div>

        {onRematch && (
          <div className="completion-detail-action">
            <button type="button" className="shell-button" disabled={rematching} onClick={onRematch}>
              {rematching ? 'Starting…' : 'Start a rematch'}
            </button>
            <p className="shell-hint">Another local game between the same two teams, with the same rules.</p>
            {rematchFailed && (
              <p className="shell-warning" role="alert">
                The rematch could not be saved locally. The finished result is still here.
              </p>
            )}
          </div>
        )}
      </section>
    </NativeDialog>
  );
}
