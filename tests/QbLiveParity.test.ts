/**
 * QBLive publishes the same rendered statistics as Director (#753, epic #755).
 *
 * The projection builds its own table cells from canonical domain standings;
 * this test pins those cells to Director's shared `teamStatCell` /
 * `playerStatCell` mapping for one bounceback-and-lightning tournament, so the
 * two surfaces cannot drift into two vocabularies. Rank numbers come from the
 * canonical competition ranks on both sides and are covered separately.
 */
import { describe, expect, test } from 'vitest';
import {
  buildPlayerStatisticsTable,
  buildStandingsTable,
  buildTeamStatisticsTable,
  type PlayerMeta,
} from '@qbsheet/qblive-projection';
import {
  defaultRules,
  derivePlayerStandings,
  deriveTeamStandings,
  emptyDirectorState,
  type DirectorState,
} from '@qbsheet/tournament-domain';
import { playerStatCell, teamStatCell } from '../src/director/standings/statsDisplay';

const at = '2026-09-05T10:00:00.000Z';

function parityState(): DirectorState {
  const state = emptyDirectorState();
  state.tournament = {
    id: 'tournament-reconcile',
    name: 'Reconciled Event',
    date: '2026-09-05',
    venue: '',
    organizer: '',
    status: 'running',
    timeZone: 'America/New_York',
    rules: structuredClone({ ...defaultRules, bouncebacks: true, lightning: true }),
    formatId: null,
    currentPhaseId: null,
    currentPacketId: null,
    currentRoundId: null,
    createdAt: at,
    updatedAt: at,
  };
  state.teams = [
    {
      id: 'team-a',
      organizationId: null,
      displayName: 'Aiken',
      teamLetter: 'A',
      seed: null,
      status: 'confirmed',
      createdAt: at,
      updatedAt: at,
    },
    {
      id: 'team-b',
      organizationId: null,
      displayName: 'Wren',
      teamLetter: 'A',
      seed: null,
      status: 'confirmed',
      createdAt: at,
      updatedAt: at,
    },
  ];
  state.players = [
    {
      id: 'player-a1',
      teamId: 'team-a',
      name: 'A. One',
      captain: true,
      active: true,
      schoolYear: 12,
      undergraduateEligible: false,
      divisionTwoEligible: false,
    },
    {
      id: 'player-b1',
      teamId: 'team-b',
      name: 'B. One',
      captain: true,
      active: true,
      schoolYear: 11,
      undergraduateEligible: true,
      divisionTwoEligible: true,
    },
  ];
  const teamScore = (teamId: string, score: number, extra: Record<string, number> = {}) => ({
    teamId,
    score,
    superpowers: 0,
    powers: 0,
    gets: 0,
    negs: 0,
    bonuses: 0,
    bonusPoints: 0,
    bouncebacks: 0,
    ...extra,
  });
  state.games = [
    {
      id: 'game-1',
      scheduledGameId: 'scheduled-1',
      roundId: 'round-1',
      packetId: null,
      status: 'accepted',
      tossupsRead: 20,
      scores: [
        teamScore('team-a', 350, {
          powers: 2,
          gets: 8,
          negs: 1,
          bonuses: 10,
          bonusPoints: 200,
          bouncebacks: 30,
          lightningPoints: 40,
        }),
        teamScore('team-b', 200, {
          powers: 1,
          gets: 7,
          negs: 2,
          bonuses: 8,
          bonusPoints: 150,
          bouncebacks: 0,
          lightningPoints: 10,
        }),
      ],
      playerStats: [
        {
          playerId: 'player-a1',
          teamId: 'team-a',
          superpowers: 0,
          powers: 2,
          gets: 5,
          negs: 1,
          bonusPoints: 0,
          tossupsHeard: 20,
        },
        {
          playerId: 'player-b1',
          teamId: 'team-b',
          superpowers: 0,
          powers: 1,
          gets: 7,
          negs: 2,
          bonusPoints: 0,
          tossupsHeard: 20,
        },
      ],
      source: 'manual',
      detailedStats: 'complete',
    },
  ];
  return state;
}

const naming = {
  teamName: (teamId: string) => teamId,
  playerName: (playerId: string) => playerId,
  playerMeta: (playerId: string): PlayerMeta | null => {
    const player = parityState().players.find((entry) => entry.id === playerId);
    if (!player) return null;
    return {
      schoolYear: player.schoolYear ?? null,
      undergraduateEligible: player.undergraduateEligible ?? null,
      divisionTwoEligible: player.divisionTwoEligible ?? null,
    };
  },
};

const scope = { id: 'overall', label: 'Overall' };

/** QBLive column id to the Director schema column id with the same meaning. */
const STANDINGS_COLUMNS: Array<[qblive: string, director: string]> = [
  ['record', 'record'],
  ['pct', 'winpct'],
  ['games', 'games'],
  ['ppg', 'ppg'],
  ['margin', 'margin'],
  ['pf', 'pf'],
  ['pa', 'pa'],
  ['powers', 'powers'],
  ['gets', 'gets'],
  ['negs', 'negs'],
  ['tuh', 'tuh'],
  ['pptuh', 'pptuh'],
  ['bonuses', 'bonuses'],
  ['bonuspoints', 'bonuspoints'],
  ['ppb', 'ppb'],
  ['bb', 'bbpoints'],
  ['bbheard', 'bbheard'],
  ['bbconv', 'bbconv'],
  ['totalbonus', 'totalbonus'],
  ['lightning', 'lightning'],
  ['lightningpg', 'lightningpg'],
];

const TEAM_COLUMNS: Array<[qblive: string, director: string]> = [
  ['games', 'games'],
  ['ppg', 'ppg'],
  ['powers', 'powers'],
  ['gets', 'gets'],
  ['negs', 'negs'],
  ['tuh', 'tuh'],
  ['pptuh', 'pptuh'],
  ['bonuses', 'bonuses'],
  ['bonuspoints', 'bonuspoints'],
  ['ppb', 'ppb'],
  ['bb', 'bbpoints'],
  ['bbheard', 'bbheard'],
  ['bbconv', 'bbconv'],
  ['totalbonus', 'totalbonus'],
  ['lightning', 'lightning'],
  ['lightningpg', 'lightningpg'],
];

const PLAYER_COLUMNS: Array<[qblive: string, director: string]> = [
  ['games', 'games'],
  ['points', 'points'],
  ['ppg', 'ppg'],
  ['tuh', 'tuh'],
  ['pptuh', 'pptuh'],
  ['powers', 'powers'],
  ['gets', 'gets'],
  ['negs', 'negs'],
  ['bonus', 'bonus'],
  ['year', 'year'],
  ['ug', 'ug'],
  ['d2', 'd2'],
];

function cellById(
  table: { columns: Array<{ id: string }>; rows: Array<{ cells: Array<{ display?: string }> }> },
  rowIndex: number,
  columnId: string,
) {
  const index = table.columns.findIndex((column) => column.id === columnId);
  expect(index).toBeGreaterThanOrEqual(0);
  return table.rows[rowIndex]!.cells[index]!.display;
}

describe('QBLive renders Director statistics', () => {
  test('standings and team-statistics cells match the shared team mapping', () => {
    const state = parityState();
    const standings = deriveTeamStandings(state, undefined, {});
    const standingsTable = buildStandingsTable(state, scope, naming);
    const teamsTable = buildTeamStatisticsTable(state, scope, naming);
    expect(standingsTable.rows).toHaveLength(standings.length);
    expect(teamsTable.rows).toHaveLength(standings.length);
    standings.forEach((standing, rowIndex) => {
      for (const [qblive, director] of STANDINGS_COLUMNS) {
        expect(cellById(standingsTable, rowIndex, qblive)).toBe(teamStatCell(director, standing));
      }
      // The team-statistics table carries the same values under its own grouping.
      const teamRow = teamsTable.rows.find((row) => row.teamId === standing.teamId)!;
      for (const [qblive, director] of TEAM_COLUMNS) {
        const index = teamsTable.columns.findIndex((column) => column.id === qblive);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(teamRow.cells[index]!.display).toBe(teamStatCell(director, standing));
      }
    });
  });

  test('individual-statistics cells match the shared player mapping', () => {
    const state = parityState();
    const players = state.players;
    const standings = derivePlayerStandings(state, {});
    const table = buildPlayerStatisticsTable(state, scope, naming);
    expect(table.rows).toHaveLength(standings.length);
    standings.forEach((standing, rowIndex) => {
      const player = players.find((entry) => entry.id === standing.playerId);
      for (const [qblive, director] of PLAYER_COLUMNS) {
        expect(cellById(table, rowIndex, qblive)).toBe(String(playerStatCell(director, standing, player)));
      }
    });
  });
});
