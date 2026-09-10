/**
 * QBLive publishes the full canonical parity stat set (#753, epic #755).
 *
 * Standings, team statistics, and individual statistics carry the same
 * YellowFruit-equivalent values Director and the printable reports show —
 * bounceback parts/conversions, lightning, fractional participation, player
 * metadata, canonical tied ranks — through the generic table protocol, with no
 * stat-specific client logic. Columns a format does not configure stay out;
 * applicable-but-unknown values render "—" with a null value.
 */
import { describe, expect, test } from 'vitest';
import {
  defaultRules,
  emptyDirectorState,
  type DirectorState,
  type TournamentRules,
} from '@qbsheet/tournament-domain';
import {
  buildPlayerStatisticsTable,
  buildStandingsTable,
  buildTeamStatisticsTable,
  type PlayerMeta,
  type TableScope,
} from '../src/tables';

const at = '2026-09-05T10:00:00.000Z';
const scope: TableScope = { id: 'overall', label: 'Overall' };

const parityRules: TournamentRules = {
  ...structuredClone(defaultRules),
  bouncebacks: true,
  lightning: true,
};

function baseState(rules: TournamentRules): DirectorState {
  const state = emptyDirectorState();
  state.tournament = {
    id: 'tournament-live-parity',
    name: 'Parity Event',
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
    {
      id: 'team-c',
      organizationId: null,
      displayName: 'Abbeville',
      teamLetter: 'A',
      seed: null,
      status: 'confirmed',
      createdAt: at,
      updatedAt: at,
    },
    {
      id: 'team-d',
      organizationId: null,
      displayName: 'Barnwell',
      teamLetter: 'A',
      seed: null,
      status: 'confirmed',
      createdAt: at,
      updatedAt: at,
    },
  ];
  return state;
}

function parityState(): DirectorState {
  const state = baseState(parityRules);
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
      id: 'player-a2',
      teamId: 'team-a',
      name: 'A. Two',
      captain: false,
      active: true,
      schoolYear: 10,
      undergraduateEligible: true,
      divisionTwoEligible: true,
    },
    { id: 'player-b1', teamId: 'team-b', name: 'B. One', captain: true, active: true },
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
          playerId: 'player-a2',
          teamId: 'team-a',
          superpowers: 0,
          powers: 0,
          gets: 3,
          negs: 0,
          bonusPoints: 0,
          tossupsHeard: 10,
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
    {
      // team-c mirrors team-a's line exactly, so the canonical ranks tie at 1.
      id: 'game-2',
      scheduledGameId: 'scheduled-2',
      roundId: 'round-1',
      packetId: null,
      status: 'accepted',
      tossupsRead: 20,
      scores: [
        teamScore('team-c', 350, {
          powers: 2,
          gets: 8,
          negs: 1,
          bonuses: 10,
          bonusPoints: 200,
          bouncebacks: 30,
          lightningPoints: 40,
        }),
        teamScore('team-d', 200, {
          powers: 1,
          gets: 7,
          negs: 2,
          bonuses: 8,
          bonusPoints: 150,
          bouncebacks: 0,
          lightningPoints: 10,
        }),
      ],
      playerStats: [],
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
    const state = parityState();
    const player = state.players.find((entry) => entry.id === playerId);
    if (!player) return null;
    return {
      schoolYear: player.schoolYear ?? null,
      undergraduateEligible: player.undergraduateEligible ?? null,
      divisionTwoEligible: player.divisionTwoEligible ?? null,
    };
  },
};

function cell(
  table: {
    columns: Array<{ id: string }>;
    rows: Array<{
      teamId?: string;
      playerId?: string;
      id: string;
      cells: Array<{ value: unknown; display?: string }>;
    }>;
  },
  id: string,
  columnId: string,
) {
  const index = table.columns.findIndex((column) => column.id === columnId);
  expect(index).toBeGreaterThanOrEqual(0);
  const row = table.rows.find((entry) => entry.teamId === id || entry.playerId === id || entry.id === id);
  expect(row).toBeDefined();
  return row!.cells[index]!;
}

describe('QBLive standings parity set', () => {
  test('bounceback and lightning columns carry canonical values', () => {
    const table = buildStandingsTable(parityState(), scope, naming);
    expect(table.columns.map((column) => column.id)).toEqual([
      'rank',
      'team',
      'record',
      'pct',
      'pf',
      'pa',
      'ppg',
      'margin',
      'games',
      'powers',
      'gets',
      'negs',
      'tuh',
      'pptuh',
      'bonuses',
      'bonuspoints',
      'ppb',
      'bb',
      'bbheard',
      'bbconv',
      'totalbonus',
      'lightning',
      'lightningpg',
    ]);
    for (const row of table.rows) expect(row.cells).toHaveLength(table.columns.length);
    // Opponent 8-for-150 leaves (8*30-150)/10 = 9 parts heard; 30 own points
    // convert 3 → 33.3%. Own 200 points are 20 parts over 30 heard → with the
    // bouncebacks, (20+3)/(30+9) = 59.0%.
    expect(cell(table, 'team-a', 'bb')).toEqual({ value: 30, display: '30' });
    expect(cell(table, 'team-a', 'bbheard')).toEqual({ value: 9, display: '9' });
    expect(cell(table, 'team-a', 'bbconv')).toEqual({ value: 1 / 3, display: '33.3%' });
    expect(cell(table, 'team-a', 'totalbonus')).toEqual({ value: 23 / 39, display: '59.0%' });
    expect(cell(table, 'team-a', 'lightning')).toEqual({ value: 40, display: '40' });
    expect(cell(table, 'team-a', 'lightningpg')).toEqual({ value: 40, display: '40.0' });
    expect(cell(table, 'team-a', 'pptuh')).toEqual({ value: 17.5, display: '17.50' });
    // A zero conversion is exact, not unknown.
    expect(cell(table, 'team-b', 'bbconv')).toEqual({ value: 0, display: '0.0%' });
  });

  test('canonical tied ranks share one number with the = marker', () => {
    const table = buildStandingsTable(parityState(), scope, naming);
    expect(cell(table, 'team-a', 'rank')).toEqual({ value: 1, display: '1=' });
    expect(cell(table, 'team-c', 'rank')).toEqual({ value: 1, display: '1=' });
    expect(cell(table, 'team-b', 'rank')).toEqual({ value: 3, display: '3=' });
    expect(cell(table, 'team-d', 'rank')).toEqual({ value: 3, display: '3=' });
  });

  test('a tossup-only format omits the bonus columns', () => {
    const table = buildStandingsTable(
      baseState({ ...structuredClone(defaultRules), useBonuses: false }),
      scope,
      naming,
    );
    const ids = table.columns.map((column) => column.id);
    expect(ids).not.toContain('bonuses');
    expect(ids).not.toContain('bonuspoints');
    expect(ids).not.toContain('ppb');
    expect(ids).not.toContain('bb');
    expect(ids).toContain('tuh');
    expect(ids).toContain('pptuh');
  });
});

describe('QBLive team statistics parity set', () => {
  test('the complete aggregate set renders with honest unknowns', () => {
    const table = buildTeamStatisticsTable(parityState(), scope, naming);
    expect(table.columns.map((column) => column.id)).toEqual([
      'team',
      'games',
      'powers',
      'gets',
      'negs',
      'tuh',
      'pptuh',
      'bonuses',
      'bonuspoints',
      'ppb',
      'bb',
      'bbheard',
      'bbconv',
      'totalbonus',
      'lightning',
      'lightningpg',
      'ppg',
    ]);
    for (const row of table.rows) expect(row.cells).toHaveLength(table.columns.length);
    expect(cell(table, 'team-a', 'tuh')).toEqual({ value: 20, display: '20' });
    expect(cell(table, 'team-a', 'pptuh')).toEqual({ value: 17.5, display: '17.50' });
    expect(cell(table, 'team-a', 'bonuses')).toEqual({ value: 10, display: '10' });
    expect(cell(table, 'team-a', 'bonuspoints')).toEqual({ value: 200, display: '200' });
    expect(cell(table, 'team-a', 'ppb')).toEqual({ value: 20, display: '20.00' });
    expect(cell(table, 'team-a', 'bb')).toEqual({ value: 30, display: '30' });
    expect(cell(table, 'team-a', 'bbconv')).toEqual({ value: 1 / 3, display: '33.3%' });
    expect(cell(table, 'team-a', 'totalbonus')).toEqual({ value: 23 / 39, display: '59.0%' });
    expect(cell(table, 'team-a', 'lightning')).toEqual({ value: 40, display: '40' });
    expect(cell(table, 'team-a', 'ppg')).toEqual({ value: 350, display: '350.0' });
  });
});

describe('QBLive individual statistics parity set', () => {
  test('metadata, fractional GP, PPTUH, and rank ties publish together', () => {
    const table = buildPlayerStatisticsTable(parityState(), scope, naming);
    expect(table.columns.map((column) => column.id)).toEqual([
      'rank',
      'player',
      'team',
      'year',
      'ug',
      'd2',
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
    for (const row of table.rows) expect(row.cells).toHaveLength(table.columns.length);
    // Full game valued under the game's own definition: 2 powers, 5 gets and a
    // neg are 75 points over 20 TUH = 3.75 PPTUH — tied with player-b1's 75,
    // so both share rank 1 with the marker while powers order them.
    expect(cell(table, 'player-a1', 'games')).toEqual({ value: 1, display: '1' });
    expect(cell(table, 'player-a1', 'tuh')).toEqual({ value: 20, display: '20' });
    expect(cell(table, 'player-a1', 'pptuh')).toEqual({ value: 3.75, display: '3.75' });
    expect(cell(table, 'player-a1', 'year')).toEqual({ value: 12, display: 'Grade 12' });
    expect(cell(table, 'player-a1', 'ug')).toEqual({ value: 'no', display: 'No' });
    expect(cell(table, 'player-a1', 'd2')).toEqual({ value: 'no', display: 'No' });
    expect(cell(table, 'player-a1', 'rank')).toEqual({ value: 1, display: '1=' });
    expect(cell(table, 'player-b1', 'rank')).toEqual({ value: 1, display: '1=' });
    expect(cell(table, 'player-a2', 'rank')).toEqual({ value: 3, display: '3' });
    // Substitute: 10 of 20 TUH is half a game, never a rounded 1.
    expect(cell(table, 'player-a2', 'games')).toEqual({ value: 0.5, display: '0.50' });
    expect(cell(table, 'player-a2', 'ug')).toEqual({ value: 'yes', display: 'Yes' });
    // A player with no metadata source rows renders unknowns, not blanks.
    expect(cell(table, 'player-b1', 'year')).toEqual({ value: null, display: '—' });
    expect(cell(table, 'player-b1', 'ug')).toEqual({ value: null, display: '—' });
  });

  test('no metadata source means no metadata columns', () => {
    const table = buildPlayerStatisticsTable(parityState(), scope, {
      teamName: naming.teamName,
      playerName: naming.playerName,
    });
    const ids = table.columns.map((column) => column.id);
    expect(ids).not.toContain('year');
    expect(ids).not.toContain('ug');
    expect(ids).not.toContain('d2');
    for (const row of table.rows) expect(row.cells).toHaveLength(table.columns.length);
  });
});
