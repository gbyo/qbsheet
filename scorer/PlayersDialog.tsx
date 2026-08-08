/**
 * Who is on the floor.
 *
 * The main screen shows only active players, and never a row of empty seats waiting to be filled —
 * a roster of four with two blanks under it invites somebody to score a buzz against nobody.
 * Changing the lineup is a deliberate act, so it happens here.
 *
 * The change takes effect from the question about to be played, which is what keeps tossups heard
 * honest: a player who came on at question eleven heard ten fewer tossups than one who started, and
 * that difference is a real statistic rather than an approximation.
 */
import { useState } from 'react';
import { LeftOrRight } from '../../renderer/Utils/UtilTypes';
import { IDerivedTeam } from '../scoring/deriveGame';
import ScorerDialog from './ScorerDialog';
import { roomPlayerNameMaxLength } from '../../main/server/ServerTypes';

export interface IPlayersDialogProps {
  left: IDerivedTeam;
  right: IDerivedTeam;
  /** How many a team may have active at once, from the format. */
  maximumActive: number;
  /** The question the change will apply from. */
  questionNumber: number;
  /**
   * Timeouts each team has taken, when the tournament tracks them.
   *
   * Here as well as on the team panel because this is where a scorekeeper looks when a coach asks,
   * and because substitutions and timeouts are the same conversation on a real scoresheet.
   */
  // eslint-disable-next-line react/require-default-props
  timeouts?: Record<LeftOrRight, number>;
  /** How many each team gets. Zero means timeouts are not tracked and nothing is shown. */
  // eslint-disable-next-line react/require-default-props
  timeoutsPerTeam?: number;
  onSubstitute: (team: LeftOrRight, activePlayers: string[]) => void;
  onAddPlayer: (team: LeftOrRight, playerName: string, activePlayers: string[]) => void;
  // eslint-disable-next-line react/require-default-props
  rosterSyncStatus?: Record<string, 'synced' | 'waiting' | 'local' | 'rejected'>;
  // eslint-disable-next-line react/require-default-props
  onRequestControl?: (team: LeftOrRight, playerName: string) => void;
  onClose: () => void;
}

export function rosterSyncKey(team: LeftOrRight, playerName: string): string {
  return `${team}\u0000${playerName.toLocaleLowerCase()}`;
}

function TeamLineup(props: {
  team: IDerivedTeam;
  side: LeftOrRight;
  maximumActive: number;
  onSubstitute: (team: LeftOrRight, activePlayers: string[]) => void;
  onAddPlayer: (team: LeftOrRight, playerName: string, activePlayers: string[]) => void;
  rosterSyncStatus: Record<string, 'synced' | 'waiting' | 'local' | 'rejected'>;
  timeoutsUsed: number;
  timeoutsPerTeam: number;
  // eslint-disable-next-line react/require-default-props
  onRequestControl?: (team: LeftOrRight, playerName: string) => void;
}) {
  const {
    team,
    side,
    maximumActive,
    onSubstitute,
    onAddPlayer,
    rosterSyncStatus,
    timeoutsUsed,
    timeoutsPerTeam,
    onRequestControl,
  } = props;
  const [selected, setSelected] = useState<string[]>(team.activePlayers);
  const [newPlayer, setNewPlayer] = useState('');

  const toggle = (name: string) => {
    setSelected((current) => {
      if (current.includes(name)) return current.filter((other) => other !== name);
      if (current.length >= maximumActive) return current;
      return current.concat(name);
    });
  };

  const unchanged =
    selected.length === team.activePlayers.length && selected.every((name) => team.activePlayers.includes(name));
  const atCapacity = selected.length >= maximumActive;
  const cleanNewPlayer = newPlayer.trim();
  const canAdd =
    cleanNewPlayer !== '' &&
    !team.players.some((player) => player.name.toLocaleLowerCase() === cleanNewPlayer.toLocaleLowerCase());

  const playerRow = (player: IDerivedTeam['players'][number], active: boolean) => {
    const sync = rosterSyncStatus[rosterSyncKey(side, player.name)];
    let syncLabel = '';
    if (sync === 'synced') syncLabel = 'Synced';
    else if (sync === 'waiting') syncLabel = 'Waiting to sync';
    else if (sync === 'local') syncLabel = 'Saved in this game';
    else if (sync === 'rejected') syncLabel = 'Needs tournament control';
    return (
      <li key={player.name}>
        <label className="scorer-lineup-row" htmlFor={`scorer-lineup-${side}-${player.name}`}>
          <input
            id={`scorer-lineup-${side}-${player.name}`}
            type="checkbox"
            checked={active}
            disabled={!active && atCapacity}
            onChange={() => toggle(player.name)}
          />
          <span className="scorer-lineup-name">{player.name}</span>
          <span className="scorer-lineup-tuh">{player.tossupsHeard} TUH</span>
          {syncLabel && <span className="scorer-lineup-sync">{syncLabel}</span>}
        </label>
        {sync === 'rejected' && onRequestControl && (
          <button type="button" className="scorer-text-action" onClick={() => onRequestControl(side, player.name)}>
            Request tournament control
          </button>
        )}
      </li>
    );
  };

  const playing = team.players.filter((player) => selected.includes(player.name));
  const bench = team.players.filter((player) => !selected.includes(player.name));

  return (
    <section className="scorer-lineup" aria-label={`${team.name} lineup`}>
      <h3 className="scorer-lineup-team">{team.name}</h3>
      {timeoutsPerTeam > 0 && (
        <p className="scorer-team-timeout">
          {timeoutsUsed === 0 &&
            (timeoutsPerTeam === 1 ? 'Timeout available' : `${timeoutsPerTeam} timeouts available`)}
          {timeoutsUsed > 0 && timeoutsUsed === 1 && 'Timeout used'}
          {timeoutsUsed > 1 && `${timeoutsUsed} timeouts used`}
        </p>
      )}
      <h4>Playing</h4>
      <ul className="scorer-lineup-list">{playing.map((player) => playerRow(player, true))}</ul>
      <h4>Bench</h4>
      <ul className="scorer-lineup-list">{bench.map((player) => playerRow(player, false))}</ul>
      <p className="scorer-lineup-count">
        {selected.length} of {maximumActive} active
      </p>
      <button
        type="button"
        className="scorer-choice"
        disabled={unchanged || selected.length === 0}
        onClick={() => onSubstitute(side, selected)}
      >
        Apply to {team.name}
      </button>
      <form
        className="scorer-add-player"
        onSubmit={(submitEvent) => {
          submitEvent.preventDefault();
          if (!canAdd) return;
          const nextActive = atCapacity ? selected : selected.concat(cleanNewPlayer);
          onAddPlayer(side, cleanNewPlayer, nextActive);
        }}
      >
        <label htmlFor={`scorer-add-player-${side}`}>
          Add player during game
          <input
            id={`scorer-add-player-${side}`}
            value={newPlayer}
            maxLength={roomPlayerNameMaxLength}
            placeholder="Player name"
            onChange={(event) => setNewPlayer(event.target.value)}
          />
        </label>
        <button type="submit" className="scorer-choice" disabled={!canAdd}>
          Add{atCapacity ? ' to bench' : ' and activate'}
        </button>
      </form>
    </section>
  );
}

export default function PlayersDialog(props: IPlayersDialogProps) {
  const {
    left,
    right,
    maximumActive,
    questionNumber,
    onSubstitute,
    onAddPlayer,
    rosterSyncStatus = {},
    timeouts = { left: 0, right: 0 },
    timeoutsPerTeam = 0,
    onRequestControl,
    onClose,
  } = props;

  return (
    <ScorerDialog title="Players" onClose={onClose}>
      <p className="scorer-dialog-note">Changes apply starting Tossup {questionNumber}.</p>
      <div className="scorer-lineups">
        <TeamLineup
          team={left}
          side="left"
          maximumActive={maximumActive}
          onSubstitute={onSubstitute}
          onAddPlayer={onAddPlayer}
          rosterSyncStatus={rosterSyncStatus}
          timeoutsUsed={timeouts.left}
          timeoutsPerTeam={timeoutsPerTeam}
          onRequestControl={onRequestControl}
        />
        <TeamLineup
          team={right}
          side="right"
          maximumActive={maximumActive}
          onSubstitute={onSubstitute}
          onAddPlayer={onAddPlayer}
          rosterSyncStatus={rosterSyncStatus}
          timeoutsUsed={timeouts.right}
          timeoutsPerTeam={timeoutsPerTeam}
          onRequestControl={onRequestControl}
        />
      </div>
    </ScorerDialog>
  );
}
