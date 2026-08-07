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
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IPlayer } from 'modaq';
import {
  cancelRoomHelp,
  clearRememberedRoomIdentity,
  createRoomHelp,
  getRoomAssignment,
  getOrCreateDeviceId,
  getRounds,
  getTeams,
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
import { IRoomResultOutboxEntry } from './ResultOutbox';
import SavedResults, { DeliveryFailureNotice } from './SavedResults';
import { buildScoringKit, isScoringKitUsable, readScoringKit, writeScoringKit } from './ScoringKit';
import ScoringView from './ScoringView';
import MatchupCard from './MatchupCard';

/** MODAQ requires a status object back from a custom export */
type ModaqStatus = { isError: false; status: string } | { isError: true; status: string };

/** How MODAQ tells us why it's exporting. From modaq's ExportSource type. */
type ExportSource = 'Menu' | 'NewGame' | 'NextButton' | 'Timer';

/** Smallest interval MODAQ allows for automatic custom exports */
const snapshotIntervalMs = 5000;

/**
 * How often to ask YellowFruit what this room should be playing.
 *
 * Polling rather than a socket: the thing that has to work is that a new assignment reaches the room
 * without anyone touching it, and a five-second GET of one small object does that on a school LAN
 * without any realtime infrastructure to go wrong mid-tournament.
 */
const assignmentPollMs = 5000;

/**
 * How often to refresh the cached emergency scoring kit.
 *
 * Rosters and rounds barely change during a tournament, so this is deliberately slow: it exists so
 * that a room which has been connected at any point in the last few minutes can still score a game
 * by hand if the server dies, not so the cache is current to the second.
 */
const scoringKitRefreshMs = 5 * 60 * 1000;

/** Turn a matchup's rosters into the player list MODAQ expects */
function toModaqPlayers(left: IRoomTeam, right: IRoomTeam): IPlayer[] {
  const forTeam = (team: IRoomTeam): IPlayer[] =>
    team.players.map((player, index) => ({
      name: player.name,
      teamName: team.name,
      // MODAQ needs a starting lineup; the scorekeeper can substitute from within MODAQ.
      isStarter: index < 4,
    }));
  return [...forTeam(left), ...forTeam(right)];
}

export default function AssignedRoomApp({ identity }: { identity: IRoomIdentity }) {
  const [assignment, setAssignment] = useState<IRoomAssignmentResponse | null>(null);
  const [loadError, setLoadError] = useState('');
  const [connection, setConnection] = useState<RoomConnectionState>(RoomConnectionState.Connected);
  /** Set only while a retained assignment is on screen that the latest poll could not refresh. */
  const [degradedMessage, setDegradedMessage] = useState('');

  /** The matchup we are actively scoring, frozen so a poll can't swap MODAQ out mid-game */
  const [scoring, setScoring] = useState<{ matchup: IRoomMatchup; credentials: ISessionCredentials } | null>(null);
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
  /**
   * Set when what the server now says disagrees with the game on screen.
   *
   * Never resolved automatically. A conflict between an in-progress game and the schedule is a
   * thing a human has to look at, and replacing the scorekeeper's game with the server's opinion
   * would destroy the only evidence of what actually happened in the room.
   */
  const [conflictNotice, setConflictNotice] = useState('');
  /** The outbox entry for the game currently being scored, once its final has been recorded. */
  const [activeResultId, setActiveResultId] = useState<string | null>(null);
  /** Set when the outbox could not write the last final. The result exists only in this page. */
  const [persistFailure, setPersistFailure] = useState(false);
  /** True while the last final has not reached YellowFruit. */
  const [deliveryFailed, setDeliveryFailed] = useState(false);

  const outbox = useResultOutbox();

  const activeIdentity = useMemo(
    () => ({ ...identity, deviceId: identity.deviceId ?? getOrCreateDeviceId(), operatorName }),
    [identity, operatorName],
  );

  /** Reachability, for the things that only care whether the server can be written to at all. */
  const online = connection !== RoomConnectionState.Offline;

  // Refs so MODAQ's export callback stays stable; re-creating it resets MODAQ's export interval.
  const credentialsRef = useRef<ISessionCredentials | null>(null);
  credentialsRef.current = scoring?.credentials ?? null;

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

  /** Which game we're scoring, so a poll result can be compared without re-rendering the world */
  const scoringMatchIdRef = useRef<string | null>(null);
  scoringMatchIdRef.current = scoring?.matchup.scheduledMatchId ?? null;

  /** Whether there is a matchup on screen that a failed poll would be leaving stale. */
  const hasAssignmentRef = useRef(false);

  useEffect(() => {
    hasAssignmentRef.current = assignment !== null;
  }, [assignment]);

  /** Room and tournament labels the export callback needs without being re-created. */
  const contextRef = useRef<{ roomId?: string; roomName?: string; tournamentName?: string }>({});
  contextRef.current = {
    roomId: assignment?.roomId,
    roomName: assignment?.roomName,
    tournamentName: assignment?.tournamentName,
  };

  /** Outbox operations MODAQ's stable callback needs. */
  const outboxRef = useRef(outbox);
  outboxRef.current = outbox;

  /** Unresolved results, so a poll can tell whether it is safe to move the room on. */
  const unresolvedRef = useRef<IRoomResultOutboxEntry[]>([]);
  unresolvedRef.current = outbox.unresolved;

  /** Results the tournament still does not have. Drives the leave-the-page warning. */
  const hasUnresolvedResults = outbox.unresolved.length > 0;

  // Poll for the assignment. This is the whole mechanism by which a room learns about a new round.
  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      const result = await getRoomAssignment(activeIdentity);
      if (cancelled) return;

      // Transport first, tournament state second. A refusal is still an answer from a reachable
      // server, so it must not put the room into its offline state.
      const status = reduceConnectionStatus(result, hasAssignmentRef.current);
      setConnection(status.state);
      setDegradedMessage(status.degradedMessage);
      setLoadError(status.loadError);
      if (status.needsPairing) {
        // The link itself is wrong for the open tournament, which no amount of retrying will fix.
        clearRememberedRoomIdentity();
        window.location.replace('/join');
        return;
      }
      if (!result.ok) {
        // A room that already has a matchup keeps showing it and says so, rather than replacing the
        // scorekeeper's game with an error page: a Chromebook that has lost touch with the control
        // room mid-round must still be able to see what it is playing. Nothing about the room,
        // round, or assignment is changed here — the last authoritative answer stays frozen.
        return;
      }

      setAssignment(result.value);
      setPresence(result.value.presence ?? null);
      setHelpRequest(result.value.helpRequest ?? null);
      const devicePresence = result.value.presence?.devices?.find(
        (device) => device.deviceId === activeIdentity.deviceId,
      );
      if (devicePresence) setReady(devicePresence.ready);
      // Recomputed from the response every poll rather than accumulated, so a verdict about a game
      // the room has moved on from cannot linger on the screen.
      setLifecycleNotice(resolveLifecycleNotice(result.value)?.text ?? '');

      const { current, session, lastOutcome } = result.value;

      // A page that reloaded mid-game picks its session back up here rather than starting a new one.
      if (current && session && scoringMatchIdRef.current === null && !session.finalReceived) {
        setScoring({ matchup: current, credentials: { sessionId: session.sessionId, token: session.token } });
      }

      // The server is the authority on whether a result is in the tournament. The local copy
      // follows its verdict rather than deciding for itself.
      if (lastOutcome?.scheduledMatchId) {
        const owned = unresolvedRef.current.find(
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
          // Same game, but the tournament may have changed what it is. Surface that rather than
          // rebuilding MODAQ underneath a scorekeeper who is mid-bonus.
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
          // Control has moved this room on while a result from the previous game is still on this
          // device. Keep the game and say so; dropping it would leave nothing to retry from.
          setConflictNotice(
            'A result from this room has not reached tournament control yet. Finish here, then use Saved results to download it if it still has not been sent.',
          );
        } else {
          // Tournament control accepted or moved the game we were scoring, so hand the room back to
          // the waiting screen and let the next assignment come through.
          setScoring(null);
          setQuestionsPlayed(0);
          setActiveResultId(null);
          setDeliveryFailed(false);
          setPersistFailure(false);
          setConflictNotice('');
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

  /**
   * Keep the emergency scoring kit current.
   *
   * Only runs after an authenticated assignment has actually loaded, so an unpaired or refused
   * browser never caches a tournament it has no business holding. What is cached is an allowlist —
   * rules, teams, rosters, rounds, and this room's own identity — and nothing else from the
   * response travels with it.
   */
  /**
   * The identity of what would be cached, rather than the whole response.
   *
   * The assignment object is replaced by every five-second poll, so keying the effect on it would
   * restart the interval continuously and re-fetch the rosters far more often than anything about
   * them changes.
   */
  const kitTournamentName = assignment?.tournamentName;
  const kitRoomId = assignment?.roomId;
  const kitRoomName = assignment?.roomName;
  const kitTimedRounds = assignment?.timedRounds === true;
  const kitRulesUsable = assignment?.gameFormat != null;
  const assignmentRef = useRef<IRoomAssignmentResponse | null>(null);
  assignmentRef.current = assignment;

  useEffect(() => {
    if (kitTournamentName === undefined || connection !== RoomConnectionState.Connected) return undefined;
    let cancelled = false;

    const refreshKit = async () => {
      const [roundsResult, teamsResult] = await Promise.all([getRounds(), getTeams()]);
      if (cancelled || !roundsResult.ok || !teamsResult.ok) return;
      writeScoringKit(
        buildScoringKit({
          tournamentKey: kitTournamentName,
          tournamentName: kitTournamentName,
          gameFormat: assignmentRef.current?.gameFormat ?? null,
          timedRounds: kitTimedRounds,
          teams: teamsResult.value.teams,
          rounds: roundsResult.value.rounds,
          roomId: kitRoomId,
          roomName: kitRoomName,
        }),
      );
    };

    refreshKit().catch(() => undefined);
    const handle = setInterval(() => {
      refreshKit().catch(() => undefined);
    }, scoringKitRefreshMs);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [kitTournamentName, kitRoomId, kitRoomName, kitTimedRounds, kitRulesUsable, connection]);

  // Presence is a separate, low-frequency heartbeat so an idle room remains visible between games.
  useEffect(() => {
    let cancelled = false;
    const checkIn = async () => {
      const result = await updateRoomPresence(activeIdentity, {
        deviceId: activeIdentity.deviceId,
        operatorName,
        ready,
      });
      if (!cancelled && result.ok) setPresence(result.value.presence);
    };
    checkIn();
    const handle = setInterval(checkIn, 10_000);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [activeIdentity, operatorName, ready]);

  /**
   * Warn before this page is closed while something would be lost.
   *
   * Only ever a warning: the browser's own dialog is the whole mechanism, so it cannot become a
   * page that will not let a scorekeeper leave. A room with nothing outstanding is not warned at
   * all, because a prompt that fires every time is a prompt nobody reads.
   */
  useEffect(() => {
    const shouldWarn = scoring !== null || hasUnresolvedResults;
    if (!shouldWarn) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Browsers ignore the text and show their own, but returnValue is still what arms the prompt.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [scoring, hasUnresolvedResults]);

  const handleStart = async () => {
    const current = assignment?.current;
    if (!current) return;

    setStartError('');
    setStarting(true);
    const result = await startAssignedMatch(activeIdentity, current.scheduledMatchId);
    setStarting(false);

    if (!result.ok) {
      setStartError(result.error);
      return;
    }

    setQuestionsPlayed(0);
    setActiveResultId(null);
    setDeliveryFailed(false);
    setPersistFailure(false);
    setScoring({
      matchup: current,
      credentials: { sessionId: result.value.sessionId, token: result.value.token },
    });
  };

  const handleOperatorNameChange = (name: string) => {
    setOperatorName(name);
    rememberRoomIdentity({ ...activeIdentity, operatorName: name });
  };

  const handleReadyChange = async (nextReady: boolean) => {
    const readyAllowed = online && assignment !== null && assignment.gameFormat !== null;
    if (nextReady && !readyAllowed) return;
    setReady(nextReady);
    const result = await updateRoomPresence(activeIdentity, {
      deviceId: activeIdentity.deviceId,
      operatorName,
      ready: nextReady,
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

  /**
   * Leaving this room for the pairing screen.
   *
   * Confirmed rather than blocked when there is a game in progress or a result this device is still
   * holding: pairing again is sometimes exactly the right recovery, and a page that refuses to let
   * go is worse than one that asks.
   */
  const handleChangeRoom = () => {
    if (scoring !== null || hasUnresolvedResults) {
      const message =
        scoring !== null
          ? 'This room has a game in progress. Leaving now keeps the game saved on this device, but this browser will stop being this room. Continue?'
          : 'This device is still holding a result that tournament control has not accepted. Download it from Saved results first if you have not already. Continue?';
      // eslint-disable-next-line no-alert
      if (!window.confirm(message)) return;
    }
    clearRememberedRoomIdentity();
    window.location.assign('/join');
  };

  const handleDownload = useCallback(
    (entry: IRoomResultOutboxEntry) => {
      outbox.download(entry, assignment?.roomName);
    },
    [outbox, assignment?.roomName],
  );

  /**
   * MODAQ's custom export callback.
   *
   * The export source decides what this means. A Timer export is a live snapshot for the control
   * room and must never be treated as a finished game; pressing Next past the last tossup, or
   * choosing the export item in MODAQ's menu, is a real submission.
   *
   * The order below is the whole safety property of this pass: normalize, write to the device,
   * *then* upload. The upload is allowed to fail in any way at all — the result is already saved
   * and the retry loop owns it from here.
   */
  const handleExport = useCallback(async (rawQbj: object, context?: { source: ExportSource }): Promise<ModaqStatus> => {
    const activeCredentials = credentialsRef.current;
    if (!activeCredentials) return { isError: true, status: 'This room is not connected to a game yet.' };

    const source = context?.source ?? 'Menu';

    // MODAQ counts questions from the scaffold packet's length, which overstates them for a tied
    // game. Correct that before anything else sees the payload.
    const options = normalizeOptionsRef.current;
    const qbj = options ? normalizeQbjMatch(rawQbj, options).qbj : (rawQbj as Record<string, any>);
    setQuestionsPlayed(countPlayedQuestions(qbj));

    if (source === 'Timer') {
      const result = await putSnapshot(activeCredentials, qbj);
      if (!result.ok) {
        setSnapshotError(result.error);
        // Reported as an error so MODAQ shows the scorekeeper the upload didn't land. Nothing local
        // is discarded and scoring continues.
        return { isError: true, status: result.error };
      }
      setSnapshotError('');
      return { isError: false, status: 'Sent to YellowFruit' };
    }

    if (source === 'NewGame') return { isError: false, status: 'Not submitted' };

    const matchup = scoringMatchupRef.current;
    const roomContext = contextRef.current;
    const enqueued = await outboxRef.current.enqueue({
      tournamentKey: roomContext.tournamentName,
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

    const delivered = await outboxRef.current.submitNow(enqueued.entry.id);
    if (delivered?.deliveryState === 'submitted') {
      setDeliveryFailed(false);
      return { isError: false, status: 'Submitted to YellowFruit' };
    }

    setDeliveryFailed(true);
    if (delivered?.retryBlocked) {
      setSubmittedSummary(
        `${
          delivered.lastError ?? 'YellowFruit refused this result.'
        } The game is saved on this device — use Download QBJ under Saved results and give the file to tournament control.`,
      );
      return { isError: true, status: delivered.lastError ?? 'YellowFruit refused this result.' };
    }

    return {
      isError: true,
      status: enqueued.persisted
        ? 'Saved on this device. It will be sent automatically when YellowFruit is reachable again.'
        : 'This browser could not save the result. Download the QBJ file now.',
    };
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

  const readyAllowed = online && assignment !== null && assignment.gameFormat !== null;

  /**
   * Whether this device could score a game on its own if it had to.
   *
   * Only offered while offline and between games. Read on every render rather than cached, because
   * the kit is refreshed by a background effect and a stale "no" here would hide the one workflow
   * that still works.
   */
  const canScoreEmergency = scoring === null && !online && isScoringKitUsable(readScoringKit());

  const activeResult = activeResultId ? outbox.entries.find((entry) => entry.id === activeResultId) : undefined;
  /** Only true while the last final genuinely has not reached YellowFruit. */
  const showDeliveryFailure = deliveryFailed && activeResult !== undefined && activeResult.deliveryState === 'queued';

  const savedResults = outbox.entries.length > 0 && (
    <SavedResults
      entries={outbox.entries}
      roomName={assignment?.roomName}
      onDownload={handleDownload}
      durable={outbox.durable}
    />
  );

  if (assignment === null) {
    return (
      <div className="room-shell">
        {loadError !== '' ? (
          <>
            {/* A warning rather than an error: nothing is lost and the page is still trying. */}
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

  const pendingFinal = outbox.unresolved.some((entry) => entry.deliveryState === 'queued');
  const awaitingReview = pendingFinal || isAwaitingReview(assignment);

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
        deliveryFailure={
          showDeliveryFailure ? (
            <DeliveryFailureNotice
              persisted={!persistFailure}
              retrying={!activeResult?.retryBlocked}
              onDownload={() => handleDownload(activeResult)}
            />
          ) : null
        }
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
      conflictNotice={conflictNotice}
      onStart={handleStart}
      canStart={
        assignment.current !== null &&
        assignment.blockedReason === undefined &&
        assignment.gameFormat !== null &&
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
    />
  );
}
