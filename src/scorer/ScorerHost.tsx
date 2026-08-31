/**
 * Puts a game on the screen, and puts it back after a reload.
 *
 * Separate from `Scorer` because the state has to be established per game, not per page. The room
 * app is mounted long before anybody starts a round and stays mounted across several, so a saved
 * game read in its own hooks would be read once — at page load, before there was a game to read.
 * Render this with `key={gameKey}` and each game gets its own state, and its own chance to recover.
 *
 * # The order recovery is attempted in
 *
 *   1. This device's own ScoreEvent history, read synchronously before the first render.
 *   2. This device's durable game record, when the fast journal has gone away.
 *   3. The authenticated server snapshot for this same session, fetched afterwards.
 *
 * The local copy wins, always, and the server is never consulted while it exists. Two reasons: the
 * local history is the scorer's own event model, so it restores editing, undo and per-question
 * correction exactly, and it is by definition at least as new as anything the server has — the
 * server's copy is a throttled echo of it.
 *
 * The durable record is deliberately second: it preserves the event list and frozen setup, while
 * only the fast journal preserves per-action undo/redo metadata. The server's copy is a real final
 * fallback rather than a formality because our own snapshots carry the same event list inside them
 * (see `attachScorerRecovery`), so a Chromebook whose localStorage was wiped can be handed its game
 * back intact. A snapshot with no such layer — one MODAQ produced, or one from a build that did not
 * attach it — is not reconstructed: no events are invented, and the room is told plainly that the
 * file has to come back through the QBJ recovery workflow instead.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IScorekeeperFormat } from '../scoring/ScorekeeperFormat';
import { IRoomProcedure } from '../scoring/RoomProcedure';
import { ITeamRoster } from '../game/Roster';
import {
  ControlRequestState,
  HelpClearResult,
  HelpRequestCategory,
  HelpRequestResult,
} from '../app/HelpRequests';
import { IDerivedGame, IGameSetup } from '../scoring/deriveGame';
import { ScoreEvent } from '../scoring/ScoreEvents';
import { RoomConnectionState } from '../app/ConnectionState';
import { LeftOrRight } from '../scoring/types';
import { IQbjMatchMeta } from '../scoring/toQbjMatch';
import { IGameDefinition } from '../game/GameDefinition';
import { IGamePackage } from '../game/GamePackage';
import { ISpreadsheetGameMetadata } from '../scoring/SpreadsheetGame';
import Scorer, { IScorerAlert, IScorerRecoveryStatus, IScorerSubmitResult } from './Scorer';
import { IGameCorrection } from '../scoring/gameCorrection';
import useGameEvents from './useGameEvents';
import { IGameSessionHistory, loadGame } from './GameSession';
import { readScorerRecovery } from './ScorerRecovery';
import { IQbsheetBackup } from './QBSheetBackup';

export interface IScorerHostProps {
  /** The session or emergency game id. Also what the saved game is filed under. */
  gameKey: string;
  format: IScorekeeperFormat;
  requiredStarterCount?: Partial<Record<LeftOrRight, number>>;
  validateStartingLineups?: (lineups: Partial<Record<LeftOrRight, string[]>>) => string | undefined;
  leftTeam: ITeamRoster;
  rightTeam: ITeamRoster;
  tournamentName: string;
  roundName: string;
  roomName?: string;
  /** The packet this round uses, when the tournament named one. Identity only. */
  packetName?: string;
  /** Halves, clock and timeouts. Absent means the room runs none of it. */
  procedure?: IRoomProcedure;
  /** Whoever is signed in to this room browser, recorded on the result as the scorekeeper. */
  operatorName?: string;
  /** Durable package used for the canonical tournament-spreadsheet copy. */
  gamePackage?: IGamePackage | IGameDefinition;
  /** Existing stable record identity for unscheduled/manual games. */
  stableGameId?: string;
  /** Credential-free record facts that are safe to carry with the spreadsheet snapshot. */
  spreadsheetMetadata?: ISpreadsheetGameMetadata;
  /** Whether the complete game record is currently backed by a healthy durable store. */
  recordDurablyStored?: boolean;
  /**
   * The durable record's frozen setup and event list.
   *
   * These are a recovery fallback only: a valid synchronous journal always wins, because it is the
   * only copy that can also restore action-level Undo and Redo. They let an imported game reopen
   * even when the browser refused that journal write.
   */
  durableSetup?: IGameSetup;
  durableEvents?: ScoreEvent[];
  connection: RoomConnectionState;
  /** Overrides the word in the header when the game's standing is not a network fact. See `Scorer`. */
  statusLabel?: string;
  degradedMessage?: string;
  onSubmit: (qbj: object) => Promise<IScorerSubmitResult>;
  onDownload: (qbj: object) => void;
  /** Passed through for an exact, credential-free QBSheet recovery export. */
  onDownloadQbsheetBackup?: (backup: IQbsheetBackup) => void;
  /** Passed straight through to the scorer's menu. See `Scorer`. */
  onDownloadForm?: (game: IDerivedGame, form: 'partial' | 'legacy-match') => void;
  /** Passed straight through to Game details. See `Scorer` and `gameCorrection`. */
  onCorrectGame?: (correction: IGameCorrection) => void | Promise<void>;
  onProgress?: (qbj: object, questionsPlayed: number) => void;
  /** The tournament's player ids, so a name correction re-keys them rather than dropping them. */
  qbjPlayerIds?: Record<string, string>;
  /**
   * The complete event history, whenever it changes.
   *
   * The scorer's own synchronous journal (`GameSession`) is what makes a scored question safe in
   * the same turn as the click, and it is not replaceable by anything asynchronous. This is the
   * seam for a second, durable copy alongside it — a store that is not capped at a few megabytes
   * and that still has the game when the journal has been cleared. It is called after the journal
   * write, never instead of it, and nothing waits on what the host does with it.
   */
  onEventsChanged?: (events: ScoreEvent[], setup: IGameSetup, history: IGameSessionHistory) => void;
  qbjMeta?: IQbjMatchMeta;
  onRequestControl?: (category: HelpRequestCategory, message: string) => Promise<HelpRequestResult>;
  controlRequest?: ControlRequestState;
  onRetryControlRequest?: () => Promise<HelpRequestResult | null>;
  onCancelControlRequest?: () => Promise<HelpClearResult | null>;
  /** Latest assignment rosters, used only to confirm roster synchronization. */
  authoritativeLeftTeam?: ITeamRoster;
  authoritativeRightTeam?: ITeamRoster;
  onSyncRosterPlayer?: (
    teamName: string,
    playerName: string,
  ) => Promise<{ ok: boolean; error?: string; rejected?: boolean }>;
  /**
   * Fetch this session's own latest server snapshot.
   *
   * Consulted only when the device has no local copy of the game. Returning null — because the
   * server is unreachable, because it has nothing, or because the room is not assigned — simply
   * means there is nothing to recover from, which is not an error.
   */
  onRecoverFromServer?: () => Promise<object | null>;
  /** Passed through to replace the opening banner. See `Scorer`. */
  openingNotice?: string;
  /** Room-level warnings about the connection, credentials or assignment. */
  alerts?: IScorerAlert[];
  /** Facts for the connection detail. Only claims the room can actually prove. */
  recovery?: Omit<IScorerRecoveryStatus, 'localSaveOk' | 'localSavedAt'>;
}

function toSetup(left: ITeamRoster, right: ITeamRoster): IGameSetup {
  const roster = (team: ITeamRoster) => ({
    name: team.name,
    players: team.players.map((player) => player.name).filter((name) => name !== ''),
  });
  return { left: roster(left), right: roster(right) };
}

export default function ScorerHost(props: IScorerHostProps) {
  const {
    gameKey,
    format,
    requiredStarterCount,
    validateStartingLineups,
    leftTeam,
    rightTeam,
    tournamentName,
    roundName,
    roomName,
    packetName,
    procedure,
    operatorName,
    gamePackage,
    stableGameId,
    spreadsheetMetadata,
    recordDurablyStored = true,
    durableSetup,
    durableEvents,
    connection,
    statusLabel,
    degradedMessage,
    onSubmit,
    onDownload,
    onDownloadQbsheetBackup,
    onDownloadForm,
    onCorrectGame,
    onProgress,
    qbjPlayerIds,
    onEventsChanged,
    qbjMeta,
    onRequestControl,
    controlRequest,
    onRetryControlRequest,
    onCancelControlRequest,
    authoritativeLeftTeam,
    authoritativeRightTeam,
    onSyncRosterPlayer,
    onRecoverFromServer,
    alerts,
    openingNotice,
    recovery,
  } = props;

  const initialGameKey = useRef(gameKey);
  useEffect(() => {
    if (import.meta.env?.DEV && initialGameKey.current !== gameKey) {
      console.warn(
        'ScorerHost gameKey changed without a remount. Render it with key={gameKey} to isolate each game.',
      );
    }
  }, [gameKey]);

  const [setup] = useState<IGameSetup>(() => toSetup(leftTeam, rightTeam));
  // Like the assignment setup above, capture the record at mount. A record update must remount this
  // component (as ScoringScreen does after a correction) rather than change the event context under
  // a live scorer.
  const [durableFallback] = useState(() => ({
    setup: durableSetup,
    events: durableEvents ?? [],
  }));
  /**
   * Whatever this device had for this game.
   *
   * The saved setup wins over the one just built from the assignment, because a game that had
   * substitutions recorded against a roster must keep being scored against that roster; rebuilding
   * it from the schedule would silently move players around underneath the events.
   */
  const [recovered] = useState(() => loadGame(gameKey));
  const activeSetup = recovered?.setup ?? durableFallback.setup ?? setup;
  const initialEvents = recovered?.events ?? durableFallback.events;
  const recoveringFromDurableRecord = recovered === null && durableFallback.events.length > 0;
  const events = useGameEvents(
    gameKey,
    format,
    activeSetup,
    initialEvents,
    procedure,
    recovered?.history,
    recoveringFromDurableRecord,
  );
  const [serverRecoveryNotice, setServerRecoveryNotice] = useState('');
  const [serverRecoveryError, setServerRecoveryError] = useState('');
  const [serverRecoveryAttempt, setServerRecoveryAttempt] = useState(0);

  /**
   * Ask the server for this session's own snapshot, but only when there is nothing local to lose.
   *
   * The guard is checked twice — once before asking and again when the answer arrives — because the
   * scorekeeper is free to keep scoring while the request is in flight, and a snapshot that was
   * current when it was fetched is stale by the time it would overwrite two more tossups.
   */
  const eventCount = events.events.length;
  const { restore } = events;

  // Mirror the history into whatever durable store the host has, after the journal has already
  // taken it. Deliberately keyed on the event list identity rather than its length, so a correction
  // that replaces a question without changing the count is mirrored too.
  const eventList = events.events;
  useEffect(() => {
    if (onEventsChanged) onEventsChanged(eventList, activeSetup, events.recoveryHistory());
  }, [onEventsChanged, eventList, activeSetup, events]);
  const lastServerRecoveryAttempt = useRef(-1);
  // Mirrored from a committed effect rather than during render: the only reader is the retry button,
  // which runs long after the commit, and a render that React throws away must not leave a count
  // behind from a pass that never happened.
  const localEventCount = useRef(eventCount);
  useEffect(() => {
    localEventCount.current = eventCount;
  }, [eventCount]);
  const recoveryFailed = useRef(false);

  const retryServerRecovery = useCallback(() => {
    if (localEventCount.current > 0) return;
    setServerRecoveryError('');
    setServerRecoveryAttempt((attempt) => attempt + 1);
  }, []);

  useEffect(() => {
    if (!onRecoverFromServer || lastServerRecoveryAttempt.current >= serverRecoveryAttempt) return undefined;
    if (recovered !== null || eventCount > 0) return undefined;
    lastServerRecoveryAttempt.current = serverRecoveryAttempt;
    recoveryFailed.current = false;
    // The error is not cleared here. The only thing that raises the attempt counter is
    // `retryServerRecovery`, which clears it before bumping, and the first attempt starts from the
    // empty initial value — so this had nothing left to clear.
    let cancelled = false;
    onRecoverFromServer()
      .then((qbj) => {
        if (cancelled || qbj === null) return undefined;
        // Anything scored while the request was in flight is newer than what came back.
        if (events.events.length > 0) return undefined;
        const payload = readScorerRecovery(qbj, activeSetup);
        if (!payload) {
          setServerRecoveryNotice(
            'Tournament control is holding a snapshot of this game, but it cannot be reopened here automatically. Use Recover from QBJ in the Game menu, or score from the paper scoresheet.',
          );
          return undefined;
        }
        if (payload.events.length === 0) return undefined;
        restore(payload.events);
        setServerRecoveryNotice('Recovered this game from the copy tournament control was holding.');
        return undefined;
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        recoveryFailed.current = true;
        setServerRecoveryError(
          error instanceof Error && error.message !== ''
            ? error.message
            : 'Tournament control could not be reached right now.',
        );
      });
    return () => {
      cancelled = true;
    };
    // `events.events` is read inside the callback deliberately and must not re-run this effect merely
    // because a local event list was replaced. The event-count guard above still cancels recovery as
    // soon as somebody scores locally.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onRecoverFromServer, recovered, eventCount, restore, activeSetup, serverRecoveryAttempt]);

  // A failed first check is exactly the case where a browser coming back online should get another
  // chance. The event-count ref prevents that retry from overwriting a game that started locally in
  // the meantime.
  useEffect(() => {
    const retryWhenOnline = () => {
      if (localEventCount.current === 0 && recoveryFailed.current) retryServerRecovery();
    };
    window.addEventListener('online', retryWhenOnline);
    return () => window.removeEventListener('online', retryWhenOnline);
  }, [retryServerRecovery]);

  const recoveryAlerts = useMemo<IScorerAlert[]>(() => {
    if (serverRecoveryError === '') return [];
    return [
      {
        id: 'server-recovery',
        tone: 'warning',
        title: "Couldn't check tournament control for recovery",
        body: serverRecoveryError,
        actions: eventCount === 0 ? [{ label: 'Retry', onSelect: retryServerRecovery }] : undefined,
      },
    ];
  }, [eventCount, retryServerRecovery, serverRecoveryError]);
  const allAlerts = useMemo(() => [...(alerts ?? []), ...recoveryAlerts], [alerts, recoveryAlerts]);

  return (
    <Scorer
      gameKey={gameKey}
      format={format}
      requiredStarterCount={requiredStarterCount}
      validateStartingLineups={validateStartingLineups}
      setup={activeSetup}
      events={events}
      tournamentName={tournamentName}
      roundName={roundName}
      roomName={roomName}
      packetName={packetName}
      procedure={procedure}
      operatorName={operatorName}
      gamePackage={gamePackage}
      stableGameId={stableGameId}
      spreadsheetMetadata={spreadsheetMetadata}
      connection={connection}
      statusLabel={statusLabel}
      degradedMessage={degradedMessage}
      saved={events.saved}
      onSubmit={onSubmit}
      onDownload={onDownload}
      onDownloadQbsheetBackup={onDownloadQbsheetBackup}
      onDownloadForm={onDownloadForm}
      onCorrectGame={onCorrectGame}
      onProgress={onProgress}
      qbjMeta={qbjMeta}
      qbjPlayerIds={qbjPlayerIds}
      onRequestControl={onRequestControl}
      controlRequest={controlRequest}
      onRetryControlRequest={onRetryControlRequest}
      onCancelControlRequest={onCancelControlRequest}
      authoritativeRosters={
        authoritativeLeftTeam && authoritativeRightTeam
          ? {
              left: authoritativeLeftTeam.players.map((player) => player.name),
              right: authoritativeRightTeam.players.map((player) => player.name),
            }
          : undefined
      }
      onSyncRosterPlayer={onSyncRosterPlayer}
      recovered={(recovered !== null && recovered.events.length > 0) || recoveringFromDurableRecord}
      openingNotice={openingNotice}
      recoveryNotice={serverRecoveryNotice}
      alerts={allAlerts}
      recovery={{
        ...(recovery ?? {}),
        localSaveOk: events.saved,
        recordDurablyStored,
        localSavedAt: events.savedAt,
      }}
    />
  );
}
