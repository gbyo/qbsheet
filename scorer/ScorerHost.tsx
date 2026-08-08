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
 *   2. The authenticated server snapshot for this same session, fetched afterwards.
 *
 * The local copy wins, always, and the server is never consulted while it exists. Two reasons: the
 * local history is the scorer's own event model, so it restores editing, undo and per-question
 * correction exactly, and it is by definition at least as new as anything the server has — the
 * server's copy is a throttled echo of it.
 *
 * The server's copy is a real fallback rather than a formality because our own snapshots carry the
 * same event list inside them (see `attachScorerRecovery`), so a Chromebook whose localStorage was
 * wiped can be handed its game back intact. A snapshot with no such layer — one MODAQ produced, or
 * one from a build that did not attach it — is not reconstructed: no events are invented, and the
 * room is told plainly that the file has to come back through the QBJ recovery workflow instead.
 */
import { useEffect, useRef, useState } from 'react';
import { IScorekeeperFormat } from '../../renderer/Services/ScorekeeperFormat';
import { IRoomProcedure } from '../../renderer/Services/RoomProcedure';
import { IRoomTeam, HelpRequestCategory } from '../../main/server/ServerTypes';
import { IGameSetup } from '../scoring/deriveGame';
import { RoomConnectionState } from '../RoomLifecycle';
import { IQbjMatchMeta } from '../scoring/toQbjMatch';
import Scorer, { IScorerAlert, IScorerRecoveryStatus, IScorerSubmitResult } from './Scorer';
import useGameEvents from './useGameEvents';
import { loadGame } from './GameSession';
import { readScorerRecovery } from './ScorerRecovery';

export interface IScorerHostProps {
  /** The session or emergency game id. Also what the saved game is filed under. */
  gameKey: string;
  format: IScorekeeperFormat;
  leftTeam: IRoomTeam;
  rightTeam: IRoomTeam;
  tournamentName: string;
  roundName: string;
  // eslint-disable-next-line react/require-default-props
  roomName?: string;
  /** The packet this round uses, when the tournament named one. Identity only. */
  // eslint-disable-next-line react/require-default-props
  packetName?: string;
  /** Halves, clock and timeouts. Absent means the room runs none of it. */
  // eslint-disable-next-line react/require-default-props
  procedure?: IRoomProcedure;
  /** Whoever is signed in to this room browser, recorded on the result as the scorekeeper. */
  // eslint-disable-next-line react/require-default-props
  operatorName?: string;
  connection: RoomConnectionState;
  // eslint-disable-next-line react/require-default-props
  degradedMessage?: string;
  onSubmit: (qbj: object) => Promise<IScorerSubmitResult>;
  // eslint-disable-next-line react/require-default-props
  onDownload?: (qbj: object) => void;
  // eslint-disable-next-line react/require-default-props
  onProgress?: (qbj: object, questionsPlayed: number) => void;
  // eslint-disable-next-line react/require-default-props
  qbjMeta?: IQbjMatchMeta;
  // eslint-disable-next-line react/require-default-props
  onRequestControl?: (category: HelpRequestCategory, message: string) => Promise<void>;
  // eslint-disable-next-line react/require-default-props
  controlRequestPending?: boolean;
  /** Latest assignment rosters, used only to confirm roster synchronization. */
  // eslint-disable-next-line react/require-default-props
  authoritativeLeftTeam?: IRoomTeam;
  // eslint-disable-next-line react/require-default-props
  authoritativeRightTeam?: IRoomTeam;
  // eslint-disable-next-line react/require-default-props
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
  // eslint-disable-next-line react/require-default-props
  onRecoverFromServer?: () => Promise<object | null>;
  /** Room-level warnings about the connection, credentials or assignment. */
  // eslint-disable-next-line react/require-default-props
  alerts?: IScorerAlert[];
  /** Facts for the connection detail. Only claims the room can actually prove. */
  // eslint-disable-next-line react/require-default-props
  recovery?: Omit<IScorerRecoveryStatus, 'localSaveOk' | 'localSavedAt'>;
}

function toSetup(left: IRoomTeam, right: IRoomTeam): IGameSetup {
  const roster = (team: IRoomTeam) => ({
    name: team.name,
    players: team.players.map((player) => player.name).filter((name) => name !== ''),
  });
  return { left: roster(left), right: roster(right) };
}

export default function ScorerHost(props: IScorerHostProps) {
  const {
    gameKey,
    format,
    leftTeam,
    rightTeam,
    tournamentName,
    roundName,
    roomName,
    packetName,
    procedure,
    operatorName,
    connection,
    degradedMessage,
    onSubmit,
    onDownload,
    onProgress,
    qbjMeta,
    onRequestControl,
    controlRequestPending,
    authoritativeLeftTeam,
    authoritativeRightTeam,
    onSyncRosterPlayer,
    onRecoverFromServer,
    alerts,
    recovery,
  } = props;

  const initialGameKey = useRef(gameKey);
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' && initialGameKey.current !== gameKey) {
      // eslint-disable-next-line no-console
      console.warn('ScorerHost gameKey changed without a remount. Render it with key={gameKey} to isolate each game.');
    }
  }, [gameKey]);

  const [setup] = useState<IGameSetup>(() => toSetup(leftTeam, rightTeam));
  /**
   * Whatever this device had for this game.
   *
   * The saved setup wins over the one just built from the assignment, because a game that had
   * substitutions recorded against a roster must keep being scored against that roster; rebuilding
   * it from the schedule would silently move players around underneath the events.
   */
  const [recovered] = useState(() => loadGame(gameKey));
  const activeSetup = recovered?.setup ?? setup;
  const events = useGameEvents(gameKey, format, activeSetup, recovered?.events ?? [], procedure);
  const [serverRecoveryNotice, setServerRecoveryNotice] = useState('');

  /**
   * Ask the server for this session's own snapshot, but only when there is nothing local to lose.
   *
   * The guard is checked twice — once before asking and again when the answer arrives — because the
   * scorekeeper is free to keep scoring while the request is in flight, and a snapshot that was
   * current when it was fetched is stale by the time it would overwrite two more tossups.
   */
  const eventCount = events.events.length;
  const { restore } = events;
  const attemptedServerRecovery = useRef(false);
  useEffect(() => {
    if (!onRecoverFromServer || attemptedServerRecovery.current) return undefined;
    if (recovered !== null || eventCount > 0) return undefined;
    attemptedServerRecovery.current = true;
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
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // `events.events` is read inside the callback deliberately and must not re-run this effect;
    // `attemptedServerRecovery` already makes it once-per-game.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onRecoverFromServer, recovered, eventCount, restore, activeSetup]);

  return (
    <Scorer
      gameKey={gameKey}
      format={format}
      setup={activeSetup}
      events={events}
      tournamentName={tournamentName}
      roundName={roundName}
      roomName={roomName}
      packetName={packetName}
      procedure={procedure}
      operatorName={operatorName}
      connection={connection}
      degradedMessage={degradedMessage}
      saved={events.saved}
      onSubmit={onSubmit}
      onDownload={onDownload}
      onProgress={onProgress}
      qbjMeta={qbjMeta}
      onRequestControl={onRequestControl}
      controlRequestPending={controlRequestPending}
      authoritativeRosters={
        authoritativeLeftTeam && authoritativeRightTeam
          ? {
              left: authoritativeLeftTeam.players.map((player) => player.name),
              right: authoritativeRightTeam.players.map((player) => player.name),
            }
          : undefined
      }
      onSyncRosterPlayer={onSyncRosterPlayer}
      recovered={recovered !== null && recovered.events.length > 0}
      recoveryNotice={serverRecoveryNotice}
      alerts={alerts}
      recovery={{
        ...(recovery ?? {}),
        localSaveOk: events.saved,
        localSavedAt: events.savedAt,
      }}
    />
  );
}
