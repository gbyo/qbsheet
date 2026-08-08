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

export interface IPlayersDialogProps {
  left: IDerivedTeam;
  right: IDerivedTeam;
  /** How many a team may have active at once, from the format. */
  maximumActive: number;
  /** The question the change will apply from. */
  questionNumber: number;
  onSubstitute: (team: LeftOrRight, activePlayers: string[]) => void;
  onClose: () => void;
}

function TeamLineup(props: {
  team: IDerivedTeam;
  side: LeftOrRight;
  maximumActive: number;
  onSubstitute: (team: LeftOrRight, activePlayers: string[]) => void;
}) {
  const { team, side, maximumActive, onSubstitute } = props;
  const [selected, setSelected] = useState<string[]>(team.activePlayers);

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

  return (
    <section className="scorer-lineup" aria-label={`${team.name} lineup`}>
      <h3 className="scorer-lineup-team">{team.name}</h3>
      <ul className="scorer-lineup-list">
        {team.players.map((player) => {
          const active = selected.includes(player.name);
          return (
            <li key={player.name}>
              <label className="scorer-lineup-row" htmlFor={`scorer-lineup-${side}-${player.name}`}>
                <input
                  id={`scorer-lineup-${side}-${player.name}`}
                  type="checkbox"
                  checked={active}
                  // A full lineup can still be reduced; it just cannot grow.
                  disabled={!active && atCapacity}
                  onChange={() => toggle(player.name)}
                />
                <span className="scorer-lineup-name">{player.name}</span>
                <span className="scorer-lineup-tuh">{player.tossupsHeard} TUH</span>
              </label>
            </li>
          );
        })}
      </ul>
      <p className="scorer-lineup-count">
        {selected.length} of {maximumActive} on the floor
      </p>
      <button
        type="button"
        className="scorer-choice"
        disabled={unchanged || selected.length === 0}
        onClick={() => onSubstitute(side, selected)}
      >
        Apply to {team.name}
      </button>
    </section>
  );
}

export default function PlayersDialog(props: IPlayersDialogProps) {
  const { left, right, maximumActive, questionNumber, onSubstitute, onClose } = props;

  return (
    <ScorerDialog title="Players" onClose={onClose}>
      <p className="scorer-dialog-note">Changes apply from question {questionNumber}.</p>
      <div className="scorer-lineups">
        <TeamLineup team={left} side="left" maximumActive={maximumActive} onSubstitute={onSubstitute} />
        <TeamLineup team={right} side="right" maximumActive={maximumActive} onSubstitute={onSubstitute} />
      </div>
    </ScorerDialog>
  );
}
