/**
 * That the player table is the whole player table.
 *
 * It used to be `.slice(0, 10)` with no heading, no count and no control saying so, on the only page
 * in Director that reports player statistics. Eleventh place did not exist anywhere in the
 * application.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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

// Column preferences persist per tournament in localStorage: every test starts
// from fresh defaults so one test's chooser cannot leak into another's table.
beforeEach(() => {
  localStorage.clear();
});

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

function openChooser(label: string): void {
  fireEvent.click(screen.getByRole('button', { name: label }));
}

function toggleColumn(name: string): void {
  fireEvent.click(screen.getByRole('switch', { name }));
}

function headerNames(table: HTMLElement): (string | null)[] {
  return within(table)
    .getAllByRole('columnheader')
    .map((header) => header.textContent);
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
  const expected = derivePlayerStandings(state)
    .filter((standing) => standing.gamesPlayed > 0)
    .map((standing) => state.players.find((player) => player.id === standing.playerId)?.name ?? 'Unknown')
    .filter((name) => name.startsWith('Player '));
  expect(generated).toEqual(expected);
  expect(names).toHaveLength(14);
  // The count is on the view control, where a director choosing between the two
  // tables can already see it.
  expect(screen.getByRole('button', { name: 'Players 14' })).toBeTruthy();
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
  const winPct = cells[3] as HTMLElement;
  expect(winPct.textContent).toContain('—');
  expect(winPct.querySelector('.director-visually-hidden')?.textContent).toBe('Win % not available');
  expect(row.textContent).not.toContain('0.0%');
});

test('a team that has played still shows the rate it earned', () => {
  render(<StandingsView state={playedTournament()} controller={controller} onAnnounce={vi.fn()} />);

  const row = within(teamTable()).getByText('Ninety Six').closest('tr') as HTMLElement;
  expect(within(row).getAllByRole('cell')[3]?.textContent).toBe('100.0%');
});

test('the team table shows the schema core by default: GP, PPG, TUH, PPB', () => {
  render(<StandingsView state={playedTournament()} controller={controller} onAnnounce={vi.fn()} />);

  expect(headerNames(teamTable())).toEqual([
    '#',
    'Team',
    'Record',
    'Win %',
    'GP',
    'Margin',
    'PPG',
    'TUH',
    'PPB',
  ]);
  // PF/PA and answer tiers stay in the chooser until the director asks for them.
  expect(within(teamTable()).queryByRole('columnheader', { name: 'PF' })).toBeNull();
  expect(within(teamTable()).queryByRole('columnheader', { name: 'Powers' })).toBeNull();
});

test('team context columns are individually toggleable and pinned when enabled', () => {
  render(<StandingsView state={playedTournament()} controller={controller} onAnnounce={vi.fn()} />);

  openChooser('Team columns');
  toggleColumn('Powers');
  toggleColumn('Gets');
  toggleColumn('Negs');
  toggleColumn('PF');
  toggleColumn('PA');

  const detailedTable = teamTable();
  expectPinnedColumns(detailedTable, ['PF', 'PA', 'Powers', 'Gets', 'Negs'], '3');
  expect(
    within(detailedTable)
      .getAllByRole('columnheader')
      .slice(0, 2)
      .every((header) => !header.dataset.pinned),
  ).toBe(true);

  toggleColumn('PF');
  expect(within(teamTable()).queryByRole('columnheader', { name: 'PF' })).toBeNull();
  // Untoggled core columns are unaffected by chooser traffic.
  expect(within(teamTable()).queryByRole('columnheader', { name: 'PPB' })).not.toBeNull();
});

test('player context columns pin without changing the compact core', () => {
  render(<StandingsView state={tournamentWithPlayers(2)} controller={controller} onAnnounce={vi.fn()} />);

  fireEvent.click(screen.getByRole('button', { name: /^Players/ }));
  const table = screen.getByRole('table', { name: 'Player statistics' });
  expect(headerNames(table)).toEqual(['Player', 'GP', 'Pts', 'PPG', 'TUH', 'PPTUH']);
  expect(within(table).queryByRole('columnheader', { name: 'Bonus pts' })).toBeNull();

  openChooser('Player columns');
  toggleColumn('Powers');
  toggleColumn('Gets');
  toggleColumn('Negs');
  toggleColumn('Bonus pts');

  const detailedTable = screen.getByRole('table', { name: 'Player statistics' });
  expectPinnedColumns(detailedTable, ['Powers', 'Gets', 'Negs', 'Bonus pts'], '3');
  expect(within(detailedTable).getAllByRole('columnheader')).toHaveLength(10);

  toggleColumn('Bonus pts');
  expect(
    within(screen.getByRole('table', { name: 'Player statistics' })).queryByRole('columnheader', {
      name: 'Bonus pts',
    }),
  ).toBeNull();
});

test('a column choice survives a fresh render of the same tournament', () => {
  const first = playedTournament();
  render(<StandingsView state={first} controller={controller} onAnnounce={vi.fn()} />);
  openChooser('Team columns');
  toggleColumn('Powers');
  expect(within(teamTable()).queryByRole('columnheader', { name: 'Powers' })).not.toBeNull();
  cleanup();

  // A new render is a new component tree: only the persisted preference brings Powers back.
  render(<StandingsView state={playedTournament()} controller={controller} onAnnounce={vi.fn()} />);
  expect(within(teamTable()).queryByRole('columnheader', { name: 'Powers' })).not.toBeNull();
});

test('a second stage adds a scope selector that re-derives both tables', () => {
  const state = playedTournament();
  state.phases.push({
    id: 'phase-2',
    name: 'Playoffs',
    kind: 'playoff',
    order: 2,
    formatId: 'format-1',
    poolIds: [],
    roundIds: [],
    advancementRule: null,
    carryover: false,
    status: 'active',
  });
  render(<StandingsView state={state} controller={controller} onAnnounce={vi.fn()} />);

  fireEvent.click(screen.getByRole('button', { name: 'Playoffs' }));
  expect(
    within(teamTable()).getByText('No accepted results in Playoffs yet.'),
  ).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Preliminary' }));
  expect(within(teamTable()).getByText('Ninety Six')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Overall' }));
  expect(within(teamTable()).getByText('Ninety Six')).toBeTruthy();
});

test('a tossup-only format offers no bonus columns to fill with zeroes', () => {
  const state = playedTournament();
  state.tournament!.rules.useBonuses = false;
  for (const game of state.games) {
    for (const score of game.scores) {
      score.bonuses = 0;
      score.bonusPoints = 0;
    }
  }
  render(<StandingsView state={state} controller={controller} onAnnounce={vi.fn()} />);

  expect(headerNames(teamTable())).not.toContain('PPB');
  openChooser('Team columns');
  expect(screen.queryByRole('switch', { name: 'Bonuses' })).toBeNull();
  expect(screen.queryByRole('switch', { name: 'PPB' })).toBeNull();
});

test('an enabled-but-scoreless superpower tier still gets its column', () => {
  const state = playedTournament();
  state.tournament!.rules.superpowerValue = 20;
  render(<StandingsView state={state} controller={controller} onAnnounce={vi.fn()} />);

  expect(headerNames(teamTable())).toContain('Superpowers');
});

test('an unknown TUH is announced as unavailable, not rendered as zero', () => {
  const state = playedTournament();
  state.games[0].playerStats[0].tossupsHeard = null;
  render(<StandingsView state={state} controller={controller} onAnnounce={vi.fn()} />);

  fireEvent.click(screen.getByRole('button', { name: /^Players/ }));
  const table = screen.getByRole('table', { name: 'Player statistics' });
  const row = within(table).getByText('Gibson').closest('tr') as HTMLElement;
  const tuhIndex = headerNames(table).indexOf('TUH');
  const cell = within(row).getAllByRole('cell')[tuhIndex] as HTMLElement;
  expect(cell.textContent).toContain('—');
  expect(cell.textContent).not.toContain('0');
  expect(within(cell).getByText('TUH not available')).toHaveClass('director-visually-hidden');
});
