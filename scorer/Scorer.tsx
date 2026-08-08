/**
 * The scorekeeping screen.
 *
 * It shows a tournament, a round, a room and two teams. It does not show a product name, a packet, a
 * question, or a reader control, because the scorekeeper is sitting next to somebody reading from
 * paper and none of those things exist for them.
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LeftOrRight } from '../../renderer/Utils/UtilTypes';
import { HelpRequestCategory } from '../../main/server/ServerTypes';
import { IScorekeeperAnswerType, IScorekeeperFormat } from '../../renderer/Services/ScorekeeperFormat';
import {
  IRoomProcedure,
  lineupChangeAllowedAtPhase,
  protestBlocksCheckpoint,
  protestBlocksSuddenDeathTossup,
  protestCheckpointPolicy,
  substitutionPolicy,
} from '../../renderer/Services/RoomProcedure';
import deriveGame, { IGameSetup, lastPlayedQuestion, lineupChangeEffectiveQuestion } from '../scoring/deriveGame';
import { IBonusPartResult, ScoreEvent } from '../scoring/ScoreEvents';
import validateScoresheet from '../scoring/validateScoresheet';
import toQbjMatch, { IQbjMatchMeta } from '../scoring/toQbjMatch';
import { RoomConnectionState } from '../RoomLifecycle';
import TeamPanel from './TeamPanel';
import BonusPrompt from './BonusPrompt';
import RecentRail from './RecentRail';
import GameMenu, { IGameMenuItem } from './GameMenu';
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
import { FlagDialog, IssueDialog, RecoveryDialog, ScoresheetReviewDialog } from './OperationsDialogs';
import { attachScorerRecovery } from './ScorerRecovery';
import { downloadCurrentQbj } from '../QbjBackup';
import useRoomClock from './useRoomClock';
import useScreenWakeLock from './useScreenWakeLock';
import { formatClock, roomClockSegment } from './RoomClock';

export interface IScorerSubmitResult {
  ok: boolean;
  message: string;
}

export interface IScorerProps {
  /** Stable per-game key used for local recovery state such as the room clock. */
  gameKey: string;
  format: IScorekeeperFormat;
  setup: IGameSetup;
  events: IGameEventsApi;
  /** Shown as the page's identity. The tournament, not the software. */
  tournamentName: string;
  roundName: string;
  // eslint-disable-next-line react/require-default-props
  roomName?: string;
  /**
   * The packet this round uses, when the tournament named one.
   *
   * Identity only, never any question text. A reader working from paper can be handed the wrong
   * packet, and one line saying which one this round is on is the cheapest catch there is.
   */
  // eslint-disable-next-line react/require-default-props
  packetName?: string;
  /** Halves, clock and timeouts. Absent means the room runs none of it, which is the default. */
  // eslint-disable-next-line react/require-default-props
  procedure?: IRoomProcedure;
  /** Whoever is signed in to this room browser. Recorded on the result as the scorekeeper. */
  // eslint-disable-next-line react/require-default-props
  operatorName?: string;
  connection: RoomConnectionState;
  /** Set when the room is degraded: the game is real, the room state behind it is stale. */
  // eslint-disable-next-line react/require-default-props
  degradedMessage?: string;
  /** False when this browser could not save the game locally. */
  // eslint-disable-next-line react/require-default-props
  saved?: boolean;
  /** Sends the finished game. The room owns what that means; this only decides when. */
  onSubmit: (qbj: object) => Promise<IScorerSubmitResult>;
  /** Writes the current game out as a file, at any point. */
  // eslint-disable-next-line react/require-default-props
  onDownload?: (qbj: object) => void;
  /** Called as the game changes, so tournament control can watch progress. */
  // eslint-disable-next-line react/require-default-props
  onProgress?: (qbj: object, questionsPlayed: number) => void;
  /** Round number and the rest of the non-scoring metadata for the exported match. */
  // eslint-disable-next-line react/require-default-props
  qbjMeta?: IQbjMatchMeta;
  /** Sends an operational issue to tournament control for the assigned-room workflow. */
  // eslint-disable-next-line react/require-default-props
  onRequestControl?: (category: HelpRequestCategory, message: string) => Promise<void>;
  /** True while this room already has an open request in control's queue. */
  // eslint-disable-next-line react/require-default-props
  controlRequestPending?: boolean;
  /** The event list was restored automatically from local storage. */
  // eslint-disable-next-line react/require-default-props
  recovered?: boolean;
  /** Latest server rosters confirm durable tournament synchronization; they never replace setup. */
  // eslint-disable-next-line react/require-default-props
  authoritativeRosters?: Record<LeftOrRight, string[]>;
  /** Narrow authoritative roster-add request for an assigned room. */
  // eslint-disable-next-line react/require-default-props
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
  | null;

/** How often, at most, to tell tournament control how the game is going. Matches MODAQ's old timer. */
const progressIntervalMs = 5000;

function connectionLabel(connection: RoomConnectionState): string {
  if (connection === RoomConnectionState.Connected) return 'Connected';
  if (connection === RoomConnectionState.Offline) return 'Offline';
  return 'Connection issue';
}

function connectionClass(connection: RoomConnectionState): string {
  if (connection === RoomConnectionState.Connected) return 'scorer-conn is-ok';
  if (connection === RoomConnectionState.Offline) return 'scorer-conn is-offline';
  return 'scorer-conn is-degraded';
}

export default function Scorer(props: IScorerProps) {
  const {
    gameKey,
    format,
    setup,
    events,
    tournamentName,
    roundName,
    roomName,
    packetName,
    procedure,
    operatorName,
    connection,
    degradedMessage,
    saved,
    onSubmit,
    onDownload,
    onProgress,
    qbjMeta,
    onRequestControl,
    controlRequestPending = false,
    recovered = false,
    authoritativeRosters,
    onSyncRosterPlayer,
  } = props;

  const [dialog, setDialog] = useState<OpenDialog>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<IScorerSubmitResult | null>(null);
  const [operationNotice, setOperationNotice] = useState(
    recovered ? 'Recovered the in-progress game saved on this device.' : '',
  );
  const [rejectedRosterSyncs, setRejectedRosterSyncs] = useState<Record<string, true>>({});
  const rosterSyncAttempts = useRef(new Map<string, { attempts: number; lastAt: number }>());
  /** Which question the scoresheet review should open at, when it was opened from somewhere specific. */
  const [reviewFocus, setReviewFocus] = useState<number | undefined>(undefined);
  const [reviewEditQuestion, setReviewEditQuestion] = useState<number | undefined>(undefined);
  const [issueCategory, setIssueCategory] = useState<HelpRequestCategory>('question-packet');
  const [moderatorName, setModeratorName] = useState(qbjMeta?.moderator ?? '');
  const [timeoutNow, setTimeoutNow] = useState(() => Date.now());
  const game = useMemo(() => deriveGame(format, setup, events.events), [format, setup, events.events]);
  const clockSegment = roomClockSegment(
    procedure?.halves,
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

  const record = useCallback((...added: ScoreEvent[]) => events.append(...added), [events]);

  const recordBuzz = useCallback(
    (team: LeftOrRight, playerName: string, answerType: IScorekeeperAnswerType) => {
      if (phase.kind !== 'tossup') return;
      record({
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
      if (phase.kind !== 'tossup') return;
      record({
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
    if (phase.kind !== 'tossup') return;
    record({ id: newEventId(), type: 'tossup-dead', questionNumber: phase.questionNumber });
  }, [record, phase]);

  const recordBonus = useCallback(
    (controlledPoints: number, bouncebackPoints?: number) => {
      if (phase.kind !== 'bonus') return;
      record({
        id: newEventId(),
        type: 'bonus',
        questionNumber: phase.questionNumber,
        team: phase.team,
        controlledPoints,
        bouncebackPoints,
      });
    },
    [record, phase],
  );

  const recordBonusParts = useCallback(
    (parts: IBonusPartResult[]) => {
      if (phase.kind !== 'bonus') return;
      record({
        id: newEventId(),
        type: 'bonus',
        questionNumber: phase.questionNumber,
        team: phase.team,
        parts,
      });
    },
    [record, phase],
  );

  const openReviewAt = useCallback((questionNumber?: number, edit = false) => {
    setReviewFocus(questionNumber);
    setReviewEditQuestion(edit ? questionNumber : undefined);
    setDialog('review');
  }, []);

  const openReplacementAt = useCallback((questionNumber: number) => {
    setReviewFocus(questionNumber);
    setReviewEditQuestion(undefined);
    setDialog('replace');
  }, []);

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

  // Space records an unanswered tossup, but only when the keyboard is not already aimed at
  // something: with focus on a button, Space is that button, and stealing it would score the wrong
  // thing. Ctrl/Cmd+Z is undo, which is the one shortcut every scorekeeper already expects.
  useEffect(() => {
    const onKeyDown = (keyEvent: KeyboardEvent) => {
      const target = keyEvent.target as HTMLElement | null;
      const inControl = !!target?.closest('button, input, select, textarea, [role="dialog"]');

      if (
        (keyEvent.metaKey || keyEvent.ctrlKey) &&
        keyEvent.key.toLowerCase() === 'z' &&
        !inControl &&
        dialog === null
      ) {
        keyEvent.preventDefault();
        if (keyEvent.shiftKey) events.redo();
        else events.undo();
        return;
      }
      if (keyEvent.key === ' ' && !inControl && dialog === null && phase.kind === 'tossup' && !playBlockedByProtest) {
        keyEvent.preventDefault();
        recordNoBuzz();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [events, recordNoBuzz, dialog, phase.kind, playBlockedByProtest]);

  const scoringEnabled = phase.kind === 'tossup' && !playBlockedByProtest;
  const eligible = (side: LeftOrRight) =>
    scoringEnabled && phase.kind === 'tossup' && phase.eligibleTeams.includes(side);
  /**
   * Nobody has answered this tossup yet, so a neg is still a possible ruling.
   *
   * Both teams still being eligible is exactly that condition: an answer of any kind — a buzz or a
   * zero — removes the team that gave it from the eligible list. See `TeamPanel`.
   */
  const negsAvailable = scoringEnabled && phase.kind === 'tossup' && phase.eligibleTeams.length === 2;
  let noBuzzLabel = 'No buzz';
  if (playBlockedByProtest) {
    noBuzzLabel = 'Resolve protest before play';
  } else if (phase.kind === 'tossup' && phase.eligibleTeams.length === 1) {
    noBuzzLabel = `${phase.eligibleTeams[0] === 'left' ? game.left.name : game.right.name} has no answer`;
  }

  const lineupChangeAllowed = lineupChangeAllowedAtPhase(substitutionPolicy(procedure), phase.kind);
  const rosterAdditionAllowed = phase.kind !== 'complete';
  const lineupChangeReason =
    phase.kind === 'complete'
      ? 'This game is complete. Use scoresheet review to correct historical lineup information.'
      : 'This procedure allows lineup changes at halftime, timeouts, and phase checkpoints.';

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

  const progress = (() => {
    if (phase.kind === 'complete') return 'Game complete';
    if (phase.kind === 'lineup') return 'Choose starters';
    if (phase.kind === 'score-check') return `Halftime · after tossup ${phase.afterQuestion}`;
    if (phase.kind === 'checkpoint') {
      return phase.checkpoint === 'overtime' ? 'Regulation complete' : 'Initial overtime complete';
    }
    if (phase.kind === 'timeout') return `Timeout · ${phase.team === 'left' ? game.left.name : game.right.name}`;
    if (phase.period === 'overtime') {
      const overtimeNumber = game.overtimeTossupsRead + (phase.kind === 'tossup' ? 1 : 0);
      // Sudden death is a state a game arrives at, not a property a format has: NAQT plays three
      // overtime tossups and only then becomes sudden death.
      const suddenDeath = game.suddenDeathStarted ? ' · sudden death' : '';
      return `Overtime tossup ${Math.max(1, overtimeNumber)}${suddenDeath}`;
    }
    if (format.regulation.timed) return `Tossup ${phase.questionNumber} · timed round`;
    return `Tossup ${phase.questionNumber} of ${format.regulation.tossupCount}`;
  })();

  const menuItems: IGameMenuItem[] = [
    { label: 'Notes', onSelect: () => setDialog('notes') },
    { label: 'Protests', onSelect: () => setDialog('protests') },
    { label: 'Issue / tournament control', onSelect: () => setDialog('issue') },
    { label: 'Game details', onSelect: () => setDialog('details') },
    { label: 'Full scoresheet review', onSelect: () => openReviewAt(undefined) },
  ];
  if (format.lightning.enabled)
    menuItems.push({ label: 'Lightning / worksheet', onSelect: () => setDialog('lightning') });
  if ((procedure?.timeoutsPerTeam ?? 0) > 0 && phase.kind !== 'complete' && phase.kind !== 'timeout') {
    menuItems.push({ label: 'Timeout', onSelect: () => setDialog('timeout') });
  }
  if (phase.kind === 'timeout') {
    menuItems.push({
      label: 'Resume play',
      onSelect: () => record({ id: newEventId(), type: 'timeout-resume', questionNumber: currentQuestion }),
    });
  }
  if (procedure?.halves && phase.kind !== 'complete' && !game.awaitingScoreCheck) {
    menuItems.push({
      label: `End ${game.halfBreaks.length === 0 ? 'first' : 'this'} half`,
      // The boundary is the last tossup actually played, not the one on screen. A displayed
      // question with nothing recorded against it has not been read.
      onSelect: () =>
        record({
          id: newEventId(),
          type: 'half-break',
          questionNumber: currentQuestion,
          lastQuestion: lastPlayedQuestion(game),
        }),
    });
  }
  if (format.regulation.timed && !game.regulationComplete && phase.kind !== 'complete') {
    menuItems.push({
      label: 'End regulation',
      /*
       * `lastRegulationQuestion` is the fix for the boundary being one out. Q18 finishes, Q19
       * appears, the horn goes before anybody reads it: the last regulation question is 18, and
       * recording 19 would make the first overtime tossup count as regulation.
       */
      onSelect: () =>
        record({
          id: newEventId(),
          type: 'end-regulation',
          questionNumber: currentQuestion,
          lastRegulationQuestion: lastPlayedQuestion(game),
        }),
    });
  }
  if (phase.kind === 'tossup' || phase.kind === 'bonus') {
    menuItems.push({
      label: `Replace question ${phase.questionNumber}`,
      onSelect: () => openReplacementAt(phase.questionNumber),
    });
  }
  if (phase.kind !== 'complete' && game.tossupsRead > 0) {
    menuItems.push({ label: 'End game early…', onSelect: () => setDialog('end-early'), destructive: true });
  }
  const downloadQbj = () => {
    if (onDownload) onDownload(qbj);
    else {
      downloadCurrentQbj(qbj, {
        roundName,
        roundNumber: qbjMeta?.round,
        roomName,
        leftTeam: game.left.name,
        rightTeam: game.right.name,
      });
    }
  };
  menuItems.push({ label: 'Download QBJ backup', onSelect: downloadQbj });
  menuItems.push({ label: 'Recover from QBJ', onSelect: () => setDialog('recovery') });
  menuItems.push({ label: 'Adjust score', onSelect: () => setDialog('adjust') });
  if (phase.kind !== 'complete') {
    menuItems.push({ label: 'Record forfeit', onSelect: () => setDialog('forfeit'), destructive: true });
  }

  const submit = async () => {
    setSubmitting(true);
    setSubmitResult(null);
    try {
      setSubmitResult(await onSubmit(qbj));
    } catch {
      setSubmitResult({ ok: false, message: 'This result could not be sent. It is still saved on this device.' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="scorer">
      <header className="scorer-header">
        <div className="scorer-header-main">
          <h1 className="scorer-tournament">{tournamentName}</h1>
          <p className="scorer-context">
            {roundName}
            {roomName && <> · {roomName}</>}
            {packetName && <> · {packetName}</>}
          </p>
        </div>
        <div className="scorer-header-side">
          <span className="scorer-progress">{progress}</span>
          {roomClock.configured && (
            <span className={roomClock.state.status === 'expired' ? 'scorer-clock is-expired' : 'scorer-clock'}>
              <span aria-label="Room clock">
                {roomClock.state.status === 'expired' ? 'Time expired' : roomClock.display}
              </span>
              {roomClock.state.status === 'idle' && (
                <button type="button" className="scorer-clock-button" onClick={roomClock.start}>
                  Start
                </button>
              )}
              {roomClock.state.status === 'running' && (
                <button type="button" className="scorer-clock-button" onClick={roomClock.pause}>
                  Pause
                </button>
              )}
              {roomClock.state.status === 'paused' && (
                <button type="button" className="scorer-clock-button" onClick={roomClock.resume}>
                  Resume
                </button>
              )}
              {roomClock.state.status === 'expired' && (
                <button type="button" className="scorer-clock-button" onClick={resetRoomClock}>
                  Reset
                </button>
              )}
            </span>
          )}
          <span className={connectionClass(connection)}>
            <span className="scorer-dot" aria-hidden="true" />
            {connectionLabel(connection)}
          </span>
        </div>
      </header>

      {degradedMessage && <p className="scorer-banner is-warning">{degradedMessage}</p>}
      {saved === false && (
        <p className="scorer-banner is-error">
          This device could not save the game locally. Do not reload the page &mdash; the questions scored so far exist
          only on this screen.
        </p>
      )}
      {operationNotice && <p className="scorer-banner is-info">{operationNotice}</p>}
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
      {controlRequestPending && (
        <p className="scorer-banner is-info">Tournament control has this room&apos;s request.</p>
      )}

      {phase.kind === 'lineup' && (
        <StartingLineupPrompt
          left={game.left}
          right={game.right}
          maximumActive={format.players.maximumActive}
          needed={phase.teams}
          onConfirm={(lineups) => {
            const chosen = (Object.keys(lineups) as LeftOrRight[]).map((side) => ({
              id: newEventId(),
              type: 'substitution' as const,
              questionNumber: 1,
              team: side,
              activePlayers: lineups[side] as string[],
            }));
            record(...chosen);
          }}
        />
      )}

      {phase.kind !== 'lineup' && (
        <div className="scorer-body">
          <main className="scorer-main">
            <div className="scorer-teams">
              <TeamPanel
                format={format}
                team={game.left}
                scoringEnabled={scoringEnabled}
                eligible={eligible('left')}
                negsAvailable={negsAvailable}
                timeoutsUsed={(procedure?.timeoutsPerTeam ?? 0) > 0 ? game.timeouts.left : undefined}
                onBuzz={(playerName, answerType) => recordBuzz('left', playerName, answerType)}
                onWrongNoPenalty={(playerName) => recordWrongNoPenalty('left', playerName)}
              />
              <TeamPanel
                format={format}
                team={game.right}
                scoringEnabled={scoringEnabled}
                eligible={eligible('right')}
                negsAvailable={negsAvailable}
                timeoutsUsed={(procedure?.timeoutsPerTeam ?? 0) > 0 ? game.timeouts.right : undefined}
                onBuzz={(playerName, answerType) => recordBuzz('right', playerName, answerType)}
                onWrongNoPenalty={(playerName) => recordWrongNoPenalty('right', playerName)}
              />
            </div>

            <div className="scorer-stage">
              {phase.kind === 'score-check' && (
                <HalftimeCheck
                  game={game}
                  afterQuestion={phase.afterQuestion}
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
                        }. Players may be changed now.`
                      : 'Next score change wins. Players may be changed now.'}
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
                  <p className="scorer-dialog-note">Players and substitutions are allowed while play is paused.</p>
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
                />
              )}

              {phase.kind === 'complete' && (
                <div className="scorer-complete">
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
                    <p className={submitResult.ok ? 'scorer-complete-ok' : 'scorer-complete-warning'}>
                      {submitResult.message}
                    </p>
                  )}
                </div>
              )}
            </div>
          </main>

          <RecentRail game={game} onInspect={(questionNumber) => openReviewAt(questionNumber, true)} />
        </div>
      )}

      <footer className="scorer-footer">
        <button type="button" className="scorer-action" onClick={events.undo} disabled={!events.canUndo}>
          Undo
        </button>
        <button type="button" className="scorer-action" onClick={events.redo} disabled={!events.canRedo}>
          Redo
        </button>
        <button type="button" className="scorer-action" onClick={() => setDialog('players')}>
          Players
        </button>
        <button type="button" className="scorer-action" onClick={() => setDialog('flag')}>
          Flag
        </button>
        <GameMenu items={menuItems} />
        {warnings.length > 0 && phase.kind !== 'complete' && (
          <span className="scorer-footer-warning">{warnings[0]}</span>
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
          onSubstitute={(team, activePlayers) => {
            record({ id: newEventId(), type: 'substitution', questionNumber: lineupQuestion, team, activePlayers });
            setDialog(null);
          }}
          onAddPlayer={(team, playerName, activePlayers) => {
            const teamName = team === 'left' ? game.left.name : game.right.name;
            const activeLineup = team === 'left' ? game.left.activePlayers : game.right.activePlayers;
            const activatesPlayer =
              activePlayers.length !== activeLineup.length ||
              activePlayers.some((name, index) => name !== activeLineup[index]);
            record(
              { id: newEventId(), type: 'roster-add', questionNumber: lineupQuestion, team, playerName },
              ...(activatesPlayer
                ? [
                    {
                      id: newEventId(),
                      type: 'substitution' as const,
                      questionNumber: lineupQuestion,
                      team,
                      activePlayers,
                    },
                  ]
                : []),
            );
            setDialog(null);
            if (!activatesPlayer) {
              if (onRequestControl) {
                setOperationNotice(`Added ${playerName} to the bench; requesting tournament control.`);
                Promise.resolve()
                  .then(() => onRequestControl('roster-change', `Please add ${playerName} to ${teamName}.`))
                  .then(
                    () => setOperationNotice(`Added ${playerName} to the bench; tournament control was notified.`),
                    () =>
                      setOperationNotice(
                        `Added ${playerName} to the bench for this game. Tournament control could not be reached.`,
                      ),
                  )
                  .catch(() => undefined);
              } else {
                setOperationNotice(`Added ${playerName} to the bench; available at the next substitution window.`);
              }
            } else if (onSyncRosterPlayer && authoritativeRosters) {
              setOperationNotice(`Added ${playerName} to ${teamName}; syncing with tournament control.`);
            } else if (onRequestControl) {
              setOperationNotice(`Added ${playerName} to ${teamName}; requesting tournament control.`);
              Promise.resolve()
                .then(() => onRequestControl('roster-change', `Please add ${playerName} to ${teamName}.`))
                .then(
                  () => setOperationNotice(`Added ${playerName} to ${teamName}; tournament control was notified.`),
                  () =>
                    setOperationNotice(
                      `Added ${playerName} to ${teamName} for this game. Tournament control could not be reached.`,
                    ),
                )
                .catch(() => undefined);
            } else {
              setOperationNotice(`Added ${playerName} to ${teamName} for this game.`);
            }
          }}
          onRequestControl={
            onRequestControl
              ? (team, playerName) => {
                  const teamName = team === 'left' ? game.left.name : game.right.name;
                  onRequestControl('roster-change', `Please add ${playerName} to ${teamName}.`).catch(() => undefined);
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
          controlAvailable={onRequestControl !== undefined}
          requestPending={controlRequestPending}
          initialCategory={issueCategory}
          onReport={async (category, details, requestControl) => {
            let label = 'Issue';
            if (category === 'protest') label = 'Protest';
            else if (category === 'question-packet') label = 'Question / packet issue';
            let controlSent = false;
            if (requestControl && onRequestControl) {
              try {
                await onRequestControl(category, details);
                controlSent = true;
              } catch {
                controlSent = false;
              }
            }
            record({
              id: newEventId(),
              type: 'note',
              questionNumber: currentQuestion,
              text: `${label}: ${details}`,
              flagged: true,
            });
            if (controlSent) setOperationNotice('Issue saved and sent to tournament control.');
            else if (requestControl)
              setOperationNotice('Issue saved on the scoresheet, but tournament control could not be reached.');
            else setOperationNotice('Issue saved on the scoresheet.');
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
          onReplace={events.replace}
          onRemove={events.remove}
          onReplaceQuestion={events.replaceQuestion}
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
          controlAvailable={onRequestControl !== undefined && !controlRequestPending}
          onRecord={(team, subject, description, requestControl) => {
            const teamName = team === 'left' ? game.left.name : game.right.name;
            record({
              id: newEventId(),
              type: 'protest',
              questionNumber: currentQuestion,
              team,
              subject,
              description,
              status: 'open',
            });
            if (requestControl && onRequestControl) {
              setOperationNotice('Protest recorded; asking tournament control to come.');
              onRequestControl('protest', `Q${currentQuestion} protest by ${teamName}: ${description}`)
                .then(() => setOperationNotice('Protest recorded and tournament control was asked to come.'))
                .catch(() =>
                  setOperationNotice(
                    'Protest recorded on the scoresheet, but tournament control could not be reached.',
                  ),
                );
            } else {
              setOperationNotice('Protest recorded. Keep scoring; tournament control will see it on the result.');
            }
          }}
          onResolve={(protest, status, resolution) => {
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
            setOperationNotice(
              scope === 'bonus'
                ? `The bonus on question ${questionNumber} was cleared. Score the replacement.`
                : `Question ${questionNumber} was cleared. Score the replacement as question ${questionNumber}.`,
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
      {dialog === 'recovery' && (
        <RecoveryDialog
          expectedTeams={setup}
          onRestore={(restoredEvents) => {
            events.restore(restoredEvents);
            setOperationNotice('Recovered the scoresheet from the QBJ backup.');
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
