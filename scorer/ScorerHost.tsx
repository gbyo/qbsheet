/**
 * Puts a game on the screen, and puts it back after a reload.
 *
 * Separate from `Scorer` because the state has to be established per game, not per page. The room
 * app is mounted long before anybody starts a round and stays mounted across several, so a saved
 * game read in its own hooks would be read once — at page load, before there was a game to read.
 * Render this with `key={gameKey}` and each game gets its own state, and its own chance to recover.
 */
import { useEffect, useRef, useState } from 'react';
import { IScorekeeperFormat } from '../../renderer/Services/ScorekeeperFormat';
import { IRoomProcedure } from '../../renderer/Services/RoomProcedure';
import { IRoomTeam, HelpRequestCategory } from '../../main/server/ServerTypes';
import { IGameSetup } from '../scoring/deriveGame';
import { RoomConnectionState } from '../RoomLifecycle';
import { IQbjMatchMeta } from '../scoring/toQbjMatch';
import Scorer, { IScorerSubmitResult } from './Scorer';
import useGameEvents from './useGameEvents';
import { loadGame } from './GameSession';

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

  return (
    <Scorer
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
    />
  );
}
