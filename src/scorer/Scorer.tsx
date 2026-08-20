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
import { connectionTimeline } from '../app/ConnectionTimeline';
import { RoomConnectionState } from '../app/ConnectionState';
import TeamPanel from './TeamPanel';
import BonusPrompt from './BonusPrompt';
import RecentRail, { IRecentMotion } from './RecentRail';
import GameMenu from './GameMenu';
import scorerMenuItems from './scorerMenu';
import ControlIcon from './ControlIcon';
import PlayersDialog, { rosterSyncKey } from './PlayersDialog';
import StartingLineupPrompt from './StartingLineupPrompt';
import PreSubmitReview, { HalftimeCheck } from './PreSubmitReview';
import { AdjustDialog, ForfeitDialog, LightningDialog, NotesDialog } from './GameDialogs';
import {
  EndGameEarlyDialog,
  GameDetailsDialog,
  ProtestDialog,
  ReplaceQuestionDialog,
  TimeoutDialog,
} from './ProcedureDialogs';
import { IGameEventsApi, newEventId } from './useGameEvents';
import {
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
import { attachScorerRecovery } from './ScorerRecovery';
import useRoomClock from './useRoomClock';
import usePlayerSeating from './usePlayerSeating';
import { orderBySeating } from './PlayerSeating';
import useScreenWakeLock from './useScreenWakeLock';
import { formatClock, RoomClockStatus, roomClockSegment } from './RoomClock';
import useScorerKeyboard from './useScorerKeyboard';
import KeyboardMap, { KeyboardMapContext } from './KeyboardMap';
import KeyboardStatus, { type KeyboardStatus as IKeyboardStatus } from './KeyboardStatus';
import { availableActionKeys, keyboardActionNames, sequenceLegend, bonusKeyLegend } from './KeyboardScoring';
import { rulingLabel, unreachableAnswerTypes } from './tossupRulings';
import { setKeyboardEnabled } from './keyboardPreference';
import useKeyboardEnabled from './useKeyboardEnabled';
import ScorerBanners, {
  ConnectionDetailDialog,
  IScorerAlert,
  IScorerRecoveryStatus,
  connectionClass,
  connectionLabel,
} from './ConnectionStatus';
import MotionNumber, {
  bonusExitMotionMs,
  connectionRecoveryMotionMs,
  noBuzzAcknowledgementMotionMs,
  recentMotionMs,
} from './ScoringMotion';
import { bouncebackNeedsTypedEntry, bouncebackOptions, regularBonusTotals } from './bonusOptions';

export type { IScorerAlert, IScorerRecoveryStatus } from './ConnectionStatus';

export interface IScorerSubmitResult {
  ok: boolean;
  message: string;
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
   * Apply corrected scoring rules to this game.
   *
   * Absent when nothing above the scorer can persist the change — the practice screen, chiefly, whose
   * format belongs to the scenario rather than to a tournament. An absent callback removes the menu
   * entry rather than disabling it, exactly as `onDownloadForm` does. See `formatCorrection`.
   */
  onCorrectScoringRules?: (correction: IScoringRulesCorrection) => void | Promise<void>;
  /** Called as the game changes, so tournament control can watch progress. */
  onProgress?: (qbj: object, questionsPlayed: number) => void;
  /** Round number and the rest of the non-scoring metadata for the exported match. */
  qbjMeta?: IQbjMatchMeta;
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
  /** Narrow authoritative roster-add request for an assigned room. */
  onSyncRosterPlayer?: (
    teamName: string,
    playerName: string,
  ) => Promise<{ ok: boolean; error?: string; rejected?: boolean }>;
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
  | null;

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

type BonusExitContent =
  | { kind: 'choices'; options: number[]; selected: number }
  | { kind: 'typed'; fieldLabel: string; selected: number }
  | { kind: 'parts'; parts: IBonusPartResult[]; pointsPerPart: number; bounceBack: boolean };

interface IBonusExit {
  token: number;
  title: string;
  context: string;
  content: BonusExitContent;
}

/** An inert snapshot of the prompt that committed the bonus, kept intact for its brief exit. */
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
          <div className="scorer-choices">
            {content.options.map((points) => (
              <span
                key={points}
                className={`scorer-choice${points === content.selected ? ' is-selected' : ''}`}
                data-presentation-label={points}
              />
            ))}
          </div>
        )}
        {content.kind === 'typed' && (
          <div className="scorer-inline-form">
            <label>
              {content.fieldLabel}
              <input type="number" value={content.selected} readOnly disabled />
            </label>
            <span className="scorer-choice is-selected" data-presentation-label="Record" />
          </div>
        )}
        {content.kind === 'parts' && (() => {
          const controlledTotal = content.parts.reduce((sum, part) => sum + part.controlledPoints, 0);
          const bouncebackTotal = content.parts.reduce((sum, part) => sum + (part.bouncebackPoints ?? 0), 0);
          return (
            <div className="scorer-bonus-parts">
              <ol className="scorer-part-list">
                {content.parts.map((part, index) => {
                  const outcome =
                    part.controlledPoints > 0 ? 'controlled' : (part.bouncebackPoints ?? 0) > 0 ? 'bounceback' : 'missed';
                  return (
                    <li key={index} className="scorer-part-row">
                      <span className="scorer-part-label" data-presentation-label={`Part ${index + 1}`} />
                      <span className="scorer-choices">
                        <span
                          className={`scorer-choice${outcome === 'controlled' ? ' is-selected' : ''}`}
                          data-presentation-label={`+${content.pointsPerPart}`}
                        />
                        {content.bounceBack && (
                          <span
                            className={`scorer-choice${outcome === 'bounceback' ? ' is-selected' : ''}`}
                            data-presentation-label="Bounce"
                          />
                        )}
                        <span
                          className={`scorer-choice${outcome === 'missed' ? ' is-selected' : ''}`}
                          data-presentation-label="Miss"
                        />
                      </span>
                    </li>
                  );
                })}
              </ol>
              <p
                className="scorer-part-total"
                data-presentation-label={`${controlledTotal}${
                  content.bounceBack && bouncebackTotal > 0 ? ` · ${bouncebackTotal} bounced back` : ''
                }`}
              />
              <div className="scorer-choices">
                <span className="scorer-choice is-selected" data-presentation-label="Record parts" />
                <span className="scorer-action" data-presentation-label="Back to totals" />
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
  const [motion, setMotion] = useState<{ from: RoomClockStatus; to: RoomClockStatus; token: number } | null>(null);

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

  const label = status === 'running' ? 'Pause' : status === 'paused' ? 'Resume' : status === 'expired' ? 'Reset' : 'Start';
  const action = status === 'running' ? onPause : status === 'paused' ? onResume : status === 'expired' ? onReset : onStart;
  const icon = status === 'running' ? 'pause' : 'play';
  const oldIcon = motion?.from === 'running' ? 'pause' : 'play';

  return (
    <span className={status === 'expired' ? 'scorer-clock is-expired' : 'scorer-clock'} data-clock-state={status}>
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
    connection,
    statusLabel,
    degradedMessage,
    saved,
    onSubmit,
    onDownload,
    onDownloadForm,
    onCorrectScoringRules,
    onProgress,
    qbjMeta,
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
    onSyncRosterPlayer,
  } = props;

  const controlRequest: ControlRequestState =
    suppliedControlRequest ??
    (onRequestControl
      ? { kind: 'unavailable' }
      : { kind: 'unsupported', error: 'This game is being scored from a file.' });

  const recoveryStatus: IScorerRecoveryStatus = recovery ?? { localSaveOk: saved !== false };

  const [dialog, setDialog] = useState<OpenDialog>(null);
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
   * Which set of choices the bonus is currently asking for, reported up by `BonusPrompt`.
   *
   * The legend has to change when the bonus does — showing seat sequences while a bounceback is on screen
   * would be showing bindings that do nothing — and the choices live in that component with its own
   * state. Reporting the stage upward is smaller than lifting the state, and keeps the shortcut in the
   * same file as the buttons it stands in for.
   */
  const [bonusStage, setBonusStage] = useState<{ title: string; options: number[]; cancellable: boolean } | null>(
    null,
  );
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

  /** Clear a timed notice once it has been read. Keyed on the notice object so replacements get a new timer. */
  useEffect(() => {
    const duration =
      operationNotice?.autoDismissMs ?? (operationNotice?.transient ? operationNoticeMs : undefined);
    if (duration === undefined) return undefined;
    const timer = window.setTimeout(() => {
      setOperationNotice(null);
      setEmphasizedQuestion(undefined);
    }, duration);
    return () => window.clearTimeout(timer);
  }, [operationNotice]);

  const dismissOperationNotice = useCallback(() => {
    setOperationNotice(null);
    setEmphasizedQuestion(undefined);
  }, []);

  /** Say that something worked. Goes away on its own; see `IOperationNotice`. */
  const acknowledge = useCallback((message: string, questionNumber?: number) => {
    setOperationNotice({ message, tone: 'info', transient: true });
    setEmphasizedQuestion(questionNumber);
  }, []);

  /** Say something that stays until it is resolved or replaced. Not always a warning; see the tone. */
  const notePersistent = useCallback((message: string, tone: 'info' | 'warning' = 'warning') => {
    setOperationNotice({ message, tone, transient: false });
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

  const game = useMemo(() => deriveGame(format, setup, events.events), [format, setup, events.events]);
  const clockSegment = roomClockSegment(
    roomTakesBreaks(procedure),
    game.halfBreaks.length,
    game.awaitingScoreCheck,
    game.overtimeStarted,
  );
  const roomClock = useRoomClock(gameKey, procedure?.halfLengthMinutes, clockSegment);
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
    () => attachScorerRecovery(toQbjMatch(format, game, meta), setup, events.events),
    [format, game, meta, setup, events.events],
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
      if (authoritative.some((name) => name.toLocaleLowerCase() === addition.playerName.toLocaleLowerCase())) {
        status[key] = 'synced';
      } else if (rejectedRosterSyncs[key]) status[key] = 'rejected';
      else if (authoritativeRosters && connection === RoomConnectionState.Connected && onSyncRosterPlayer)
        status[key] = 'waiting';
      else status[key] = 'local';
    }
    return status;
  }, [authoritativeRosters, connection, localRosterAdds, onSyncRosterPlayer, rejectedRosterSyncs]);

  useEffect(() => {
    if (connection !== RoomConnectionState.Connected || !onSyncRosterPlayer || !authoritativeRosters) return undefined;
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
        if (authoritative.some((name) => name.toLocaleLowerCase() === addition.playerName.toLocaleLowerCase()))
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
        onSyncRosterPlayer(teamName, addition.playerName)
          .then((result) => {
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
    onSyncRosterPlayer,
    rejectedRosterSyncs,
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

  const recordNoBuzz = useCallback(() => {
    if (phase.kind !== 'tossup') return false;
    const accepted = record({ id: newEventId(), type: 'tossup-dead', questionNumber: phase.questionNumber });
    if (accepted) setNoBuzzAcknowledgement({ token: nextTransientToken() });
    return accepted;
  }, [nextTransientToken, record, phase]);

  const recordReadingResumed = useCallback(() => {
    if (phase.kind !== 'tossup') return;
    record({ id: newEventId(), type: 'tossup-reading-resumed', questionNumber: phase.questionNumber });
  }, [record, phase]);

  const recordReadout = useCallback(() => {
    if (phase.kind !== 'tossup') return;
    record({ id: newEventId(), type: 'tossup-readout', questionNumber: phase.questionNumber });
  }, [record, phase]);

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
        if (payload.parts) {
          setBonusExit({
            token: nextTransientToken(),
            title: `${controllingTeamName} bonus`,
            context: `Q${phase.questionNumber}`,
            content: {
              kind: 'parts',
              parts: payload.parts,
              pointsPerPart: format.bonus.pointsPerPart ?? 0,
              bounceBack: format.bonus.bounceBack,
            },
          });
        } else {
          const controlledPoints = payload.controlledPoints ?? 0;
          const completingBounceback = format.bonus.bounceBack && payload.bouncebackPoints !== undefined;
          const options = completingBounceback
            ? bouncebackNeedsTypedEntry(format.bonus, controlledPoints)
              ? null
              : bouncebackOptions(format.bonus, controlledPoints)
            : regularBonusTotals(format.bonus);
          const selected = completingBounceback ? (payload.bouncebackPoints as number) : controlledPoints;
          setBonusExit({
            token: nextTransientToken(),
            title: completingBounceback ? `${opponentName} bounceback` : `${controllingTeamName} bonus`,
            context: completingBounceback
              ? `Q${phase.questionNumber} · ${controllingTeamName} took ${controlledPoints}`
              : `Q${phase.questionNumber}`,
            content: options
              ? { kind: 'choices', options, selected }
              : {
                  kind: 'typed',
                  fieldLabel: completingBounceback ? 'Bounceback points' : 'Bonus points',
                  selected,
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
      acknowledge(`${incoming} came on for ${outgoing} (${derivedTeam.name}), starting Tossup ${lineupQuestion}.`);
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

  const openReviewAt = useCallback((questionNumber?: number, edit = false) => {
    if (submitting) return;
    setReviewFocus(questionNumber);
    setReviewEditQuestion(edit ? questionNumber : undefined);
    setDialog('review');
  }, [submitting]);

  const openReplacementAt = useCallback((questionNumber: number) => {
    if (submitting) return;
    setReviewFocus(questionNumber);
    setReviewEditQuestion(undefined);
    setDialog('replace');
  }, [submitting]);

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
   * Nobody has answered this tossup yet, so a neg is still a possible ruling.
   *
   * Both teams still being eligible is exactly that condition: an answer of any kind — a buzz or a
   * zero — removes the team that gave it from the eligible list. See `TeamPanel`.
   */
  const currentQuestionState =
    phase.kind === 'tossup' ? game.questions.find((question) => question.questionNumber === phase.questionNumber) : undefined;
  const answeredTeams = new Set<LeftOrRight>([
    ...(currentQuestionState?.buzzes.map((buzz) => buzz.team) ?? []),
    ...(currentQuestionState?.noPenalty.map((missed) => missed.team) ?? []),
  ]);
  const negsAvailable = (side: LeftOrRight) =>
    scoringEnabled &&
    phase.kind === 'tossup' &&
    phase.eligibleTeams.includes(side) &&
    currentQuestionState?.readout !== true &&
    (answeredTeams.size === 0 || currentQuestionState?.readingResumed === true);
  const anyNegAvailable = negsAvailable('left') || negsAvailable('right');
  const canResumeReading =
    phase.kind === 'tossup' &&
    answeredTeams.size > 0 &&
    answeredTeams.size < 2 &&
    currentQuestionState?.readingResumed !== true &&
    currentQuestionState?.readout !== true;
  const canReadout = phase.kind === 'tossup' && currentQuestionState?.readout !== true;
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
        game.left.players.filter((player) => game.left.activePlayers.includes(player.name)),
        seating.seating.left,
        (player) => player.name,
      ).map((player) => player.name),
      right: orderBySeating(
        game.right.players.filter((player) => game.right.activePlayers.includes(player.name)),
        seating.seating.right,
        (player) => player.name,
      ).map((player) => player.name),
    }),
    [game.left, game.right, seating.seating],
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
    negsAvailable,
    eligible,
    seatedPlayers,
    dialogOpen: dialog !== null,
    noBuzzAllowed: phase.kind === 'tossup' && !playBlockedByProtest,
    // The same callbacks the buttons are given. A keystroke cannot reach a code path a tap cannot.
    onBuzz: recordBuzz,
    onWrongNoPenalty: (side, playerName) => recordWrongNoPenalty(side, playerName),
    onNoBuzz: recordNoBuzz,
    onUndo: undoWithFeedback,
    onRedo: redoWithFeedback,
    onSeatArmed: (seat) =>
      setKeyStatus({ kind: 'armed', seat, actions: availableActionKeys(format, negsAvailable(seat.side)) }),
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
    if (dialog !== null) return { kind: 'inactive', reason: 'Finish what is open first.' };
    if (bonusStage !== null) {
      return {
        kind: 'choices',
        title: bonusStage.title,
        choices: bonusKeyLegend(bonusStage.options),
        cancellable: bonusStage.cancellable,
      };
    }
    if (phase.kind === 'bonus') {
      // A bonus whose total is typed rather than chosen. Its digits belong to the number field.
      return { kind: 'inactive', reason: 'Type the bonus total.' };
    }
    if (phase.kind !== 'tossup') return { kind: 'inactive', reason: 'No tossup is live.' };
    if (playBlockedByProtest) return { kind: 'inactive', reason: 'Resolve the protest first.' };
    return {
      kind: 'tossup',
      actions: sequenceLegend(format, anyNegAvailable),
      unreachable: unreachableAnswerTypes(format).map(rulingLabel),
    };
  }, [dialog, bonusStage, phase.kind, playBlockedByProtest, format, anyNegAvailable]);

  const lineupChangeAllowed = lineupChangeAllowedAtPhase(substitutionPolicy(procedure), phase.kind);
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
        .filter((addition) => rosterSyncStatus[rosterSyncKey(addition.team, addition.playerName)] !== 'synced')
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
        question.questionNumber === phase.questionNumber && (question.bonus !== undefined || question.awaitingBonus),
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
    ? roomBreakLabel(procedure, roomBreakTaken(procedure, phase.kind === 'score-check' ? game.halfBreaks.length : 0))
    : 'Halftime';
  const progressText = (() => {
    if (phase.kind === 'complete') return 'Game complete';
    if (phase.kind === 'lineup') return 'Choose starters';
    if (phase.kind === 'score-check') return `${currentBreakName} · after tossup ${phase.afterQuestion}`;
    if (phase.kind === 'checkpoint') {
      return phase.checkpoint === 'overtime' ? 'Regulation complete' : 'Initial overtime complete';
    }
    if (phase.kind === 'timeout') return `Timeout · ${phase.team === 'left' ? game.left.name : game.right.name}`;
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
  const downloadQbj = () => onDownload(qbj);

  /**
   * Apply a rules correction, and leave a record of it in the game itself.
   *
   * The note is the whole reason this is not the prop passed straight down. A result whose scores
   * were repriced mid-game and says nothing about it is a result that looks, to whoever imports it on
   * Monday, exactly like one scored wrong. A note event travels into the QBJ with everything else, so
   * the answer is in the document rather than in somebody's memory of the morning.
   *
   * Written into the history handed upward rather than appended through `events.append`, because the
   * two have to be persisted together: `ScoringScreen` writes this array and the corrected format as
   * one operation, and an `append` here would be a third write racing the other two.
   */
  const applyScoringRulesCorrection = async (correction: IScoringRulesCorrection) => {
    if (!onCorrectScoringRules) return;
    const summary = correction.changes.map((change) => `${change.subject}: ${change.detail}`).join('; ');
    const note: ScoreEvent = {
      id: newEventId(),
      questionNumber: lastPlayedQuestion(game),
      type: 'note',
      text: summary === '' ? 'Scoring rules corrected.' : `Scoring rules corrected — ${summary}.`,
    };
    await onCorrectScoringRules({ ...correction, events: [...correction.events, note] });
  };

  const menuItems = scorerMenuItems({
    game,
    format,
    phase,
    procedure,
    currentQuestion,
    lastPlayed: lastPlayedQuestion(game),
    keyboardEnabled,
    submitting,
    canDownloadForms: onDownloadForm !== undefined,
    canCorrectScoringRules: onCorrectScoringRules !== undefined,
    openDialog: setDialog,
    setKeyboardEnabled,
    record,
    newEventId,
    openReview: () => openReviewAt(undefined),
    openReplacement: openReplacementAt,
    downloadQbjBackup: downloadQbj,
    downloadPartialQbj: () => onDownloadForm?.(game, 'partial'),
    downloadLegacyQbj: () => onDownloadForm?.(game, 'legacy-match'),
    print,
  })

  const submit = async () => {
    if (submitInFlight.current) return;
    submitInFlight.current = true;
    setSubmitting(true);
    setSubmitResult(null);
    try {
      setSubmitResult(await onSubmit(qbj));
    } catch {
      setSubmitResult({ ok: false, message: 'This result could not be sent. It is still saved on this device.' });
    } finally {
      submitInFlight.current = false;
      setSubmitting(false);
    }
  };

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
            <span
              className={progressMotion ? 'scorer-progress has-motion-number' : 'scorer-progress'}
            >
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
          {operatorName?.trim() && <span className="scorer-operator">Scorekeeper: {operatorName.trim()}</span>}
        </div>
      </header>

      <ScorerBanners
        connection={connection}
        recovery={recoveryStatus}
        alerts={alerts ?? []}
        degradedMessage={degradedMessage}
        onDownload={() => downloadQbj()}
      />
      {recoveryNotice && <p className="scorer-banner is-info">{recoveryNotice}</p>}
      {/*
        `role="status"` for the ordinary case, which is a completed action being acknowledged: it is
        announced when the reader gets to it and interrupts nothing. `role="alert"` is kept for the
        notices that are a problem rather than a receipt — see `IOperationNotice`. A screen reader
        stopped mid-sentence to be told a substitution worked would learn to distrust the one thing
        that interrupting is for.
      */}
      {operationNotice && (
        <div
          className={operationNotice.tone === 'warning' ? 'scorer-banner is-warning' : 'scorer-banner is-info'}
          role={operationNotice.tone === 'warning' ? 'alert' : 'status'}
        >
          <span className="scorer-banner-message">{operationNotice.message}</span>
          {operationNotice.dismissible && (
            <button
              type="button"
              className="scorer-banner-dismiss"
              aria-label="Dismiss recovery notice"
              title="Dismiss recovery notice"
              onClick={dismissOperationNotice}
            >
              <span aria-hidden="true">×</span>
            </button>
          )}
        </div>
      )}
      {/*
        A refused action is never silent. The engine rejecting a second buzz on the same tossup is
        almost always a double-tap the scorekeeper did not know they made, and a button that simply
        did nothing would leave them wondering whether the first one landed either.
      */}
      {events.rejection && (
        <p className="scorer-banner is-warning" role="alert">
          {events.rejection}
        </p>
      )}
      {controlRequest.kind === 'sending' && (
        <p className="scorer-banner is-info" role="status">
          Requesting tournament control…
        </p>
      )}
      {controlRequest.kind === 'outstanding' && (
        <div className="scorer-banner is-info" role="status">
          <span>
            Tournament control requested · {helpRequestCategoryLabels[controlRequest.request.category]} ·{' '}
            {formatControlRequestTime(controlRequest.requestedAt, controlRequest.requestedAtSource)}
          </span>
          {onCancelControlRequest && controlRequest.request.id && controlRequest.canCancel !== false && (
            <button type="button" className="scorer-text-action" onClick={() => void onCancelControlRequest()}>
              Cancel request for control
            </button>
          )}
        </div>
      )}
      {controlRequest.kind === 'failed' && (
        <div className="scorer-banner is-warning" role="alert">
          <span>Tournament control was not reached.</span>
          {onRetryControlRequest && controlRequest.retryable && (
            <button type="button" className="scorer-text-action" onClick={() => void onRetryControlRequest()}>
              Try request again
            </button>
          )}
        </div>
      )}
      {controlRequest.kind === 'refused' && (
        <div className="scorer-banner is-warning" role="alert">
          <span>Tournament control refused this request.</span>
          {onRetryControlRequest && controlRequest.retryable && (
            <button type="button" className="scorer-text-action" onClick={() => void onRetryControlRequest()}>
              Try request again
            </button>
          )}
        </div>
      )}

      {phase.kind === 'lineup' && (
        <StartingLineupPrompt
          left={game.left}
          right={game.right}
          maximumActive={format.players.maximumActive}
          needed={phase.teams}
          procedure={procedure}
          requiredStarterCount={requiredStarterCount}
          onAddPlayer={(team, playerName) => addRosterPlayer(team, playerName)}
          onConfirm={(lineups) => {
            const problem = validateStartingLineups?.(lineups);
            if (problem) return problem;
            seating.arrange(
              {
                left: game.left.players.map((player) => player.name),
                right: game.right.players.map((player) => player.name),
              },
              lineups,
            );
            const chosen = (Object.keys(lineups) as LeftOrRight[]).map((side) => ({
              id: newEventId(),
              type: 'substitution' as const,
              questionNumber: 1,
              team: side,
              activePlayers: lineups[side] as string[],
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
              unsyncedRosterAdditions={unsyncedRosterAdditions}
              warnings={warnings}
              blockers={blockers}
              submitting={submitting}
              onSubmit={submit}
              onDownload={downloadQbj}
              onReview={() => openReviewAt(undefined)}
            />
            {submitResult && (
              <div className={submitResult.ok ? 'scorer-complete-ok' : 'scorer-complete-warning'}>
                {/**
                  A finished game that could not be handed over is the one moment where the
                  difference between "wait" and "carry this file to the director" decides
                  whether the game reaches the standings. Both are said, and which one is
                  said depends on whether there is a delivery path at all.
                */}
                {!submitResult.ok && connection === RoomConnectionState.Offline && (
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
            <div className="scorer-teams">
              <TeamPanel
                format={format}
                team={game.left}
                seatOrder={seating.seating.left}
                flashSeat={keyEcho?.side === 'left' ? keyEcho.seat : undefined}
                scoringEnabled={scoringEnabled}
                eligible={eligible('left')}
                negsAvailable={negsAvailable('left')}
                timeoutsUsed={(procedure?.timeoutsPerTeam ?? 0) > 0 ? game.timeouts.left : undefined}
                timeoutsPerTeam={(procedure?.timeoutsPerTeam ?? 0) > 0 ? procedure?.timeoutsPerTeam : undefined}
                onBuzz={(playerName, answerType) => recordBuzz('left', playerName, answerType)}
                onWrongNoPenalty={(playerName) => recordWrongNoPenalty('left', playerName)}
                onSubstitute={(outgoing, incoming) => substituteFromRow('left', outgoing, incoming)}
                benchPlayers={benchFor('left')}
                substitutionAllowed={lineupChangeAllowed}
                substitutionBlockedReason={lineupChangeReason}
                substitutionQuestionNumber={lineupQuestion}
              />
              <TeamPanel
                format={format}
                team={game.right}
                seatOrder={seating.seating.right}
                flashSeat={keyEcho?.side === 'right' ? keyEcho.seat : undefined}
                scoringEnabled={scoringEnabled}
                eligible={eligible('right')}
                negsAvailable={negsAvailable('right')}
                timeoutsUsed={(procedure?.timeoutsPerTeam ?? 0) > 0 ? game.timeouts.right : undefined}
                timeoutsPerTeam={(procedure?.timeoutsPerTeam ?? 0) > 0 ? procedure?.timeoutsPerTeam : undefined}
                onBuzz={(playerName, answerType) => recordBuzz('right', playerName, answerType)}
                onWrongNoPenalty={(playerName) => recordWrongNoPenalty('right', playerName)}
                onSubstitute={(outgoing, incoming) => substituteFromRow('right', outgoing, incoming)}
                benchPlayers={benchFor('right')}
                substitutionAllowed={lineupChangeAllowed}
                substitutionBlockedReason={lineupChangeReason}
                substitutionQuestionNumber={lineupQuestion}
              />
            </div>

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
                  breakName={currentBreakName}
                  substitutionMessage={substitutionMessage}
                  onPlayers={() => setDialog('players')}
                  onContinue={() => record({ id: newEventId(), type: 'half-resume', questionNumber: currentQuestion })}
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
                  {canResumeReading && (
                    <button type="button" className="scorer-action" onClick={recordReadingResumed} disabled={playBlockedByProtest}>
                      Resume reading
                    </button>
                  )}
                  {canReadout && (
                    <button type="button" className="scorer-action" onClick={recordReadout} disabled={playBlockedByProtest}>
                      Question read out
                    </button>
                  )}
                  {phase.eligibleTeams.length === 1 && (
                    <p className="scorer-hint">
                      {phase.eligibleTeams[0] === 'left' ? game.left.name : game.right.name} may still answer.
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
                      {game.left.name} <strong>{game.left.points}</strong>
                    </span>
                    <span>
                      {game.right.name} <strong>{game.right.points}</strong>
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
                    Timeout · {phase.team === 'left' ? game.left.name : game.right.name}
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
                  controllingSide={phase.team}
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
        <button type="button" className="scorer-action" onClick={undoWithFeedback} disabled={submitting || !events.canUndo}>
          <ControlIcon name="undo" />
          Undo
        </button>
        <button type="button" className="scorer-action" onClick={redoWithFeedback} disabled={submitting || !events.canRedo}>
          <ControlIcon name="redo" />
          Redo
        </button>
        <button type="button" className="scorer-action" onClick={() => setDialog('players')} disabled={submitting}>
          <ControlIcon name="players" />
          Players
        </button>
        <button type="button" className="scorer-action" onClick={() => setDialog('flag')} disabled={submitting}>
          <ControlIcon name="flag" />
          Flag
        </button>
        <GameMenu items={menuItems} />
        {warnings.length > 0 && phase.kind !== 'complete' && (
          <span className="scorer-footer-warning" aria-label={warnings.join(' ')}>
            {warnings[0]}
            {warnings.length > 1 && ` (+${warnings.length - 1} more; see final review)`}
          </span>
        )}
      </footer>

      {dialog === 'players' && (
        <PlayersDialog
          left={game.left}
          right={game.right}
          maximumActive={format.players.maximumActive}
          questionNumber={lineupQuestion}
          rosterSyncStatus={rosterSyncStatus}
          timeouts={game.timeouts}
          timeoutsPerTeam={procedure?.timeoutsPerTeam ?? 0}
          lineupChangeAllowed={lineupChangeAllowed}
          rosterAdditionAllowed={rosterAdditionAllowed}
          lineupChangeReason={lineupChangeReason}
          seating={seating.seating}
          onMovePlayer={(team, visibleNames, playerName, direction) => {
            if (submitting) return;
            seating.move(
              team,
              (team === 'left' ? game.left : game.right).players.map((player) => player.name),
              visibleNames,
              playerName,
              direction,
            );
          }}
          onSeatSubstitute={(team, outgoing, incoming) => {
            if (submitting) return;
            seating.substitute(
              team,
              (team === 'left' ? game.left : game.right).players.map((player) => player.name),
              outgoing,
              incoming,
            );
          }}
          onSubstitute={(team, activePlayers) => {
            if (submitting) return;
            record({ id: newEventId(), type: 'substitution', questionNumber: lineupQuestion, team, activePlayers });
            setDialog(null);
          }}
          onAddPlayer={(team, playerName, activePlayers) => {
            if (submitting) return;
            addRosterPlayer(team, playerName, activePlayers);
            setDialog(null);
          }}
          onRequestControl={
            onRequestControl
              ? (team, playerName) => {
                  const teamName = team === 'left' ? game.left.name : game.right.name;
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
          game={game}
          onRecord={(team, points) =>
            record({ id: newEventId(), type: 'lightning', questionNumber: currentQuestion, team, points })
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
          game={game}
          onAdjust={(team, points, reason) => {
            record({ id: newEventId(), type: 'adjustment', questionNumber: currentQuestion, team, points, reason });
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'forfeit' && (
        <ForfeitDialog
          game={game}
          onForfeit={(teams) => {
            record({ id: newEventId(), type: 'forfeit', questionNumber: currentQuestion, teams });
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
              noteControlOutcome({ prefix: 'Issue saved', localOnly: 'Issue saved on the scoresheet.' }, result);
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
          game={game}
          questionNumber={currentQuestion}
          controlRequest={controlRequest}
          onRetryControl={onRetryControlRequest}
          onCancelControl={onCancelControlRequest}
          onRecord={async (team, subject, description, requestControl) => {
            if (submitting) return undefined;
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
                result = await onRequestControl('protest', `Q${currentQuestion} protest by ${teamName}: ${description}`);
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
          game={game}
          timeoutsPerTeam={procedure?.timeoutsPerTeam ?? 0}
          onRecord={(team) =>
            record({
              id: newEventId(),
              type: 'timeout-start',
              questionNumber: currentQuestion,
              team,
              startedAt: Date.now(),
            })
          }
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'replace' && (reviewFocus !== undefined || phase.kind === 'tossup' || phase.kind === 'bonus') && (
        <ReplaceQuestionDialog
          questionNumber={reviewFocus ?? (phase.kind === 'tossup' || phase.kind === 'bonus' ? phase.questionNumber : 1)}
          bonusReplaceable={
            (reviewFocus !== undefined &&
              (game.questions.find((question) => question.questionNumber === reviewFocus)?.bonus !== undefined ||
                game.questions.find((question) => question.questionNumber === reviewFocus)?.awaitingBonus === true)) ||
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
            record(
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
          game={game}
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
          moderator={moderatorName}
          scorekeeper={operatorName ?? ''}
          onSave={setModeratorName}
          onClose={() => setDialog(null)}
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
          tournamentName={tournamentName}
          roundName={roundName}
          roomName={roomName}
          packetName={packetName}
          operatorName={operatorName}
        />
      )}
      {dialog === 'scoring-rules' && onCorrectScoringRules && (
        <ScoringRulesCorrectionDialog
          format={format}
          events={events.events}
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
    </div>
  );
}
