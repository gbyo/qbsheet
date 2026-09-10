/**
 * That the player table is the whole player table.
 *
 * It used to be `.slice(0, 10)` with no heading, no count and no control saying so, on the only page
 * in Director that reports player statistics. Eleventh place did not exist anywhere in the
 * application.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { derivePlayerStandings, playerHasAppearance, type DirectorState } from '../domain';
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

/**
 * Teams and players are peer views of the same destination now, so the player
 * table is one press away rather than a second table stacked below the first.
 */
function playerTable(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: /^Players/ }));
  return screen.getByRole('table', { name: 'Player statistics' });
}

function teamTable(): HTMLElement {
  return screen.getByRole('table', { name: 'Team standings' });
}

function detailedSwitch(): HTMLElement {
  return screen.getByRole('switch', { name: 'Detailed scoring columns' });
}

function expectPinnedColumns(table: HTMLElement, headers: string[], priority: string): void {
  const columnHeaders = within(table).getAllByRole('columnheader');
  const firstDataRow = within(table).getAllByRole('row')[1] as HTMLElement;
  const cells = within(firstDataRow).getAllByRole('cell');

  expect(cells).toHaveLength(columnHeaders.length);
  for (const header of headers) {
    const headerIndex = columnHeaders.findIndex((columnHeader) => columnHeader.textContent === header);
    expect(headerIndex).toBeGreaterThanOrEqual(0);
    expect(columnHeaders[headerIndex]).toHaveAttribute('data-priority', priority);
    expect(columnHeaders[headerIndex]).toHaveAttribute('data-pinned', 'true');
    expect(cells[headerIndex]).toHaveAttribute('data-priority', priority);
    expect(cells[headerIndex]).toHaveAttribute('data-pinned', 'true');
  }
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
  // The expectation uses the same appearance rule as the view: bare GP > 0 would
  // silently drop real scorers whose game TUH is unknown (#746).
  const expected = derivePlayerStandings(state)
    .filter(playerHasAppearance)
    .map((standing) => state.players.find((player) => player.id === standing.playerId)?.name ?? 'Unknown')
    .filter((name) => name.startsWith('Player '));
  expect(generated).toEqual(expected);
  expect(names).toHaveLength(14);
  // The count is on the view control, where a director choosing between the two
  // tables can already see it.
  expect(screen.getByRole('button', { name: 'Players 14' })).toBeTruthy();
});

/**
 * A scoring average needs games to be an average over.
 *
 * Player 0 has result lines but the games carry no tossups-read count, so GP
 * is unknown rather than zero — and the PPG next to it is unknown too, not
 * 0.0 next to real points (#746).
 */
test('a scorer with unknown participation shows unknown PPG, not 0.0', () => {
  render(<StandingsView state={tournamentWithPlayers(1)} controller={controller} onAnnounce={vi.fn()} />);

  const row = within(playerTable()).getByText('Player 0').closest('tr') as HTMLElement;
  const cells = within(row).getAllByRole('cell');
  // Player, Games, PPG
  expect(cells[1]?.textContent).toBe('—');
  expect(cells[2]?.textContent).toBe('—');
});

/**
 * Both exports are still here, by name — but as a compact menu rather than two
 * large buttons competing with the tables. Exports is the destination that owns
 * the export model; this is the shortcut for a director already looking at the
 * numbers.
 */
test('the two exports are offered by name rather than as one unexplained CSV', () => {
  render(<StandingsView state={playedTournament()} controller={controller} onAnnounce={vi.fn()} />);

  fireEvent.click(screen.getByRole('button', { name: 'Export' }));

  expect(screen.getByRole('option', { name: 'Team standings CSV' })).toBeTruthy();
  expect(screen.getByRole('option', { name: 'Player stats CSV' })).toBeTruthy();
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

  const row = within(teamTable()).getByText('Abbeville').closest('tr') as HTMLElement;
  const cells = within(row).getAllByRole('cell');
  // #, Team, W–L, Win %
  expect(cells[3]?.textContent).toBe('—');
  expect(row.textContent).not.toContain('0.0%');
});

test('a team that has played still shows the rate it earned', () => {
  render(<StandingsView state={playedTournament()} controller={controller} onAnnounce={vi.fn()} />);

  const row = within(teamTable()).getByText('Ninety Six').closest('tr') as HTMLElement;
  expect(within(row).getAllByRole('cell')[3]?.textContent).toBe('100.0%');
});

test('team detail columns are omitted by default and pinned when enabled', () => {
  render(<StandingsView state={playedTournament()} controller={controller} onAnnounce={vi.fn()} />);

  const compactTable = teamTable();
  expect(within(compactTable).queryByRole('columnheader', { name: 'PF' })).toBeNull();
  expect(
    within(compactTable)
      .getAllByRole('columnheader')
      .map((header) => header.dataset.priority),
  ).toEqual(['1', '1', '1', '2', '2']);
  expect(detailedSwitch()).toHaveAttribute('aria-checked', 'false');

  fireEvent.click(detailedSwitch());

  expect(detailedSwitch()).toHaveAttribute('aria-checked', 'true');
  const detailedTable = teamTable();
  expectPinnedColumns(detailedTable, ['PF', 'PA', 'Powers', 'Gets', 'Negs'], '3');
  expect(
    within(detailedTable)
      .getAllByRole('columnheader')
      .slice(0, 5)
      .every((header) => !header.dataset.pinned),
  ).toBe(true);

  fireEvent.click(detailedSwitch());
  expect(within(teamTable()).queryByRole('columnheader', { name: 'PF' })).toBeNull();
});

test('player detail columns pin Bonus pts without changing the compact core', () => {
  render(<StandingsView state={tournamentWithPlayers(2)} controller={controller} onAnnounce={vi.fn()} />);

  fireEvent.click(screen.getByRole('button', { name: /^Players/ }));
  const table = screen.getByRole('table', { name: 'Player statistics' });
  expect(within(table).queryByRole('columnheader', { name: 'Bonus pts' })).toBeNull();

  fireEvent.click(detailedSwitch());

  const detailedTable = screen.getByRole('table', { name: 'Player statistics' });
  expectPinnedColumns(detailedTable, ['Powers', 'Gets', 'Negs'], '2');
  expectPinnedColumns(detailedTable, ['Bonus pts'], '3');
  expect(within(detailedTable).getAllByRole('columnheader')).toHaveLength(7);
  expect(
    within(detailedTable)
      .getAllByRole('columnheader')
      .slice(0, 3)
      .map((header) => header.dataset.priority),
  ).toEqual(['1', '1', '1']);

  fireEvent.click(detailedSwitch());
  expect(
    within(screen.getByRole('table', { name: 'Player statistics' })).queryByRole('columnheader', {
      name: 'Bonus pts',
    }),
  ).toBeNull();
});
