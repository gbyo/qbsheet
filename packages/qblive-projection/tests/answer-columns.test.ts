/**
 * QBLive statistics tables use the tournament's own answer tiers (#753, epic #755).
 *
 * The team/individual tables used to publish hard-coded `15` / `10` / `−5` columns with no
 * superpower tier, so any other format published mislabeled columns. Column identity stays
 * semantic (`superpowers`, not `20`) while labels come from the scoring definition, and every
 * row carries exactly one cell per column.
 */
import { describe, expect, test } from 'vitest';
import {
  defaultRules,
  emptyDirectorState,
  type DirectorState,
  type TournamentRules,
} from '@qbsheet/tournament-domain';
import {
  answerTierColumns,
  buildPlayerStatisticsTable,
  buildTeamStatisticsTable,
  type TableScope,
} from '../src/tables';

const scope: TableScope = { id: 'overall', label: 'Overall' };
const naming = {
  teamName: (teamId: string) => teamId,
  playerName: (playerId: string) => playerId,
};

function liveState(rules: TournamentRules): DirectorState {
  const state = emptyDirectorState();
  state.tournament = {
    id: 'tournament-live-tiers',
    name: 'Tier Test',
    date: '2026-09-05',
    venue: '',
    organizer: '',
    status: 'running',
    timeZone: 'America/New_York',
    rules: structuredClone(rules),
    formatId: null,
    currentPhaseId: null,
    currentPacketId: null,
    currentRoundId: null,
    createdAt: '2026-09-05T10:00:00.000Z',
    updatedAt: '2026-09-05T10:00:00.000Z',
  };
  state.teams = [
    {
      id: 'team-a',
      organizationId: null,
      displayName: 'Aiken',
      teamLetter: 'A',
      seed: null,
      status: 'confirmed',
      createdAt: '2026-09-05T10:00:00.000Z',
      updatedAt: '2026-09-05T10:00:00.000Z',
    },
    {
      id: 'team-b',
      organizationId: null,
      displayName: 'Wren',
      teamLetter: 'A',
      seed: null,
      status: 'confirmed',
      createdAt: '2026-09-05T10:00:00.000Z',
      updatedAt: '2026-09-05T10:00:00.000Z',
    },
  ];
  state.players = [{ id: 'player-a1', teamId: 'team-a', name: 'A. Player', captain: true, active: true }];
  state.games = [
    {
      id: 'game-1',
      scheduledGameId: 'scheduled-1',
      roundId: 'round-1',
      packetId: null,
      status: 'accepted',
      scores: [
        {
          teamId: 'team-a',
          score: 320,
          superpowers: 1,
          powers: 2,
          gets: 5,
          negs: 1,
          bonuses: 8,
          bonusPoints: 160,
          bouncebacks: 0,
        },
        {
          teamId: 'team-b',
          score: 110,
          superpowers: 0,
          powers: 1,
          gets: 3,
          negs: 2,
          bonuses: 4,
          bonusPoints: 60,
          bouncebacks: 0,
        },
      ],
      playerStats: [
        {
          playerId: 'player-a1',
          teamId: 'team-a',
          superpowers: 1,
          powers: 2,
          gets: 5,
          negs: 1,
          bonusPoints: 0,
          tossupsHeard: 20,
        },
      ],
      source: 'manual',
      detailedStats: 'complete',
      acceptedAt: '2026-09-05T12:00:00.000Z',
    },
  ];
  return state;
}

function cellText(
  table: {
    columns: Array<{ id: string }>;
    rows: Array<{ cells: Array<{ display?: string; value: unknown }> }>;
  },
  columnId: string,
  rowIndex = 0,
) {
  const columnIndex = table.columns.findIndex((column) => column.id === columnId);
  expect(columnIndex).toBeGreaterThan(-1);
  return table.rows[rowIndex]?.cells[columnIndex];
}

describe('answer tier columns', () => {
  test('default rules publish the historical 15/10/−5 columns unchanged', () => {
    const tiers = answerTierColumns(structuredClone(defaultRules));
    expect(tiers.map((tier) => [tier.id, tier.label])).toEqual([
      ['powers', '15'],
      ['gets', '10'],
      ['negs', '−5'],
    ]);
    const state = liveState(structuredClone(defaultRules));
    const teams = buildTeamStatisticsTable(state, scope, naming);
    // Default rules configure bonuses but not bouncebacks or lightning: the
    // parity set appends TUH/PPTUH/Pts-X/bonus facts, while BB and lightning
    // columns stay out rather than publishing em dashes for a format without
    // them.
    expect(teams.columns.map((column) => column.id)).toEqual([
      'team',
      'games',
      'powers',
      'gets',
      'negs',
      'tuh',
      'pptuh',
      'ppx',
      'bonuses',
      'bonuspoints',
      'ppb',
      'ppg',
    ]);
    for (const row of teams.rows) expect(row.cells).toHaveLength(teams.columns.length);
    const players = buildPlayerStatisticsTable(state, scope, naming);
    expect(players.columns.map((column) => column.id)).toEqual([
      'rank',
      'player',
      'team',
      'games',
      'tuh',
      'powers',
      'gets',
      'negs',
      'points',
      'ppg',
      'pptuh',
      'bonus',
    ]);
    for (const row of players.rows) expect(row.cells).toHaveLength(players.columns.length);
  });

  test('a superpower tier publishes a labeled column with aligned cells', () => {
    const rules = { ...structuredClone(defaultRules), superpowerValue: 20 };
    const state = liveState(rules);
    const teams = buildTeamStatisticsTable(state, scope, naming);
    expect(teams.columns.map((column) => [column.id, column.label])).toContainEqual(['superpowers', '20']);
    // Semantic order: superpowers lead the answer tiers, right after games played.
    expect(teams.columns.map((column) => column.id).slice(0, 4)).toEqual([
      'team',
      'games',
      'superpowers',
      'powers',
    ]);
    for (const row of teams.rows) expect(row.cells).toHaveLength(teams.columns.length);
    expect(cellText(teams, 'superpowers', 0)?.display).toBe('1');

    const players = buildPlayerStatisticsTable(state, scope, naming);
    expect(players.columns.map((column) => column.id)).toContain('superpowers');
    for (const row of players.rows) expect(row.cells).toHaveLength(players.columns.length);
    expect(cellText(players, 'superpowers', 0)?.display).toBe('1');
  });

  test('custom values relabel tiers and undefined tiers publish no column', () => {
    const rules = { ...structuredClone(defaultRules), powerValue: 20, negValue: null };
    const tiers = answerTierColumns(rules);
    expect(tiers.map((tier) => [tier.id, tier.label])).toEqual([
      ['powers', '20'],
      ['gets', '10'],
    ]);
    const state = liveState(rules);
    const teams = buildTeamStatisticsTable(state, scope, naming);
    expect(teams.columns.map((column) => column.id)).not.toContain('negs');
    for (const row of teams.rows) expect(row.cells).toHaveLength(teams.columns.length);
  });
});
