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
import { readScorerChoice } from './ScorerChoice';
import MatchupCard from './MatchupCard';
import ManualRoomApp from './ManualRoomApp';

type ModaqStatus = { isError: false; status: string } | { isError: true; status: string };
type ExportSource = 'Menu' | 'NewGame' | 'NextButton' | 'Timer';
const snapshotIntervalMs = 5000;
const assignmentPollMs = 5000;
const scoringKitRefreshMs = 5 * 60 * 1000;

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
  const [emergencyMode, setEmergencyMode] = useState(false);
  // Only whether this device could score on its own. The kit's tournament key is deliberately not
  // kept here — see `verifiedTournamentKeyRef` for the one results are tagged with.
  const [scoringKitUsable, setScoringKitUsable] = useState(() => isScoringKitUsable(readScoringKit()));
  const [conflictNotice, setConflictNotice] = useState('');
  const [activeResultId, setActiveResultId] = useState<string | null>(null);
  const [persistFailure, setPersistFailure] = useState(false);
  const [deliveryFailed, setDeliveryFailed] = useState(false);
  // Read once per mount: it consults storage, and a scorer that could change under a game in
  // progress would be worse than either scorer on its own.
  const [scorerChoice] = useState(() => readScorerChoice());

  const outbox = useResultOutbox();
  const activeIdentity = useMemo(
    () => ({ ...identity, deviceId: identity.deviceId ?? getOrCreateDeviceId(), operatorName }),
    [identity, operatorName],
  );
  const online = connection !== RoomConnectionState.Offline;

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

  const outboxRef = useRef(outbox);
  outboxRef.current = outbox;

  /** Results that automatic retry can still deliver; rejected results stay downloadable but do not latch the room. */
  const deliverableResults = outbox.unresolved.filter(
    (entry) => entry.deliveryState === 'queued' || entry.deliveryState === 'submitted',
  );
  const unresolvedRef = useRef<IRoomResultOutboxEntry[]>([]);
  unresolvedRef.current = deliverableResults;
  const hasUnresolvedResults = deliverableResults.length > 0;

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
        clearRememberedRoomIdentity();
        clearScoringKit();
        window.location.replace('/join');
        return;
      }
      if (!result.ok) return;

      setAssignment(result.value);
      setPresence(result.value.presence ?? null);
      setHelpRequest(result.value.helpRequest ?? null);
      const devicePresence = result.value.presence?.devices?.find(
        (device) => device.deviceId === activeIdentity.deviceId,
      );
      if (devicePresence) setReady(devicePresence.ready);
      setLifecycleNotice(resolveLifecycleNotice(result.value)?.text ?? '');

      const { current, session, lastOutcome } = result.value;
      if (current && session && scoringMatchIdRef.current === null && !session.finalReceived) {
        setScoring({ matchup: current, credentials: { sessionId: session.sessionId, token: session.token } });
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
        } else {
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

  const kitTournamentName = assignment?.tournamentName;
  const kitRoomId = assignment?.roomId;
  const kitRoomName = assignment?.roomName;
  const kitTimedRounds = assignment?.timedRounds === true;
  // This dependency makes the kit rebuild as soon as the scoring format becomes available.
  const kitRulesUsable = assignment?.gameFormat != null;
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
      if (!roundsResult.ok || !teamsResult.ok) return;
      const kit = buildScoringKit({
        tournamentKey: tournamentResult.value.tournamentKey,
        tournamentName: kitTournamentName,
        gameFormat: assignmentRef.current?.gameFormat ?? null,
        scoringFormat: assignmentRef.current?.scoringFormat ?? null,
        timedRounds: kitTimedRounds,
        teams: teamsResult.value.teams,
        rounds: roundsResult.value.rounds,
        roomId: kitRoomId,
        roomName: kitRoomName,
      });
      if (writeScoringKit(kit) && !cancelled) {
        setScoringKitUsable(isScoringKitUsable(kit));
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
  }, [kitTournamentName, kitRoomId, kitRoomName, kitTimedRounds, kitRulesUsable, connection]);

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

  useEffect(() => {
    const shouldWarn = scoring !== null || hasUnresolvedResults;
    if (!shouldWarn) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [scoring, hasUnresolvedResults]);

  const handleStart = async () => {
    const current = assignment?.current;
    if (!current) return;
    setStartError('');
    setSubmittedSummary('');
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

  const handleExport = useCallback(async (rawQbj: object, context?: { source: ExportSource }): Promise<ModaqStatus> => {
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
      return { isError: false, status: 'Sent to YellowFruit' };
    }
    if (source === 'NewGame') return { isError: false, status: 'Not submitted' };

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
  const canScoreEmergency = scoring === null && !online && scoringKitUsable;
  const activeResult = activeResultId ? outbox.entries.find((entry) => entry.id === activeResultId) : undefined;
  const showDeliveryFailure = deliveryFailed && activeResult !== undefined && activeResult.deliveryState === 'queued';

  const savedResults = outbox.entries.length > 0 && (
    <SavedResults
      entries={outbox.entries}
      roomName={assignment?.roomName}
      onDownload={handleDownload}
      durable={outbox.durable}
      onMarkHandedOver={handleMarkHandedOver}
    />
  );

  if (emergencyMode) return <ManualRoomApp emergency />;

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

  if (scoring && scorerChoice === 'first-party') {
    return <ScoringUnavailable roundName={scoring.matchup.roundName} roomName={assignment.roomName} />;
  }

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
              reason={activeResult?.lastError}
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
      onScoreEmergency={() => setEmergencyMode(true)}
    />
  );
}
