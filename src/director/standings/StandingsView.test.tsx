/**
 * That the player table is the whole player table.
 *
 * It used to be `.slice(0, 10)` with no heading, no count and no control saying so, on the only page
 * in Director that reports player statistics. Eleventh place did not exist anywhere in the
 * application.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { derivePlayerStandings, type DirectorState } from '../domain';
import type { DirectorController } from '../state/useDirectorController';
import {
  acceptedGame,
  player,
  playerStat,
  playedTournament,
  scheduledGame,
  score,
  team,
} from '../../../tests/directorFixtures';
import { StandingsView } from './StandingsView';

afterEach(cleanup);

const controller = {} as DirectorController;

/** A tournament with `count` players who have each played and scored something distinguishable. */
function tournamentWithPlayers(count: number): DirectorState {
  const state = playedTournament();
  for (let index = 0; index < count; index += 1) {
    const teamId = `team-${index}`;
    state.teams.push(team(teamId, `Team ${index}`));
    state.players.push(player(`player-${index}`, teamId, `Player ${index}`));
    state.scheduledGames.push(scheduledGame(`scheduled-p${index}`, teamId, 'team-b'));
    state.games.push(
      acceptedGame(
        `game-p${index}`,
        `scheduled-p${index}`,
        [score(teamId, 200 - index), score('team-b', 100)],
        // Descending gets, so the derivation's own ordering puts Player 0 first and Player 11 last.
        [playerStat(`player-${index}`, teamId, { gets: count - index })],
      ),
    );
  }
  return state;
}

function playerTable(): HTMLElement {
  return document.querySelector('.director-player-table') as HTMLElement;
}

test('a twelfth-place player is on the page rather than silently dropped', () => {
  render(<StandingsView state={tournamentWithPlayers(12)} controller={controller} onAnnounce={vi.fn()} />);

  const table = playerTable();
  expect(within(table).getByText('Player 10')).toBeTruthy();
  expect(within(table).getByText('Player 11')).toBeTruthy();
});

test('the ordering is the derivation’s, and the page says how many players it is showing', () => {
  const state = tournamentWithPlayers(12);
  render(<StandingsView state={state} controller={controller} onAnnounce={vi.fn()} />);

  const names = within(playerTable())
    .getAllByRole('row')
    .slice(1)
    .map((row) => row.querySelector('strong')?.textContent);
  // Player 0 scores the most and Player 11 the least, so their order in the table is the
  // derivation's ranking rather than the roster's insertion order.
  const generated = names.filter((name) => name?.startsWith('Player '));
  const expected = derivePlayerStandings(state)
    .filter((standing) => standing.gamesPlayed > 0)
    .map((standing) => state.players.find((player) => player.id === standing.playerId)?.name ?? 'Unknown')
    .filter((name) => name.startsWith('Player '));
  expect(generated).toEqual(expected);
  expect(names).toHaveLength(14);
  expect(screen.getByText('14 players')).toBeTruthy();
});

test('the two exports are offered by name rather than as one unexplained CSV', () => {
  render(<StandingsView state={playedTournament()} controller={controller} onAnnounce={vi.fn()} />);

  expect(screen.getByRole('button', { name: 'Export team standings CSV' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Export player stats CSV' })).toBeTruthy();
});

/**
 * A win rate needs a game to be a rate.
 *
 * Every confirmed team is seeded `winPercentage: 0`, so a team added to the field and not yet
 * played rendered `0.0%` in the same column, the same shape and the same weight as a team that
 * played four games and lost all four. Two different facts cannot share one cell.
 */
test('a team that has not played shows an unknown win rate, not 0.0%', () => {
  const state = playedTournament();
  state.teams.push(team('team-c', 'Abbeville'));

  render(<StandingsView state={state} controller={controller} onAnnounce={vi.fn()} />);

  const table = document.querySelector('.director-standings-table') as HTMLElement;
  const row = within(table).getByText('Abbeville').closest('tr') as HTMLElement;
  const cells = within(row).getAllByRole('cell');
  // #, Team, W–L, Win %
  expect(cells[3]?.textContent).toBe('—');
  expect(row.textContent).not.toContain('0.0%');
});

test('a team that has played still shows the rate it earned', () => {
  render(<StandingsView state={playedTournament()} controller={controller} onAnnounce={vi.fn()} />);

  const table = document.querySelector('.director-standings-table') as HTMLElement;
  const row = within(table).getByText('Ninety Six').closest('tr') as HTMLElement;
  expect(within(row).getAllByRole('cell')[3]?.textContent).toBe('100.0%');
});
