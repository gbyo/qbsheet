/**
 * Who is starting.
 *
 * # Why this is a screen and not a default
 *
 * Because the default was wrong and silent. A roster of six with four active seats used to start the
 * first four names the registration happened to be in, and nothing anywhere said so. Every tossup
 * then charged those four a tossup heard, and the two on the bench — who may well have been the ones
 * actually playing — finished the game with none. Tossups heard is not decoration: YellowFruit
 * validates it, the stat report divides by it, and a game whose TUH is attributed to the wrong four
 * players is wrong in a way nobody looking at the final score would ever notice.
 *
 * It is asked only when there is genuinely something to ask. A roster that fits inside the format's
 * cap has one possible lineup and this never appears.
 *
 * It is deliberately fast: two columns of names, tap the starters, one button. A room that has to
 * fight this before question one will learn to guess, which is where we came in.
 */
import { useState } from 'react';
import { LeftOrRight } from '../../renderer/Utils/UtilTypes';
import { IDerivedTeam } from '../scoring/deriveGame';
import { IRoomProcedure, substitutionPolicy } from '../../renderer/Services/RoomProcedure';

export interface IStartingLineupPromptProps {
  left: IDerivedTeam;
  right: IDerivedTeam;
  maximumActive: number;
  /** Sides that must be chosen. A side not listed here already has a settled lineup. */
  needed: LeftOrRight[];
  /** How this room runs a game, which decides when the bench can come on. */
  // eslint-disable-next-line react/require-default-props
  procedure?: IRoomProcedure;
  onConfirm: (lineups: Partial<Record<LeftOrRight, string[]>>) => void;
}

/**
 * When the players not chosen here can come on.
 *
 * Said from the configured procedure rather than from the usual case. A room running the
 * restrictive policy that is told it can substitute "between any two tossups" will try to, be
 * refused, and reasonably conclude the software is broken.
 */
export function substitutionSentence(procedure: IRoomProcedure | undefined): string {
  return substitutionPolicy(procedure) === 'any-boundary'
    ? 'The rest start on the bench and can come on between any two tossups.'
    : 'The rest start on the bench and can come on at halftime, at a timeout, or at a phase checkpoint.';
}

function TeamStarters(props: {
  team: IDerivedTeam;
  maximumActive: number;
  selected: string[];
  onToggle: (name: string) => void;
  settled: boolean;
}) {
  const { team, maximumActive, selected, onToggle, settled } = props;
  const atCapacity = selected.length >= maximumActive;

  return (
    <section className="scorer-starters-team" aria-label={`${team.name} starters`}>
      <h3 className="scorer-lineup-team">{team.name}</h3>
      {settled ? (
        <p className="scorer-dialog-note">Starting: {team.activePlayers.join(', ')}</p>
      ) : (
        <>
          <ul className="scorer-lineup-list">
            {team.players.map((player) => {
              const checked = selected.includes(player.name);
              return (
                <li key={player.name}>
                  <label className="scorer-lineup-row" htmlFor={`scorer-start-${team.name}-${player.name}`}>
                    <input
                      id={`scorer-start-${team.name}-${player.name}`}
                      type="checkbox"
                      checked={checked}
                      disabled={!checked && atCapacity}
                      onChange={() => onToggle(player.name)}
                    />
                    <span className="scorer-lineup-name">{player.name}</span>
                    {/*
                      Only once the seats are full, and only on the names that did not get one. Said
                      earlier it would be labelling every unticked name "Bench" before the
                      scorekeeper has decided anything.
                    */}
                    {!checked && atCapacity && <span className="scorer-lineup-tuh">Bench</span>}
                  </label>
                </li>
              );
            })}
          </ul>
          <p className="scorer-lineup-count">
            {selected.length} of {maximumActive} selected
          </p>
        </>
      )}
    </section>
  );
}

export default function StartingLineupPrompt(props: IStartingLineupPromptProps) {
  const { left, right, maximumActive, needed, procedure, onConfirm } = props;
  const [chosen, setChosen] = useState<Record<LeftOrRight, string[]>>({ left: [], right: [] });

  const toggle = (side: LeftOrRight, name: string) => {
    setChosen((current) => {
      const existing = current[side];
      if (existing.includes(name)) return { ...current, [side]: existing.filter((other) => other !== name) };
      if (existing.length >= maximumActive) return current;
      return { ...current, [side]: existing.concat(name) };
    });
  };

  const ready = needed.every((side) => chosen[side].length > 0);

  return (
    <section className="scorer-starters" aria-label="Starting lineups">
      <h2 className="scorer-starters-title">Who is starting?</h2>
      <p className="scorer-dialog-note">
        These rosters have more players than the {maximumActive} who can be on the floor.{' '}
        {substitutionSentence(procedure)}
      </p>
      <div className="scorer-lineups">
        <TeamStarters
          team={left}
          maximumActive={maximumActive}
          selected={chosen.left}
          settled={!needed.includes('left')}
          onToggle={(name) => toggle('left', name)}
        />
        <TeamStarters
          team={right}
          maximumActive={maximumActive}
          selected={chosen.right}
          settled={!needed.includes('right')}
          onToggle={(name) => toggle('right', name)}
        />
      </div>
      <button
        type="button"
        className="scorer-submit"
        disabled={!ready}
        onClick={() => {
          const lineups: Partial<Record<LeftOrRight, string[]>> = {};
          for (const side of needed) lineups[side] = chosen[side];
          onConfirm(lineups);
        }}
      >
        Start game
      </button>
    </section>
  );
}
