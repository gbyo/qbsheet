/**
 * The scorekeeping screen.
 *
 * It shows the product mark, tournament, round, room and two teams. It does not show a question or a
 * reader control, because the scorekeeper is sitting next to somebody reading from paper and none
 * of those things exist for them.
 *
 * # It is never asked what it is scoring
 *
 * There is no Tossup / Bonus / Overtime selector. The phase comes from `deriveGame`, which works it
 * out from the rules and the events so far: a converted tossup moves to the bonus on its own, a neg
 * leaves the other team able to answer, a tied regulation runs into overtime. A scorekeeper telling
 * the software what it already knows is a step that exists only to go wrong.
 *
 * # Submission is an end-of-game act
 *
 * "Submit" appears when the game is over, not in a toolbar during every question. A button that ends
 * the game sitting next to the buttons that score it is a mis-tap away from a half-finished result
 * reaching tournament control.
 */
import { CSSProperties, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import BrandLogo from '../BrandLogo';
import { LeftOrRight } from '../scoring/types';
import {
  ControlRequestState,
  HelpClearResult,
  HelpRequestCategory,
  HelpRequestResult,
  helpRequestCategoryLabels,
} from '../app/HelpRequests';
import { IScorekeeperAnswerType, IScorekeeperFormat } from '../scoring/ScorekeeperFormat';
import {
  IRoomProcedure,
  lineupChangeAllowedAtPhase,
  protestBlocksCheckpoint,
  protestBlocksSuddenDeathTossup,
  protestCheckpointPolicy,
  roomBreakLabel,
  roomBreakTaken,
  roomBreaksAreScheduled,
  roomTakesBreaks,
  substitutionOpportunityPhrase,
  substitutionPolicy,
} from '../scoring/RoomProcedure';
import deriveGame, {
  IDerivedGame,
  IGameSetup,
  lastPlayedQuestion,
  lineupChangeEffectiveQuestion,
} from '../scoring/deriveGame';
import { IBonusEvent, IBonusPartResult, ScoreEvent } from '../scoring/ScoreEvents';
import validateScoresheet from '../scoring/validateScoresheet';
import toQbjMatch, { IQbjMatchMeta } from '../scoring/toQbjMatch';
import { IGameDefinition } from '../game/GameDefinition';
import { IGamePackage } from '../game/GamePackage';
import {
  createSpreadsheetGameSnapshot,
  ISpreadsheetGameMetadata,
  serializeSpreadsheetGame,
} from '../spreadsheet';
import { connectionTimeline } from '../app/ConnectionTimeline';
import { RoomConnectionState } from '../app/ConnectionState';
import TeamPanel from './TeamPanel';
import BonusPrompt from './BonusPrompt';
import RecentRail, { IRecentMotion } from './RecentRail';
import GameMenu from './GameMenu';
import scorerMenuItems from './scorerMenu';
import ArcadeLauncher from '../arcade/ArcadeLauncher';
import ControlIcon from './ControlIcon';
import PlayersDialog, { rosterSyncKey } from './PlayersDialog';
import StartingLineupPrompt from './StartingLineupPrompt';
import PreSubmitReview, { HalftimeCheck } from './PreSubmitReview';
import { AdjustDialog, ForfeitDialog, LightningDialog, NotesDialog } from './GameDialogs';
import { EndGameEarlyDialog, ProtestDialog, ReplaceQuestionDialog, TimeoutDialog } from './ProcedureDialogs';
import { IGameEventsApi, newEventId } from './useGameEvents';
import {
  ExportDialog,
  FlagDialog,
  formatControlRequestTime,
  frameDescription,
  frameQuestion,
  IssueDialog,
  RecoveryDialog,
  ScoresheetReviewDialog,
} from './OperationsDialogs';
import PrintableScoresheet from './PrintableScoresheet';
import usePrinting from './usePrinting';
import ScoringRulesCorrectionDialog, { IScoringRulesCorrection } from './ScoringRulesCorrectionDialog';
import GameDetailsDialog from './GameDetailsDialog';
import ProcedureCorrectionDialog, {
  IProcedureExceptionInput,
  ProcedureTopic,
} from './ProcedureCorrectionDialog';
import {
  correctionNote,
  correctionSummary,
  IGameCorrection,
  IProposedGameCorrection,
} from '../scoring/gameCorrection';
import { correctPlayerName, correctTeamName } from '../scoring/identityCorrection';
import canApplyScoreEvent from '../scoring/canApplyScoreEvent';
import { attachScorerRecovery } from './ScorerRecovery';
import useRoomClock from './useRoomClock';
import usePlayerSeating from './usePlayerSeating';
import { orderBySeating, PlayerSeating, reseatLineup } from './PlayerSeating';
import { sameMembership } from './LineupEditing';
import useScreenWakeLock from './useScreenWakeLock';
import {
  exportRoomClocks,
  formatClock,
  RoomClockStatus,
  roomClockSegment,
  snapshotRoomClock,
} from './RoomClock';
import { createQbsheetBackup, IQbsheetBackup } from './QBSheetBackup';
import useScorerKeyboard from './useScorerKeyboard';
import KeyboardMap, { KeyboardMapContext } from './KeyboardMap';
import KeyboardStatus, { type KeyboardStatus as IKeyboardStatus } from './KeyboardStatus';
import {
  availableActionKeys,
  bonusKeyLegend,
  bonusPartKeyLegend,
  keyboardActionNames,
  sequenceLegend,
  type BonusKeyboardStage,
} from './KeyboardScoring';
import { rulingLabel, unreachableAnswerTypes } from './tossupRulings';
import { setKeyboardEnabled } from './keyboardPreference';
import useKeyboardEnabled from './useKeyboardEnabled';
import TableView from './TableView';
import {
  ScoringView,
  setScoringView,
  setTableOrientation,
  tableOrientationDescriptions,
  tableOrientationLabels,
  tableOrientations,
  TableOrientation,
} from './scoringViewPreference';
import useScoringView, { useTableOrientation } from './useScoringView';
import ScoringLayoutSwitcher from './ScoringLayoutSwitcher';
import SegmentedChoice, { ISegmentedOption } from './SegmentedChoice';
import ScoringLayoutDialog from './ScoringLayoutDialog';
import { rememberScoringLayoutChoice, scoringLayoutChosen } from './scoringLayoutPrompt';
import {
  ConnectionDetailDialog,
  IScorerAlert,
  IScorerRecoveryStatus,
  connectionClass,
  connectionLabel,
  offlineBody,
} from './ConnectionStatus';
import ScorerNoticeCenter, { IScorerNotice } from './ScorerNoticeCenter';
import MotionNumber, {
  bonusExitMotionMs,
  connectionRecoveryMotionMs,
  noBuzzAcknowledgementMotionMs,
  recentMotionMs,
} from './ScoringMotion';
import { bonusPartResultTotals, bouncebackOptions, regularBonusTotals } from './bonusOptions';
import { extraTimeoutsGranted, substitutionAllowed } from '../scoring/ProcedureExceptions';
import removeOvertime, { overtimeQuestionNumbers, overtimeRemovalNote } from '../scoring/overtimeCorrection';
import { canonicalSideForDisplay, displaySideForCanonical, mapSides } from './DisplaySideMapping';
import useDisplaySideMapping from './useDisplaySideMapping';
import type { IRosterAddResult } from '../integrations/fruity/FruityServerClient';

export type { IScorerAlert, IScorerRecoveryStatus } from './ConnectionStatus';

export interface IScorerSubmitResult {
  ok: boolean;
  message: string;
  /** False only when the host knows the finished result did not reach durable local storage. */
  durablySaved?: boolean;
}

export interface IScorerProps {
  /** Stable per-game key used for local recovery state such as the room clock. */
  gameKey: string;
  format: IScorekeeperFormat;
  /** Optional workflow-specific minimums for the pregame lineup prompt. */
  requiredStarterCount?: Partial<Record<LeftOrRight, number>>;
  /** Refuse a pregame lineup without writing events, leaving it available for correction. */
  validateStartingLineups?: (lineups: Partial<Record<LeftOrRight, string[]>>) => string | undefined;
  setup: IGameSetup;
  events: IGameEventsApi;
  /** Shown as the page's identity. The tournament, not the software. */
  tournamentName: string;
  roundName: string;
  roomName?: string;
  /**
   * The packet this round uses, when the tournament named one.
   *
   * Identity only, never any question text. A reader working from paper can be handed the wrong
   * packet, and one line saying which one this round is on is the cheapest catch there is.
   */
  packetName?: string;
  /** Halves, clock and timeouts. Absent means the room runs none of it, which is the default. */
  procedure?: IRoomProcedure;
  /** Whoever is signed in to this room browser. Recorded on the result as the scorekeeper. */
  operatorName?: string;
  /** The durable package used to build the canonical tournament-spreadsheet copy. */
  gamePackage?: IGamePackage | IGameDefinition;
  /** Existing stable record identity for unscheduled/manual games. */
  stableGameId?: string;
  /** Credential-free record facts that are safe to carry with the spreadsheet snapshot. */
  spreadsheetMetadata?: ISpreadsheetGameMetadata;
  connection: RoomConnectionState;
  /**
   * What the status pill says, when the game's standing is not a network fact.
   *
   * Practice has no tournament control behind it, so "Connected" would be a claim about a server
   * nobody asked. `connection` still drives the banners, the roster sync and the detail dialog —
   * a practice game really is saving locally — and only the word in the header changes.
   */
  statusLabel?: string;
  /** Set when the room is degraded: the game is real, the room state behind it is stale. */
  degradedMessage?: string;
  /** False when this browser could not save the game locally. */
  saved?: boolean;
  /** Sends the finished game. The room owns what that means; this only decides when. */
  onSubmit: (qbj: object) => Promise<IScorerSubmitResult>;
  /** Writes the current game out as a file, at any point. */
  onDownload: (qbj: object) => void;
  /** Writes QBSheet's exact, credential-free recovery envelope, when the host supports it. */
  onDownloadQbsheetBackup?: (backup: IQbsheetBackup) => void;
  /**
   * Save the game as portable QBJ in a named form.
   *
   * Separate from `onDownload` because these need the derived game rather than the payload: a
   * serialized document carries lineups, which are a property of how personnel moved through the
   * game and not something the aggregate payload retains. Optional, so a host that offers no file
   * system simply does not get the menu entries.
   */
  onDownloadForm?: (game: IDerivedGame, form: 'partial' | 'legacy-match') => void;
  /**
   * Apply a correction to this game's own definition: its rules, its procedure, its names.
   *
   * Absent when nothing above the scorer can persist the change — the practice screen, chiefly, whose
   * format belongs to the scenario rather than to a tournament. An absent callback removes the action
   * beside each Game details row rather than disabling it, exactly as `onDownloadForm` does for the
   * menu. See `gameCorrection`.
   */
  onCorrectGame?: (correction: IGameCorrection) => void | Promise<void>;
  /** Called as the game changes, so tournament control can watch progress. */
  onProgress?: (qbj: object, questionsPlayed: number) => void;
  /** Asynchronously mirrors the exact QBSheet state into the recovery service. */
  onRecoverySnapshot?: (backup: IQbsheetBackup) => void;
  /** Round number and the rest of the non-scoring metadata for the exported match. */
  qbjMeta?: IQbjMatchMeta;
  /**
   * The tournament's own player ids, keyed by team and player name.
   *
   * Passed in only so a name correction can re-key them rather than dropping them; see
   * `identityCorrection`. Nothing on this screen reads them otherwise, and a game that arrived
   * without any simply has none.
   */
  qbjPlayerIds?: Record<string, string>;
  /** Sends an operational issue to tournament control for the assigned-room workflow. */
  onRequestControl?: (category: HelpRequestCategory, message: string) => Promise<HelpRequestResult>;
  controlRequest?: ControlRequestState;
  onRetryControlRequest?: () => Promise<HelpRequestResult | null>;
  onCancelControlRequest?: () => Promise<HelpClearResult | null>;
  /** The event list was restored automatically from local storage. */
  recovered?: boolean;
  /**
   * Why the scoresheet has just been mounted on a game that was already in progress.
   *
   * The default assumption is recovery — a reload, a restored tab, a device picked back up — and the
   * opening banner says so. A rules correction remounts the scorer deliberately (see `ScoringScreen`)
   * and is not that: telling a room its game was "recovered" seconds after they corrected the rules
   * describes something that did not happen and hides the thing that did.
   */
  openingNotice?: string;
  /** Something the host wants said about recovery, e.g. where a restored game came from. */
  recoveryNotice?: string;
  /**
   * Room-level warnings about the connection, the credentials, or the assignment.
   *
   * Owned by the room rather than by the scorer because the scorer has no view of the tournament:
   * whether tournament control can still authenticate this browser, and what repairing that would
   * mean, are questions only the page holding the room identity can answer.
   */
  alerts?: IScorerAlert[];
  /** Where this game currently exists, for the connection detail. Facts only. */
  recovery?: IScorerRecoveryStatus;
  /** Latest server rosters confirm durable tournament synchronization; they never replace setup. */
  authoritativeRosters?: Record<LeftOrRight, string[]>;
  /** Stable team ids let the server resolve an amendment without fuzzy team-name matching. */
  teamIds?: Partial<Record<LeftOrRight, string>>;
  /** Narrow authoritative roster-add request for an assigned room. */
  onSyncRosterPlayer?: (
    teamName: string,
    playerName: string,
    teamId?: string,
    questionNumber?: number,
  ) => Promise<{ ok: boolean; error?: string; rejected?: boolean; canonical?: IRosterAddResult }>;
  /** Persist a canonical roster identity returned by tournament control. */
  onRosterIdentity?: (
    requestedTeamName: string,
    requestedPlayerName: string,
    canonical: IRosterAddResult,
  ) => void | Promise<void>;
}

type OpenDialog =
  | 'players'
  | 'lightning'
  | 'notes'
  | 'adjust'
  | 'forfeit'
  | 'issue'
  | 'flag'
  | 'review'
  | 'recovery'
  | 'protests'
  | 'timeout'
  | 'replace'
  | 'end-early'
  | 'details'
  | 'connection'
  | 'scoring-rules'
  | 'export'
  | 'scoring-layout'
  | 'procedure'
  | 'arcade'
  | null;

/**
 * The two ways the table can be drawn, as the strip offers them.
 *
 * Built once at module scope: the options never depend on the game, and rebuilding the array on
 * every render would hand the control a new identity for no reason.
 */
const orientationOptions: ReadonlyArray<ISegmentedOption<TableOrientation>> = tableOrientations.map(
  (orientation) => ({
    value: orientation,
    label: tableOrientationLabels[orientation],
    description: tableOrientationDescriptions[orientation],
  }),
);

/** How often, at most, to tell tournament control how the game is going. Matches MODAQ's old timer. */
const progressIntervalMs = 5000;

/**
 * Something the scorer wants to say about an action, and whether it is still true in a moment.
 *
 * The distinction is the point. "Olivia came on for Sarah" is finished the instant it is read: it
 * describes a thing that happened, the scoresheet already shows it, and there is nothing for anybody
 * to do about it. "Tournament control was not reached" is a situation, and it stays a situation
 * until somebody acts on it. A single forever-string could not tell them apart, so the screen
 * accumulated acknowledgements of successful actions and left them sitting above the scoresheet for
 * the rest of the game, which is how a room learns to stop reading the top of the screen — and the
 * top of the screen is where the problems go.
 */
export interface IOperationNotice {
  message: string;
  /** `warning` gets the warning surface and `role="alert"`; ordinary acknowledgements do not. */
  tone: 'info' | 'warning';
  /** Whether this uses the ordinary short acknowledgement lifetime. */
  transient: boolean;
  /** An optional longer lifetime for notices that are useful but do not need to remain forever. */
  autoDismissMs?: number;
  /** Whether the notice also offers an explicit close button. */
  dismissible?: boolean;
}

/**
 * How long an acknowledgement stays.
 *
 * Long enough to be read by somebody whose eyes were on the table when it appeared, short enough
 * that it is gone before the next tossup is over.
 */
export const operationNoticeMs = 3000;

/** How long the local recovery explanation stays before getting out of the way of the scoresheet. */
export const recoveryNoticeMs = 15_000;

/**
 * One row of the snapshot of a totals panel: a team's choices and the one that was pressed.
 *
 * Rows rather than a single option list, because the bounceback panel has two teams on it and the
 * copy left behind has to show what the scorekeeper was actually looking at when they finished.
 */
interface IBonusExitRow {
  /** The team the row belongs to, omitted where there is only one and the title already names it. */
  label?: string;
  options: number[];
  selected: number | null;
}

interface IBonusExitField {
  label: string;
  value: number;
}

type BonusExitContent =
  | { kind: 'choices'; rows: IBonusExitRow[] }
  | { kind: 'typed'; fields: IBonusExitField[] }
  | {
      kind: 'parts';
      parts: IBonusPartResult[];
      pointsPerPart: number;
      bounceBack: boolean;
      controllingTeamName: string;
      opponentName: string;
    };

interface IBonusExit {
  token: number;
  title: string;
  context: string;
  content: BonusExitContent;
}

/**
 * An inert snapshot of the prompt that committed the bonus, kept intact for its brief exit.
 *
 * Presentation only: every label is a data attribute painted by CSS, so the copy on its way out
 * cannot be read as text, found by a query, or pressed. The bonus is already recorded and the next
 * phase is already underneath — this is the acknowledgement that the whole thing landed, shown where
 * the scorekeeper's eyes already are rather than in a toast somewhere else on the screen. For a part
 * breakdown that means the teams named across the top and the outcome chosen for each part, which is
 * exactly what was just answered.
 */
function BonusExitPrompt({ exit }: { exit: IBonusExit }) {
  const content = exit.content;
  return (
    <div
      key={`bonus-exit-${exit.token}`}
      className="scorer-prompt scorer-bonus-exit"
      data-motion-token={exit.token}
      aria-hidden="true"
    >
      <div className="scorer-prompt-content">
        <p className="scorer-prompt-title">
          <span className="scorer-prompt-team">{exit.title}</span>
          <span className="scorer-prompt-context">{exit.context}</span>
        </p>
        {content.kind === 'choices' && (
          <div className="scorer-bonus-totals">
            {content.rows.map((row, index) => (
              <div key={row.label ?? index} className="scorer-bonus-total-row">
                {row.label !== undefined && (
                  <span className="scorer-bonus-total-label" data-presentation-label={row.label} />
                )}
                <div className="scorer-choices">
                  {row.options.map((points) => (
                    <span
                      key={points}
                      className={`scorer-choice${points === row.selected ? ' is-selected' : ''}`}
                      data-presentation-label={points}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
        {content.kind === 'typed' && (
          <div className="scorer-bonus-typed">
            {content.fields.map((field) => (
              <div key={field.label} className="scorer-bonus-typed-team">
                <label>
                  {field.label}
                  <input type="number" value={field.value} readOnly disabled />
                </label>
              </div>
            ))}
            <span className="scorer-choice is-selected" data-presentation-label="Record bonus" />
          </div>
        )}
        {content.kind === 'parts' &&
          (() => {
            const totals = bonusPartResultTotals(content.parts);
            return (
              <div className="scorer-bonus-parts">
                <div className="scorer-part-list">
                  {content.parts.map((part, index) => {
                    const outcome =
                      part.controlledPoints > 0
                        ? 'controlled'
                        : (part.bouncebackPoints ?? 0) > 0
                          ? 'bounceback'
                          : 'missed';
                    return (
                      <div
                        key={index}
                        className={
                          content.bounceBack
                            ? 'scorer-part-row is-answered'
                            : 'scorer-part-row is-two-way is-answered'
                        }
                      >
                        <span className="scorer-part-label" data-presentation-label={`Part ${index + 1}`} />
                        <span
                          className={`scorer-choice${outcome === 'controlled' ? ' is-selected' : ''}`}
                          data-presentation-label={content.controllingTeamName}
                        />
                        {content.bounceBack && (
                          <span
                            className={`scorer-choice${outcome === 'bounceback' ? ' is-selected' : ''}`}
                            data-presentation-label={content.opponentName}
                          />
                        )}
                        <span
                          className={`scorer-choice${outcome === 'missed' ? ' is-selected' : ''}`}
                          data-presentation-label="No points"
                        />
                      </div>
                    );
                  })}
                </div>
                <div className="scorer-part-footer">
                  <p
                    className="scorer-part-total"
                    data-presentation-label={`${content.controllingTeamName} ${totals.controlled}${
                      content.bounceBack ? ` · ${content.opponentName} ${totals.bounceback}` : ''
                    }`}
                  />
                  <span
                    className="scorer-choice scorer-part-record is-selected"
                    data-presentation-label="Record bonus"
                  />
                </div>
              </div>
            );
          })()}
      </div>
    </div>
  );
}

/**
 * A clock control that changes its paint when start/stop state changes, while the clock hook remains
 * the sole owner of time. Tick updates only replace `display`; they never create a motion token.
 */
function ClockControl(props: {
  status: RoomClockStatus;
  display: string;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onReset: () => void;
}) {
  const { status, display, onStart, onPause, onResume, onReset } = props;
  const previous = useRef(status);
  const sequence = useRef(0);
  const [motion, setMotion] = useState<{ from: RoomClockStatus; to: RoomClockStatus; token: number } | null>(
    null,
  );

  useLayoutEffect(() => {
    const from = previous.current;
    previous.current = status;
    const isStartStop =
      from !== status &&
      (status === 'running' || status === 'paused') &&
      (from === 'idle' || from === 'running' || from === 'paused');
    if (!isStartStop) {
      setMotion(null);
      return undefined;
    }
    sequence.current += 1;
    const next = { from, to: status, token: sequence.current };
    setMotion(next);
    const timer = window.setTimeout(
      () => setMotion((current) => (current?.token === next.token ? null : current)),
      180,
    );
    return () => window.clearTimeout(timer);
  }, [status]);

  const label =
    status === 'running'
      ? 'Pause'
      : status === 'paused'
        ? 'Resume'
        : status === 'expired'
          ? 'Reset'
          : 'Start';
  const action =
    status === 'running'
      ? onPause
      : status === 'paused'
        ? onResume
        : status === 'expired'
          ? onReset
          : onStart;
  const icon = status === 'running' ? 'pause' : 'play';
  const oldIcon = motion?.from === 'running' ? 'pause' : 'play';

  return (
    <span
      className={status === 'expired' ? 'scorer-clock is-expired' : 'scorer-clock'}
      data-clock-state={status}
    >
      <span
        className={motion ? `scorer-clock-digits is-${motion.to}` : 'scorer-clock-digits'}
        aria-label="Room clock"
        data-motion-token={motion?.token}
      >
        {status === 'expired' ? 'Time expired' : display}
      </span>
      <button type="button" className="scorer-clock-button" onClick={action}>
        {status !== 'expired' && (
          <span className="scorer-clock-icons" aria-hidden="true">
            {motion && (
              <span className="scorer-clock-icon is-outgoing">
                <ControlIcon name={oldIcon} />
              </span>
            )}
            <span className={motion ? 'scorer-clock-icon is-incoming' : 'scorer-clock-icon'}>
              <ControlIcon name={icon} />
            </span>
          </span>
        )}
        {label}
      </button>
    </span>
  );
}

/** What happened at tournament control, appended to the local fact. */
function controlOutcomeSuffix(result: HelpRequestResult): string {
  if (result.kind === 'accepted') return ' and was sent to tournament control.';
  if (result.kind === 'already-outstanding') return '. Tournament control was already requested.';
  if (result.kind === 'unreachable' || result.kind === 'server-error') {
    return ', but tournament control was not reached.';
  }
  if (result.kind === 'refused') return '. Tournament control refused the request.';
  return '. This tournament connection does not support remote control requests.';
}

/** Whether the request left something outstanding for a person to deal with. */
function controlOutcomeIsProblem(result: HelpRequestResult): boolean {
  return result.kind === 'unreachable' || result.kind === 'server-error' || result.kind === 'refused';
}

/**
 * What to say when a single historical event has been corrected.
 *
 * Named by what was changed rather than by the event type, because the scorekeeper is checking that
 * the thing they went in to fix is the thing that got fixed.
 */
export function correctionNotice(event: ScoreEvent): string {
  if (event.type === 'substitution') return `Lineup at Tossup ${event.questionNumber} corrected.`;
  if (event.type === 'adjustment') return `Adjustment at Q${event.questionNumber} corrected.`;
  if (event.type === 'lightning') return `Lightning total at Q${event.questionNumber} corrected.`;
  if (event.type === 'note') return `Note at Q${event.questionNumber} corrected.`;
  return `Q${event.questionNumber} corrected.`;
}

export default function Scorer(props: IScorerProps) {
  const {
    gameKey,
    format,
    requiredStarterCount,
    validateStartingLineups,
    setup,
    events,
    tournamentName,
    roundName,
    roomName,
    packetName,
    procedure,
    operatorName,
    gamePackage,
    stableGameId,
    spreadsheetMetadata,
    connection,
    statusLabel,
    degradedMessage,
    saved,
    onSubmit,
    onDownload,
    onDownloadQbsheetBackup,
    onDownloadForm,
    onCorrectGame,
    onProgress,
    onRecoverySnapshot,
    qbjMeta,
    qbjPlayerIds,
    onRequestControl,
    controlRequest: suppliedControlRequest,
    onRetryControlRequest,
    onCancelControlRequest,
    recovered = false,
    openingNotice,
    recoveryNotice,
    alerts,
    recovery,
    authoritativeRosters,
    teamIds,
    onSyncRosterPlayer,
    onRosterIdentity,
  } = props;

  const controlRequest: ControlRequestState = useMemo(
    () =>
      suppliedControlRequest ??
      (onRequestControl
        ? { kind: 'unavailable' as const }
        : { kind: 'unsupported' as const, error: 'This game is being scored from a file.' }),
    [onRequestControl, suppliedControlRequest],
  );

  const recoveryStatus: IScorerRecoveryStatus = useMemo(
    () => recovery ?? { localSaveOk: saved !== false },
    [recovery, saved],
  );

  const [dialog, setDialog] = useState<OpenDialog>(null);
  /**
   * What the procedure dialog was opened about.
   *
   * Set only when a refusal sent the scorekeeper there; see `ScoreEventEscape`. Undefined means they
   * arrived from Game details, where they have already said which half of the question they want.
   */
  const [procedureTopic, setProcedureTopic] = useState<ProcedureTopic | undefined>(undefined);
  const [procedureTeam, setProcedureTeam] = useState<LeftOrRight | undefined>(undefined);
  // Mounts the paper copy for the length of a print and not otherwise. See `usePrinting`.
  const { printing, print } = usePrinting();
  /**
   * Whether the seat layer is on.
   *
   * This device's stored preference, and never defaulted to true. See `keyboardPreference`: turning this
   * on for somebody who did not ask would make an ordinary browser shortcut record a tossup.
   */
  const keyboardEnabled = useKeyboardEnabled();
  /**
   * Which layout this scorekeeper is scoring in.
   *
   * Presentation only, and beside the keyboard preference deliberately: both belong to the device,
   * neither reaches the game. The table is handed the display-mapped state below and the same
   * callbacks `TeamPanel` gets, so nothing about what is recorded depends on this value.
   */
  const scoringLayout = useScoringView();
  /**
   * Which way the table runs, for a scorekeeper who is not sitting alongside it.
   *
   * A facet of the table rather than a third layout — see `TableOrientation` — so it lives beside
   * the layout preference, is offered only while the table is on screen, and changes nothing about
   * the seats or the events.
   */
  const tableOrientationChoice = useTableOrientation();
  /**
   * Whether this game still has to be asked which layout to score it in.
   *
   * Decided once, from the journal as it was when the scoresheet opened. An empty journal is a game
   * nobody has scored yet, which is the only moment a modal costs nothing; anything recovered,
   * reloaded or already in progress is left alone. See `scoringLayoutPrompt` for why the answer is
   * remembered per game rather than only per device.
   */
  const [layoutPromptOpen, setLayoutPromptOpen] = useState(
    () => events.events.length === 0 && !scoringLayoutChosen(gameKey),
  );
  /** True while the room is putting the tables in the order it is actually sitting in. */
  const [arrangingTable, setArrangingTable] = useState(false);
  // Arranging is something only the table can do, so leaving the table ends it.
  if (arrangingTable && scoringLayout !== 'table') setArrangingTable(false);
  /**
   * What the bonus is currently asking for, reported up by `BonusPrompt`.
   *
   * The legend has to change when the bonus does — showing seat sequences while a bonus part is on
   * screen would be showing bindings that do nothing — and the choices live in that component with its
   * own state. Reporting the stage upward is smaller than lifting the state, and keeps the shortcut in
   * the same file as the buttons it stands in for. It is a union rather than a list of numbers because
   * a part stage is a genuinely different question from a totals stage, and the legend has to say which.
   */
  const [bonusStage, setBonusStage] = useState<BonusKeyboardStage | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submitInFlight = useRef(false);
  const [submitResult, setSubmitResult] = useState<IScorerSubmitResult | null>(null);
  const [operationNotice, setOperationNotice] = useState<IOperationNotice | null>(
    recovered || openingNotice
      ? {
          // Not an acknowledgement. It says the events on screen came from somewhere other than this
          // session, which is worth knowing for a little while but should not occupy the scoresheet
          // for the whole game.
          message: openingNotice ?? 'Recovered the in-progress game saved on this device.',
          tone: 'info',
          transient: false,
          autoDismissMs: recoveryNoticeMs,
          dismissible: true,
        }
      : null,
  );
  /**
   * The Recent row something just changed.
   *
   * Set alongside a notice and cleared on the same timer, so the sentence at the top of the screen
   * and the line it is about stop pointing at each other together.
   */
  const [emphasizedQuestion, setEmphasizedQuestion] = useState<number | undefined>(undefined);
  const transientSequence = useRef(0);
  const [noBuzzAcknowledgement, setNoBuzzAcknowledgement] = useState<{ token: number } | null>(null);
  const [bonusExit, setBonusExit] = useState<IBonusExit | null>(null);
  const [recentMotion, setRecentMotion] = useState<IRecentMotion | undefined>(undefined);

  const nextTransientToken = useCallback(() => {
    transientSequence.current += 1;
    return transientSequence.current;
  }, []);

  useEffect(() => {
    if (!noBuzzAcknowledgement) return undefined;
    const timer = window.setTimeout(() => setNoBuzzAcknowledgement(null), noBuzzAcknowledgementMotionMs);
    return () => window.clearTimeout(timer);
  }, [noBuzzAcknowledgement]);

  useEffect(() => {
    if (!bonusExit) return undefined;
    const timer = window.setTimeout(() => setBonusExit(null), bonusExitMotionMs);
    return () => window.clearTimeout(timer);
  }, [bonusExit]);

  useEffect(() => {
    if (!recentMotion) return undefined;
    const token = recentMotion.token;
    const timer = window.setTimeout(
      () => setRecentMotion((current) => (current?.token === token ? undefined : current)),
      recentMotionMs,
    );
    return () => window.clearTimeout(timer);
  }, [recentMotion]);

  const previousConnection = useRef(connection);
  const [connectionRecovery, setConnectionRecovery] = useState<{ token: number } | null>(null);
  useEffect(() => {
    const from = previousConnection.current;
    previousConnection.current = connection;
    if (from === RoomConnectionState.Connected || connection !== RoomConnectionState.Connected) return;
    setConnectionRecovery({ token: nextTransientToken() });
  }, [connection, nextTransientToken]);
  useEffect(() => {
    if (!connectionRecovery) return undefined;
    const timer = window.setTimeout(() => setConnectionRecovery(null), connectionRecoveryMotionMs);
    return () => window.clearTimeout(timer);
  }, [connectionRecovery]);

  /**
   * The notice center owns the timer and the dismissed presentation state. Transient receipts can
   * be removed from this source on dismissal/expiry; unresolved instructions stay in the center's
   * compact issues list so hiding their large surface never claims that they were fixed.
   */
  const dismissOperationNotice = useCallback(() => {
    setOperationNotice((current) => {
      if (!current || current.transient || current.autoDismissMs !== undefined) return null;
      return current;
    });
    setEmphasizedQuestion(undefined);
  }, []);

  /** Say that something worked. Goes away on its own; see `IOperationNotice`. */
  const acknowledge = useCallback((message: string, questionNumber?: number) => {
    setOperationNotice({ message, tone: 'info', transient: true, dismissible: true });
    setEmphasizedQuestion(questionNumber);
  }, []);

  /** Say something that stays until it is resolved or replaced. Not always a warning; see the tone. */
  const notePersistent = useCallback((message: string, tone: 'info' | 'warning' = 'warning') => {
    setOperationNotice({ message, tone, transient: false, dismissible: true });
    setEmphasizedQuestion(undefined);
  }, []);

  /**
   * Whether the room, rather than this screen, owns the persistent story about tournament control.
   *
   * When it does, `controlRequest` is already rendering "Tournament control was not reached" with
   * the retry beside it, and repeating that here would leave two permanent copies of one problem
   * with two different places to clear it. So this screen keeps the half it is authoritative about —
   * that the issue is on the scoresheet, which is true regardless of what the network did — and says
   * it the way it says every other completed action.
   */
  const controlRequestOwned = suppliedControlRequest !== undefined;

  const noteControlOutcome = useCallback(
    (facts: { prefix: string; localOnly: string }, result: HelpRequestResult) => {
      const problem = controlOutcomeIsProblem(result);
      /*
       * Whatever this notice is about, it is not about a question. Cleared on every branch because
       * the persistent one has no timer behind it: a correction emphasising Q7 and then a control
       * request failing before its three seconds were up would have left the rail pointing at Q7
       * under an unrelated warning, with nothing left running to take the emphasis off again.
       */
      setEmphasizedQuestion(undefined);
      if (problem && controlRequestOwned) {
        setOperationNotice({ message: facts.localOnly, tone: 'info', transient: true });
        return;
      }
      setOperationNotice({
        message: `${facts.prefix}${controlOutcomeSuffix(result)}`,
        tone: problem ? 'warning' : 'info',
        transient: !problem,
      });
    },
    [controlRequestOwned],
  );
  /** Only for the connection detail's relative times, so it ticks nowhere else. */
  const [detailNow, setDetailNow] = useState(() => Date.now());
  const [rejectedRosterSyncs, setRejectedRosterSyncs] = useState<Record<string, true>>({});
  const rosterSyncAttempts = useRef(new Map<string, { attempts: number; lastAt: number }>());
  /** Which question the scoresheet review should open at, when it was opened from somewhere specific. */
  const [reviewFocus, setReviewFocus] = useState<number | undefined>(undefined);
  const [reviewEditQuestion, setReviewEditQuestion] = useState<number | undefined>(undefined);
  const [issueCategory, setIssueCategory] = useState<HelpRequestCategory>('question-packet');
  const [moderatorName, setModeratorName] = useState(qbjMeta?.moderator ?? '');
  const [timeoutNow, setTimeoutNow] = useState(() => Date.now());
  /**
   * What order the two rosters are in on screen.
   *
   * Local to this device and this game, and read by nothing that scores — a room arranging its
   * rows to match the table must not be able to write anything into the scoresheet. See
   * `PlayerSeating`.
   */
  const seating = usePlayerSeating(gameKey);
  /**
   * Which canonical team is shown on each side of this screen.
   *
   * This is deliberately separate from the event journal and from player seating. The mapping is a
   * presentation transform only: every callback below maps the side a scorekeeper touched back to
   * the canonical side before recording anything.
   */
  const displaySideState = useDisplaySideMapping(gameKey);

  const game = useMemo(() => deriveGame(format, setup, events.events), [format, setup, events.events]);
  const displaySideMapping = displaySideState.mapping;
  const displayedTeams = useMemo(
    () => ({
      left: game[displaySideMapping.left],
      right: game[displaySideMapping.right],
    }),
    [displaySideMapping, game],
  );
  /** A view-shaped game for dialogs that only read team-facing fields. Never pass this to scoring. */
  const displayedGame = useMemo(
    () => ({
      ...game,
      left: displayedTeams.left,
      right: displayedTeams.right,
      timeouts: mapSides(game.timeouts, displaySideMapping),
      activeTimeout: game.activeTimeout
        ? {
            ...game.activeTimeout,
            team: displaySideForCanonical(displaySideMapping, game.activeTimeout.team),
          }
        : undefined,
    }),
    [displaySideMapping, displayedTeams.left, displayedTeams.right, game],
  );
  const canonicalForDisplay = useCallback(
    (side: LeftOrRight) => canonicalSideForDisplay(displaySideMapping, side),
    [displaySideMapping],
  );
  const displayForCanonical = useCallback(
    (side: LeftOrRight) => displaySideForCanonical(displaySideMapping, side),
    [displaySideMapping],
  );
  const clockSegment = roomClockSegment(
    roomTakesBreaks(procedure),
    game.halfBreaks.length,
    game.awaitingScoreCheck,
    game.overtimeStarted,
  );
  const roomClock = useRoomClock(gameKey, procedure?.halfLengthMinutes, clockSegment);
  const recoveryEventList = events.events;
  const getRecoveryHistory = events.recoveryHistory;

  /**
   * Publish the same exact envelope the manual backup action writes.
   *
   * The recovery service owns persistence and coalescing. This callback only assembles a
   * credential-free snapshot from state already owned by the scorer. In particular, it is never
   * awaited by a scoring action and it includes the current clock segment explicitly because a
   * running clock's displayed seconds are intentionally not persisted on every tick.
   */
  const emitRecoverySnapshot = useCallback(
    (now = Date.now()) => {
      if (!onRecoverySnapshot || !gamePackage) return;
      const clocks = exportRoomClocks(gameKey, now);
      clocks[clockSegment] = snapshotRoomClock(roomClock.state, now);
      onRecoverySnapshot(
        createQbsheetBackup({
          gamePackage,
          setup,
          events: recoveryEventList,
          history: getRecoveryHistory(),
          clocks,
          display: { mapping: displaySideMapping, seating: seating.seating },
        }),
      );
    },
    [
      clockSegment,
      displaySideMapping,
      getRecoveryHistory,
      gameKey,
      gamePackage,
      onRecoverySnapshot,
      roomClock.state,
      seating.seating,
      recoveryEventList,
      setup,
    ],
  );

  // State changes create an immediate candidate. The recovery service coalesces rapid sequences,
  // so a buzz/neg/bonus burst becomes one external write rather than one write per click.
  useEffect(() => {
    emitRecoverySnapshot();
  }, [emitRecoverySnapshot]);

  // A running clock gets a bounded heartbeat. `roomClock.state` does not change for each displayed
  // second, so this does not serialize or write on every clock tick.
  const recoveryClockHeartbeatMs = 20_000;
  useEffect(() => {
    if (!onRecoverySnapshot || roomClock.state.status !== 'running') return undefined;
    const timer = window.setInterval(() => emitRecoverySnapshot(Date.now()), recoveryClockHeartbeatMs);
    return () => window.clearInterval(timer);
  }, [emitRecoverySnapshot, onRecoverySnapshot, roomClock.state.status]);

  const scoresheetValidation = useMemo(
    () => validateScoresheet(format, setup, events.events, procedure),
    [format, setup, events.events, procedure],
  );
  const { phase } = game;
  const previousPhaseKind = useRef(phase.kind);
  const [completionMotion, setCompletionMotion] = useState<{ token: number } | null>(null);
  useLayoutEffect(() => {
    const from = previousPhaseKind.current;
    previousPhaseKind.current = phase.kind;
    if (from !== 'complete' && phase.kind === 'complete') {
      setCompletionMotion({ token: nextTransientToken() });
    } else if (phase.kind !== 'complete') {
      setCompletionMotion(null);
    }
  }, [nextTransientToken, phase.kind]);
  useEffect(() => {
    if (!completionMotion) return undefined;
    const token = completionMotion.token;
    const timer = window.setTimeout(
      () => setCompletionMotion((current) => (current?.token === token ? null : current)),
      280,
    );
    return () => window.clearTimeout(timer);
  }, [completionMotion]);
  useScreenWakeLock(phase.kind === 'tossup' || phase.kind === 'bonus' || phase.kind === 'timeout');
  const {
    configured: roomClockConfigured,
    pause: pauseRoomClock,
    pauseFor: pauseRoomClockFor,
    resumeAfter: resumeRoomClockAfter,
    reset: resetRoomClock,
  } = roomClock;

  useEffect(() => {
    if (!roomClockConfigured) return;
    if (phase.kind === 'complete') {
      pauseRoomClock();
      return;
    }
    if (phase.kind === 'timeout') pauseRoomClockFor('timeout');
    else resumeRoomClockAfter('timeout');
    if (phase.kind === 'score-check' || phase.kind === 'checkpoint') pauseRoomClockFor('checkpoint');
    else resumeRoomClockAfter('checkpoint');
  }, [phase.kind, pauseRoomClock, pauseRoomClockFor, resumeRoomClockAfter, roomClockConfigured]);

  useEffect(() => {
    if (phase.kind !== 'timeout' || procedure?.timeoutDurationSeconds === undefined) return undefined;
    const refresh = () => setTimeoutNow(Date.now());
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => clearInterval(timer);
  }, [game.activeTimeout?.startedAt, phase.kind, procedure?.timeoutDurationSeconds]);
  /**
   * Who was in the room, filled in rather than asked for where it can be.
   *
   * `toQbjMatch` has always carried these; the room simply never told it. The scorekeeper is known
   * already — it is whoever signed in to this browser — so asking would be asking a question we have
   * the answer to. The reader is not known to anything, so it stays optional.
   */
  const meta = useMemo<IQbjMatchMeta | undefined>(() => {
    if (!qbjMeta && !operatorName && !moderatorName) return undefined;
    return {
      ...qbjMeta,
      scorekeeper: qbjMeta?.scorekeeper || operatorName || undefined,
      moderator: moderatorName || qbjMeta?.moderator || undefined,
    };
  }, [qbjMeta, operatorName, moderatorName]);
  const qbj = useMemo(
    () =>
      attachScorerRecovery(toQbjMatch(format, game, meta), setup, recoveryEventList, getRecoveryHistory()),
    [format, game, getRecoveryHistory, meta, recoveryEventList, setup],
  );
  const spreadsheetTsv = useMemo(() => {
    if (!gamePackage) return undefined;
    try {
      return serializeSpreadsheetGame(
        createSpreadsheetGameSnapshot({
          package: gamePackage,
          setup,
          events: events.events,
          gameId: stableGameId ?? gameKey,
          metadata: {
            ...spreadsheetMetadata,
            qbjMatchMeta: meta,
            scorekeeper: meta?.scorekeeper ?? spreadsheetMetadata?.scorekeeper ?? operatorName,
            moderator: meta?.moderator ?? spreadsheetMetadata?.moderator,
            notes: meta?.notes ?? spreadsheetMetadata?.notes,
          },
        }),
      );
    } catch {
      // A malformed host package should not take down the scoresheet. The ordinary QBJ/review
      // actions remain available; the spreadsheet action simply stays unavailable until the host
      // supplies a package that can be serialized.
      return undefined;
    }
  }, [events.events, gameKey, gamePackage, meta, operatorName, setup, spreadsheetMetadata, stableGameId]);
  const spreadsheetGameLabel = useMemo(
    () => `${roundName} · ${game.left.name} ${game.left.points}–${game.right.points} ${game.right.name}`,
    [game.left.name, game.left.points, game.right.name, game.right.points, roundName],
  );
  const spreadsheetSuggestedTabName = useMemo(
    () => `${roundName} ${game.left.name}–${game.right.name}`,
    [game.left.name, game.right.name, roundName],
  );

  /** The question anything recorded now belongs to. */
  const currentQuestion = (() => {
    if (phase.kind === 'tossup' || phase.kind === 'bonus') return phase.questionNumber;
    if (phase.kind === 'score-check') return Math.max(1, phase.afterQuestion);
    if (phase.kind === 'lineup') return 1;
    return Math.max(1, lastPlayedQuestion(game));
  })();
  const lineupQuestion = lineupChangeEffectiveQuestion(game, events.events);

  const localRosterAdds = useMemo(
    () =>
      events.events.filter(
        (event): event is Extract<ScoreEvent, { type: 'roster-add' }> => event.type === 'roster-add',
      ),
    [events.events],
  );
  const rosterSyncStatus = useMemo(() => {
    const status: Record<string, 'synced' | 'waiting' | 'local' | 'rejected'> = {};
    for (const addition of localRosterAdds) {
      const key = rosterSyncKey(addition.team, addition.playerName);
      const authoritative = authoritativeRosters?.[addition.team] ?? [];
      if (
        authoritative.some((name) => name.toLocaleLowerCase() === addition.playerName.toLocaleLowerCase())
      ) {
        status[key] = 'synced';
      } else if (rejectedRosterSyncs[key]) status[key] = 'rejected';
      else if (authoritativeRosters && connection === RoomConnectionState.Connected && onSyncRosterPlayer)
        status[key] = 'waiting';
      else status[key] = 'local';
    }
    return status;
  }, [authoritativeRosters, connection, localRosterAdds, onSyncRosterPlayer, rejectedRosterSyncs]);
  const displayedRosterSyncStatus = useMemo(() => {
    const status: Record<string, 'synced' | 'waiting' | 'local' | 'rejected'> = {};
    for (const displaySide of ['left', 'right'] as LeftOrRight[]) {
      const canonicalSide = displaySideMapping[displaySide];
      for (const player of game[canonicalSide].players) {
        const key = rosterSyncKey(canonicalSide, player.name);
        const displayedKey = rosterSyncKey(displaySide, player.name);
        const value = rosterSyncStatus[key];
        if (value !== undefined) status[displayedKey] = value;
      }
    }
    return status;
  }, [displaySideMapping, game, rosterSyncStatus]);

  useEffect(() => {
    if (connection !== RoomConnectionState.Connected || !onSyncRosterPlayer || !authoritativeRosters)
      return undefined;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const syncPending = () => {
      if (cancelled) return;
      const now = Date.now();
      let nextRetryAt: number | undefined;
      const scheduleRetry = (deadline: number) => {
        nextRetryAt = nextRetryAt === undefined ? deadline : Math.min(nextRetryAt, deadline);
      };

      for (const addition of localRosterAdds) {
        const authoritative = authoritativeRosters[addition.team];
        if (
          authoritative.some((name) => name.toLocaleLowerCase() === addition.playerName.toLocaleLowerCase())
        )
          continue;
        const key = rosterSyncKey(addition.team, addition.playerName);
        if (rejectedRosterSyncs[key]) continue;
        const previous = rosterSyncAttempts.current.get(key) ?? { attempts: 0, lastAt: 0 };
        const backoff = Math.min(30_000, 5_000 * 2 ** Math.min(previous.attempts, 3));
        const retryAt = previous.lastAt + backoff;
        if (now < retryAt) {
          scheduleRetry(retryAt);
          continue;
        }

        const attempts = previous.attempts + 1;
        rosterSyncAttempts.current.set(key, { attempts, lastAt: now });
        const nextBackoff = Math.min(30_000, 5_000 * 2 ** Math.min(attempts, 3));
        scheduleRetry(now + nextBackoff);
        const teamName = addition.team === 'left' ? game.left.name : game.right.name;
        const teamId = teamIds?.[addition.team];
        const sync =
          teamId === undefined
            ? onSyncRosterPlayer(teamName, addition.playerName)
            : onSyncRosterPlayer(teamName, addition.playerName, teamId, addition.questionNumber);
        sync
          .then(async (result) => {
            if (result.ok && result.canonical) {
              // The durable package update is part of roster synchronization. Awaiting it keeps
              // concurrent additions ordered and makes a rejected persistence write observable to
              // this retry path instead of creating an unhandled promise.
              try {
                await onRosterIdentity?.(teamName, addition.playerName, result.canonical);
              } catch {
                setRejectedRosterSyncs((current) => ({ ...current, [key]: true }));
              }
            }
            if (!result.ok && result.rejected) {
              setRejectedRosterSyncs((current) => ({ ...current, [key]: true }));
            }
            return undefined;
          })
          .catch(() => undefined);
      }

      if (nextRetryAt !== undefined) {
        retryTimer = setTimeout(syncPending, Math.max(0, nextRetryAt - Date.now()));
      }
    };

    syncPending();
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
  }, [
    authoritativeRosters,
    connection,
    game.left.name,
    game.right.name,
    localRosterAdds,
    onRosterIdentity,
    onSyncRosterPlayer,
    rejectedRosterSyncs,
    teamIds,
  ]);

  /**
   * Tell tournament control how the game is going, but not on every click.
   *
   * The derived game changes with each buzz, and posting a snapshot for each one would put a request
   * on the wire every time a scorekeeper's finger comes down — far more than MODAQ's five-second
   * timer ever did, and enough on a room full of Chromebooks to look like a server fault. So: send
   * at most once per interval, and always send a trailing update so the last thing that happened is
   * never the thing that got dropped.
   */
  const lastProgressAt = useRef(0);
  useEffect(() => {
    if (!onProgress) return undefined;
    const sinceLast = Date.now() - lastProgressAt.current;
    if (sinceLast >= progressIntervalMs) {
      lastProgressAt.current = Date.now();
      onProgress(qbj, game.tossupsRead);
      return undefined;
    }
    const timer = setTimeout(() => {
      lastProgressAt.current = Date.now();
      onProgress(qbj, game.tossupsRead);
    }, progressIntervalMs - sinceLast);
    return () => clearTimeout(timer);
  }, [onProgress, qbj, game.tossupsRead]);

  const record = useCallback(
    (...added: ScoreEvent[]) => {
      if (submitting) return false;
      return events.append(...added);
    },
    [events, submitting],
  );

  /**
   * Add a player through one event and one synchronization path, wherever the name was entered.
   *
   * `activePlayers` is intentionally absent on the starting-lineup screen. That screen may grow
   * the roster, but its existing Start game action remains the only thing that writes question-1
   * lineup events.
   */
  const addRosterPlayer = useCallback(
    (team: LeftOrRight, playerName: string, activePlayers?: string[]) => {
      if (submitting) return;
      const derivedTeam = team === 'left' ? game.left : game.right;
      const current = derivedTeam.activePlayers;
      const lineupChanged =
        activePlayers !== undefined &&
        (activePlayers.length !== current.length || activePlayers.some((name) => !current.includes(name)));
      const added: ScoreEvent[] = [
        { id: newEventId(), type: 'roster-add', questionNumber: lineupQuestion, team, playerName },
      ];
      if (lineupChanged) {
        added.push({
          id: newEventId(),
          type: 'substitution',
          questionNumber: lineupQuestion,
          team,
          activePlayers,
        });
      }
      if (!record(...added)) return;

      let resultNotice: string;
      if (lineupChanged) {
        resultNotice = `Added ${playerName} and put them in starting Tossup ${lineupQuestion}.`;
      } else if (phase.kind === 'lineup' && phase.teams.includes(team)) {
        resultNotice = `Added ${playerName} to the roster. They are not selected as a starter.`;
      } else {
        resultNotice = `Added ${playerName} to the bench.`;
      }

      if (onSyncRosterPlayer && authoritativeRosters) {
        acknowledge(`${resultNotice} Syncing with tournament control.`);
        return;
      }
      if (!onRequestControl) {
        acknowledge(resultNotice);
        return;
      }

      acknowledge(`${resultNotice} Requesting tournament control.`);
      Promise.resolve()
        .then(() => onRequestControl('roster-change', `Please add ${playerName} to ${derivedTeam.name}.`))
        .then((result) => noteControlOutcome({ prefix: resultNotice, localOnly: resultNotice }, result))
        .catch(() =>
          noteControlOutcome(
            { prefix: resultNotice, localOnly: resultNotice },
            { kind: 'unreachable', error: 'Could not reach tournament control.' },
          ),
        );
    },
    [
      acknowledge,
      authoritativeRosters,
      game.left,
      game.right,
      lineupQuestion,
      noteControlOutcome,
      onRequestControl,
      onSyncRosterPlayer,
      phase,
      record,
      submitting,
    ],
  );

  const recordBuzz = useCallback(
    (team: LeftOrRight, playerName: string, answerType: IScorekeeperAnswerType) => {
      if (phase.kind !== 'tossup') return false;
      return record({
        id: newEventId(),
        type: 'tossup-buzz',
        questionNumber: phase.questionNumber,
        team,
        playerName,
        answerTypeIndex: answerType.index,
      });
    },
    [record, phase],
  );

  /**
   * A wrong answer that costs nothing.
   *
   * Not the same thing as No buzz even though both end this team's involvement: somebody answered,
   * and if the other team has not yet had its chance, it still has one.
   */
  const recordWrongNoPenalty = useCallback(
    (team: LeftOrRight, playerName: string) => {
      if (phase.kind !== 'tossup') return false;
      return record({
        id: newEventId(),
        type: 'tossup-no-penalty',
        questionNumber: phase.questionNumber,
        team,
        playerName,
      });
    },
    [record, phase],
  );

  /** The panel/keyboard speak in displayed sides; the journal always receives canonical sides. */
  const recordDisplayedBuzz = useCallback(
    (displaySide: LeftOrRight, playerName: string, answerType: IScorekeeperAnswerType) =>
      recordBuzz(canonicalForDisplay(displaySide), playerName, answerType),
    [canonicalForDisplay, recordBuzz],
  );
  const recordDisplayedWrongNoPenalty = useCallback(
    (displaySide: LeftOrRight, playerName: string) =>
      recordWrongNoPenalty(canonicalForDisplay(displaySide), playerName),
    [canonicalForDisplay, recordWrongNoPenalty],
  );

  const recordNoBuzz = useCallback(() => {
    if (phase.kind !== 'tossup') return false;
    const accepted = record({ id: newEventId(), type: 'tossup-dead', questionNumber: phase.questionNumber });
    if (accepted) setNoBuzzAcknowledgement({ token: nextTransientToken() });
    return accepted;
  }, [nextTransientToken, record, phase]);

  const recordBonusWithExit = useCallback(
    (payload: Pick<IBonusEvent, 'controlledPoints' | 'bouncebackPoints' | 'parts'>) => {
      if (phase.kind !== 'bonus') return false;
      const controllingTeamName = phase.team === 'left' ? game.left.name : game.right.name;
      const opponentName = phase.team === 'left' ? game.right.name : game.left.name;
      const accepted = record({
        id: newEventId(),
        type: 'bonus',
        questionNumber: phase.questionNumber,
        team: phase.team,
        ...payload,
      });
      if (accepted) {
        /*
         * The snapshot is of the panel that was on screen, not of a generic bonus. A part breakdown
         * leaves the part grid with its teams and its chosen outcomes; a totals panel with
         * bouncebacks leaves both rows, because both were visible when the last press landed.
         */
        const context = `Q${phase.questionNumber}`;
        if (payload.parts) {
          setBonusExit({
            token: nextTransientToken(),
            title: `${controllingTeamName} bonus`,
            context,
            content: {
              kind: 'parts',
              parts: payload.parts,
              pointsPerPart: format.bonus.pointsPerPart ?? 0,
              bounceBack: format.bonus.bounceBack,
              controllingTeamName,
              opponentName,
            },
          });
        } else {
          const controlledPoints = payload.controlledPoints ?? 0;
          const bouncebackPoints = payload.bouncebackPoints ?? 0;
          const bouncesBack = format.bonus.bounceBack;
          const totals = regularBonusTotals(format.bonus);
          const opponentTotals =
            bouncesBack && totals !== null ? bouncebackOptions(format.bonus, controlledPoints) : null;
          setBonusExit({
            token: nextTransientToken(),
            title: `${controllingTeamName} bonus`,
            context,
            content:
              totals !== null
                ? {
                    kind: 'choices',
                    rows: [
                      {
                        label: bouncesBack ? controllingTeamName : undefined,
                        options: totals,
                        selected: controlledPoints,
                      },
                      ...(opponentTotals
                        ? [{ label: opponentName, options: opponentTotals, selected: bouncebackPoints }]
                        : []),
                    ],
                  }
                : {
                    kind: 'typed',
                    fields: [
                      { label: 'Bonus points', value: controlledPoints },
                      ...(bouncesBack
                        ? [{ label: 'Points from missed parts', value: bouncebackPoints }]
                        : []),
                    ],
                  },
          });
        }
      }
      return accepted;
    },
    [format.bonus, game.left.name, game.right.name, nextTransientToken, record, phase],
  );

  const recordBonus = useCallback(
    (controlledPoints: number, bouncebackPoints?: number) =>
      recordBonusWithExit({ controlledPoints, bouncebackPoints }),
    [recordBonusWithExit],
  );

  const recordBonusParts = useCallback(
    (parts: IBonusPartResult[]) => recordBonusWithExit({ parts }),
    [recordBonusWithExit],
  );

  /**
   * A one-for-one substitution made from the player's own row on the scoresheet.
   *
   * The same two writes the Players dialog makes, in the same order: the seat so the replacement
   * takes the outgoing player's column, then the complete lineup effective at the next question
   * boundary. Nothing here is a shortcut around the engine — it is the same event, asked for in one
   * place instead of four.
   */
  const substituteFromRow = useCallback(
    (team: LeftOrRight, outgoing: string, incoming: string) => {
      if (submitting) return;
      const derivedTeam = team === 'left' ? game.left : game.right;
      const roster = derivedTeam.players.map((player) => player.name);
      const activePlayers = derivedTeam.activePlayers.slice();
      const seat = activePlayers.indexOf(outgoing);
      if (seat < 0) activePlayers.push(incoming);
      else activePlayers.splice(seat, 1, incoming);
      seating.substitute(team, roster, outgoing, incoming);
      record({ id: newEventId(), type: 'substitution', questionNumber: lineupQuestion, team, activePlayers });
      // The seat itself says most of this now — see `TeamPanel` — so the sentence is here to name the
      // tossup it takes effect from, and then to get out of the way.
      acknowledge(
        `${incoming} came on for ${outgoing} (${derivedTeam.name}), starting Tossup ${lineupQuestion}.`,
      );
    },
    [acknowledge, game.left, game.right, lineupQuestion, record, seating, submitting],
  );

  /**
   * Undo and redo, with the frame they changed said out loud.
   *
   * # Why this wraps rather than replaces
   *
   * The event stack is still the authority and still does the work; this only reads what came off
   * it. Nothing waits for the sentence — by the time it is composed the events are already gone or
   * already back, and a scorekeeper who presses undo twice quickly gets two undos and the second
   * sentence, not one undo and an animation queue.
   *
   * # Why both routes come through here
   *
   * Because the footer button and the keyboard shortcut are the same act. They used to call
   * `events.undo` directly and separately, which meant any feedback added to one of them would
   * simply not exist on the other — and the keyboard is the route used by the scorekeepers most
   * likely to be looking at the table rather than the screen when it happens.
   */
  const undoWithFeedback = useCallback(() => {
    if (submitting) return;
    const frame = events.undo();
    if (!frame || frame.length === 0) return;
    const questionNumber = frameQuestion(frame);
    acknowledge(`Undid ${frameDescription(frame, format, game)}`, questionNumber);
    if (questionNumber !== undefined) {
      setRecentMotion({
        questionNumber,
        kind: 'undo',
        token: nextTransientToken(),
        snapshot: game.questions.find((question) => question.questionNumber === questionNumber),
      });
    }
  }, [acknowledge, events, format, game, nextTransientToken, submitting]);

  const redoWithFeedback = useCallback(() => {
    if (submitting) return;
    const frame = events.redo();
    if (!frame || frame.length === 0) return;
    const questionNumber = frameQuestion(frame);
    acknowledge(`Redid ${frameDescription(frame, format, game)}`, questionNumber);
    if (questionNumber !== undefined) {
      setRecentMotion({ questionNumber, kind: 'redo', token: nextTransientToken() });
    }
  }, [acknowledge, events, format, game, nextTransientToken, submitting]);

  const benchFor = (team: LeftOrRight): string[] => {
    const derivedTeam = team === 'left' ? game.left : game.right;
    return derivedTeam.players
      .filter((player) => !derivedTeam.activePlayers.includes(player.name))
      .map((player) => player.name);
  };

  const openReviewAt = useCallback(
    (questionNumber?: number, edit = false) => {
      if (submitting) return;
      setReviewFocus(questionNumber);
      setReviewEditQuestion(edit ? questionNumber : undefined);
      setDialog('review');
    },
    [submitting],
  );

  const openReplacementAt = useCallback(
    (questionNumber: number) => {
      if (submitting) return;
      setReviewFocus(questionNumber);
      setReviewEditQuestion(undefined);
      setDialog('replace');
    },
    [submitting],
  );

  const openProtests = game.protests.filter((protest) => protest.status === 'open');
  const playBlockedByProtest =
    phase.kind === 'tossup' &&
    phase.period === 'overtime' &&
    protestBlocksSuddenDeathTossup(
      protestCheckpointPolicy(procedure),
      game.suddenDeathStarted,
      openProtests.length > 0,
    );
  const checkpointProtestBlocks = (checkpoint: 'overtime' | 'sudden-death') =>
    openProtests.length > 0 && protestBlocksCheckpoint(protestCheckpointPolicy(procedure), checkpoint);

  const scoringEnabled = phase.kind === 'tossup' && !playBlockedByProtest;
  const eligible = (side: LeftOrRight) =>
    scoringEnabled && phase.kind === 'tossup' && phase.eligibleTeams.includes(side);
  /**
   * A neg is available only before either team has used its tossup opportunity.
   *
   * Both a scored buzz and a zero-point/no-penalty answer spend that opportunity. The historical
   * reading markers below the scorer's event model are deliberately not part of live legality.
   */
  const currentQuestionState =
    phase.kind === 'tossup'
      ? game.questions.find((question) => question.questionNumber === phase.questionNumber)
      : undefined;
  const answeredTeams = new Set<LeftOrRight>([
    ...(currentQuestionState?.buzzes.map((buzz) => buzz.team) ?? []),
    ...(currentQuestionState?.noPenalty.map((missed) => missed.team) ?? []),
  ]);
  const negsAvailable = (side: LeftOrRight) => eligible(side) && answeredTeams.size === 0;
  const anyNegAvailable = negsAvailable('left') || negsAvailable('right');
  const displayedEligible = (side: LeftOrRight) => eligible(canonicalForDisplay(side));
  const displayedNegsAvailable = (side: LeftOrRight) => negsAvailable(canonicalForDisplay(side));
  /**
   * The button says the same thing all game.
   *
   * Which team is still able to buzz is said in the hint beside it, where it can change without the
   * button a scorekeeper is aiming for moving or renaming itself mid-tossup.
   */
  const noBuzzLabel = playBlockedByProtest ? 'Resolve protest before play' : 'No buzz';

  /**
   * Who is in each seat, per side, in the order the room arranged them.
   *
   * The same derivation `TeamPanel` renders from, so the key for seat three addresses whoever is in the
   * third row on screen. That is also the whole substitution story: `PlayerSeating.takeSeat` puts an
   * incoming player in the outgoing one's place, so the name behind `D` changes and the binding does
   * not.
   */
  const seatedPlayers = useMemo(
    () => ({
      left: orderBySeating(
        displayedTeams.left.players.filter((player) =>
          displayedTeams.left.activePlayers.includes(player.name),
        ),
        seating.seating[displaySideMapping.left],
        (player) => player.name,
      ).map((player) => player.name),
      right: orderBySeating(
        displayedTeams.right.players.filter((player) =>
          displayedTeams.right.activePlayers.includes(player.name),
        ),
        seating.seating[displaySideMapping.right],
        (player) => player.name,
      ).map((player) => player.name),
    }),
    [displaySideMapping, displayedTeams, seating.seating],
  );

  /**
   * Keeping the table standing across a lineup change nobody described seat by seat.
   *
   * A one-for-one substitution already says who sat down where — `seating.substitute` is called at the
   * moment the room says "eleven for four", and by the time this runs there is nothing left to work
   * out. A bulk change is the other case: the event stores the complete lineup and deliberately says
   * nothing about physical seats, because a seat is not scoring history and putting one in a
   * substitution event would be recording a fact nobody stated.
   *
   * So the seats are reconciled here instead — survivors keep their chairs, the emptied ones are
   * filled in order — and when two or more chairs changed hands the scorekeeper is told to check it
   * rather than left to discover it. See `reseatLineup`.
   *
   * Canonical sides throughout: this is the seat order itself, not a view of it.
   */
  const [tableOrderCheck, setTableOrderCheck] = useState<{ token: number } | null>(null);
  const previousActivePlayers = useRef<Record<LeftOrRight, readonly string[]> | null>(null);
  useEffect(() => {
    const next: Record<LeftOrRight, readonly string[]> = {
      left: game.left.activePlayers,
      right: game.right.activePlayers,
    };
    const previous = previousActivePlayers.current;
    previousActivePlayers.current = next;
    // Nothing to preserve on the first render, and nothing to preserve before anybody is on the floor.
    if (previous === null) return;

    const rosterNames: PlayerSeating = {
      left: game.left.players.map((player) => player.name),
      right: game.right.players.map((player) => player.name),
    };
    const visibleOrders: Partial<PlayerSeating> = {};
    let bulk = false;
    for (const side of ['left', 'right'] as LeftOrRight[]) {
      if (sameMembership(previous[side], next[side])) continue;
      const seated = orderBySeating(next[side], seating.seating[side], (name) => name);
      const result = reseatLineup(seating.seating[side], previous[side], next[side]);
      if (result.vacated >= 2) bulk = true;
      // A change the seating store has already absorbed leaves the order it would produce, so
      // writing it again would be a storage write per substitution for no change at all.
      if (result.seats.length !== seated.length || result.seats.some((name, seat) => name !== seated[seat])) {
        visibleOrders[side] = result.seats;
      }
    }
    if (Object.keys(visibleOrders).length > 0) seating.arrange(rosterNames, visibleOrders);
    if (bulk) setTableOrderCheck({ token: nextTransientToken() });
  }, [game.left, game.right, nextTransientToken, seating]);

  /**
   * Nobody on this device has said what order the room is sitting in.
   *
   * The starting-lineup prompt writes a seating preference when it confirms, so this is only ever
   * true for the game it never appears for: a roster of exactly the maximum, everybody starting
   * automatically, and a table whose order is therefore whatever the roster happened to be in.
   */
  const arrangementUnconfirmed = seating.seating.left.length === 0 && seating.seating.right.length === 0;
  /*
   * Whether the room has already answered that question.
   *
   * Held here rather than in `TableView`, which is unmounted every time the scorekeeper looks at the
   * scoresheet: a hint that came back after being dismissed would be a hint nobody had really been
   * asked. Presentation only, and deliberately not persisted — it is true for this sitting.
   */
  const [tableHintDismissed, setTableHintDismissed] = useState(false);

  /**
   * Whether anything modal currently owns the screen.
   *
   * The layout question is not one of the scorer's ordinary dialogs — it opens on its own, from the
   * state of the game rather than from a menu — but it is a dialog, and everything that has to stand
   * back for one has to stand back for it: the keyboard layer, the ruling picker, the legend.
   */
  const layoutChooserOpen = layoutPromptOpen || dialog === 'scoring-layout';
  const anyDialogOpen = dialog !== null || layoutPromptOpen;

  /**
   * The layout question, answered.
   *
   * One press does all of it: the layout changes, the device remembers it for the next game, and
   * this game is marked as asked so a reload does not ask again. Dismissing is the same answer with
   * whichever card the dialog is showing as selected — see `ScoringLayoutDialog` — so it arrives
   * here as an ordinary answer rather than as a separate route that leaves the layout alone.
   */
  const answerLayoutPrompt = useCallback(
    (layout?: ScoringView) => {
      if (layout) setScoringView(layout);
      rememberScoringLayoutChoice(gameKey);
      setLayoutPromptOpen(false);
      setDialog((current) => (current === 'scoring-layout' ? null : current));
    },
    [gameKey],
  );

  /** The seat a keystroke just scored into, flashed briefly and then forgotten. */
  const [keyEcho, setKeyEcho] = useState<{ side: LeftOrRight; seat: number } | null>(null);
  useEffect(() => {
    if (keyEcho === null) return undefined;
    // Long enough to register in peripheral vision, short enough that consecutive tossups do not queue
    // up behind each other. Nothing waits on it and nothing is announced.
    const timer = window.setTimeout(() => setKeyEcho(null), 450);
    return () => window.clearTimeout(timer);
  }, [keyEcho]);

  /**
   * The running commentary on the keyboard sequence, shown at the bottom of the screen.
   *
   * Distinct from `keyEcho`, which is a wash on a roster row and says only *where* a ruling landed.
   * This says what the keyboard is doing and survives long enough to be read: a chosen seat stays up
   * until it resolves or expires, and the ruling it resolves to stays up on its own timer.
   */
  const [keyStatus, setKeyStatus] = useState<IKeyboardStatus | null>(null);
  useEffect(() => {
    // A waiting seat has no timer of its own. The keyboard layer already expires it and says so, and a
    // second countdown here would be a copy of that rule, free to disagree with it.
    if (keyStatus?.kind !== 'ruled') return undefined;
    const timer = window.setTimeout(() => setKeyStatus(null), 1400);
    return () => window.clearTimeout(timer);
  }, [keyStatus]);

  useScorerKeyboard({
    keyboardEnabled,
    format,
    scoringEnabled,
    negsAvailable: displayedNegsAvailable,
    eligible: displayedEligible,
    seatedPlayers,
    dialogOpen: anyDialogOpen,
    noBuzzAllowed: phase.kind === 'tossup' && !playBlockedByProtest,
    seatLayoutKey: displaySideMapping.left,
    // The same callbacks the buttons are given. A keystroke cannot reach a code path a tap cannot.
    onBuzz: recordDisplayedBuzz,
    onWrongNoPenalty: recordDisplayedWrongNoPenalty,
    onNoBuzz: recordNoBuzz,
    onUndo: undoWithFeedback,
    onRedo: redoWithFeedback,
    onSeatArmed: (seat) =>
      setKeyStatus({
        kind: 'armed',
        seat,
        actions: availableActionKeys(format, displayedNegsAvailable(seat.side)),
      }),
    onSequenceCleared: () => setKeyStatus(null),
    onEcho: ({ side, seat, number, playerName, action, answerType }) => {
      setKeyEcho({ side, seat });
      setKeyStatus({
        kind: 'ruled',
        seat: { side, seat, number, playerName },
        // The name of the action plus what this format pays for it. A wrong answer with no penalty has
        // no answer type behind it, and saying "0" is more honest than inventing a ruling for it.
        ruling:
          answerType === null
            ? `${keyboardActionNames[action]} 0`
            : `${keyboardActionNames[action]} ${rulingLabel(answerType)}`,
      });
    },
  });

  /**
   * What the legend says right now.
   *
   * Derived rather than stored, so it cannot fall out of step with the screen. Ordered by what actually
   * has the keyboard: a dialog takes everything, then the bonus, then the tossup.
   */
  const keyboardContext = useMemo<KeyboardMapContext>(() => {
    if (anyDialogOpen) return { kind: 'inactive', reason: 'Finish what is open first.' };
    if (bonusStage !== null) {
      /*
       * Both bonus stages render as the same strip of key/meaning rows, but what a row means is not
       * the same thing: a totals row is a value and a part row is who scored it. The meanings are
       * built where the distinction is still in the type, so the legend names the actual teams
       * rather than listing numbers that would not answer the question being asked.
       */
      if (bonusStage.kind === 'part') {
        return {
          kind: 'choices',
          title: bonusStage.title,
          choices: bonusPartKeyLegend(bonusStage.choices),
          cancellable: false,
        };
      }
      if (bonusStage.kind === 'record') {
        // Not a shortcut of its own: Record has the focus by now, so Enter is that button. Saying so
        // is the point — and saying what it will write is what makes it safe to press without looking.
        return {
          kind: 'choices',
          title: bonusStage.title,
          choices: [{ keys: 'Enter', meaning: `record ${bonusStage.summary}`, available: true }],
          cancellable: false,
        };
      }
      return {
        kind: 'choices',
        title: bonusStage.title,
        choices: bonusKeyLegend(bonusStage.options),
        cancellable: bonusStage.cancellable,
      };
    }
    if (phase.kind === 'bonus') {
      // A bonus whose totals are typed rather than chosen. Its digits belong to the number fields.
      return { kind: 'inactive', reason: 'Type the bonus total.' };
    }
    if (phase.kind !== 'tossup') return { kind: 'inactive', reason: 'No tossup is live.' };
    if (playBlockedByProtest) return { kind: 'inactive', reason: 'Resolve the protest first.' };
    return {
      kind: 'tossup',
      actions: sequenceLegend(format, anyNegAvailable),
      unreachable: unreachableAnswerTypes(format).map(rulingLabel),
    };
  }, [anyDialogOpen, bonusStage, phase.kind, playBlockedByProtest, format, anyNegAvailable]);

  const lineupChangeAllowed = lineupChangeAllowedAtPhase(substitutionPolicy(procedure), phase.kind);
  /**
   * A lineup change somebody authorized for this team but the procedure would not otherwise offer.
   *
   * The screen has to know as well as the guard does. A room that records a director's ruling and
   * then finds Sub still greyed out has been given a way in and no way through, which is the dead
   * end this whole route exists to remove.
   */
  const lineupChangeAuthorized: Record<LeftOrRight, boolean> = {
    left: phase.kind !== 'complete' && substitutionAllowed(events.events, 'left'),
    right: phase.kind !== 'complete' && substitutionAllowed(events.events, 'right'),
  };
  const rosterAdditionAllowed = phase.kind !== 'complete';
  const substitutionMessage =
    phase.kind === 'complete'
      ? 'This game is complete. Use scoresheet review to correct historical lineup information.'
      : lineupChangeAllowed
        ? procedure
          ? `Lineup changes are available ${substitutionOpportunityPhrase(procedure)}.`
          : 'QBSheet can record lineup changes here; follow the tournament procedure for when they are allowed.'
        : procedure
          ? `Lineup changes are available ${substitutionOpportunityPhrase(procedure)}.`
          : 'Lineup changes are not offered in this phase.';
  const lineupChangeReason = substitutionMessage;

  const timeoutDurationMs = (procedure?.timeoutDurationSeconds ?? 0) * 1000;
  const timeoutRemainingMs =
    phase.kind === 'timeout' && timeoutDurationMs > 0 && game.activeTimeout?.startedAt !== undefined
      ? Math.max(0, timeoutDurationMs - Math.max(0, timeoutNow - game.activeTimeout.startedAt))
      : undefined;

  const unsyncedRosterAdditions = useMemo(
    () =>
      localRosterAdds
        .filter(
          (addition) => rosterSyncStatus[rosterSyncKey(addition.team, addition.playerName)] !== 'synced',
        )
        .map((addition) => ({ team: addition.team, playerName: addition.playerName })),
    [localRosterAdds, rosterSyncStatus],
  );

  /** Things worth saying before a result is sent, without stopping anybody scoring. */
  const warnings = useMemo(() => {
    const found: string[] = [];
    const unfinished = game.questions.filter((question) => !question.resolved || question.awaitingBonus);
    if (unfinished.length > 0) {
      found.push(
        `Question ${unfinished[0].questionNumber} is not finished${
          unfinished.length > 1 ? ` (and ${unfinished.length - 1} more)` : ''
        }.`,
      );
    }
    if (game.regulationComplete && game.left.points === game.right.points) found.push('This game is a tie.');
    for (const problem of scoresheetValidation.warnings) found.push(problem.message);
    return found;
  }, [game, scoresheetValidation.warnings]);

  /** Problems that stop a result being sent at all, as opposed to ones worth mentioning. */
  const blockers = useMemo(
    () => scoresheetValidation.blockers.map((problem) => problem.message),
    [scoresheetValidation.blockers],
  );

  /** Whether the cycle on screen has a bonus that could be replaced on its own. */
  const currentCycleHasBonus =
    (phase.kind === 'tossup' || phase.kind === 'bonus') &&
    game.questions.some(
      (question) =>
        question.questionNumber === phase.questionNumber &&
        (question.bonus !== undefined || question.awaitingBonus),
    );

  /**
   * What this room calls the break it is at.
   *
   * Named from the schedule where there is one. A room breaking after tossup 5 of 24 is not at
   * halftime, and telling it that it is makes the scoresheet look like it has lost the round.
   *
   * By how many breaks have been taken rather than by the tossup this one was recorded at — see
   * `roomBreakTaken`. A room that overran its first break and stopped after tossup 12 is at its
   * first break, not at whichever scheduled break happens to sit nearest to 12.
   */
  const currentBreakName = roomBreaksAreScheduled(procedure)
    ? roomBreakLabel(
        procedure,
        roomBreakTaken(procedure, phase.kind === 'score-check' ? game.halfBreaks.length : 0),
      )
    : 'Halftime';
  const progressText = (() => {
    if (phase.kind === 'complete') return 'Game complete';
    if (phase.kind === 'lineup') return 'Choose starters';
    if (phase.kind === 'score-check') return `${currentBreakName} · after tossup ${phase.afterQuestion}`;
    if (phase.kind === 'checkpoint') {
      return phase.checkpoint === 'overtime' ? 'Regulation complete' : 'Initial overtime complete';
    }
    if (phase.kind === 'timeout') return `Timeout · ${displayedTeams[displayForCanonical(phase.team)].name}`;
    if (phase.period === 'overtime') {
      const overtimeNumber = game.overtimeTossupsRead + (phase.kind === 'tossup' ? 1 : 0);
      return `Overtime tossup ${Math.max(1, overtimeNumber)}${game.suddenDeathStarted ? ' · sudden death' : ''}`;
    }
    if (format.regulation.timed) return `Tossup ${phase.questionNumber} · timed round`;
    return `Tossup ${phase.questionNumber} of ${format.regulation.tossupCount}`;
  })();
  const progressMotion = (() => {
    if (phase.kind !== 'tossup' && phase.kind !== 'bonus') return null;
    if (phase.period === 'overtime') {
      const overtimeNumber = game.overtimeTossupsRead + (phase.kind === 'tossup' ? 1 : 0);
      return {
        prefix: 'Overtime tossup ',
        value: Math.max(1, overtimeNumber),
        suffix: game.suddenDeathStarted ? ' · sudden death' : '',
        digits: 1,
      };
    }
    return {
      prefix: 'Tossup ',
      value: phase.questionNumber,
      suffix: format.regulation.timed ? ' · timed round' : ` of ${format.regulation.tossupCount}`,
      digits: format.regulation.timed ? 2 : String(format.regulation.tossupCount).length,
    };
  })();

  /**
   * Hand the current scoresheet to the application to write out.
   *
   * The scorer does not write the file itself. Turning a scored game into something a person can
   * carry away means knowing which game package it came from, what the file should be called and
   * what has to be stripped out of it first (see `PortableQbj`), and none of that is knowledge the
   * scoring surface should have. What it has is a payload and a request.
   */
  const downloadQbj = useCallback(() => onDownload(qbj), [onDownload, qbj]);

  /**
   * Save the complete QBSheet recovery envelope. The current segment is read from the hook as well
   * as the other persisted segments because a clock tick is intentionally not a React render; the
   * export must snapshot the value visible at the instant the scorekeeper presses the button.
   */
  const downloadQbsheetBackup = useCallback(() => {
    if (!onDownloadQbsheetBackup || !gamePackage) return;
    const now = Date.now();
    const clocks = exportRoomClocks(gameKey, now);
    clocks[clockSegment] = snapshotRoomClock(roomClock.state, now);
    onDownloadQbsheetBackup(
      createQbsheetBackup({
        gamePackage,
        setup,
        events: events.events,
        history: events.recoveryHistory(),
        clocks,
        display: { mapping: displaySideMapping, seating: seating.seating },
      }),
    );
  }, [
    clockSegment,
    displaySideMapping,
    events,
    gameKey,
    gamePackage,
    onDownloadQbsheetBackup,
    roomClock.state,
    seating.seating,
    setup,
  ]);

  /**
   * Apply a correction to the game's definition, and leave a record of it in the game itself.
   *
   * The note is the whole reason this is not the prop passed straight down. A result whose scores
   * were repriced, or whose roster was renamed, mid-game and says nothing about it is a result that
   * looks, to whoever imports it on Monday, exactly like one scored wrong. A note event travels into
   * the QBJ with everything else, so the answer is in the document rather than in somebody's memory
   * of the morning.
   *
   * Written into the history handed upward rather than appended through `events.append`, because the
   * two have to be persisted together: `ScoringScreen` writes this array and the corrected definition
   * as one operation, and an `append` here would be a third write racing the other two.
   */
  const applyCorrection = async (correction: IProposedGameCorrection) => {
    if (!onCorrectGame) return;
    const note: ScoreEvent = {
      id: newEventId(),
      // `currentQuestion`, not `lastPlayedQuestion`: cycles are 1-based, and a correction made
      // before the first tossup has been scored would otherwise file its note against question zero.
      questionNumber: currentQuestion,
      type: 'note',
      text: correction.summary === '' ? correctionNote('The game was corrected') : correction.summary,
    };
    await onCorrectGame({
      ...correction,
      events: [...correction.events, note],
      /*
       * The way back, supplied here because this is the only place that still knows it.
       *
       * The host writes the history and the definition to two different storages and the second can
       * be refused after the first has been accepted; see `correctGame` in `ScoringScreen` for what
       * that leaves behind. Nothing about a rewritten array says where it came from, so the way back
       * has to travel with it.
       *
       * The note goes on `events` and deliberately not on `previousEvents`: the second is the
       * history to restore if the write is refused, and a game that was not corrected must not come
       * back carrying a note saying it was.
       *
       * `previousSetup` only when the correction rewrote the rosters. A correction that left them
       * alone must not hand back a `setup` for the journal to rewrite on the way out.
       */
      previousEvents: events.events,
      previousSetup: correction.setup ? setup : undefined,
    });
  };

  const applyScoringRulesCorrection = async (correction: IScoringRulesCorrection) => {
    const detail = correctionSummary(correction.changes);
    await applyCorrection({
      ...correction,
      summary: correctionNote(detail === '' ? 'Scoring rules updated' : `Scoring rules: ${detail}`),
    });
  };

  /**
   * The two name corrections, computed by the engine and persisted by the host.
   *
   * Both run the pure function first and only then write, so a refusal — a name that would make the
   * two teams indistinguishable, a merge nobody asked for — never reaches persistence at all. The
   * preview functions beside them are the same calls with the write left off, which is how the field
   * can complain while somebody is still typing rather than at Save.
   */
  const teamNameProblem = (side: LeftOrRight, name: string): string[] => {
    const attempt = correctTeamName({ setup, events: events.events }, side, name);
    return attempt.ok ? [] : attempt.problems;
  };
  const playerNameProblem = (side: LeftOrRight, from: string, to: string) => {
    const attempt = correctPlayerName({ setup, events: events.events }, side, from, to);
    if (attempt.ok) return { problems: [] };
    return {
      problems: attempt.problems,
      ...(attempt.mergeAvailable
        ? {
            mergeWith: setup[side].players.find(
              (player) => player.trim().toLowerCase() === to.trim().toLowerCase(),
            ),
          }
        : {}),
    };
  };
  const applyTeamNameCorrection = async (side: LeftOrRight, name: string) => {
    const attempt = correctTeamName({ setup, events: events.events, playerIds: qbjPlayerIds }, side, name);
    if (!attempt.ok || attempt.changes.length === 0) return;
    await applyCorrection({
      events: attempt.events,
      setup: attempt.setup,
      ...(attempt.playerIds ? { playerIds: attempt.playerIds } : {}),
      changes: attempt.changes,
      summary: attempt.summary,
    });
  };
  const applyPlayerNameCorrection = async (side: LeftOrRight, from: string, to: string, merge: boolean) => {
    const attempt = correctPlayerName(
      { setup, events: events.events, playerIds: qbjPlayerIds },
      side,
      from,
      to,
      { merge },
    );
    if (!attempt.ok || attempt.changes.length === 0) return;
    await applyCorrection({
      events: attempt.events,
      setup: attempt.setup,
      ...(attempt.playerIds ? { playerIds: attempt.playerIds } : {}),
      changes: attempt.changes,
      summary: attempt.summary,
    });
    /*
     * The seat follows the corrected name.
     *
     * The seating preference is keyed by name, so leaving it alone would point it at a spelling
     * nobody has any more — and `orderBySeating` puts a name it does not recognize at the end. A
     * scorekeeper who fixed a typo would watch that player cross the room. Not an event, because
     * nobody moved; the correction that renamed them is already in the history.
     *
     * After the write and not before it: a host that refuses the correction must not be left with a
     * table arranged around a name the roster never took.
     */
    seating.rename(side, from, to);
  };

  /**
   * Whether the engine would accept this exception, asked before the form offers to record it.
   *
   * The same guard the append goes through, so the dialog cannot present a grant that Save would
   * then refuse — and so the one grant the engine genuinely will not make (lengthening regulation
   * after overtime has begun) explains itself in the form rather than as a rejected action.
   */
  const exceptionRefusal = (input: IProcedureExceptionInput): string | undefined => {
    const verdict = canApplyScoreEvent(
      { format, setup, procedure },
      events.events,
      {
        id: 'procedure-exception-preview',
        type: 'procedure-exception',
        questionNumber: currentQuestion,
        allowance: input.allowance,
        authority: input.authority,
        reason: input.reason,
        ...(input.team ? { team: input.team } : {}),
      },
      game,
    );
    return verdict.ok ? undefined : verdict.reason;
  };

  const recordProcedureException = (input: IProcedureExceptionInput) => {
    if (submitting) return;
    const accepted = record({
      id: newEventId(),
      type: 'procedure-exception',
      questionNumber: currentQuestion,
      allowance: input.allowance,
      authority: input.authority,
      reason: input.reason,
      ...(input.team ? { team: input.team } : {}),
    });
    if (accepted) acknowledge('Recorded what the room was told.', currentQuestion);
  };

  const applyProcedureCorrection = async (next: IRoomProcedure, summary: string) => {
    await applyCorrection({
      events: events.events,
      procedure: next,
      changes: [],
      summary,
    });
  };

  /**
   * Strike out an overtime a correction has made unnecessary.
   *
   * The note goes in with the removal rather than after it, so the two are one write and the result
   * can never hold the second without the first. See `overtimeCorrection`.
   */
  const removeOvertimeTossups = () => {
    if (submitting) return;
    const removed = overtimeQuestionNumbers(game);
    const next = removeOvertime(events.events, game);
    if (next.length === events.events.length) return;
    const applied = events.correctHistory([
      ...next,
      {
        id: newEventId(),
        type: 'note',
        questionNumber: currentQuestion,
        text: overtimeRemovalNote(removed),
      },
    ]);
    if (applied) acknowledge('Overtime struck out. The score is regulation alone.');
  };

  /** Open the procedure dialog on whatever was just refused, or on nothing in particular. */
  const openProcedureDialog = (topic?: ProcedureTopic, team?: LeftOrRight) => {
    setProcedureTopic(topic);
    setProcedureTeam(team);
    setDialog('procedure');
  };

  // `onRedo` intentionally closes over the scorer's event/motion refs; it is invoked by the menu,
  // never during this render. The hooks linter cannot see that boundary through the pure menu
  // factory, so keep the call explicit rather than weakening the feedback path.
  // eslint-disable-next-line react-hooks/refs
  const menuItems = scorerMenuItems({
    game,
    format,
    phase,
    procedure,
    currentQuestion,
    lastPlayed: lastPlayedQuestion(game),
    keyboardEnabled,
    submitting,
    canRedo: events.canRedo,
    onRedo: redoWithFeedback,
    canDownloadForms: onDownloadForm !== undefined,
    canCorrectGame: onCorrectGame !== undefined,
    openDialog: (next) => {
      setDialog(next);
    },
    setKeyboardEnabled,
    record,
    newEventId,
    openReview: () => openReviewAt(undefined),
    openReplacement: openReplacementAt,
    downloadQbjBackup: downloadQbj,
    downloadPartialQbj: () => onDownloadForm?.(game, 'partial'),
    downloadLegacyQbj: () => onDownloadForm?.(game, 'legacy-match'),
    openExport: () => setDialog('export'),
    print,
  });

  const submit = async () => {
    if (submitInFlight.current) return;
    submitInFlight.current = true;
    setSubmitting(true);
    setSubmitResult(null);
    try {
      setSubmitResult(await onSubmit(qbj));
    } catch {
      setSubmitResult({
        ok: false,
        message: 'This result could not be sent. It is still saved on this device.',
      });
    } finally {
      submitInFlight.current = false;
      setSubmitting(false);
    }
  };

  /**
   * Normalize every ambient status source into the one notice center. The IDs describe the
   * condition, while fingerprints describe its current meaning; a repeated room poll therefore
   * cannot create a fresh dismissal target, but a changed error can surface deliberately.
   */
  const scorerNotices = useMemo<IScorerNotice[]>(() => {
    const found: IScorerNotice[] = [];
    const add = (notice: IScorerNotice) => found.push(notice);

    if (recoveryStatus.recordDurablyStored === false) {
      add({
        id: 'durability-record',
        fingerprint: 'record-not-durable',
        tone: 'error',
        title: 'Temporary — do not close this tab.',
        body: 'The complete game record is not currently durable on this device. Download a QBJ backup now and again when the game ends.',
        priority: 0,
        persistent: true,
        actions: [{ label: 'Download QBJ backup', onSelect: downloadQbj }],
      });
    }
    if (!recoveryStatus.localSaveOk) {
      add({
        id: 'durability-journal',
        fingerprint: 'event-journal-save-failed',
        tone: 'error',
        title: 'Event journal save failed — do not reload or close this tab.',
        body: 'The game currently exists only on this screen. Download a QBJ backup now and again when the game ends.',
        priority: 1,
        persistent: true,
        actions: [{ label: 'Download QBJ backup', onSelect: downloadQbj }],
      });
    }

    for (const alert of alerts ?? []) {
      const tone: IScorerNotice['tone'] = alert.tone === 'error' ? 'error' : alert.tone;
      add({
        id: `room-alert:${alert.id}`,
        fingerprint: `${alert.tone}|${alert.title}|${alert.body ?? ''}|${alert.actions?.map((action) => action.label).join(',') ?? ''}|${alert.offerDownload ? 'download' : ''}`,
        tone,
        title: alert.title,
        body: alert.body,
        actions: [
          ...(alert.actions ?? []),
          ...(alert.offerDownload ? [{ label: 'Download QBJ backup', onSelect: downloadQbj }] : []),
        ],
        priority: alert.tone === 'error' ? 10 : alert.tone === 'warning' ? 20 : 45,
        persistent: true,
      });
    }

    if (connection === RoomConnectionState.Offline && recoveryStatus.localSaveOk) {
      add({
        id: 'connection-offline',
        fingerprint: `offline|${offlineBody(recoveryStatus)}`,
        tone: 'warning',
        title: 'Offline — keep scoring.',
        body: offlineBody(recoveryStatus),
        priority: 40,
        persistent: true,
        actions: [{ label: 'Download QBJ backup', onSelect: downloadQbj }],
      });
    } else if (connection !== RoomConnectionState.Offline && degradedMessage) {
      add({
        id: 'connection-degraded',
        fingerprint: degradedMessage,
        tone: 'warning',
        message: degradedMessage,
        priority: 41,
        persistent: true,
      });
    }

    if (recoveryNotice) {
      add({
        id: 'recovery-notice',
        fingerprint: recoveryNotice,
        tone: 'info',
        message: recoveryNotice,
        priority: 60,
        transient: false,
        autoDismissMs: recoveryNoticeMs,
        dismissible: true,
        dismissLabel: 'Dismiss recovery notice',
        dismissGlyph: true,
      });
    }

    if (operationNotice) {
      const isRecovery = operationNotice.message.startsWith('Recovered the in-progress game');
      add({
        id: 'operation',
        fingerprint: `${operationNotice.tone}|${operationNotice.message}|${operationNotice.transient ? 'transient' : 'persistent'}`,
        tone: operationNotice.tone === 'warning' ? 'warning' : 'info',
        message: operationNotice.message,
        // A persistent replacement instruction is the next required workflow step, so it keeps
        // the expanded slot ahead of a simultaneous stale rejection receipt. Ordinary receipts
        // remain below actionable warnings and failures.
        priority: operationNotice.transient ? (operationNotice.tone === 'warning' ? 25 : 50) : 18,
        transient: operationNotice.transient,
        persistent: !operationNotice.transient && operationNotice.autoDismissMs === undefined,
        autoDismissMs:
          operationNotice.autoDismissMs ?? (operationNotice.transient ? operationNoticeMs : undefined),
        dismissible: operationNotice.dismissible !== false,
        onDismiss: dismissOperationNotice,
        onExpire: dismissOperationNotice,
        dismissLabel: isRecovery ? 'Dismiss recovery notice' : 'Dismiss notice',
        dismissGlyph: isRecovery,
      });
    }

    if (events.rejection) {
      add({
        id: 'event-rejection',
        fingerprint: events.rejection,
        tone: 'warning',
        message: events.rejection,
        /*
         * The way out of a dead end, and only where there is one.
         *
         * `rejectionEscape` is set by the guard for the refusals a *setting* caused, so this appears
         * beside "Central A has already used its timeout" and never beside "Central A has already
         * answered this tossup". Nothing renders for an ordinary refusal.
         */
        actions:
          events.rejectionEscape !== undefined
            ? [
                {
                  label: 'Procedure changed?',
                  onSelect: () => openProcedureDialog(events.rejectionEscape),
                },
              ]
            : undefined,
        priority: 24,
        // Keep a rejected score action discoverable until the next accepted event. It is easy to
        // miss while looking at the players, and silently losing it after a short timer would make
        // a double tap indistinguishable from a missed tap.
        persistent: true,
        onDismiss: events.clearRejection,
        onExpire: events.clearRejection,
      });
    }

    switch (controlRequest.kind) {
      case 'sending':
        add({
          id: 'control-request',
          fingerprint: `sending|${controlRequest.category}|${controlRequest.message}`,
          tone: 'info',
          message: 'Requesting tournament control…',
          priority: 50,
          persistent: true,
        });
        break;
      case 'outstanding':
        add({
          id: 'control-request',
          fingerprint: `outstanding|${controlRequest.request.id ?? ''}|${controlRequest.request.message}|${controlRequest.requestedAt}`,
          tone: 'info',
          message: `Tournament control requested · ${helpRequestCategoryLabels[controlRequest.request.category]} · ${formatControlRequestTime(
            controlRequest.requestedAt,
            controlRequest.requestedAtSource,
          )}`,
          priority: 50,
          persistent: true,
          actions:
            onCancelControlRequest && controlRequest.request.id && controlRequest.canCancel !== false
              ? [{ label: 'Cancel request for control', onSelect: () => void onCancelControlRequest() }]
              : undefined,
        });
        break;
      case 'failed':
        add({
          id: 'control-request',
          fingerprint: `failed|${controlRequest.category}|${controlRequest.message}|${controlRequest.error}`,
          tone: 'warning',
          message: 'Tournament control was not reached.',
          priority: 26,
          persistent: true,
          actions:
            onRetryControlRequest && controlRequest.retryable
              ? [{ label: 'Try request again', onSelect: () => void onRetryControlRequest() }]
              : undefined,
        });
        break;
      case 'refused':
        add({
          id: 'control-request',
          fingerprint: `refused|${controlRequest.category}|${controlRequest.message}|${controlRequest.error}|${controlRequest.status ?? ''}`,
          tone: 'warning',
          message: 'Tournament control refused this request.',
          priority: 26,
          persistent: true,
          actions:
            onRetryControlRequest && controlRequest.retryable
              ? [{ label: 'Try request again', onSelect: () => void onRetryControlRequest() }]
              : undefined,
        });
        break;
      default:
        break;
    }

    // These are the same warnings previously shown as a second, growing footer row. They remain
    // discoverable without consuming any vertical space beside the scoring controls.
    for (const warning of scoresheetValidation.warnings) {
      add({
        id: `scoresheet-warning:${warning.code}:${warning.questionNumber ?? ''}`,
        fingerprint: warning.message,
        tone: 'warning',
        message: warning.message,
        // Keep these in the issues route behind a receipt for the action that just happened. Once
        // the receipt expires, the warning naturally becomes the expanded notice.
        priority: 70,
        persistent: true,
      });
    }
    if (game.regulationComplete && game.left.points === game.right.points) {
      add({
        id: 'scoresheet-warning:tie',
        fingerprint: 'This game is a tie.',
        tone: 'warning',
        message: 'This game is a tie.',
        priority: 70,
        persistent: true,
      });
    }
    return found;
  }, [
    alerts,
    connection,
    controlRequest,
    degradedMessage,
    dismissOperationNotice,
    downloadQbj,
    events.clearRejection,
    events.rejection,
    events.rejectionEscape,
    onCancelControlRequest,
    onRetryControlRequest,
    operationNotice,
    recoveryNotice,
    recoveryStatus,
    scoresheetValidation.warnings,
    game.left.points,
    game.right.points,
    game.regulationComplete,
  ]);

  return (
    <div className="scorer">
      <header className="scorer-header">
        <div className="scorer-header-brand">
          <div className="scorer-brand" aria-label="QBSheet">
            <BrandLogo className="scorer-brand-logo" />
          </div>
          <div className="scorer-header-main">
            <h1 className="scorer-tournament">{tournamentName}</h1>
            <p className="scorer-context">
              {roundName}
              {roomName && <> · {roomName}</>}
              {packetName && <> · {packetName}</>}
            </p>
          </div>
        </div>
        <div className="scorer-header-side">
          <div className="scorer-header-status">
            <span className={progressMotion ? 'scorer-progress has-motion-number' : 'scorer-progress'}>
              {progressMotion ? (
                <>
                  <span
                    className="scorer-progress-copy"
                    style={
                      {
                        '--scorer-progress-missing-digit-width': `${Math.max(
                          0,
                          progressMotion.digits - String(progressMotion.value).length,
                        )}ch`,
                      } as CSSProperties
                    }
                  >
                    {progressText}
                  </span>
                  <span
                    className="scorer-progress-visual"
                    data-prefix={progressMotion.prefix}
                    data-suffix={progressMotion.suffix}
                    aria-hidden="true"
                  >
                    <MotionNumber value={progressMotion.value} minimumDigits={progressMotion.digits} />
                  </span>
                </>
              ) : (
                progressText
              )}
            </span>
            {roomClock.configured && (
              <ClockControl
                status={roomClock.state.status}
                display={roomClock.display}
                onStart={roomClock.start}
                onPause={roomClock.pause}
                onResume={roomClock.resume}
                onReset={resetRoomClock}
              />
            )}
            <button
              type="button"
              className={`${connectionClass(connection)}${connectionRecovery ? ' is-recovered' : ''}`}
              data-recovery-token={connectionRecovery?.token}
              aria-label={`${statusLabel ?? `Connection: ${connectionLabel(connection)}`}. Show connection detail`}
              onClick={() => {
                setDetailNow(Date.now());
                setDialog('connection');
              }}
            >
              <span className="scorer-dot" aria-hidden="true" />
              {statusLabel ?? connectionLabel(connection)}
            </button>
          </div>
          {/*
            Who this device thinks is scoring, under the round and the status pill.

            The full name rather than the first, because this line is the one place on the scoresheet
            that shows what will go out on the result as the scorekeeper — a "Gibby" in the header
            over a "Gibson Bell" in the submitted match is a mismatch nobody can check mid-game.
            Absent when nobody has named themselves, since an empty label claims a fact.
          */}
          {operatorName?.trim() && (
            <span className="scorer-operator">Scorekeeper: {operatorName.trim()}</span>
          )}
        </div>
      </header>

      <ScorerNoticeCenter notices={scorerNotices} />

      {phase.kind === 'lineup' && (
        <StartingLineupPrompt
          left={displayedTeams.left}
          right={displayedTeams.right}
          maximumActive={format.players.maximumActive}
          needed={phase.teams.map(displayForCanonical)}
          procedure={procedure}
          requiredStarterCount={
            Object.fromEntries(
              (['left', 'right'] as LeftOrRight[]).flatMap((displaySide) => {
                const count = requiredStarterCount?.[canonicalForDisplay(displaySide)];
                return count === undefined ? [] : [[displaySide, count]];
              }),
            ) as Partial<Record<LeftOrRight, number>>
          }
          onAddPlayer={(displaySide, playerName) =>
            addRosterPlayer(canonicalForDisplay(displaySide), playerName)
          }
          onConfirm={(lineups) => {
            const canonicalLineups: Partial<Record<LeftOrRight, string[]>> = {};
            for (const displaySide of ['left', 'right'] as LeftOrRight[]) {
              const lineup = lineups[displaySide];
              if (lineup !== undefined) canonicalLineups[canonicalForDisplay(displaySide)] = lineup;
            }
            const problem = validateStartingLineups?.(canonicalLineups);
            if (problem) return problem;
            seating.arrange(
              {
                left: game.left.players.map((player) => player.name),
                right: game.right.players.map((player) => player.name),
              },
              canonicalLineups,
            );
            const chosen = (Object.keys(canonicalLineups) as LeftOrRight[]).map((side) => ({
              id: newEventId(),
              type: 'substitution' as const,
              questionNumber: 1,
              team: side,
              activePlayers: canonicalLineups[side] as string[],
            }));
            record(...chosen);
            return undefined;
          }}
        />
      )}

      {phase.kind === 'complete' && (
        <div className="scorer-completion">
          <div
            className={`scorer-complete${completionMotion ? ' is-newly-complete' : ''}`}
            data-completion-token={completionMotion?.token}
          >
            <PreSubmitReview
              format={format}
              game={game}
              displaySides={displaySideMapping}
              unsyncedRosterAdditions={unsyncedRosterAdditions}
              warnings={warnings}
              blockers={blockers}
              submitting={submitting}
              onSubmit={submit}
              onDownload={downloadQbj}
              onReview={() => openReviewAt(undefined)}
              spreadsheetTsv={spreadsheetTsv}
              spreadsheetGameLabel={spreadsheetGameLabel}
              spreadsheetSuggestedTabName={spreadsheetSuggestedTabName}
            />
            {submitResult && (
              <div className={submitResult.ok ? 'scorer-complete-ok' : 'scorer-complete-warning'}>
                {/**
                  A finished game that could not be handed over is the one moment where the
                  difference between "wait" and "carry this file to the director" decides
                  whether the game reaches the standings. Both are said, and which one is
                  said depends on whether there is a delivery path at all.
                */}
                {!submitResult.ok &&
                  submitResult.durablySaved !== false &&
                  connection === RoomConnectionState.Offline && (
                    <strong>Result saved on this Chromebook</strong>
                  )}
                <p>{submitResult.message}</p>
                {!submitResult.ok && (
                  <button type="button" className="scorer-action" onClick={downloadQbj}>
                    Download QBJ backup
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {phase.kind !== 'lineup' && phase.kind !== 'complete' && (
        <div className="scorer-body">
          <main className="scorer-main">
            {/*
              The switch, and — in the table layout — the one editing action the table has.

              Outside the choice below on purpose: a control that moved when it was used would make
              switching back a hunt. Two visible options rather than a toggle naming the current one,
              for the reason `ScoringLayoutSwitcher` gives. Not in the footer either: that row is
              Undo, Redo, Players and Flag, all of which do something to the game, and this does
              something to the screen.
            */}
            <div className="scorer-layout-bar">
              <span className="scorer-layout-bar-label" aria-hidden="true">
                Scoring layout
              </span>
              <ScoringLayoutSwitcher value={scoringLayout} onChange={(layout) => setScoringView(layout)} />
              {/*
                Which chair the scorekeeper is in, offered only where it means anything.

                Beside the layout rather than inside the chooser: a new game's question is which of
                two layouts to score in, and adding "and which way round" to it would be asking two
                things at a moment that should cost one press.
              */}
              {scoringLayout === 'table' && (
                <>
                  {/* Its own caption, or four buttons in two pills read as one control with one label. */}
                  <span className="scorer-layout-bar-label" aria-hidden="true">
                    Seats
                  </span>
                  <SegmentedChoice
                    className="scorer-layout-orientation"
                    options={orientationOptions}
                    value={tableOrientationChoice}
                    label="Which way the seats run"
                    onChange={(next) => setTableOrientation(next)}
                  />
                </>
              )}
              {scoringLayout === 'table' && !submitting && (
                <button
                  type="button"
                  className="scorer-text-action scorer-layout-bar-action"
                  onClick={() => {
                    setArrangingTable((current) => !current);
                    setTableHintDismissed(true);
                    setTableOrderCheck(null);
                  }}
                >
                  {arrangingTable ? 'Done arranging' : 'Arrange table'}
                </button>
              )}
            </div>

            {/*
              One surface or the other, never both.

              The table is not a second scorer: it is handed the same display-mapped teams, the same
              seat order, the same eligibility questions and the same two record callbacks the panels
              below are given. Switching between them changes what is drawn and nothing else, which is
              why the choice is a device preference rather than anything the game knows about. Keyed,
              so the outgoing tree is unmounted rather than left running behind the one on screen.
            */}
            {scoringLayout === 'table' ? (
              <TableView
                key="table"
                format={format}
                teams={displayedTeams}
                seatedPlayers={seatedPlayers}
                scoringEnabled={scoringEnabled}
                eligible={displayedEligible}
                negsAvailable={displayedNegsAvailable}
                flashSeat={keyEcho}
                onBuzz={recordDisplayedBuzz}
                onWrongNoPenalty={recordDisplayedWrongNoPenalty}
                sideLayoutKey={displaySideMapping.left}
                dialogOpen={anyDialogOpen}
                timeouts={
                  (procedure?.timeoutsPerTeam ?? 0) > 0
                    ? mapSides(game.timeouts, displaySideMapping)
                    : undefined
                }
                timeoutsPerTeam={
                  (procedure?.timeoutsPerTeam ?? 0) > 0 ? procedure?.timeoutsPerTeam : undefined
                }
                orientation={tableOrientationChoice}
                arranging={arrangingTable}
                onArrangingChange={setArrangingTable}
                arrangementUnconfirmed={arrangementUnconfirmed && !tableHintDismissed}
                onDismissArrangementHint={() => setTableHintDismissed(true)}
                lineupOrderCheck={tableOrderCheck}
                onDismissOrderCheck={() => setTableOrderCheck(null)}
                onArrangeSeats={
                  submitting
                    ? undefined
                    : (displaySide, visibleNames) => {
                        // The side a scorekeeper touched, mapped back to the team the game stores,
                        // exactly as every scoring callback here does. `seating.arrange` is the one
                        // physical seat order — the same one the scoresheet rows and the keyboard's
                        // seat mapping read — so a drag on the table moves all three or none.
                        const side = canonicalForDisplay(displaySide);
                        seating.arrange(
                          {
                            left: game.left.players.map((player) => player.name),
                            right: game.right.players.map((player) => player.name),
                          },
                          { [side]: [...visibleNames] },
                        );
                      }
                }
                onConfirmArrangement={() => {
                  // The room saying the roster order is the table order. A seating preference and
                  // nothing else: no event, no lineup, nothing that reaches the scoresheet.
                  const canonicalSeats: Partial<PlayerSeating> = {};
                  canonicalSeats[canonicalForDisplay('left')] = [...seatedPlayers.left];
                  canonicalSeats[canonicalForDisplay('right')] = [...seatedPlayers.right];
                  seating.arrange(
                    {
                      left: game.left.players.map((player) => player.name),
                      right: game.right.players.map((player) => player.name),
                    },
                    canonicalSeats,
                  );
                }}
              />
            ) : (
              <div key="scoresheet" className="scorer-teams">
                <TeamPanel
                  key={displaySideMapping.left}
                  format={format}
                  team={displayedTeams.left}
                  seatOrder={seating.seating[displaySideMapping.left]}
                  flashSeat={keyEcho?.side === 'left' ? keyEcho.seat : undefined}
                  scoringEnabled={scoringEnabled}
                  eligible={displayedEligible('left')}
                  negsAvailable={displayedNegsAvailable('left')}
                  timeoutsUsed={
                    (procedure?.timeoutsPerTeam ?? 0) > 0 ? game.timeouts[displaySideMapping.left] : undefined
                  }
                  timeoutsPerTeam={
                    (procedure?.timeoutsPerTeam ?? 0) > 0 ? procedure?.timeoutsPerTeam : undefined
                  }
                  onBuzz={(playerName, answerType) => recordDisplayedBuzz('left', playerName, answerType)}
                  onWrongNoPenalty={(playerName) => recordDisplayedWrongNoPenalty('left', playerName)}
                  onSubstitute={(outgoing, incoming) =>
                    substituteFromRow(displaySideMapping.left, outgoing, incoming)
                  }
                  benchPlayers={benchFor(displaySideMapping.left)}
                  substitutionAllowed={lineupChangeAllowed || lineupChangeAuthorized[displaySideMapping.left]}
                  substitutionBlockedReason={lineupChangeReason}
                  substitutionQuestionNumber={lineupQuestion}
                />
                <TeamPanel
                  key={displaySideMapping.right}
                  format={format}
                  team={displayedTeams.right}
                  seatOrder={seating.seating[displaySideMapping.right]}
                  flashSeat={keyEcho?.side === 'right' ? keyEcho.seat : undefined}
                  scoringEnabled={scoringEnabled}
                  eligible={displayedEligible('right')}
                  negsAvailable={displayedNegsAvailable('right')}
                  timeoutsUsed={
                    (procedure?.timeoutsPerTeam ?? 0) > 0
                      ? game.timeouts[displaySideMapping.right]
                      : undefined
                  }
                  timeoutsPerTeam={
                    (procedure?.timeoutsPerTeam ?? 0) > 0 ? procedure?.timeoutsPerTeam : undefined
                  }
                  onBuzz={(playerName, answerType) => recordDisplayedBuzz('right', playerName, answerType)}
                  onWrongNoPenalty={(playerName) => recordDisplayedWrongNoPenalty('right', playerName)}
                  onSubstitute={(outgoing, incoming) =>
                    substituteFromRow(displaySideMapping.right, outgoing, incoming)
                  }
                  benchPlayers={benchFor(displaySideMapping.right)}
                  substitutionAllowed={
                    lineupChangeAllowed || lineupChangeAuthorized[displaySideMapping.right]
                  }
                  substitutionBlockedReason={lineupChangeReason}
                  substitutionQuestionNumber={lineupQuestion}
                />
              </div>
            )}

            {/* After the teams and before the control bar, so it sits beside the rulings it describes
                without joining the two-column grid they are laid out in. */}
            {keyboardEnabled && <KeyboardMap context={keyboardContext} />}

            {/* Pinned to the control bar during live play so the current scoring action stays in view. */}
            <div className="scorer-stage is-pinned">
              {noBuzzAcknowledgement && (
                <span
                  key={`no-buzz-${noBuzzAcknowledgement.token}`}
                  className="scorer-no-buzz-sweep"
                  data-motion-token={noBuzzAcknowledgement.token}
                  aria-hidden="true"
                />
              )}
              {bonusExit && <BonusExitPrompt exit={bonusExit} />}
              {phase.kind === 'score-check' && (
                <HalftimeCheck
                  game={game}
                  afterQuestion={phase.afterQuestion}
                  displaySides={displaySideMapping}
                  breakName={currentBreakName}
                  substitutionMessage={substitutionMessage}
                  onPlayers={() => setDialog('players')}
                  onContinue={() =>
                    record({ id: newEventId(), type: 'half-resume', questionNumber: currentQuestion })
                  }
                />
              )}

              {phase.kind === 'tossup' && playBlockedByProtest && (
                <div className="scorer-check-outstanding" role="alert">
                  <strong>Resolve the open protest before the next sudden-death tossup.</strong>
                  <button type="button" className="scorer-action" onClick={() => setDialog('protests')}>
                    Resolve protest
                  </button>
                </div>
              )}

              {phase.kind === 'tossup' && (
                <div className="scorer-tossup-actions">
                  <button
                    type="button"
                    className="scorer-nobuzz"
                    onClick={recordNoBuzz}
                    disabled={playBlockedByProtest}
                  >
                    {noBuzzLabel}
                  </button>
                  {phase.eligibleTeams.length === 1 && (
                    <p className="scorer-hint">
                      {displayedTeams[displayForCanonical(phase.eligibleTeams[0])].name} may still answer.
                    </p>
                  )}
                </div>
              )}

              {phase.kind === 'checkpoint' && (
                <div className="scorer-checkpoint" aria-label={`${phase.checkpoint} checkpoint`}>
                  <p className="scorer-checkpoint-title">
                    {phase.checkpoint === 'overtime' ? 'Regulation complete' : 'Initial overtime complete'}
                  </p>
                  <p className="scorer-complete-score">
                    <span>
                      {displayedTeams.left.name} <strong>{displayedTeams.left.points}</strong>
                    </span>
                    <span>
                      {displayedTeams.right.name} <strong>{displayedTeams.right.points}</strong>
                    </span>
                  </p>
                  <p className="scorer-dialog-note">
                    {phase.checkpoint === 'overtime'
                      ? `${format.overtime.minimumQuestionCount} tossups · ${
                          format.overtime.includesBonuses ? 'bonuses included' : 'no bonuses'
                        }. ${substitutionMessage}`
                      : `Next score change wins. ${substitutionMessage}`}
                  </p>
                  {openProtests.length > 0 && (
                    <div className="scorer-check-outstanding">
                      <strong>
                        {checkpointProtestBlocks(phase.checkpoint)
                          ? 'Resolve open protests before continuing.'
                          : 'Open protest recorded; continuing is allowed by this procedure.'}
                      </strong>
                      <button type="button" className="scorer-action" onClick={() => setDialog('protests')}>
                        Resolve protest
                      </button>
                    </div>
                  )}
                  <div className="scorer-complete-actions">
                    <button type="button" className="scorer-action" onClick={() => setDialog('players')}>
                      Players
                    </button>
                    <button
                      type="button"
                      className="scorer-submit"
                      disabled={checkpointProtestBlocks(phase.checkpoint)}
                      onClick={() =>
                        record({
                          id: newEventId(),
                          type: phase.checkpoint === 'overtime' ? 'begin-overtime' : 'begin-sudden-death',
                          questionNumber: currentQuestion,
                        })
                      }
                    >
                      {phase.checkpoint === 'overtime' ? 'Begin overtime' : 'Begin sudden death'}
                    </button>
                  </div>
                </div>
              )}

              {phase.kind === 'timeout' && (
                <div className="scorer-timeout" aria-label="Timeout active">
                  <p className="scorer-checkpoint-title">
                    Timeout · {displayedTeams[displayForCanonical(phase.team)].name}
                  </p>
                  {timeoutRemainingMs !== undefined && (
                    <p className="scorer-timeout-clock" aria-label="Timeout remaining">
                      {timeoutRemainingMs === 0 ? 'Timeout time elapsed' : formatClock(timeoutRemainingMs)}
                    </p>
                  )}
                  <p className="scorer-dialog-note">{substitutionMessage}</p>
                  <div className="scorer-complete-actions">
                    <button type="button" className="scorer-action" onClick={() => setDialog('players')}>
                      Players
                    </button>
                    <button
                      type="button"
                      className="scorer-submit"
                      onClick={() =>
                        record({ id: newEventId(), type: 'timeout-resume', questionNumber: currentQuestion })
                      }
                    >
                      Resume play
                    </button>
                  </div>
                </div>
              )}

              {phase.kind === 'bonus' && (
                <BonusPrompt
                  key={phase.questionNumber}
                  format={format}
                  controllingTeamName={phase.team === 'left' ? game.left.name : game.right.name}
                  opponentName={phase.team === 'left' ? game.right.name : game.left.name}
                  questionNumber={phase.questionNumber}
                  onRecord={recordBonus}
                  onRecordParts={recordBonusParts}
                  keyboardEnabled={keyboardEnabled && dialog === null}
                  onStageChange={setBonusStage}
                />
              )}
            </div>
          </main>

          <RecentRail
            game={game}
            displaySides={displaySideMapping}
            emphasizeQuestion={emphasizedQuestion}
            motion={recentMotion}
            onInspect={(questionNumber) => openReviewAt(questionNumber, true)}
          />
        </div>
      )}

      {/* Outside the body and pinned to the viewport, so a long roster cannot scroll the one thing on
          screen that is only true for the next second and a half out of sight. */}
      {keyboardEnabled && <KeyboardStatus status={keyStatus} />}

      <footer className="scorer-footer">
        <button
          type="button"
          className="scorer-action"
          onClick={undoWithFeedback}
          disabled={submitting || !events.canUndo}
        >
          <ControlIcon name="undo" />
          Undo
        </button>
        <button
          type="button"
          className="scorer-action scorer-footer-redo"
          onClick={redoWithFeedback}
          disabled={submitting || !events.canRedo}
        >
          <ControlIcon name="redo" />
          Redo
        </button>
        <button
          type="button"
          className="scorer-action"
          onClick={() => setDialog('players')}
          disabled={submitting}
        >
          <ControlIcon name="players" />
          Players
        </button>
        <button
          type="button"
          className="scorer-action"
          onClick={() => setDialog('flag')}
          disabled={submitting}
        >
          <ControlIcon name="flag" />
          Flag
        </button>
        <GameMenu items={menuItems} />
      </footer>

      {dialog === 'players' && (
        <PlayersDialog
          left={displayedTeams.left}
          right={displayedTeams.right}
          maximumActive={format.players.maximumActive}
          questionNumber={lineupQuestion}
          rosterSyncStatus={displayedRosterSyncStatus}
          timeouts={mapSides(game.timeouts, displaySideMapping)}
          timeoutsPerTeam={procedure?.timeoutsPerTeam ?? 0}
          lineupChangeAllowed={lineupChangeAllowed}
          lineupChangeAuthorized={mapSides(lineupChangeAuthorized, displaySideMapping)}
          rosterAdditionAllowed={rosterAdditionAllowed}
          lineupChangeReason={lineupChangeReason}
          // Only rendered when a lineup change is currently refused, which is a phase an ordinary
          // game passes through without ever opening this dialog.
          onProcedureQuery={() => openProcedureDialog('substitution-opportunity')}
          seating={mapSides(seating.seating, displaySideMapping)}
          onMovePlayer={(displaySide, visibleNames, playerName, direction) => {
            if (submitting) return;
            seating.move(
              canonicalForDisplay(displaySide),
              game[canonicalForDisplay(displaySide)].players.map((player) => player.name),
              visibleNames,
              playerName,
              direction,
            );
          }}
          onSeatSubstitute={(displaySide, outgoing, incoming) => {
            if (submitting) return;
            seating.substitute(
              canonicalForDisplay(displaySide),
              game[canonicalForDisplay(displaySide)].players.map((player) => player.name),
              outgoing,
              incoming,
            );
          }}
          onSubstitute={(displaySide, activePlayers) => {
            if (submitting) return;
            record({
              id: newEventId(),
              type: 'substitution',
              questionNumber: lineupQuestion,
              team: canonicalForDisplay(displaySide),
              activePlayers,
            });
            setDialog(null);
          }}
          onAddPlayer={(displaySide, playerName, activePlayers) => {
            if (submitting) return;
            addRosterPlayer(canonicalForDisplay(displaySide), playerName, activePlayers);
            setDialog(null);
          }}
          onRequestControl={
            onRequestControl
              ? (displaySide, playerName) => {
                  const teamName = game[canonicalForDisplay(displaySide)].name;
                  const facts = {
                    prefix: `Roster change for ${playerName}:`,
                    localOnly: `${playerName} is on this scoresheet.`,
                  };
                  acknowledge(`Requesting tournament control to add ${playerName}.`);
                  void onRequestControl('roster-change', `Please add ${playerName} to ${teamName}.`)
                    .then((result) => noteControlOutcome(facts, result))
                    .catch(() =>
                      noteControlOutcome(facts, {
                        kind: 'unreachable',
                        error: 'Could not reach tournament control.',
                      }),
                    );
                }
              : undefined
          }
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'lightning' && (
        <LightningDialog
          format={format}
          game={displayedGame}
          onRecord={(displaySide, points) =>
            record({
              id: newEventId(),
              type: 'lightning',
              questionNumber: currentQuestion,
              team: canonicalForDisplay(displaySide),
              points,
            })
          }
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'notes' && (
        <NotesDialog
          questionNumber={currentQuestion}
          existing={game.notes}
          onRecord={(text, flagged) => {
            record({ id: newEventId(), type: 'note', questionNumber: currentQuestion, text, flagged });
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'adjust' && (
        <AdjustDialog
          game={displayedGame}
          onAdjust={(displaySide, points, reason) => {
            record({
              id: newEventId(),
              type: 'adjustment',
              questionNumber: currentQuestion,
              team: canonicalForDisplay(displaySide),
              points,
              reason,
            });
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'forfeit' && (
        <ForfeitDialog
          game={displayedGame}
          onForfeit={(displaySides) => {
            record({
              id: newEventId(),
              type: 'forfeit',
              questionNumber: currentQuestion,
              teams: displaySides.map(canonicalForDisplay),
            });
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'issue' && (
        <IssueDialog
          questionNumber={currentQuestion}
          controlRequest={controlRequest}
          onRetryControl={onRetryControlRequest}
          onCancelControl={onCancelControlRequest}
          initialCategory={issueCategory}
          onReport={async (category, details, requestControl) => {
            if (submitting) return undefined;
            let label = 'Issue';
            if (category === 'protest') label = 'Protest';
            else if (category === 'question-packet') label = 'Question / packet issue';
            // The scoresheet is authoritative. Commit the note before any network operation.
            const recorded = record({
              id: newEventId(),
              type: 'note',
              questionNumber: currentQuestion,
              text: `${label}: ${details}`,
              flagged: true,
            });
            if (!recorded) return undefined;
            if (requestControl && onRequestControl) {
              let result: HelpRequestResult;
              try {
                result = await onRequestControl(category, details);
              } catch {
                result = { kind: 'unreachable', error: 'Could not reach tournament control.' };
              }
              // The scoresheet fact and the network fact, split: the note really is saved whatever
              // happened on the wire, and when the room is modelling the request it owns the rest.
              noteControlOutcome(
                { prefix: 'Issue saved', localOnly: 'Issue saved on the scoresheet.' },
                result,
              );
              return result;
            }
            acknowledge('Issue saved on the scoresheet.');
            return undefined;
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'review' && (
        <ScoresheetReviewDialog
          game={game}
          events={events.events}
          format={format}
          displaySides={displaySideMapping}
          focusQuestion={reviewFocus}
          editQuestion={reviewEditQuestion}
          /*
           * A correction that landed, said out loud.
           *
           * The modal closing and the totals quietly becoming different numbers is the whole of the
           * feedback today, and a scorekeeper who has just retyped question seven under time
           * pressure has no way to tell that from a modal that closed without saving. So: the same
           * sentence every completed action gets, and a wash on the line it changed if that line is
           * still on screen. Both are temporary — being corrected is something that happened to a
           * question, not a property it now has, and a permanent mark would be making a claim the
           * scoresheet does not.
           */
          onReplace={(id, next) => {
            if (submitting) return;
            events.replace(id, next);
            acknowledge(correctionNotice(next), next.questionNumber);
          }}
          onRemove={(id) => {
            if (submitting) return;
            events.remove(id);
          }}
          onReplaceQuestion={(questionNumber, question) => {
            if (submitting) return false;
            // Only on the way out. A refused correction leaves the editor open with the reason on
            // it, and saying it worked here would be contradicting the dialog underneath.
            const applied = events.replaceQuestion(questionNumber, question);
            if (applied) acknowledge(`Question ${questionNumber} corrected.`, questionNumber);
            return applied;
          }}
          onOpenReplacement={openReplacementAt}
          onRemoveOvertime={submitting ? undefined : removeOvertimeTossups}
          onClose={() => {
            setDialog(null);
            setReviewFocus(undefined);
            setReviewEditQuestion(undefined);
          }}
        />
      )}
      {dialog === 'flag' && (
        <FlagDialog
          onProtest={() => setDialog('protests')}
          onIssue={(category) => {
            setIssueCategory(category);
            setDialog('issue');
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'protests' && (
        <ProtestDialog
          game={displayedGame}
          questionNumber={currentQuestion}
          controlRequest={controlRequest}
          onRetryControl={onRetryControlRequest}
          onCancelControl={onCancelControlRequest}
          onRecord={async (displaySide, subject, description, requestControl) => {
            if (submitting) return undefined;
            const team = canonicalForDisplay(displaySide);
            const teamName = team === 'left' ? game.left.name : game.right.name;
            const recorded = record({
              id: newEventId(),
              type: 'protest',
              questionNumber: currentQuestion,
              team,
              subject,
              description,
              status: 'open',
            });
            if (!recorded) return undefined;
            if (requestControl && onRequestControl) {
              acknowledge('Protest recorded; asking tournament control to come.');
              let result: HelpRequestResult;
              try {
                result = await onRequestControl(
                  'protest',
                  `Q${currentQuestion} protest by ${teamName}: ${description}`,
                );
              } catch {
                result = { kind: 'unreachable', error: 'Could not reach tournament control.' };
              }
              noteControlOutcome(
                {
                  prefix: 'Protest recorded',
                  localOnly: 'Protest recorded. Keep scoring; tournament control will see it on the result.',
                },
                result,
              );
              return result;
            } else {
              acknowledge('Protest recorded. Keep scoring; tournament control will see it on the result.');
            }
            return undefined;
          }}
          onResolve={(protest, status, resolution) => {
            if (submitting) return;
            const existing = events.events.find((event) => event.id === protest.eventId);
            if (!existing || existing.type !== 'protest') return;
            events.replace(protest.eventId, { ...existing, status, resolution: resolution || undefined });
          }}
          onEditQuestion={(questionNumber) => {
            setDialog(null);
            openReviewAt(questionNumber);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'timeout' && (
        <TimeoutDialog
          game={displayedGame}
          timeoutsPerTeam={procedure?.timeoutsPerTeam ?? 0}
          extraTimeouts={{
            ...mapSides(
              {
                left: extraTimeoutsGranted(events.events, 'left'),
                right: extraTimeoutsGranted(events.events, 'right'),
              },
              displaySideMapping,
            ),
          }}
          // Offered only from the team that has actually run out; see `TimeoutDialog`. There is no
          // such control on a team with a timeout left, which is every team in an ordinary game.
          onProcedureQuery={(displaySide) =>
            openProcedureDialog('timeout-allowance', canonicalForDisplay(displaySide))
          }
          onRecord={(displaySide) =>
            record({
              id: newEventId(),
              type: 'timeout-start',
              questionNumber: currentQuestion,
              team: canonicalForDisplay(displaySide),
              startedAt: Date.now(),
            })
          }
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'replace' &&
        (reviewFocus !== undefined || phase.kind === 'tossup' || phase.kind === 'bonus') && (
          <ReplaceQuestionDialog
            questionNumber={
              reviewFocus ?? (phase.kind === 'tossup' || phase.kind === 'bonus' ? phase.questionNumber : 1)
            }
            bonusReplaceable={
              (reviewFocus !== undefined &&
                (game.questions.find((question) => question.questionNumber === reviewFocus)?.bonus !==
                  undefined ||
                  game.questions.find((question) => question.questionNumber === reviewFocus)
                    ?.awaitingBonus === true)) ||
              (reviewFocus === undefined && (phase.kind === 'bonus' || currentCycleHasBonus))
            }
            onReplace={(scope, reason) => {
              if (submitting) return;
              // Resolved once: the note, the void and the message must all be about one question.
              const questionNumber = reviewFocus ?? currentQuestion;
              /*
               * The void and the note go together as one action: a cycle removed from the scoresheet
               * with no record of why is indistinguishable from a scorekeeper who deleted it by
               * mistake, and the whole point of this is that the room can explain itself afterwards.
               */
              const recorded = record(
                {
                  id: newEventId(),
                  type: 'note',
                  questionNumber,
                  text: `${scope === 'bonus' ? 'Bonus' : 'Question'} replaced: ${reason}`,
                  flagged: true,
                },
                {
                  id: newEventId(),
                  type: 'question-void',
                  questionNumber,
                  scope,
                  reason,
                },
              );
              if (!recorded) return;
              setDialog(null);
              /*
               * Persistent, unlike the other acknowledgements here: this one is not "that worked", it
               * is an instruction about the next thing to do, and it stays until the replacement has
               * been scored over the top of it.
               */
              notePersistent(
                scope === 'bonus'
                  ? `The bonus on question ${questionNumber} was cleared. Score the replacement.`
                  : `Question ${questionNumber} was cleared. Score the replacement as question ${questionNumber}.`,
                'info',
              );
            }}
            onClose={() => {
              setDialog(null);
              setReviewFocus(undefined);
            }}
          />
        )}
      {dialog === 'end-early' && (
        <EndGameEarlyDialog
          game={displayedGame}
          regulationTossupCount={format.regulation.tossupCount}
          onEnd={(reason, tossupsRead) => {
            record({
              id: newEventId(),
              type: 'end-game-early',
              questionNumber: currentQuestion,
              reason,
              tossupsRead,
            });
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'details' && (
        <GameDetailsDialog
          identity={{ tournamentName, roundName, roomName, packetName }}
          game={game}
          format={format}
          procedure={procedure}
          events={events.events}
          moderator={moderatorName}
          scorekeeper={operatorName ?? ''}
          onSaveModerator={setModeratorName}
          onCorrectTeamName={onCorrectGame && !submitting ? applyTeamNameCorrection : undefined}
          onCorrectPlayerName={onCorrectGame && !submitting ? applyPlayerNameCorrection : undefined}
          teamNameProblem={teamNameProblem}
          playerNameProblem={playerNameProblem}
          onCorrectScoringRules={onCorrectGame && !submitting ? () => setDialog('scoring-rules') : undefined}
          onCorrectProcedure={onCorrectGame && !submitting ? () => openProcedureDialog() : undefined}
          displaySides={displaySideMapping}
          onSwapSides={displaySideState.swap}
          onClose={() => setDialog(null)}
        />
      )}
      {/*
        Which layout, asked once a game.

        The same dialog from both routes: automatically for a game nobody has scored yet, and from
        the Game menu whenever somebody wants to read what the two are. See `scoringLayoutPrompt`.
      */}
      {layoutChooserOpen && <ScoringLayoutDialog value={scoringLayout} onChoose={answerLayoutPrompt} />}
      {dialog === 'export' && (
        <ExportDialog
          onDownloadQbjBackup={downloadQbj}
          onDownloadQbsheetBackup={onDownloadQbsheetBackup ? downloadQbsheetBackup : undefined}
          onDownloadPartialQbj={onDownloadForm ? () => onDownloadForm(game, 'partial') : undefined}
          onDownloadLegacyQbj={onDownloadForm ? () => onDownloadForm(game, 'legacy-match') : undefined}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'procedure' && (
        <ProcedureCorrectionDialog
          game={game}
          events={events.events}
          procedure={procedure}
          topic={procedureTopic}
          team={procedureTeam}
          disabled={submitting}
          refusalFor={exceptionRefusal}
          onRecordException={recordProcedureException}
          onCorrect={applyProcedureCorrection}
          displaySides={displaySideMapping}
          onClose={() => {
            setProcedureTopic(undefined);
            setProcedureTeam(undefined);
            setDialog(null);
          }}
        />
      )}
      {dialog === 'connection' && (
        <ConnectionDetailDialog
          connection={connection}
          recovery={recoveryStatus}
          statusLabel={statusLabel}
          now={detailNow}
          // Read when the dialog opens rather than subscribed to. A history that grew a line under
          // somebody reading it would move the rest of the list, and nothing in here is urgent.
          timeline={connectionTimeline.entries()}
          onDownload={downloadQbj}
          onClose={() => setDialog(null)}
        />
      )}
      {/*
        Mounted only while a print is being produced, so the scoresheet is not carrying a second copy
        of the whole game in the DOM at all times. Ctrl+P reaches it through `beforeprint`; see
        `usePrinting`. It portals out of this tree so one rule in `print.css` can hide the interface.
      */}
      {printing && (
        <PrintableScoresheet
          game={game}
          format={format}
          displaySides={displaySideMapping}
          tournamentName={tournamentName}
          roundName={roundName}
          roomName={roomName}
          packetName={packetName}
          operatorName={operatorName}
        />
      )}
      {dialog === 'scoring-rules' && onCorrectGame && (
        <ScoringRulesCorrectionDialog
          format={format}
          events={events.events}
          setup={setup}
          disabled={submitting}
          onCorrect={applyScoringRulesCorrection}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'recovery' && (
        <RecoveryDialog
          expectedTeams={setup}
          onRestore={(restoredEvents) => {
            if (submitting) return;
            events.restore(restoredEvents);
            // Where the events on screen came from, which stays worth knowing; not an acknowledgement.
            notePersistent('Recovered the scoresheet from the QBJ backup.', 'info');
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {/*
        The arcade, which is a dialog and nothing else.

        It reaches the scoresheet through the same `dialog` state every other infrequent action does,
        which is what makes it safe: `anyDialogOpen` is already what turns off keyboard scoring and
        already what `useScorerKeyboard` checks, so a game gets Space and the arrows for exactly as
        long as this is open and the scoresheet gets them back the instant it is not. Nothing
        arcade-shaped appears anywhere else in this file, and nothing in it can record an event.

        `ArcadeLauncher` rather than the dialog itself: the games are in a chunk of their own that a
        reloading Chromebook never fetches. See `ArcadeLauncher`.
      */}
      <ArcadeLauncher open={dialog === 'arcade'} onClose={() => setDialog(null)} />
    </div>
  );
}
