/**
 * The room page a Chromebook stays on all day.
 *
 * It never asks the scorekeeper which teams are playing. The page polls YellowFruit for its
 * assignment, and when tournament control accepts a result or generates a new round, the next game
 * simply appears — no new URL, no reload, nothing to type. The scorekeeper's only decision is when to
 * press Start.
 *
 * Recovery is the other half of the job, and it has two layers. A refresh, a dropped access point,
 * or a closed and reopened lid all land back here, and the assignment response carries the token of
 * any session already open for this game, so the page resumes the game it was scoring rather than
 * starting a second one. Underneath that, every completed game goes into the outbox on this device
 * before the first upload attempt and stays there until tournament control has accepted it — so a
 * server that disappears for twenty minutes costs the room nothing but patience, and a server that
 * never comes back still leaves every result downloadable as a file.
 *
 * The rule that shapes the offline behavior: while YellowFruit is unreachable, this page does not
 * invent or change room, round, assignment, or schedule state. It shows the last thing YellowFruit
 * actually said, keeps MODAQ working, and says plainly which of the two it is doing.
 *
 * # A game in progress outranks everything the server says
 *
 * The rule that shapes the *failure* behavior, and the one that took the longest to get right: once
 * a game is on screen, nothing arriving over the network may take it off. Not a timeout, not a
 * 500, not a shutdown, not a 403, not tournament control reassigning the room. All of those are
 * operational problems with a scorekeeper's day; none of them is permission to destroy the only
 * copy of the questions this room has scored. So the page freezes what the game started with, keeps
 * writing every action to this device, says what is wrong and what can be done about it, and waits.
 * The scorekeeper leaves the game when the scorekeeper decides to.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IPlayer } from 'modaq';
import {
  cancelRoomHelp,
  addRoomPlayer,
  clearRememberedRoomIdentity,
  createRoomHelp,
  getRoomAssignment,
  getOrCreateDeviceId,
  getRounds,
  getSessionRecovery,
  getTeams,
  getTournament,
  IRoomIdentity,
  ISessionCredentials,
  putSnapshot,
  rememberRoomIdentity,
  startAssignedMatch,
  updateRoomPresence,
} from './api';
import {
  HelpRequestCategory,
  IHelpRequest,
  IRoomAssignmentResponse,
  IRoomMatchup,
  IRoomTeam,
  RoomBlockedReason,
  SessionStatus,
} from '../main/server/ServerTypes';
import { isAwaitingReview, reduceConnectionStatus, resolveLifecycleNotice, RoomConnectionState } from './RoomLifecycle';
import normalizeQbjMatch, { IQbjNormalizeOptions, countPlayedQuestions } from '../renderer/Services/QbjMatchNormalizer';
import useResultOutbox from './useResultOutbox';
import { blocksNewStart, IRoomResultOutboxEntry } from './ResultOutbox';
import SavedResults, { DeliveryFailureNotice } from './SavedResults';
import { buildScoringKit, clearScoringKit, isScoringKitUsable, readScoringKit, writeScoringKit } from './ScoringKit';
import ScoringView from './ScoringView';
import ScoringUnavailable from './ScoringUnavailable';
import ScorerHost from './scorer/ScorerHost';
import { IScorerAlert } from './scorer/ConnectionStatus';
import { readScorerChoice } from './ScorerChoice';
import MatchupCard from './MatchupCard';
import ManualRoomApp from './ManualRoomApp';
import RepairConnectionDialog from './RepairConnectionDialog';
import { clearActiveGame, IActiveRoomGame, readActiveGame, touchActiveGame, writeActiveGame } from './ActiveGameRecord';
import { IScorekeeperFormat, scorekeeperFormatProblems } from '../renderer/Services/ScorekeeperFormat';
import { IRoomProcedure } from '../renderer/Services/RoomProcedure';
import { downloadCurrentQbj } from './QbjBackup';

type ModaqStatus = { isError: false; status: string } | { isError: true; status: string };
type ExportSource = 'Menu' | 'NewGame' | 'NextButton' | 'Timer';
const snapshotIntervalMs = 5000;
const assignmentPollMs = 5000;
const scoringKitRefreshMs = 5 * 60 * 1000;

/**
 * The context a game keeps for its whole life, whatever the server says afterwards.
 *
 * Frozen on purpose. The scoring rules a game was started under decide what every buzz in it was
 * worth, and the rosters decide who the substitutions moved; letting a poll replace either would
 * rewrite the meaning of questions already scored. It is also what makes an offline reload
 * possible at all — none of it has to be fetched to put the game back on screen.
 */
interface IFrozenGameContext {
  tournamentName: string;
  roomName?: string;
  roundName: string;
  roundNumber?: number;
  packetName?: string;
  scoringFormat: IScorekeeperFormat;
  procedure?: IRoomProcedure;
  /** The tournament the server had confirmed when this game started, if it had confirmed one. */
  tournamentKey?: string;
}

/** The game on screen: what is being scored, what it is being scored against, and who it is for. */
interface IActiveScoring {
  matchup: IRoomMatchup;
  credentials: ISessionCredentials;
  frozen: IFrozenGameContext;
}

/** Rebuild the game on screen from local storage alone, with no server involved. */
function scoringFromActiveGame(record: IActiveRoomGame): IActiveScoring {
  return {
    matchup: record.matchup,
    credentials: { sessionId: record.sessionId, token: record.sessionToken },
    frozen: {
      tournamentName: record.tournamentName,
      roomName: record.roomName,
      roundName: record.roundName,
      roundNumber: record.roundNumber,
      packetName: record.packetName,
      scoringFormat: record.scoringFormat,
      procedure: record.roomProcedure,
      tournamentKey: record.tournamentKey,
    },
  };
}

function toModaqPlayers(left: IRoomTeam, right: IRoomTeam): IPlayer[] {
  const forTeam = (team: IRoomTeam): IPlayer[] =>
    team.players.map((player, index) => ({
      name: player.name,
      teamName: team.name,
      isStarter: index < 4,
    }));
  return [...forTeam(left), ...forTeam(right)];
}

export default function AssignedRoomApp({ identity }: { identity: IRoomIdentity }) {
  const [assignment, setAssignment] = useState<IRoomAssignmentResponse | null>(null);
  const [loadError, setLoadError] = useState('');
  const [connection, setConnection] = useState<RoomConnectionState>(RoomConnectionState.Connected);
  const [degradedMessage, setDegradedMessage] = useState('');
  /**
   * Read before the first render, and before anything has been asked of the server.
   *
   * This is what makes a reload during an outage land on the scoresheet instead of on
   * "Connecting…". The tournament key is deliberately not required here: a browser that cannot
   * reach the server cannot confirm one, and refusing to reopen the game for want of a confirmation
   * that is impossible to obtain is the exact failure this is for. The confirmation happens later,
   * when the server answers, and a genuine mismatch is surfaced then.
   */
  const [scoring, setScoring] = useState<IActiveScoring | null>(() => {
    // Only the first-party scorer can be rebuilt from this record; the MODAQ fallback keeps its own
    // storage and its own recovery, and inventing a half-restored one for it would be a new bug.
    if (readScorerChoice() !== 'first-party') return null;
    const record = readActiveGame({ roomId: identity.roomId });
    return record ? scoringFromActiveGame(record) : null;
  });
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState('');
  const [submittedSummary, setSubmittedSummary] = useState<string>('');
  const [snapshotError, setSnapshotError] = useState('');
  const [questionsPlayed, setQuestionsPlayed] = useState(0);
  const [operatorName, setOperatorName] = useState(identity.operatorName ?? '');
  const [ready, setReady] = useState(false);
  const [presence, setPresence] = useState(assignment?.presence ?? null);
  const [helpRequest, setHelpRequest] = useState<IHelpRequest | null>(assignment?.helpRequest ?? null);
  const [helpBusy, setHelpBusy] = useState(false);
  const [lifecycleNotice, setLifecycleNotice] = useState('');
  const [emergencyMode, setEmergencyMode] = useState(false);
  // Read once per mount: it consults storage, and a scorer that could change under a game in
  // progress would be worse than either scorer on its own.
  const [scorerChoice] = useState(() => readScorerChoice());
  // Only whether this device could score on its own. The kit's tournament key is deliberately not
  // kept here — see `verifiedTournamentKeyRef` for the one results are tagged with.
  const [scoringKitUsable, setScoringKitUsable] = useState(() =>
    isScoringKitUsable(readScoringKit(), new Date(), scorerChoice),
  );
  const [conflictNotice, setConflictNotice] = useState('');
  const [activeResultId, setActiveResultId] = useState<string | null>(null);
  const [persistFailure, setPersistFailure] = useState(false);
  const [deliveryFailed, setDeliveryFailed] = useState(false);
  /**
   * The server can no longer authenticate this browser.
   *
   * A fact about credentials, not about the game. It never clears the identity and never navigates:
   * see the note at the top of the file.
   */
  const [authProblem, setAuthProblem] = useState(false);
  const [repairOpen, setRepairOpen] = useState(false);
  /** Set once the server has said this browser is scoring a game from a different tournament. */
  const [tournamentConflict, setTournamentConflict] = useState(false);
  /** Credentials adopted by a successful repair, which replace the ones this page was mounted with. */
  const [repairedIdentity, setRepairedIdentity] = useState<IRoomIdentity | null>(null);
  /** When the server last accepted a live snapshot of the game on screen. Null means never. */
  const [lastSnapshotAt, setLastSnapshotAt] = useState<number | null>(null);

  const outbox = useResultOutbox();
  const baseIdentity = repairedIdentity ?? identity;
  const activeIdentity = useMemo(
    () => ({ ...baseIdentity, deviceId: baseIdentity.deviceId ?? getOrCreateDeviceId(), operatorName }),
    [baseIdentity, operatorName],
  );
  const online = connection !== RoomConnectionState.Offline;
  const assignmentRulesUsable =
    assignment !== null &&
    (scorerChoice === 'legacy'
      ? assignment.gameFormat !== null
      : assignment.scoringFormat !== null && scorekeeperFormatProblems(assignment.scoringFormat).length === 0);

  const credentialsRef = useRef<ISessionCredentials | null>(null);
  credentialsRef.current = scoring?.credentials ?? null;
  const scoringRef = useRef<IActiveScoring | null>(null);
  scoringRef.current = scoring;
  const scoringMatchupRef = useRef<IRoomMatchup | null>(null);
  scoringMatchupRef.current = scoring?.matchup ?? null;
  const normalizeOptionsRef = useRef<IQbjNormalizeOptions | null>(null);
  normalizeOptionsRef.current = assignment?.gameFormat
    ? {
        regulationTossupCount: assignment.gameFormat.regulationTossupCount,
        minimumOvertimeQuestionCount: assignment.gameFormat.minimumOvertimeQuestionCount,
        gameMayEndEarly: assignment.timedRounds,
      }
    : null;
  const scoringMatchIdRef = useRef<string | null>(null);
  scoringMatchIdRef.current = scoring?.matchup.scheduledMatchId ?? null;
  const hasAssignmentRef = useRef(false);
  useEffect(() => {
    hasAssignmentRef.current = assignment !== null;
  }, [assignment]);

  const contextRef = useRef<{ roomId?: string; roomName?: string }>({});
  contextRef.current = {
    roomId: assignment?.roomId,
    roomName: assignment?.roomName,
  };

  /**
   * The tournament identity the server itself last confirmed, for tagging results.
   *
   * Deliberately not read from the scoring kit. The kit's key is only adopted once localStorage has
   * accepted a write, so a browser that refuses the write would tag results with no tournament at
   * all — and before the first refresh the kit is whatever this device cached *last* time, which on
   * a Chromebook reused at the next tournament is a key belonging to someone else's event. A result
   * labelled with the wrong tournament is worse than one labelled with none, and both are avoidable:
   * this holds only what `getTournament` returned for the tournament now open, and is dropped the
   * moment the room or the tournament changes.
   */
  const verifiedTournamentKeyRef = useRef<string | undefined>(undefined);

  /**
   * The game as it last stood, kept only so a backup can be downloaded from outside the scorer.
   *
   * The scorer owns the QBJ and offers its own download; this exists for the repair dialog, which
   * is rendered over the top of the scorer and has to be able to say "download it and hand it over"
   * with a button rather than with an instruction.
   */
  const latestQbjRef = useRef<object | null>(null);

  const outboxRef = useRef(outbox);
  outboxRef.current = outbox;

  /**
   * Has this game's result reached the outbox, or has tournament control confirmed it did?
   *
   * The one question that decides whether the page may take the scorer down. Before it is true,
   * this device holds the only copy of what the scorekeeper entered, and every reason the page used
   * to have for clearing the scorer — the assignment moved on, the poll disagreed, the session went
   * away — is a reason to keep it instead.
   */
  const resultHandedOffRef = useRef(false);
  resultHandedOffRef.current = activeResultId !== null;
  /** Set when the server itself says the session on screen already has a final under review. */
  const serverHasFinalRef = useRef(false);

  /** Results that automatic retry can still deliver; rejected results stay downloadable but do not latch the room. */
  const deliverableResults = outbox.unresolved.filter(
    (entry) => entry.deliveryState === 'queued' || entry.deliveryState === 'submitted',
  );
  const unresolvedRef = useRef<IRoomResultOutboxEntry[]>([]);
  unresolvedRef.current = deliverableResults;
  const hasUnresolvedResults = deliverableResults.length > 0;

  /**
   * File the game under this room so a reload can find it without asking anybody.
   *
   * The session token goes in because this record never leaves browser storage — it is not
   * exported, not attached to QBJ and not displayed. Everything that *is* handed around goes
   * through `GameSession` and the outbox, and neither of those has ever carried a credential.
   */
  const roomIdForRecord = activeIdentity.roomId;
  const rememberActiveGame = useCallback(
    (active: IActiveScoring) => {
      // Rewriting the record — to stamp a confirmed tournament key, say — must not restart the
      // clock that ages an abandoned game out.
      const existing = readActiveGame({ roomId: roomIdForRecord });
      const startedAt =
        existing?.sessionId === active.credentials.sessionId ? existing.startedAt : new Date().toISOString();
      writeActiveGame({
        roomId: roomIdForRecord,
        tournamentKey: active.frozen.tournamentKey,
        scheduledMatchId: active.matchup.scheduledMatchId,
        sessionId: active.credentials.sessionId,
        sessionToken: active.credentials.token,
        tournamentName: active.frozen.tournamentName,
        roomName: active.frozen.roomName,
        roundNumber: active.frozen.roundNumber,
        roundName: active.frozen.roundName,
        packetName: active.frozen.packetName,
        matchup: active.matchup,
        scoringFormat: active.frozen.scoringFormat,
        roomProcedure: active.frozen.procedure,
        startedAt,
      });
    },
    [roomIdForRecord],
  );
  const rememberActiveGameRef = useRef(rememberActiveGame);
  rememberActiveGameRef.current = rememberActiveGame;

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const result = await getRoomAssignment(activeIdentity);
      if (cancelled) return;
      const status = reduceConnectionStatus(result, hasAssignmentRef.current);
      setConnection(status.state);
      setDegradedMessage(status.degradedMessage);
      setLoadError(status.loadError);
      if (status.needsPairing) {
        /*
         * The server will not accept this browser's room token any more: control reset the room's
         * access, or restored a file with different tokens in it.
         *
         * With a game on screen this is a warning and nothing else. Clearing the identity and
         * navigating to /join — which is what used to happen — would take a scorekeeper mid-round
         * to a pairing form, and the game they had scored would be under a session id nothing was
         * left holding. With no game there is nothing to protect, so the old behavior stands.
         */
        setAuthProblem(true);
        if (scoringRef.current === null) {
          clearRememberedRoomIdentity();
          clearScoringKit();
          window.location.replace('/join');
        }
        return;
      }
      if (!result.ok) return;
      setAuthProblem(false);

      /*
       * Which tournament this server is serving, checked on the poll the room is already making.
       *
       * The scoring kit's own refresh confirms the same thing but only every few minutes, and every
       * snapshot sent in between would be filed against the wrong event. A game is stamped with the
       * first key the server confirms — Start can win the race against the first `/tournament`
       * response — and any later disagreement stops synchronization rather than being reconciled.
       */
      const active = scoringRef.current;
      const servedKey = result.value.tournamentKey;
      if (active && servedKey !== undefined) {
        if (active.frozen.tournamentKey === undefined) {
          const stamped = { ...active, frozen: { ...active.frozen, tournamentKey: servedKey } };
          setScoring(stamped);
          rememberActiveGameRef.current(stamped);
        } else if (active.frozen.tournamentKey !== servedKey) {
          setTournamentConflict(true);
        } else {
          setTournamentConflict(false);
        }
      }

      setAssignment(result.value);
      setPresence(result.value.presence ?? null);
      setHelpRequest(result.value.helpRequest ?? null);
      const devicePresence = result.value.presence?.devices?.find(
        (device) => device.deviceId === activeIdentity.deviceId,
      );
      if (devicePresence) setReady(devicePresence.ready);
      setLifecycleNotice(resolveLifecycleNotice(result.value)?.text ?? '');

      const { current, session, lastOutcome } = result.value;
      if (session !== null && scoringRef.current?.credentials.sessionId === session.sessionId) {
        serverHasFinalRef.current = session.finalReceived;
      }
      if (current && session && scoringMatchIdRef.current === null && !session.finalReceived) {
        const resumed: IActiveScoring = {
          matchup: current,
          credentials: { sessionId: session.sessionId, token: session.token },
          frozen: {
            tournamentName: result.value.tournamentName,
            roomName: result.value.roomName,
            roundName: current.roundName,
            roundNumber: current.roundNumber,
            packetName: current.packetName,
            // A resumed session with no usable scoring format has nothing to render, so this stays
            // null and the existing "scoring unavailable" path handles it.
            scoringFormat: result.value.scoringFormat as IScorekeeperFormat,
            procedure: result.value.roomProcedure,
            tournamentKey: verifiedTournamentKeyRef.current,
          },
        };
        if (resumed.frozen.scoringFormat) rememberActiveGameRef.current(resumed);
        setScoring(resumed);
      }

      if (lastOutcome?.scheduledMatchId) {
        const owned = outboxRef.current.entries.find(
          (entry) => entry.scheduledMatchId === lastOutcome.scheduledMatchId && entry.deliveryState !== 'accepted',
        );
        if (owned && lastOutcome.status === SessionStatus.Accepted) {
          outboxRef.current.markAccepted(owned.id).catch(() => undefined);
        } else if (owned && lastOutcome.status === SessionStatus.Rejected) {
          outboxRef.current.markNeedsCorrection(owned.id, lastOutcome.rejectionReason).catch(() => undefined);
        }
      }

      const activeMatchId = scoringMatchIdRef.current;
      if (activeMatchId !== null) {
        const stillUnresolved = unresolvedRef.current.some((entry) => entry.scheduledMatchId === activeMatchId);
        if (current?.scheduledMatchId === activeMatchId) {
          const frozen = scoringMatchupRef.current;
          const teamsChanged =
            frozen !== null &&
            (frozen.leftTeam.name !== current.leftTeam.name || frozen.rightTeam.name !== current.rightTeam.name);
          const roundChanged = frozen !== null && frozen.roundNumber !== current.roundNumber;
          setConflictNotice(
            teamsChanged || roundChanged
              ? 'Tournament control changed this game while it was being scored. Finish and submit the game you are on, then check with tournament control before starting anything else.'
              : '',
          );
        } else if (stillUnresolved) {
          setConflictNotice(
            'A result from this room has not reached tournament control yet. Finish here, then use Saved results to download it if it still has not been sent.',
          );
        } else if (resultHandedOffRef.current || serverHasFinalRef.current) {
          /*
           * The room has moved on and this game's result is somewhere safe: in the outbox on this
           * device, or with tournament control. Only now is it right to take the scorer down and
           * show whatever is next.
           */
          const finished = scoringRef.current;
          setScoring(null);
          setQuestionsPlayed(0);
          setActiveResultId(null);
          setDeliveryFailed(false);
          setPersistFailure(false);
          setConflictNotice('');
          setLastSnapshotAt(null);
          serverHasFinalRef.current = false;
          if (finished) clearActiveGame(finished.credentials.sessionId);
        } else {
          /*
           * The assignment moved without this room's game reaching anywhere. That is a control-room
           * decision colliding with a game in progress, and the resolution is a human's, not a
           * poll's: the scorer stays, the events stay, and the room is told what happened.
           */
          setConflictNotice(
            'Tournament control has given this room a different game. The game on screen is still saved on this device — finish it and submit it, or download the QBJ and hand it to tournament control.',
          );
        }
      } else {
        setConflictNotice('');
      }
    };

    poll();
    const handle = setInterval(poll, assignmentPollMs);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [activeIdentity]);

  const kitTournamentName = assignment?.tournamentName;
  const kitRoomId = assignment?.roomId;
  const kitRoomName = assignment?.roomName;
  const kitTimedRounds = assignment?.timedRounds === true;
  // This dependency makes the kit rebuild as soon as the scoring format becomes available.
  const kitRulesUsable = assignmentRulesUsable;
  const assignmentRef = useRef<IRoomAssignmentResponse | null>(null);
  assignmentRef.current = assignment;

  /** Keep the emergency scoring kit current from authenticated room state plus the server's stable tournament identity. */
  useEffect(() => {
    if (kitTournamentName === undefined || connection !== RoomConnectionState.Connected) return undefined;
    let cancelled = false;

    const refreshKit = async () => {
      const [tournamentResult, roundsResult, teamsResult] = await Promise.all([
        getTournament(),
        getRounds(),
        getTeams(),
      ]);
      if (cancelled || !tournamentResult.ok) return;
      // Known as soon as the server says so, whatever becomes of the cached kit below.
      verifiedTournamentKeyRef.current = tournamentResult.value.tournamentKey;
      /*
       * The server is serving a different tournament than the one this game started under.
       *
       * Almost always a Chromebook that reconnected to a machine which has since opened another
       * file. The game is not touched and not sent: a result filed against the wrong tournament is
       * worse than one that arrives on a USB stick, so this stops automatic synchronization and
       * says so, and the QBJ remains downloadable.
       */
      const active = scoringRef.current;
      const confirmed = tournamentResult.value.tournamentKey;
      if (active && confirmed !== undefined && active.frozen.tournamentKey === undefined) {
        /*
         * The game started before the server had told this page which tournament it was — a race
         * between Start and the first `getTournament`. Adopting the first confirmation makes the
         * game comparable from here on; without it a later switch would be undetectable, because
         * "no key" matches everything.
         */
        const stamped = { ...active, frozen: { ...active.frozen, tournamentKey: confirmed } };
        setScoring(stamped);
        rememberActiveGameRef.current(stamped);
      } else if (
        active &&
        active.frozen.tournamentKey !== undefined &&
        confirmed !== undefined &&
        confirmed !== active.frozen.tournamentKey
      ) {
        setTournamentConflict(true);
      } else {
        setTournamentConflict(false);
      }
      if (!roundsResult.ok || !teamsResult.ok) return;
      const kit = buildScoringKit({
        tournamentKey: tournamentResult.value.tournamentKey,
        tournamentName: kitTournamentName,
        gameFormat: assignmentRef.current?.gameFormat ?? null,
        scoringFormat: assignmentRef.current?.scoringFormat ?? null,
        timedRounds: kitTimedRounds,
        roomProcedure: assignmentRef.current?.roomProcedure,
        teams: teamsResult.value.teams,
        rounds: roundsResult.value.rounds,
        roomId: kitRoomId,
        roomName: kitRoomName,
      });
      if (writeScoringKit(kit) && !cancelled) {
        setScoringKitUsable(isScoringKitUsable(kit, new Date(), scorerChoice));
      }
    };

    refreshKit().catch(() => undefined);
    const handle = setInterval(() => {
      refreshKit().catch(() => undefined);
    }, scoringKitRefreshMs);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [kitTournamentName, kitRoomId, kitRoomName, kitTimedRounds, kitRulesUsable, connection, scorerChoice]);

  // A different room, or a different tournament, and the confirmed key no longer describes what
  // this page is scoring. Dropped rather than carried until a refresh happens to replace it.
  useEffect(() => {
    verifiedTournamentKeyRef.current = undefined;
  }, [kitTournamentName, kitRoomId]);

  useEffect(() => {
    let cancelled = false;
    const checkIn = async () => {
      const result = await updateRoomPresence(activeIdentity, {
        deviceId: activeIdentity.deviceId,
        operatorName,
        ready,
        scorer: scorerChoice,
      });
      if (!cancelled && result.ok) setPresence(result.value.presence);
    };
    checkIn();
    const handle = setInterval(checkIn, 10_000);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [activeIdentity, operatorName, ready, scorerChoice]);

  /**
   * The native "leave site?" dialog, for an actual user leaving.
   *
   * Nothing on this page navigates during a game any more, so this fires only for a real refresh,
   * close or back — which is the only thing it was ever meant to be about.
   *
   * What it is *not* raised for matters as much: a finished result sitting in a durable outbox is
   * safe across a reload by construction, and warning about it anyway teaches a room to click
   * through the dialog without reading it, which is exactly the habit that loses the game the
   * warning was for. So: a game still being scored, or storage this browser could not write to.
   */
  const gameInProgress = scoring !== null && activeResultId === null;
  const strandedResults = outbox.unresolved.some((entry) => !outbox.isPersisted(entry.id));
  useEffect(() => {
    const shouldWarn = gameInProgress || persistFailure || strandedResults;
    if (!shouldWarn) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [gameInProgress, persistFailure, strandedResults]);

  const handleStart = async () => {
    const current = assignment?.current;
    if (!current || !assignment) return;
    setStartError('');
    setSubmittedSummary('');
    setStarting(true);
    const result = await startAssignedMatch(activeIdentity, current.scheduledMatchId, scorerChoice);
    setStarting(false);
    if (!result.ok) {
      setStartError(result.error);
      return;
    }
    setQuestionsPlayed(0);
    setActiveResultId(null);
    setDeliveryFailed(false);
    setPersistFailure(false);
    setLastSnapshotAt(null);
    serverHasFinalRef.current = false;
    const started: IActiveScoring = {
      matchup: current,
      credentials: { sessionId: result.value.sessionId, token: result.value.token },
      frozen: {
        tournamentName: assignment.tournamentName,
        roomName: assignment.roomName,
        roundName: current.roundName,
        roundNumber: current.roundNumber,
        packetName: current.packetName,
        scoringFormat: assignment.scoringFormat as IScorekeeperFormat,
        procedure: assignment.roomProcedure,
        tournamentKey: verifiedTournamentKeyRef.current,
      },
    };
    // The moment the session is authoritative is the moment a reload has to be able to find it
    // again, so this is written before the scorer is even on screen.
    if (started.frozen.scoringFormat) rememberActiveGame(started);
    setScoring(started);
  };

  const handleOperatorNameChange = (name: string) => {
    setOperatorName(name);
    rememberRoomIdentity({ ...activeIdentity, operatorName: name });
  };

  const handleReadyChange = async (nextReady: boolean) => {
    const readyAllowed = online && assignmentRulesUsable;
    if (nextReady && !readyAllowed) return;
    setReady(nextReady);
    const result = await updateRoomPresence(activeIdentity, {
      deviceId: activeIdentity.deviceId,
      operatorName,
      ready: nextReady,
      scorer: scorerChoice,
    });
    if (result.ok) setPresence(result.value.presence);
    else if (nextReady) setReady(false);
  };

  const handleRequestHelp = async (category: HelpRequestCategory, message: string) => {
    setHelpBusy(true);
    const result = await createRoomHelp(activeIdentity, {
      category,
      message,
      deviceId: activeIdentity.deviceId,
      operatorName,
    });
    setHelpBusy(false);
    if (result.ok) setHelpRequest(result.value.request);
    else throw new Error(result.error);
  };

  const handleCancelHelp = async () => {
    if (!helpRequest) return;
    setHelpBusy(true);
    const result = await cancelRoomHelp(activeIdentity, helpRequest.id);
    setHelpBusy(false);
    if (result.ok) setHelpRequest(null);
  };

  const handleChangeRoom = () => {
    if (scoring !== null || hasUnresolvedResults) {
      const message =
        scoring !== null
          ? 'This room has a game in progress. Leaving now keeps the game saved on this device, but this browser will stop being this room. Continue?'
          : 'This device is still holding a result that tournament control has not accepted. Download it from Saved results first if you have not already. Continue?';
      // eslint-disable-next-line no-alert
      if (!window.confirm(message)) return;
    }
    // The one place a game is abandoned, and only ever behind that confirmation. The saved
    // `GameSession` and the outbox are left alone: what is being given up is this browser's claim
    // to be this room, not the record of what it scored.
    if (scoring !== null) clearActiveGame(scoring.credentials.sessionId);
    clearRememberedRoomIdentity();
    clearScoringKit();
    window.location.assign('/join');
  };

  const handleMarkHandedOver = useCallback(
    (entry: IRoomResultOutboxEntry) => {
      outbox.markHandedOver(entry.id).catch(() => undefined);
    },
    [outbox],
  );

  const handleDownload = useCallback(
    (entry: IRoomResultOutboxEntry) => {
      outbox.download(entry, assignment?.roomName);
    },
    [outbox, assignment?.roomName],
  );

  /**
   * Put a finished game into the outbox and try to send it.
   *
   * Shared by both scorers on purpose. The outbox is what makes a result survive a dead network, a
   * closed laptop and a refusal from tournament control, and a second delivery path would be a
   * second set of those bugs.
   */
  const deliverFinal = useCallback(async (qbj: Record<string, any>, activeCredentials: ISessionCredentials) => {
    setSubmittedSummary('');
    const matchup = scoringMatchupRef.current;
    const roomContext = contextRef.current;
    const enqueued = await outboxRef.current.enqueue({
      tournamentKey: verifiedTournamentKeyRef.current,
      roomId: roomContext.roomId,
      scheduledMatchId: matchup?.scheduledMatchId,
      roundNumber: matchup?.roundNumber,
      roundName: matchup?.roundName,
      leftTeam: matchup?.leftTeam.name ?? '',
      rightTeam: matchup?.rightTeam.name ?? '',
      qbj,
      deliveryState: 'queued',
      sessionCredentials: activeCredentials,
    });
    setActiveResultId(enqueued.entry.id);
    setPersistFailure(!enqueued.persisted);
    /*
     * The game has become a result, and the outbox is now the thing that survives a reload for it.
     * Retiring the active-game record here is what stops the room reopening a finished game on its
     * next reload — but only once the outbox has actually accepted the write. A browser that could
     * not persist the result keeps its recovery record, because otherwise a refresh would leave the
     * room with neither copy.
     */
    if (enqueued.persisted) clearActiveGame(activeCredentials.sessionId);

    const delivered = await outboxRef.current.submitNow(enqueued.entry.id);
    if (delivered?.deliveryState === 'submitted') {
      setDeliveryFailed(false);
      return { isError: false, status: 'Sent to tournament control' };
    }
    setDeliveryFailed(true);
    /*
     * Everything below is a promise about what happens to a finished game, so each branch says only
     * what this device can actually deliver on. A refusal will not retry itself and a result that
     * could not be saved will not survive a reload; telling a scorekeeper to wait in either case is
     * how a played game ends up in nobody's standings.
     */
    if (delivered?.retryBlocked) {
      const refusal = delivered.lastError ?? 'Tournament control refused this result.';
      setSubmittedSummary(
        `${refusal} The game is saved on this device — use Download QBJ under Saved results and give the file to tournament control.`,
      );
      return { isError: true, status: `${refusal} Download the QBJ and give it to tournament control.` };
    }
    return {
      isError: true,
      status: enqueued.persisted
        ? 'Tournament control could not be reached. Automatic delivery will continue if the connection returns.'
        : 'This browser could not save the result. Download the QBJ now and give it to tournament control.',
    };
  }, []);

  const handleExport = useCallback(
    async (rawQbj: object, context?: { source: ExportSource }): Promise<ModaqStatus> => {
      const activeCredentials = credentialsRef.current;
      if (!activeCredentials) return { isError: true, status: 'This room is not connected to a game yet.' };
      const source = context?.source ?? 'Menu';
      const options = normalizeOptionsRef.current;
      const qbj = options ? normalizeQbjMatch(rawQbj, options).qbj : (rawQbj as Record<string, any>);
      setQuestionsPlayed(countPlayedQuestions(qbj));

      if (source === 'Timer') {
        const result = await putSnapshot(activeCredentials, qbj);
        if (!result.ok) {
          setSnapshotError(result.error);
          return { isError: true, status: result.error };
        }
        setSnapshotError('');
        setLastSnapshotAt(Date.now());
        return { isError: false, status: 'Sent to YellowFruit' };
      }
      if (source === 'NewGame') return { isError: false, status: 'Not submitted' };

      return deliverFinal(qbj, activeCredentials);
    },
    [deliverFinal],
  );

  /**
   * The first-party scorer's final submission.
   *
   * Its QBJ deliberately skips `normalizeQbjMatch`. That exists to strip padding MODAQ invents from
   * the scaffold packet it is handed; a derived game counts only the cycles that were actually
   * played, so there is nothing to strip and running it could only take something real away.
   */
  const handleScorerSubmit = useCallback(
    async (qbj: object) => {
      const activeCredentials = credentialsRef.current;
      if (!activeCredentials) {
        return { ok: false, message: 'This room is not connected to a game yet.' };
      }
      const outcome = await deliverFinal(qbj as Record<string, any>, activeCredentials);
      return { ok: !outcome.isError, message: outcome.status };
    },
    [deliverFinal],
  );

  /**
   * Live progress for tournament control, on the same endpoint MODAQ's timer export used.
   *
   * Deliberately after the fact and deliberately allowed to fail: the scoring action has already
   * been committed locally by the time this runs, so a refused or unanswered snapshot costs the
   * room nothing but a stale score line on the control-room dashboard. The one case it is skipped
   * entirely is a server that has since opened a different tournament, where sending would file
   * this game's progress against somebody else's event.
   */
  const handleScorerProgress = useCallback(
    async (qbj: object, questionsHeard: number) => {
      const activeCredentials = credentialsRef.current;
      setQuestionsPlayed(questionsHeard);
      latestQbjRef.current = qbj;
      if (activeCredentials) touchActiveGame(activeCredentials.sessionId);
      if (!activeCredentials || tournamentConflict) return;
      const result = await putSnapshot(activeCredentials, qbj);
      setSnapshotError(result.ok ? '' : result.error);
      if (result.ok) setLastSnapshotAt(Date.now());
    },
    [tournamentConflict],
  );

  const handleDownloadBackup = useCallback(() => {
    const qbj = latestQbjRef.current;
    const active = scoringRef.current;
    if (!qbj || !active) return;
    downloadCurrentQbj(qbj, {
      roundName: active.frozen.roundName,
      roundNumber: active.frozen.roundNumber,
      roomName: active.frozen.roomName,
      leftTeam: active.matchup.leftTeam.name,
      rightTeam: active.matchup.rightTeam.name,
    });
  }, []);

  /**
   * This session's own snapshot from the server, for a device whose local copy is gone.
   *
   * Only ever this session, only ever with this session's token, and only ever consulted by
   * `ScorerHost` when there is nothing local — see the ordering note there.
   */
  const recoverFromServer = useCallback(async () => {
    const activeCredentials = credentialsRef.current;
    if (!activeCredentials) return null;
    const result = await getSessionRecovery(activeCredentials);
    return result.ok ? result.value.latestQbj : null;
  }, []);

  const customExport = useMemo(
    () => ({
      type: 'QBJ' as const,
      label: 'Submit to YellowFruit',
      customExportInterval: snapshotIntervalMs,
      onExport: handleExport as unknown,
    }),
    [handleExport],
  );
  const players = useMemo(
    () => (scoring ? toModaqPlayers(scoring.matchup.leftTeam, scoring.matchup.rightTeam) : []),
    [scoring],
  );
  const readyAllowed = online && assignmentRulesUsable;
  const canScoreEmergency = scoring === null && !online && scoringKitUsable;
  const activeResult = activeResultId ? outbox.entries.find((entry) => entry.id === activeResultId) : undefined;
  const showDeliveryFailure = deliveryFailed && activeResult !== undefined && activeResult.deliveryState === 'queued';
  const deliveryFailureNotice = showDeliveryFailure ? (
    <DeliveryFailureNotice
      persisted={!persistFailure}
      retrying={!activeResult.retryBlocked}
      reason={activeResult.lastError}
      onDownload={() => handleDownload(activeResult)}
    />
  ) : null;

  const savedResults = outbox.entries.length > 0 && (
    <SavedResults
      entries={outbox.entries}
      roomName={assignment?.roomName}
      onDownload={handleDownload}
      durable={outbox.durable}
      onMarkHandedOver={handleMarkHandedOver}
    />
  );

  /** Where the finished result has got to, for the connection detail. Only what is known. */
  let deliveryProgress: 'in-progress' | 'waiting' | 'sent' | 'accepted' | 'hand-over' = 'in-progress';
  if (activeResult) {
    if (activeResult.deliveryState === 'accepted') deliveryProgress = 'accepted';
    else if (activeResult.deliveryState === 'submitted') deliveryProgress = 'sent';
    else if (activeResult.retryBlocked || activeResult.deliveryState === 'manual-backup')
      deliveryProgress = 'hand-over';
    else deliveryProgress = 'waiting';
  }

  /**
   * Everything the scorekeeper needs to know that the scorer itself cannot work out.
   *
   * Each one is an operational problem with an action attached, and none of them removes the game
   * from the screen — that is the whole distinction this pass is about.
   */
  const scorerAlerts: IScorerAlert[] = [];
  if (authProblem) {
    scorerAlerts.push({
      id: 'auth',
      tone: 'warning',
      title: 'Room connection changed — keep scoring.',
      body: 'Tournament control can no longer authenticate this Chromebook. This game is still saved on this device. If the connection is not restored by the end of the game, download the QBJ and give it to tournament control.',
      actions: [{ label: 'Repair connection', onSelect: () => setRepairOpen(true) }],
      offerDownload: true,
    });
  }
  if (tournamentConflict) {
    scorerAlerts.push({
      id: 'tournament',
      tone: 'error',
      title: 'This computer is now running a different tournament.',
      body: 'Nothing from this game is being sent, so it cannot be filed against the wrong event. Keep scoring, then download the QBJ and give it to tournament control.',
      offerDownload: true,
    });
  }
  if (conflictNotice)
    scorerAlerts.push({ id: 'conflict', tone: 'warning', title: conflictNotice, offerDownload: true });
  if (lifecycleNotice) scorerAlerts.push({ id: 'lifecycle', tone: 'info', title: lifecycleNotice });

  if (emergencyMode) return <ManualRoomApp emergency />;

  const repairDialog = repairOpen ? (
    <RepairConnectionDialog
      roomId={activeIdentity.roomId}
      gameInProgress={gameInProgress}
      onRepaired={(repaired) => {
        setRepairedIdentity(repaired);
        setAuthProblem(false);
        setRepairOpen(false);
      }}
      onDownloadBackup={handleDownloadBackup}
      onClose={() => setRepairOpen(false)}
    />
  ) : null;

  /*
   * The scorer is rendered before anything is checked about the assignment, and that ordering is
   * the whole point: a Chromebook that reloaded while the server was unreachable has a complete
   * game on this device and no way to fetch an assignment, and it used to sit on "Connecting…"
   * looking at nothing. Everything the screen needs is frozen in `scoring.frozen`.
   */
  if (scoring && scorerChoice === 'first-party') {
    const authoritative =
      assignment?.current?.scheduledMatchId === scoring.matchup.scheduledMatchId ? assignment.current : null;
    return scoring.frozen.scoringFormat ? (
      <>
        {/* Keyed by the session so each game gets its own state, and its own chance to recover. */}
        <ScorerHost
          key={scoring.credentials.sessionId}
          gameKey={scoring.credentials.sessionId}
          format={scoring.frozen.scoringFormat}
          leftTeam={scoring.matchup.leftTeam}
          rightTeam={scoring.matchup.rightTeam}
          authoritativeLeftTeam={authoritative?.leftTeam ?? scoring.matchup.leftTeam}
          authoritativeRightTeam={authoritative?.rightTeam ?? scoring.matchup.rightTeam}
          onSyncRosterPlayer={async (teamName, playerName) => {
            const result = await addRoomPlayer(activeIdentity, scoring.credentials, teamName, playerName);
            if (result.ok) return { ok: true };
            const rejected =
              result.status === 400 || result.status === 403 || result.error.includes('cannot accept another player');
            return { ok: false, error: result.error, rejected };
          }}
          tournamentName={scoring.frozen.tournamentName}
          roundName={scoring.frozen.roundName}
          roomName={scoring.frozen.roomName}
          packetName={scoring.frozen.packetName}
          procedure={scoring.frozen.procedure}
          operatorName={operatorName}
          connection={connection}
          degradedMessage={degradedMessage}
          onSubmit={handleScorerSubmit}
          onDownload={activeResult ? () => handleDownload(activeResult) : undefined}
          onProgress={handleScorerProgress}
          onRecoverFromServer={recoverFromServer}
          onRequestControl={handleRequestHelp}
          controlRequestPending={helpRequest !== null && helpRequest.status === 'open'}
          alerts={scorerAlerts}
          recovery={{
            serverSnapshotAt: lastSnapshotAt,
            snapshotError,
            automaticDelivery: !tournamentConflict,
            delivery: deliveryProgress,
          }}
          qbjMeta={{
            round: scoring.frozen.roundNumber,
            location: scoring.frozen.roomName,
          }}
        />
        {deliveryFailureNotice}
        {savedResults}
        {repairDialog}
      </>
    ) : (
      <ScoringUnavailable roundName={scoring.frozen.roundName} roomName={scoring.frozen.roomName} />
    );
  }

  if (assignment === null) {
    return (
      <div className="room-shell">
        {loadError !== '' ? (
          <>
            <div className="room-banner room-banner-warning">
              <strong>{loadError}</strong>
              <div>
                This page keeps trying. Check that the YellowFruit computer is on and that this device is on the same
                network.
              </div>
            </div>
            <button type="button" className="room-button" onClick={handleChangeRoom}>
              Pair this browser again
            </button>
          </>
        ) : (
          <p className="room-muted">Connecting to YellowFruit&hellip;</p>
        )}
        {savedResults}
      </div>
    );
  }

  const pendingFinal = outbox.pendingAutomaticDelivery;
  const blocksStart = outbox.unresolved.some((entry) => blocksNewStart(entry, assignment.current?.scheduledMatchId));
  const awaitingReview = blocksStart || isAwaitingReview(assignment);

  if (scoring && assignment.gameFormat) {
    return (
      <ScoringView
        roomName={assignment.roomName}
        roundName={scoring.matchup.roundName}
        leftTeamName={scoring.matchup.leftTeam.name}
        rightTeamName={scoring.matchup.rightTeam.name}
        gameFormat={assignment.gameFormat}
        players={players}
        storeName={`yf-room-${scoring.credentials.sessionId}`}
        customExport={customExport as any}
        connection={connection}
        degradedMessage={degradedMessage}
        questionsPlayed={questionsPlayed}
        awaitingReview={awaitingReview}
        snapshotError={snapshotError}
        lifecycleNotice={lifecycleNotice}
        conflictNotice={conflictNotice}
        resultIsSaved={!persistFailure}
        operatorName={operatorName}
        ready={ready}
        readyAllowed={readyAllowed}
        presence={presence}
        helpRequest={helpRequest}
        helpBusy={helpBusy}
        onOperatorNameChange={handleOperatorNameChange}
        onReadyChange={handleReadyChange}
        onRequestHelp={handleRequestHelp}
        onCancelHelp={handleCancelHelp}
        onChangeRoom={handleChangeRoom}
        deliveryFailure={deliveryFailureNotice}
        savedResults={savedResults || null}
      />
    );
  }

  return (
    <MatchupCard
      assignment={assignment}
      connection={connection}
      degradedMessage={degradedMessage}
      starting={starting}
      startError={startError}
      pendingFinal={pendingFinal}
      awaitingReview={awaitingReview}
      submittedSummary={submittedSummary}
      scorerChoice={scorerChoice}
      conflictNotice={conflictNotice}
      onStart={handleStart}
      canStart={
        assignment.current !== null &&
        assignment.blockedReason === undefined &&
        assignmentRulesUsable &&
        !awaitingReview &&
        ready
      }
      blockedReason={assignment.blockedReason as RoomBlockedReason | undefined}
      lifecycleNotice={lifecycleNotice}
      operatorName={operatorName}
      ready={ready}
      readyAllowed={readyAllowed}
      presence={presence}
      helpRequest={helpRequest}
      helpBusy={helpBusy}
      onOperatorNameChange={handleOperatorNameChange}
      onReadyChange={handleReadyChange}
      onRequestHelp={handleRequestHelp}
      onCancelHelp={handleCancelHelp}
      onChangeRoom={handleChangeRoom}
      savedResults={savedResults || null}
      canScoreEmergency={canScoreEmergency}
      onScoreEmergency={() => setEmergencyMode(true)}
    />
  );
}
