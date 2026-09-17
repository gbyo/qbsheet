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
 * It is deliberately fast: one roster, one press per starter, with the starting order visible on
 * the selected players themselves. A room that has to fight this before question one will learn to
 * guess, which is where we came in.
 */
import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from 'react';
import { LeftOrRight } from '../scoring/types';
import { IDerivedTeam } from '../scoring/deriveGame';
import { IRoomProcedure, substitutionOpportunityPhrase, substitutionPolicy } from '../scoring/RoomProcedure';
import { playerNameMaxLength, validatePlayerName } from '../game/Roster';

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
 * restrictive policy that is told it can substitute at any point will try to, be refused, and
 * reasonably conclude the software is broken.
 *
 * The permissive branch says only that the lineup can change later, because "any boundary" is what
 * *this software* allows, not what the tournament allows. Plenty of events restrict substitutions
 * to set or packet breaks without anybody configuring a policy here, and a prompt that promised
 * substitutions between any two tossups would be stating a rule it has no way to know.
 */
export function substitutionSentence(procedure: IRoomProcedure | undefined): string {
  return substitutionPolicy(procedure) === 'any-boundary'
    ? 'The rest start on the bench. You can change the lineup later when tournament rules allow.'
    : `The rest start on the bench and can come on ${substitutionOpportunityPhrase(procedure)}.`;
}

function TeamStarters(props: {
  team: IDerivedTeam;
  side: LeftOrRight;
  maximumActive: number;
  selected: string[];
  onToggle: (name: string) => void;
  onClear: () => void;
  settled: boolean;
  onAddPlayer: (playerName: string) => void;
}) {
  const { team, side, maximumActive, selected, onToggle, onClear, settled, onAddPlayer } = props;
  const [adding, setAdding] = useState(false);
  const [newPlayer, setNewPlayer] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const starters = settled ? team.activePlayers : selected;
  const atCapacity = starters.length >= maximumActive;
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
    <section className="scorer-starters-team" aria-label={`${team.name} starters`} data-side={side}>
      <div className="scorer-lineup-head">
        <h3 className="scorer-lineup-team">{team.name}</h3>
        {!settled && selected.length > 0 && (
          <button type="button" className="scorer-text-action scorer-lineup-clear" onClick={onClear}>
            Clear
          </button>
        )}
      </div>

      <p className="scorer-lineup-count" aria-live="polite">
        {settled ? (
          <>
            {starters.length} selected · <span>Lineup set automatically</span>
          </>
        ) : (
          `${selected.length} of ${maximumActive} selected${atCapacity ? ' · Full' : ''}`
        )}
      </p>

      <div className="scorer-starter-grid" role="group" aria-label={`${team.name} roster`}>
        {team.players.map((player, playerIndex) => {
          const seat = starters.indexOf(player.name);
          const isSelected = seat !== -1;
          const unavailable = !isSelected && atCapacity;
          const contents = (
            <>
              <span className="scorer-starter-seat" aria-hidden="true">
                {isSelected ? seat + 1 : '–'}
              </span>
              <span className="scorer-starter-name">{player.name}</span>
            </>
          );

          if (settled) {
            return (
              <div
                key={player.name}
                className={`scorer-starter-tile${isSelected ? ' is-selected' : ''}`}
                aria-label={`${player.name}${isSelected ? `, starting position ${seat + 1}` : ', bench'}`}
              >
                {contents}
              </div>
            );
          }

          return (
            <button
              key={player.name}
              type="button"
              className={`scorer-starter-tile${isSelected ? ' is-selected' : ''}`}
              aria-label={isSelected ? `Bench ${player.name}` : `Start ${player.name}`}
              aria-pressed={isSelected}
              aria-disabled={unavailable}
              aria-describedby={isSelected ? `scorer-starting-seat-${side}-${playerIndex}` : undefined}
              title={unavailable ? `Remove a starter before selecting ${player.name}` : undefined}
              onClick={() => {
                if (!unavailable) onToggle(player.name);
              }}
            >
              {contents}
              {isSelected && (
                <span id={`scorer-starting-seat-${side}-${playerIndex}`} className="visually-hidden">
                  Starting position {seat + 1}
                </span>
              )}
            </button>
          );
        })}
        {!adding && (
          <button type="button" className="scorer-starter-add" onClick={() => setAdding(true)}>
            + Add player
          </button>
        )}
      </div>

      {adding && (
        <form className="scorer-inline-add scorer-starter-inline-add" onSubmit={submitAdd}>
          <label htmlFor={`scorer-start-add-${side}`}>Player name</label>
          <div className="scorer-inline-add-fields">
            <input
              ref={input}
              id={`scorer-start-add-${side}`}
              value={newPlayer}
              maxLength={playerNameMaxLength}
              onChange={(event) => setNewPlayer(event.target.value)}
              onKeyDown={handleAddKeyDown}
              aria-describedby={
                newPlayer !== '' && validation.problem ? `scorer-start-add-error-${side}` : undefined
              }
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
  const {
    left,
    right,
    maximumActive,
    needed,
    procedure,
    requiredStarterCount = {},
    onAddPlayer,
    onConfirm,
  } = props;
  const [chosen, setChosen] = useState<Record<LeftOrRight, string[]>>({ left: [], right: [] });
  const [confirmationProblem, setConfirmationProblem] = useState('');

  const toggle = (side: LeftOrRight, name: string) => {
    setConfirmationProblem('');
    setChosen((current) => {
      const existing = current[side];
      if (existing.includes(name)) {
        return { ...current, [side]: existing.filter((other) => other !== name) };
      }
      if (existing.length >= maximumActive) return current;
      return { ...current, [side]: existing.concat(name) };
    });
  };

  const clear = (side: LeftOrRight) => {
    setConfirmationProblem('');
    setChosen((current) => ({ ...current, [side]: [] }));
  };

  const remaining = needed.reduce(
    (total, side) => total + Math.max(0, (requiredStarterCount[side] ?? 1) - chosen[side].length),
    0,
  );
  const ready = remaining === 0;

  return (
    <section className="scorer-starters" aria-label="Starting lineups">
      <h2 className="scorer-starters-title">Starting lineup</h2>
      <p className="scorer-starters-instruction">Tap players in the order they’re seated.</p>
      <p className="scorer-dialog-note scorer-starters-procedure">
        Up to {maximumActive} players may start for each team. {substitutionSentence(procedure)}
      </p>
      <div className="scorer-lineups">
        <TeamStarters
          team={left}
          side="left"
          maximumActive={maximumActive}
          selected={chosen.left}
          settled={!needed.includes('left')}
          onToggle={(name) => toggle('left', name)}
          onClear={() => clear('left')}
          onAddPlayer={(name) => onAddPlayer('left', name)}
        />
        <TeamStarters
          team={right}
          side="right"
          maximumActive={maximumActive}
          selected={chosen.right}
          settled={!needed.includes('right')}
          onToggle={(name) => toggle('right', name)}
          onClear={() => clear('right')}
          onAddPlayer={(name) => onAddPlayer('right', name)}
        />
      </div>
      <div className="scorer-starters-footer">
        <div className="scorer-starters-status">
          <p className={ready ? 'is-ready' : undefined} aria-live="polite">
            {ready ? 'Ready to start' : `${remaining} more starter${remaining === 1 ? '' : 's'} needed`}
          </p>
          {confirmationProblem && (
            <p className="scorer-lineup-problem" role="alert">
              {confirmationProblem}
            </p>
          )}
        </div>
        <button
          type="button"
          className="scorer-submit scorer-starters-submit"
          disabled={!ready}
          onClick={() => {
            const lineups: Partial<Record<LeftOrRight, string[]>> = {};
            for (const side of needed) lineups[side] = chosen[side];
            setConfirmationProblem(onConfirm(lineups) ?? '');
          }}
        >
          Start game
        </button>
      </div>
    </section>
  );
}
