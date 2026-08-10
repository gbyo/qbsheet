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
import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from 'react';
import { LeftOrRight } from '../scoring/types';
import { IDerivedTeam } from '../scoring/deriveGame';
import { IRoomProcedure, substitutionPolicy } from '../scoring/RoomProcedure';
import { playerNameMaxLength, validatePlayerName } from '../game/Roster';
import { moveWithin } from './PlayerSeating';

export interface IStartingLineupPromptProps {
  left: IDerivedTeam;
  right: IDerivedTeam;
  maximumActive: number;
  /** Sides that must be chosen. A side not listed here already has a settled lineup. */
  needed: LeftOrRight[];
  /** How this room runs a game, which decides when the bench can come on. */
  procedure?: IRoomProcedure;
  /** Optional per-side minimum, used when a workflow requires every available seat to be filled. */
  requiredStarterCount?: Partial<Record<LeftOrRight, number>>;
  /** Add somebody through the scorer's ordinary roster-add and synchronization path. */
  onAddPlayer: (team: LeftOrRight, playerName: string) => void;
  /** Return a message to keep the prompt open and let the scorekeeper correct the selection. */
  onConfirm: (lineups: Partial<Record<LeftOrRight, string[]>>) => string | undefined;
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
  side: LeftOrRight;
  maximumActive: number;
  selected: string[];
  onToggle: (name: string) => void;
  onMove: (name: string, direction: -1 | 1) => void;
  settled: boolean;
  onAddPlayer: (playerName: string) => void;
}) {
  const { team, side, maximumActive, selected, onToggle, onMove, settled, onAddPlayer } = props;
  const [adding, setAdding] = useState(false);
  const [reordering, setReordering] = useState(false);
  const [newPlayer, setNewPlayer] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const displayedSelection = settled ? team.activePlayers : selected;
  const atCapacity = displayedSelection.length >= maximumActive;
  const validation = validatePlayerName(
    newPlayer,
    team.players.map((player) => player.name),
  );

  useEffect(() => {
    if (adding) input.current?.focus();
  }, [adding]);

  const cancelAdd = () => {
    setAdding(false);
    setNewPlayer('');
  };

  const submitAdd = (event: FormEvent) => {
    event.preventDefault();
    if (validation.problem) return;
    onAddPlayer(validation.name);
    cancelAdd();
  };

  const handleAddKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    cancelAdd();
  };

  return (
    <section className="scorer-starters-team" aria-label={`${team.name} starters`}>
      <h3 className="scorer-lineup-team">{team.name}</h3>
      {reordering ? (
        <div className="scorer-starters-reorder">
          <div className="scorer-reorder-head">
            <p className="scorer-lineup-step-title">Reorder starters</p>
            <button type="button" className="scorer-text-action" onClick={() => setReordering(false)}>
              Done
            </button>
          </div>
          <ul className="scorer-lineup-list">
            {selected.map((name, seat) => (
              <li key={name} className="scorer-lineup-entry">
                <span className="scorer-lineup-seat" aria-hidden="true">
                  {seat + 1}
                </span>
                <span className="scorer-lineup-name">{name}</span>
                <span className="scorer-lineup-move">
                  <button
                    type="button"
                    className="scorer-text-action"
                    aria-label={`Move ${name} up in starting lineup`}
                    disabled={seat === 0}
                    onClick={() => onMove(name, -1)}
                  >
                    &uarr;
                  </button>
                  <button
                    type="button"
                    className="scorer-text-action"
                    aria-label={`Move ${name} down in starting lineup`}
                    disabled={seat === selected.length - 1}
                    onClick={() => onMove(name, 1)}
                  >
                    &darr;
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <>
          <ul className="scorer-lineup-list scorer-starters-list">
            {team.players.map((player, index) => {
              const checked = displayedSelection.includes(player.name);
              const seat = displayedSelection.indexOf(player.name);
              const id = `scorer-start-${side}-${index}`;
              return (
                <li key={player.name}>
                  <label className="scorer-lineup-row" htmlFor={id}>
                    <input
                      id={id}
                      type="checkbox"
                      aria-label={player.name}
                      checked={checked}
                      disabled={settled || (!checked && atCapacity)}
                      onChange={() => onToggle(player.name)}
                    />
                    <span className="scorer-lineup-name">{player.name}</span>
                    {checked && <span className="scorer-lineup-tuh">Seat {seat + 1}</span>}
                    {!checked && atCapacity && <span className="scorer-lineup-tuh">Bench</span>}
                  </label>
                </li>
              );
            })}
          </ul>
          <p className="scorer-lineup-count">
            {settled ? 'Starting lineup set' : `${selected.length} of ${maximumActive} selected`}
          </p>
          <div className="scorer-starters-actions">
            {!adding && (
              <button type="button" className="scorer-text-action" onClick={() => setAdding(true)}>
                + Add player
              </button>
            )}
            {!settled && selected.length > 1 && (
              <button type="button" className="scorer-text-action" onClick={() => setReordering(true)}>
                Reorder starters
              </button>
            )}
          </div>
        </>
      )}

      {adding && !reordering && (
        <form className="scorer-inline-add" onSubmit={submitAdd}>
          <label htmlFor={`scorer-start-add-${side}`}>Player name</label>
          <div className="scorer-inline-add-fields">
            <input
              ref={input}
              id={`scorer-start-add-${side}`}
              value={newPlayer}
              maxLength={playerNameMaxLength}
              onChange={(event) => setNewPlayer(event.target.value)}
              onKeyDown={handleAddKeyDown}
              aria-describedby={newPlayer !== '' && validation.problem ? `scorer-start-add-error-${side}` : undefined}
            />
            <button type="submit" className="scorer-choice" disabled={validation.problem !== undefined}>
              Add
            </button>
            <button type="button" className="scorer-text-action" onClick={cancelAdd}>
              Cancel
            </button>
          </div>
          {newPlayer !== '' && validation.problem && (
            <span id={`scorer-start-add-error-${side}`} className="scorer-field-error" role="alert">
              {validation.problem}
            </span>
          )}
        </form>
      )}
    </section>
  );
}

export default function StartingLineupPrompt(props: IStartingLineupPromptProps) {
  const { left, right, maximumActive, needed, procedure, requiredStarterCount = {}, onAddPlayer, onConfirm } = props;
  const [chosen, setChosen] = useState<Record<LeftOrRight, string[]>>({ left: [], right: [] });
  const [confirmationProblem, setConfirmationProblem] = useState('');

  const toggle = (side: LeftOrRight, name: string) => {
    setConfirmationProblem('');
    setChosen((current) => {
      const existing = current[side];
      if (existing.includes(name)) return { ...current, [side]: existing.filter((other) => other !== name) };
      if (existing.length >= maximumActive) return current;
      return { ...current, [side]: existing.concat(name) };
    });
  };

  const move = (side: LeftOrRight, name: string, direction: -1 | 1) => {
    setConfirmationProblem('');
    setChosen((current) => ({ ...current, [side]: moveWithin(current[side], name, direction) }));
  };

  const ready = needed.every((side) => chosen[side].length >= (requiredStarterCount[side] ?? 1));

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
          side="left"
          maximumActive={maximumActive}
          selected={chosen.left}
          settled={!needed.includes('left')}
          onToggle={(name) => toggle('left', name)}
          onMove={(name, direction) => move('left', name, direction)}
          onAddPlayer={(name) => onAddPlayer('left', name)}
        />
        <TeamStarters
          team={right}
          side="right"
          maximumActive={maximumActive}
          selected={chosen.right}
          settled={!needed.includes('right')}
          onToggle={(name) => toggle('right', name)}
          onMove={(name, direction) => move('right', name, direction)}
          onAddPlayer={(name) => onAddPlayer('right', name)}
        />
      </div>
      {confirmationProblem && (
        <p className="scorer-lineup-problem" role="alert">
          {confirmationProblem}
        </p>
      )}
      <button
        type="button"
        className="scorer-submit"
        disabled={!ready}
        onClick={() => {
          const lineups: Partial<Record<LeftOrRight, string[]>> = {};
          for (const side of needed) lineups[side] = chosen[side];
          setConfirmationProblem(onConfirm(lineups) ?? '');
        }}
      >
        Start game
      </button>
    </section>
  );
}
