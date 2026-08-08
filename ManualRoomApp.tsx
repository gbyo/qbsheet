/**
 * Scorekeeping when nobody is telling this browser what to play.
 *
 * Two workflows share this screen because they are the same screen: the scorekeeper picks a round
 * and two teams by hand, and then scores a game in MODAQ.
 *
 * - **Manual** is the original workflow, still the right answer for a tournament that hasn't set up
 *   rooms and a schedule, and for a spare laptop pressed into service mid-morning. It talks to
 *   YellowFruit, creates a real session, and its result is an ordinary submission.
 * - **Emergency** is the same workflow with YellowFruit gone. It gets its rounds, teams and rules
 *   from the scoring kit this device cached while it was still connected, creates no session
 *   because there is nothing to create one with, and produces a result that is explicitly *not*
 *   authoritative until a human at tournament control imports it.
 *
 * The distinction the emergency mode must never blur: a game scored here is a record of what
 * happened in a room, not a change to the tournament. It goes into the outbox as `manual-backup`,
 * is never delivered automatically, and reaches the standings only when a director looks at it and
 * imports it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IPlayer } from 'modaq';
import {
  ISessionCredentials,
  ITournamentInfo,
  createSession,
  getRounds,
  getStatus,
  getTeams,
  getTournament,
  putSnapshot,
} from './api';
import { IRoomRound, IRoomTeam } from '../main/server/ServerTypes';
import normalizeQbjMatch, { IQbjNormalizeOptions, countPlayedQuestions } from '../renderer/Services/QbjMatchNormalizer';
import useResultOutbox from './useResultOutbox';
import { IRoomResultOutboxEntry } from './ResultOutbox';
import SavedResults, { DeliveryFailureNotice } from './SavedResults';
import { IScoringKit, describeUnusableKit, isScoringKitUsable, readScoringKit } from './ScoringKit';
import ScoringView from './ScoringView';
import ScoringUnavailable from './ScoringUnavailable';
import ScorerHost from './scorer/ScorerHost';
import { readScorerChoice, type ScorerChoice } from './ScorerChoice';
import { RoomConnectionState } from './RoomLifecycle';
import { scorekeeperFormatProblems } from '../renderer/Services/ScorekeeperFormat';

/** MODAQ requires a status object back from a custom export */
type ModaqStatus = { isError: false; status: string } | { isError: true; status: string };

/** How MODAQ tells us why it's exporting. From modaq's ExportSource type. */
type ExportSource = 'Menu' | 'NewGame' | 'NextButton' | 'Timer';

/** Smallest interval MODAQ allows for automatic custom exports */
const snapshotIntervalMs = 5000;

/** How often to re-check whether YellowFruit is reachable */
const connectivityIntervalMs = 10000;

/** An emergency game must survive the exact refresh/server-outage scenario emergency mode is for. */
const emergencyGameStorageKey = 'yellowfruit.room.emergency-game.v1';

type Phase = 'loading' | 'setup' | 'scoring' | 'submitted';

interface IGameSetup {
  round: IRoomRound;
  leftTeam: IRoomTeam;
  rightTeam: IRoomTeam;
}

interface IEmergencyGameState {
  gameId: string;
  tournamentKey?: string;
  roundNumber: number;
  leftTeamName: string;
  rightTeamName: string;
  scorer: ScorerChoice;
}

function readEmergencyGameState(): IEmergencyGameState | null {
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(emergencyGameStorageKey) ?? 'null',
    ) as Partial<IEmergencyGameState>;
    if (
      typeof parsed?.gameId !== 'string' ||
      typeof parsed.roundNumber !== 'number' ||
      typeof parsed.leftTeamName !== 'string' ||
      typeof parsed.rightTeamName !== 'string'
    ) {
      return null;
    }
    return {
      gameId: parsed.gameId,
      tournamentKey: typeof parsed.tournamentKey === 'string' ? parsed.tournamentKey : undefined,
      roundNumber: parsed.roundNumber,
      leftTeamName: parsed.leftTeamName,
      rightTeamName: parsed.rightTeamName,
      scorer: parsed.scorer === 'first-party' || parsed.scorer === 'legacy' ? parsed.scorer : 'legacy',
    };
  } catch {
    return null;
  }
}

function writeEmergencyGameState(state: IEmergencyGameState): void {
  try {
    window.localStorage.setItem(emergencyGameStorageKey, JSON.stringify(state));
  } catch {
    // MODAQ still has its in-page state. The result UI will avoid claiming reload durability.
  }
}

function clearEmergencyGameState(): void {
  try {
    window.localStorage.removeItem(emergencyGameStorageKey);
  } catch {
    // Nothing else to do; an old entry is still guarded by tournament identity on restore.
  }
}

/** Turn the two chosen rosters into the player list MODAQ expects */
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

export interface IManualRoomAppProps {
  /**
   * Score from this device's cached tournament data instead of from the server.
   *
   * Reachable only from an explicit action taken while YellowFruit is unavailable, and refused
   * outright when this device has no usable cached kit.
   */
  // eslint-disable-next-line react/require-default-props
  emergency?: boolean;
}

export default function ManualRoomApp({ emergency = false }: IManualRoomAppProps) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [loadError, setLoadError] = useState('');
  const [tournament, setTournament] = useState<ITournamentInfo | null>(null);
  const [rounds, setRounds] = useState<IRoomRound[]>([]);
  const [teams, setTeams] = useState<IRoomTeam[]>([]);
  const [online, setOnline] = useState(true);
  const [cachedKit] = useState<IScoringKit | null>(() => readScoringKit());
  const [scorerChoice, setScorerChoice] = useState(() => readScorerChoice());
  const cachedKitUsable = isScoringKitUsable(cachedKit, new Date(), scorerChoice);
  const kit = emergency ? cachedKit : null;

  const [roundNumber, setRoundNumber] = useState<number | ''>('');
  const [leftTeamName, setLeftTeamName] = useState('');
  const [rightTeamName, setRightTeamName] = useState('');
  const [setupError, setSetupError] = useState('');
  const [starting, setStarting] = useState(false);

  const [setup, setSetup] = useState<IGameSetup | null>(null);
  const [credentials, setCredentials] = useState<ISessionCredentials | null>(null);
  /** A stable local id for an emergency game, used only as MODAQ's persistence key. */
  const [emergencyGameId, setEmergencyGameId] = useState<string | null>(null);
  const [submitMessage, setSubmitMessage] = useState('');
  const [lastSnapshotError, setLastSnapshotError] = useState('');
  const [questionsPlayed, setQuestionsPlayed] = useState(0);
  const [activeResultId, setActiveResultId] = useState<string | null>(null);
  const [persistFailure, setPersistFailure] = useState(false);
  const [deliveryFailed, setDeliveryFailed] = useState(false);

  const outbox = useResultOutbox();

  const kitUsable = emergency && cachedKitUsable;

  // Held in refs so MODAQ's export callback always sees current values without being re-created
  // (which would reset MODAQ's export interval).
  const credentialsRef = useRef<ISessionCredentials | null>(null);
  credentialsRef.current = credentials;

  const setupRef = useRef<IGameSetup | null>(null);
  setupRef.current = setup;

  const outboxRef = useRef(outbox);
  outboxRef.current = outbox;

  const emergencyRef = useRef(false);
  emergencyRef.current = emergency;

  const tournamentKeyRef = useRef<string | undefined>(undefined);
  tournamentKeyRef.current = emergency ? kit?.tournamentKey : tournament?.tournamentKey;

  const gameFormat = emergency ? (kit?.gameFormat ?? null) : (tournament?.gameFormat ?? null);
  const scoringFormat = emergency ? (kit?.scoringFormat ?? null) : (tournament?.scoringFormat ?? null);
  const selectedRulesUsable =
    scorerChoice === 'legacy'
      ? gameFormat !== null
      : scoringFormat !== null && scorekeeperFormatProblems(scoringFormat).length === 0;
  const timedRounds = emergency ? kit?.timedRounds === true : tournament?.timedRounds === true;

  const normalizeOptionsRef = useRef<IQbjNormalizeOptions | null>(null);
  normalizeOptionsRef.current = gameFormat
    ? {
        regulationTossupCount: gameFormat.regulationTossupCount,
        minimumOvertimeQuestionCount: gameFormat.minimumOvertimeQuestionCount,
        gameMayEndEarly: timedRounds,
      }
    : null;

  // Load the tournament projection once. Emergency mode uses the cached kit and never asks.
  useEffect(() => {
    if (emergency) {
      if (kit) {
        setRounds(kit.rounds);
        setTeams(kit.teams);
        const saved = readEmergencyGameState();
        const belongsToKit =
          saved !== null &&
          (saved.tournamentKey === undefined ||
            kit.tournamentKey === undefined ||
            saved.tournamentKey === kit.tournamentKey);
        if (belongsToKit && saved) {
          const round = kit.rounds.find((candidate) => candidate.number === saved.roundNumber);
          const leftTeam = kit.teams.find((candidate) => candidate.name === saved.leftTeamName);
          const rightTeam = kit.teams.find((candidate) => candidate.name === saved.rightTeamName);
          if (round && leftTeam && rightTeam) {
            setRoundNumber(round.number);
            setLeftTeamName(leftTeam.name);
            setRightTeamName(rightTeam.name);
            setEmergencyGameId(saved.gameId);
            setScorerChoice(saved.scorer);
            setSetup({ round, leftTeam, rightTeam });
            setPhase('scoring');
            return undefined;
          }
        }
      }
      setPhase('setup');
      return undefined;
    }
    let cancelled = false;
    (async () => {
      const [tournamentResult, roundsResult, teamsResult] = await Promise.all([
        getTournament(),
        getRounds(),
        getTeams(),
      ]);
      if (cancelled) return;
      if (!tournamentResult.ok) {
        setLoadError(tournamentResult.error);
        setPhase('setup');
        return;
      }
      setTournament(tournamentResult.value);
      if (roundsResult.ok) setRounds(roundsResult.value.rounds);
      if (teamsResult.ok) setTeams(teamsResult.value.teams);
      setPhase('setup');
    })();
    return () => {
      cancelled = true;
    };
  }, [emergency, kit]);

  // Watch connectivity so the scorekeeper always knows whether YellowFruit can hear them. Emergency
  // mode still watches: coming back is how the scorekeeper learns they can return to the room page.
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      const result = await getStatus();
      if (!cancelled) setOnline(result.ok);
    };
    check();
    const handle = setInterval(check, connectivityIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, []);

  const handleDownload = useCallback(
    (entry: IRoomResultOutboxEntry) => {
      outbox.download(entry, kit?.roomName);
    },
    [outbox, kit?.roomName],
  );

  const handleStartGame = async () => {
    setSetupError('');
    if (emergency && !kitUsable) return;
    if (roundNumber === '' || leftTeamName === '' || rightTeamName === '') {
      setSetupError('Choose a round and both teams.');
      return;
    }
    if (leftTeamName === rightTeamName) {
      setSetupError('The two teams must be different.');
      return;
    }
    const round = rounds.find((r) => r.number === roundNumber);
    const leftTeam = teams.find((t) => t.name === leftTeamName);
    const rightTeam = teams.find((t) => t.name === rightTeamName);
    if (!round || !leftTeam || !rightTeam) {
      setSetupError('That round or team is no longer part of the tournament. Reload the page.');
      return;
    }

    if (emergency) {
      // No session, because there is no server to create one with. The result is a local record
      // until somebody imports it. Persist the identity/setup first so refreshing offline restores
      // the same MODAQ store rather than silently starting an empty game.
      const gameId = `emergency-${round.number}-${Date.now().toString(36)}`;
      writeEmergencyGameState({
        gameId,
        tournamentKey: kit?.tournamentKey,
        roundNumber: round.number,
        leftTeamName: leftTeam.name,
        rightTeamName: rightTeam.name,
        scorer: scorerChoice,
      });
      setEmergencyGameId(gameId);
      setActiveResultId(null);
      setDeliveryFailed(false);
      setPersistFailure(false);
      setSetup({ round, leftTeam, rightTeam });
      setPhase('scoring');
      return;
    }

    setStarting(true);
    const result = await createSession({
      roundNumber: round.number,
      leftTeam: leftTeam.name,
      rightTeam: rightTeam.name,
      scorer: scorerChoice,
    });
    setStarting(false);
    if (!result.ok) {
      setSetupError(result.error);
      return;
    }

    setCredentials({ sessionId: result.value.sessionId, token: result.value.token });
    setActiveResultId(null);
    setDeliveryFailed(false);
    setPersistFailure(false);
    setSetup({ round, leftTeam, rightTeam });
    setPhase('scoring');
  };

  /**
   * Put a finished game into the outbox and try to send it.
   *
   * Shared by both scorers. Manual and emergency diverge only at the end: both write to the device
   * first, but an emergency result has no session to upload to and is stored as a non-authoritative
   * backup that reaches the tournament only when somebody imports the file.
   */
  const deliverFinal = useCallback(
    async (
      qbj: Record<string, any>,
      activeCredentials: ISessionCredentials | null,
      isEmergency: boolean,
    ): Promise<ModaqStatus> => {
      const activeSetup = setupRef.current;
      const enqueued = await outboxRef.current.enqueue({
        tournamentKey: tournamentKeyRef.current,
        roundNumber: activeSetup?.round.number,
        roundName: activeSetup?.round.name,
        leftTeam: activeSetup?.leftTeam.name ?? '',
        rightTeam: activeSetup?.rightTeam.name ?? '',
        qbj,
        deliveryState: isEmergency ? 'manual-backup' : 'queued',
        sessionCredentials: activeCredentials ?? undefined,
      });
      setActiveResultId(enqueued.entry.id);
      setPersistFailure(!enqueued.persisted);

      if (isEmergency) {
        // Once the finished result is durably in the outbox, the in-progress recovery record has done
        // its job. If persistence failed, keep it: it may still be the only reload-safe copy.
        if (enqueued.persisted) clearEmergencyGameState();
        setPhase('submitted');
        setSubmitMessage(
          enqueued.persisted
            ? 'Saved on this device. Download the QBJ file and give it to tournament control — this game is not in the tournament until they import it.'
            : 'This browser could not save the game. Download the QBJ file now, before closing this page.',
        );
        return {
          isError: !enqueued.persisted,
          status: enqueued.persisted ? 'Saved on this device' : 'Not saved — download the file now',
        };
      }

      const delivered = await outboxRef.current.submitNow(enqueued.entry.id);
      if (delivered?.deliveryState === 'submitted') {
        setDeliveryFailed(false);
        setPhase('submitted');
        setSubmitMessage('Game submitted successfully. Waiting for tournament control to accept the result.');
        return { isError: false, status: 'Submitted to YellowFruit' };
      }

      setDeliveryFailed(true);
      if (delivered?.retryBlocked) {
        setSubmitMessage(
          `${
            delivered.lastError ?? 'YellowFruit refused this result.'
          } The game is saved on this device — use Download QBJ under Saved results and give the file to the statskeeper.`,
        );
        return { isError: true, status: delivered.lastError ?? 'YellowFruit refused this result.' };
      }

      return {
        isError: true,
        status: enqueued.persisted
          ? 'Saved on this device. It will be sent automatically when YellowFruit is reachable again.'
          : 'This browser could not save the result. Download the QBJ file now.',
      };
    },
    [],
  );

  const handleExport = useCallback(
    async (rawQbj: object, context?: { source: ExportSource }): Promise<ModaqStatus> => {
      const activeCredentials = credentialsRef.current;
      const isEmergency = emergencyRef.current;
      if (!activeCredentials && !isEmergency) {
        return { isError: true, status: 'This room is not connected to a game yet.' };
      }

      const source = context?.source ?? 'Menu';

      // MODAQ counts questions from the scaffold packet's length, which overstates them for a game
      // that stayed tied. Correct that here so nothing downstream ever sees the inflated counts.
      const normalizeOptions = normalizeOptionsRef.current;
      const qbj = normalizeOptions ? normalizeQbjMatch(rawQbj, normalizeOptions).qbj : (rawQbj as Record<string, any>);
      setQuestionsPlayed(countPlayedQuestions(qbj));

      if (source === 'Timer') {
        if (isEmergency || !activeCredentials) {
          // Nothing to send a live snapshot to. Not an error: there is no dashboard watching.
          return { isError: false, status: 'Saved on this device' };
        }
        const result = await putSnapshot(activeCredentials, qbj);
        if (!result.ok) {
          setLastSnapshotError(result.error);
          // Reported as an error so MODAQ shows the scorekeeper that the upload didn't land, but
          // nothing local is discarded and scoring continues.
          return { isError: true, status: result.error };
        }
        setLastSnapshotError('');
        return { isError: false, status: 'Sent to YellowFruit' };
      }

      if (source === 'NewGame') {
        // Starting a fresh game in MODAQ isn't a submission for this session.
        return { isError: false, status: 'Not submitted' };
      }

      return deliverFinal(qbj, activeCredentials, isEmergency);
    },
    [deliverFinal],
  );

  /** The first-party scorer's final submission. Its counts are exact, so nothing is normalized. */
  const handleScorerSubmit = useCallback(
    async (qbj: object) => {
      const activeCredentials = credentialsRef.current;
      const isEmergency = emergencyRef.current;
      if (!activeCredentials && !isEmergency) {
        return { ok: false, message: 'This room is not connected to a game yet.' };
      }
      const outcome = await deliverFinal(qbj as Record<string, any>, activeCredentials, isEmergency);
      return { ok: !outcome.isError, message: outcome.status };
    },
    [deliverFinal],
  );

  /** Live progress, when there is a session listening. An emergency game has nothing to tell. */
  const handleScorerProgress = useCallback(async (qbj: object, questionsHeard: number) => {
    setQuestionsPlayed(questionsHeard);
    const activeCredentials = credentialsRef.current;
    if (!activeCredentials || emergencyRef.current) return;
    const result = await putSnapshot(activeCredentials, qbj);
    setLastSnapshotError(result.ok ? '' : result.error);
  }, []);

  const modaqPlayers = useMemo(() => (setup ? toModaqPlayers(setup.leftTeam, setup.rightTeam) : []), [setup]);

  // A stable store name per game, so a refresh restores this game and only this game. An emergency
  // game has no session to name itself after, so it carries a locally generated id instead.
  let storeName: string | undefined;
  if (emergency) storeName = emergencyGameId ?? undefined;
  else if (credentials) storeName = `yf-room-${credentials.sessionId}`;

  const customExport = useMemo(
    () => ({
      type: 'QBJ' as const,
      label: emergency ? 'Save on this device' : 'Submit to YellowFruit',
      customExportInterval: snapshotIntervalMs,
      onExport: handleExport as any,
    }),
    [handleExport, emergency],
  );

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
  /**
   * A finished game that really is still on its way.
   *
   * Only results that will be sent on their own: the banner it drives promises exactly that, and a
   * refused or handed-over result is not going anywhere by itself.
   */
  const pendingFinal = outbox.pendingAutomaticDelivery;
  const savedResults = outbox.entries.length > 0 && (
    <SavedResults
      entries={outbox.entries}
      roomName={kit?.roomName}
      onDownload={handleDownload}
      durable={outbox.durable}
      // SavedResults asks the scorekeeper to confirm before this runs, so manual scoring gets the
      // same prompt the assigned-room page does.
      onMarkHandedOver={(entry) => outbox.markHandedOver(entry.id).catch(() => undefined)}
    />
  );

  if (phase === 'loading') {
    return <div className="room-shell">Loading tournament information&hellip;</div>;
  }

  const connectionBanner = !online && !emergency && (
    <div className="room-banner room-banner-warning">
      <strong>Offline &mdash; keep scoring.</strong> This game is saved on this Chromebook and will be sent when the
      connection comes back.
    </div>
  );

  if (phase === 'scoring' && setup && scorerChoice === 'first-party') {
    // The same key the game is saved under, so a reload comes back to this game and only this one.
    return scoringFormat && storeName ? (
      <>
        <ScorerHost
          key={storeName}
          gameKey={storeName}
          format={scoringFormat}
          leftTeam={setup.leftTeam}
          rightTeam={setup.rightTeam}
          tournamentName={emergency ? (kit?.tournamentName ?? '') : (tournament?.name ?? '')}
          roundName={setup.round.name}
          roomName={emergency ? kit?.roomName : undefined}
          connection={online ? RoomConnectionState.Connected : RoomConnectionState.Offline}
          onSubmit={handleScorerSubmit}
          onDownload={activeResult ? () => handleDownload(activeResult) : undefined}
          onProgress={handleScorerProgress}
          qbjMeta={{ round: setup.round.number, location: emergency ? kit?.roomName : undefined }}
        />
        {deliveryFailureNotice}
        {savedResults}
      </>
    ) : (
      <ScoringUnavailable roundName={setup.round.name} roomName={emergency ? kit?.roomName : undefined} />
    );
  }

  if (phase === 'scoring' && setup && gameFormat) {
    return (
      <ScoringView
        roomName={emergency ? (kit?.roomName ?? 'Emergency scoring') : undefined}
        roundName={setup.round.name}
        leftTeamName={setup.leftTeam.name}
        rightTeamName={setup.rightTeam.name}
        gameFormat={gameFormat}
        players={modaqPlayers}
        storeName={storeName}
        customExport={customExport as any}
        // Manual scoring polls only for reachability, so it has no separate degraded state to show.
        connection={online ? RoomConnectionState.Connected : RoomConnectionState.Offline}
        questionsPlayed={questionsPlayed}
        awaitingReview={pendingFinal}
        snapshotError={lastSnapshotError}
        resultIsSaved={!persistFailure}
        // An emergency game is stored as a non-authoritative backup with no session behind it, so
        // nothing will ever send it: the offline banner must say so rather than promise a delivery
        // that cannot happen.
        automaticDelivery={!emergency}
        conflictNotice={
          emergency ? 'Emergency scoring: this game is not in the tournament until tournament control imports it.' : ''
        }
        deliveryFailure={deliveryFailureNotice}
        savedResults={savedResults || null}
      />
    );
  }

  if (phase === 'submitted') {
    return (
      <div className="room-shell">
        <h1>{emergency ? 'Game saved on this device' : 'Game submitted'}</h1>
        <p>{submitMessage}</p>
        {activeResult && (
          <button type="button" className="room-button" onClick={() => handleDownload(activeResult)}>
            Download QBJ
          </button>
        )}
        <p className="room-muted">
          You can close this page, or start the next game to score another round in this room.
        </p>
        <button
          type="button"
          className="room-button room-button-secondary"
          onClick={() => {
            clearEmergencyGameState();
            setSetup(null);
            setCredentials(null);
            setEmergencyGameId(null);
            setActiveResultId(null);
            setSubmitMessage('');
            setRoundNumber('');
            setLeftTeamName('');
            setRightTeamName('');
            setPhase('setup');
          }}
        >
          Start Next Game
        </button>
        <p className="room-join-manual">
          <a href="/join">Open room</a>
        </p>
        {savedResults}
      </div>
    );
  }

  // Setup screen
  const rulesUnusable = !emergency && tournament !== null && !selectedRulesUsable;

  if (emergency && !kitUsable) {
    return (
      <div className="room-shell">
        <h1>Emergency scoring is not available</h1>
        <div className="room-banner room-banner-error">{describeUnusableKit(kit, new Date(), scorerChoice)}</div>
        <p className="room-muted">
          This device can only score a game on its own using tournament information it saved while it was connected.
          Pair this browser with its room, or ask tournament control for a paper scoresheet.
        </p>
        <p className="room-join-manual">
          <a href="/join">Open room</a>
        </p>
        {savedResults}
      </div>
    );
  }

  return (
    <div className="room-shell">
      {connectionBanner}
      <h1>{(emergency ? kit?.tournamentName : tournament?.name) || 'YellowFruit'}</h1>
      <p className="room-muted">{emergency ? 'Emergency scoring' : 'Scorekeeping room'}</p>

      {emergency && (
        <div className="room-banner room-banner-warning">
          <strong>YellowFruit is unavailable, so this game is scored from information saved on this device.</strong>
          <div>
            The result is kept here and is <strong>not</strong> in the tournament until tournament control imports the
            file. Rounds, teams and rules are from {new Date(kit?.updatedAt ?? Date.now()).toLocaleString()}.
          </div>
        </div>
      )}

      {loadError !== '' && (
        <div className="room-banner room-banner-error">
          Couldn&apos;t load tournament information: {loadError}
          <div>Make sure the YellowFruit computer is on the same network and its server is running.</div>
          {cachedKitUsable && (
            <div>
              If tournament control has told you to score anyway, <a href="/room/emergency">score from this device</a>.
              The result is not in the tournament until they import it.
            </div>
          )}
        </div>
      )}

      {rulesUnusable && (
        <div className="room-banner room-banner-error">
          <strong>This tournament&apos;s scoring rules can&apos;t be used for browser scorekeeping.</strong>
          {scorerChoice === 'legacy' && (
            <ul>
              {tournament?.gameFormatErrors.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {pendingFinal && (
        <div className="room-banner room-banner-warning">
          A finished game is still waiting to be sent to YellowFruit. It will go automatically once the connection is
          back. Don&apos;t clear this browser&apos;s data.
        </div>
      )}

      {submitMessage !== '' && <div className="room-banner room-banner-error">{submitMessage}</div>}

      <p className="room-join-manual">
        <a href="/join">{emergency ? 'Open room' : 'Pair this browser to a configured room'}</a>
      </p>

      {!rulesUnusable && (emergency ? kitUsable : tournament !== null) && (
        <>
          {!emergency &&
            scorerChoice === 'legacy' &&
            tournament !== null &&
            tournament.gameFormatWarnings.length > 0 && (
              <div className="room-banner room-banner-info">
                {tournament.gameFormatWarnings.map((message) => (
                  <div key={message}>{message}</div>
                ))}
              </div>
            )}

          <label className="room-field" htmlFor="round-select">
            <span>Round</span>
            <select
              id="round-select"
              value={roundNumber}
              onChange={(e) => setRoundNumber(e.target.value === '' ? '' : Number(e.target.value))}
            >
              <option value="">Choose a round</option>
              {rounds.map((round) => (
                <option key={round.number} value={round.number}>
                  {round.name}
                </option>
              ))}
            </select>
          </label>

          <label className="room-field" htmlFor="left-team-select">
            <span>Team 1</span>
            <select id="left-team-select" value={leftTeamName} onChange={(e) => setLeftTeamName(e.target.value)}>
              <option value="">Choose a team</option>
              {teams.map((team) => (
                <option key={team.name} value={team.name} disabled={team.name === rightTeamName}>
                  {team.name}
                </option>
              ))}
            </select>
          </label>

          <label className="room-field" htmlFor="right-team-select">
            <span>Team 2</span>
            <select id="right-team-select" value={rightTeamName} onChange={(e) => setRightTeamName(e.target.value)}>
              <option value="">Choose a team</option>
              {teams.map((team) => (
                <option key={team.name} value={team.name} disabled={team.name === leftTeamName}>
                  {team.name}
                </option>
              ))}
            </select>
          </label>

          {setupError !== '' && <div className="room-banner room-banner-error">{setupError}</div>}

          <button type="button" className="room-button" onClick={handleStartGame} disabled={starting}>
            {starting ? 'Starting…' : 'Start Game'}
          </button>
        </>
      )}

      {savedResults}
    </div>
  );
}
