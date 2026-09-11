/**
 * Cross-surface parity matrix (#754, epic #755).
 *
 * Three representative matrix modes travel from one DirectorState through
 * Director columns, the canonical snapshot, printable HTML, CSV/JSON exports,
 * and QBLive tables. Canonical numerators live in the domain goldens
 * (`parityMatrix.test.ts`); this file proves every surface renders the same
 * values, honors the same unknowns, and changes row widths only through the
 * shared applicability gates. Hermetic: fixed timestamps, no network.
 */
import { describe, expect, test } from 'vitest';
import {
  buildPlayerStatisticsTable,
  buildStandingsTable,
  buildTeamStatisticsTable,
} from '@qbsheet/qblive-projection';
import {
  defaultRules,
  derivePlayerStandings,
  deriveTeamStandings,
  emptyDirectorState,
  type DirectorState,
  type GameRecord,
  type TeamGameScore,
} from '@qbsheet/tournament-domain';
import {
  buildExtendedStatReportBundle,
  defaultReportOptions,
  deriveRoundStats,
  exportStatsCsv,
  exportStatsJson,
  type ReportOptions,
} from '@qbsheet/tournament-formats';
import { buildCanonicalSnapshot } from '../src/director/reports/canonicalReports';
import { withReportPresentation } from '../src/director/reports/reportPresentation';
import { playerStatCell, teamStatCell } from '../src/director/standings/statsDisplay';

const POINTS_TOSSUPS = 20;

/** The real export flow: presentation first, then the page bundle. */
function presentedBundle(state: DirectorState, options?: ReportOptions) {
  const snapshot = withReportPresentation(
    state,
    buildCanonicalSnapshot(state, undefined, at),
    options ?? defaultReportOptions,
  );
  return buildExtendedStatReportBundle(snapshot);
}

/** Presentation applied the way downloads apply it, for JSON assertions. */
function presentedSnapshot(state: DirectorState, options?: ReportOptions) {
  return withReportPresentation(
    state,
    buildCanonicalSnapshot(state, undefined, at),
    options ?? defaultReportOptions,
  );
}

const at = '2026-09-09T12:00:00.000Z';

function teamScore(teamId: string, score: number, detail: Partial<TeamGameScore> = {}): TeamGameScore {
  return {
    teamId,
    score,
    superpowers: 0,
    powers: 0,
    gets: 0,
    negs: 0,
    bonuses: 0,
    bonusPoints: 0,
    bouncebacks: 0,
    ...detail,
  };
}

function matrixState(
  games: GameRecord[],
  rules: typeof defaultRules,
  players: DirectorState['players'] = [],
  gameDefinitions: DirectorState['gameDefinitions'] = [],
): DirectorState {
  const state = emptyDirectorState();
  state.tournament = {
    id: 't',
    name: 'Cross-surface matrix',
    date: '2026-09-09',
    venue: '',
    organizer: '',
    status: 'running',
    timeZone: 'America/New_York',
    rules: structuredClone(rules),
    formatId: null,
    currentPhaseId: 'phase-1',
    currentPacketId: null,
    currentRoundId: null,
    createdAt: at,
    updatedAt: at,
  };
  const teamIds = [...new Set(games.flatMap((entry) => entry.scores.map((score) => score.teamId)))];
  state.teams = teamIds.map((id) => ({
    id,
    organizationId: null,
    displayName: id.toUpperCase(),
    teamLetter: 'A',
    seed: null,
    status: 'confirmed' as const,
    createdAt: at,
    updatedAt: at,
  }));
  state.players = players;
  state.gameDefinitions = gameDefinitions;
  state.rounds = [
    {
      id: 'round-1',
      phaseId: 'phase-1',
      name: 'Round 1',
      number: 1,
      revision: 1,
      status: 'closed',
      packetId: 'packet-1',
      scheduledGameIds: games.map((entry) => entry.scheduledGameId),
      dayOrder: 0,
      scheduledStart: null,
      releasedAt: null,
      startedAt: null,
      closedAt: null,
    },
  ];
  state.scheduledGames = games.map((entry) => ({
    id: entry.scheduledGameId,
    roundId: 'round-1',
    roomId: null,
    packetId: 'packet-1',
    leftTeamId: entry.scores[0]!.teamId,
    rightTeamId: entry.scores[1]!.teamId,
    bye: false,
    status: 'accepted' as const,
    assignmentRevision: 1,
  }));
  state.games = games;
  return state;
}

function acceptedGame(
  id: string,
  scores: [TeamGameScore, TeamGameScore],
  extra: Partial<GameRecord> = {},
): GameRecord {
  return {
    id,
    scheduledGameId: `s-${id}`,
    roundId: 'round-1',
    packetId: 'packet-1',
    status: 'accepted',
    scores,
    playerStats: [],
    source: 'manual',
    detailedStats: 'complete',
    tossupsRead: 20,
    ...extra,
  } as GameRecord;
}

/** Regular bouncebacks + lightning + a substitute with metadata. */
function richMode(): DirectorState {
  return matrixState(
    [
      acceptedGame(
        'g1',
        [
          teamScore('a', 350, {
            powers: 2,
            gets: 8,
            negs: 1,
            bonuses: 10,
            bonusPoints: 200,
            bouncebacks: 30,
            lightningPoints: 40,
          }),
          teamScore('b', 200, {
            powers: 1,
            gets: 7,
            negs: 2,
            bonuses: 8,
            bonusPoints: 150,
            bouncebacks: 0,
            lightningPoints: 10,
          }),
        ],
        {
          // No overtime was played: the recorded zero keeps regulation scoring known.
          overtimeTossupsRead: 0,
          playerStats: [
            {
              playerId: 'a1',
              teamId: 'a',
              superpowers: 0,
              powers: 2,
              gets: 5,
              negs: 1,
              bonusPoints: 0,
              tossupsHeard: 20,
            },
            {
              playerId: 'a2',
              teamId: 'a',
              superpowers: 0,
              powers: 0,
              gets: 3,
              negs: 0,
              bonusPoints: 0,
              tossupsHeard: 10,
            },
          ],
        },
      ),
    ],
    { ...defaultRules, bouncebacks: true, lightning: true },
    [
      {
        id: 'a1',
        teamId: 'a',
        name: 'A. One',
        captain: true,
        active: true,
        schoolYear: 12,
        undergraduateEligible: false,
        divisionTwoEligible: false,
      },
      {
        id: 'a2',
        teamId: 'a',
        name: 'A. Two',
        captain: false,
        active: true,
        schoolYear: 10,
        undergraduateEligible: true,
        divisionTwoEligible: true,
      },
    ],
  );
}

/**
 * Mixed history: game-1 plays bouncebacks and lightning; game-2's pinned
 * definition plays neither (scorer-exported bounceback zeroes, no lightning
 * field). Current tournament rules match game-2, proving history governs.
 */
function mixedNaMode(): DirectorState {
  const on = { ...defaultRules, bouncebacks: true, lightning: true };
  const off = { ...defaultRules };
  const games = [
    acceptedGame(
      'g1',
      [
        teamScore('a', 350, {
          powers: 2,
          gets: 8,
          negs: 1,
          bonuses: 10,
          bonusPoints: 200,
          bouncebacks: 30,
          lightningPoints: 40,
        }),
        teamScore('b', 200, {
          powers: 1,
          gets: 7,
          negs: 2,
          bonuses: 8,
          bonusPoints: 150,
          bouncebacks: 0,
          lightningPoints: 30,
        }),
      ],
      { definitionDigest: 'mixed-on', overtimeTossupsRead: 0 },
    ),
    acceptedGame(
      'g2',
      [
        teamScore('a', 300, { powers: 2, gets: 8, negs: 1, bonuses: 10, bonusPoints: 180, bouncebacks: 0 }),
        teamScore('b', 150, { powers: 1, gets: 4, negs: 2, bonuses: 5, bonusPoints: 60, bouncebacks: 0 }),
      ],
      { definitionDigest: 'mixed-off', overtimeTossupsRead: 0 },
    ),
  ];
  const definition = (digest: string, scheduledGameId: string, rules: typeof defaultRules) => ({
    id: `def-${digest}`,
    scheduledGameId,
    revision: 1,
    createdAt: at,
    rules: structuredClone(rules),
    roundId: 'round-1',
    packetId: 'packet-1',
    leftTeamId: 'a',
    rightTeamId: 'b',
    leftRoster: [],
    rightRoster: [],
    assignmentRevision: 1,
    digest,
  });
  return matrixState(
    games,
    off,
    [],
    [definition('mixed-on', 's-g1', on), definition('mixed-off', 's-g2', off)],
  );
}

/** Overtime with a known 30/10 split over 2 of 20 tossups. */
function overtimeKnownMode(): DirectorState {
  return matrixState(
    [
      acceptedGame(
        'g1',
        [
          teamScore('a', 330, {
            powers: 4,
            gets: 8,
            negs: 1,
            bonuses: 12,
            bonusPoints: 130,
            overtimePoints: 30,
          }),
          teamScore('b', 120, {
            powers: 1,
            gets: 5,
            negs: 2,
            bonuses: 6,
            bonusPoints: 40,
            overtimePoints: 10,
          }),
        ],
        { overtimeTossupsRead: 2 },
      ),
    ],
    { ...defaultRules },
  );
}

/** Overtime-capable but untracked: regulation scoring must decline everywhere. */
function overtimeUnknownMode(): DirectorState {
  return matrixState(
    [
      acceptedGame('g1', [teamScore('a', 330, { powers: 4, gets: 8, negs: 1 }), teamScore('b', 120)], {
        overtimeTossupsRead: 2,
      }),
    ],
    { ...defaultRules },
  );
}

/** Score-only partial: unknowns everywhere detail is required. */
function partialMode(): DirectorState {
  return matrixState(
    [
      acceptedGame(
        'g1',
        [teamScore('a', 250, { bouncebacks: null }), teamScore('b', 240, { bouncebacks: null })],
        { detailedStats: 'unknown', tossupsRead: null },
      ),
    ],
    { ...defaultRules },
  );
}

const naming = {
  teamName: (teamId: string) => teamId.toUpperCase(),
  playerName: (playerId: string) => playerId,
  playerMeta: (playerId: string) => {
    const player = richMode().players.find((entry) => entry.id === playerId);
    if (!player) return null;
    return {
      schoolYear: player.schoolYear ?? null,
      undergraduateEligible: player.undergraduateEligible ?? null,
      divisionTwoEligible: player.divisionTwoEligible ?? null,
    };
  },
};
const scope = { id: 'overall', label: 'Overall' };

function cellText(
  table: { columns: Array<{ id: string }>; rows: Array<{ cells: Array<{ display?: string }> }> },
  row: number,
  columnId: string,
) {
  const index = table.columns.findIndex((column) => column.id === columnId);
  expect(index).toBeGreaterThanOrEqual(0);
  return table.rows[row]!.cells[index]!.display;
}

describe('cross-surface parity matrix', () => {
  test('rich mode: Director, print, CSV/JSON, and QBLive agree', () => {
    const state = richMode();
    const snapshot = buildCanonicalSnapshot(state, undefined, at);
    const team = deriveTeamStandings(state, undefined, {}).find((entry) => entry.teamId === 'a')!;
    expect(teamStatCell('bbconv', team)).toBe('33.3%');
    expect(teamStatCell('lightning', team)).toBe('40');

    const pages = presentedBundle(state);
    const standings = pages.find((entry) => entry.name === 'standings.html')!.content;
    expect(standings).toContain('BB %');
    expect(standings).toContain('33.3%');
    expect(standings).toContain('Lightning');
    const detail = pages.find((entry) => entry.name === 'teamdetail.html')!.content;
    expect(detail).toContain('BB parts heard');
    expect(detail).toContain('33.3%');

    const csv = exportStatsCsv(snapshot, 'teams');
    expect(csv).toContain('bounceback_conversion_pct');
    expect(csv).toContain('lightning_points');
    const parsed = JSON.parse(exportStatsJson(snapshot, false));
    expect(parsed.teams.find((entry: { teamId: string }) => entry.teamId === 'a')).toMatchObject({
      bouncebackPoints: 30,
      lightningPoints: 40,
    });

    const live = buildStandingsTable(state, scope, naming);
    expect(live.columns.map((column) => column.id)).toEqual(
      expect.arrayContaining(['bb', 'bbheard', 'bbconv', 'totalbonus', 'lightning', 'lightningpg']),
    );
    expect(cellText(live, 0, 'bbconv')).toBe('33.3%');
    expect(cellText(live, 0, 'lightning')).toBe('40');
    const individuals = buildPlayerStatisticsTable(state, scope, naming);
    expect(individuals.columns.map((column) => column.id)).toEqual(
      expect.arrayContaining(['rank', 'year', 'ug', 'd2', 'pptuh']),
    );
    const a2 = individuals.rows.find((row) => row.playerId === 'a2')!;
    const games = individuals.columns.findIndex((column) => column.id === 'games');
    expect(a2.cells[games]).toEqual({ value: 0.5, display: '0.50' });
    const player = state.players.find((entry) => entry.id === 'a2')!;
    const playerStanding = derivePlayerStandings(state, {}).find((entry) => entry.playerId === 'a2')!;
    expect(playerStanding.gamesPlayed).toBe(0.5);
    expect(playerStatCell('year', playerStanding, player)).toBe('Grade 10');
    expect(playerStatCell('ug', playerStanding, player)).toBe('Yes');

    // Individuals: Director player Pts/X (PPTUH × X) matches the printable individuals page.
    const a1 = derivePlayerStandings(state, {}).find((entry) => entry.playerId === 'a1')!;
    expect(playerStatCell('ppx', a1, undefined, { pointsTossups: POINTS_TOSSUPS })).toBe('75.00');
    const metricPages = presentedBundle(state, { ...defaultReportOptions, pointsMetric: 'pointsPerX' });
    const individualsPage = metricPages.find((entry) => entry.name === 'individuals.html')!.content;
    expect(individualsPage).toContain('75.00');
  });

  test('partial mode: every surface renders unknowns, never zeroes', () => {
    const state = partialMode();
    const snapshot = buildCanonicalSnapshot(state, undefined, at);
    expect(snapshot.teams.find((entry) => entry.teamId === 'a')!.tossupsHeard).toBeNull();
    const team = deriveTeamStandings(state, undefined, {}).find((entry) => entry.teamId === 'a')!;
    expect(teamStatCell('pptuh', team)).toBe('—');
    expect(teamStatCell('bbconv', team)).toBe('—');

    const pages = presentedBundle(state);
    const standings = pages.find((entry) => entry.name === 'standings.html')!.content;
    expect(standings).toContain('—');

    const live = buildStandingsTable(state, scope, naming);
    expect(cellText(live, 0, 'pptuh')).toBe('—');
    expect(cellText(live, 0, 'tuh')).toBe('—');
  });

  test('mixed N/A history: the off game stays out of every surface', () => {
    const state = mixedNaMode();
    // Canonical: game-2 contributes W/L but no bounceback/lightning facts.
    const team = deriveTeamStandings(state, undefined, {}).find((entry) => entry.teamId === 'a')!;
    expect(team).toMatchObject({
      gamesPlayed: 2,
      bouncebacksKnown: true,
      bouncebackPoints: 30,
      lightningKnown: true,
      lightningPoints: 40,
    });
    expect(teamStatCell('bbconv', team)).toBe('33.3%');
    expect(teamStatCell('lightning', team)).toBe('40');
    expect(teamStatCell('lightningpg', team)).toBe('40.0');
    // 650 regulation points over 40 regulation TUH, scaled to 20.
    expect(teamStatCell('ppx', team, { pointsTossups: 20 })).toBe('325.00');

    // Printable: same values, same rounding, no em dashes for N/A games.
    const pages = presentedBundle(state, { ...defaultReportOptions, pointsMetric: 'pointsPerX' });
    const standings = pages.find((entry) => entry.name === 'standings.html')!.content;
    expect(standings).toContain('33.3%');
    expect(standings).toContain('325.00');
    const detail = pages.find((entry) => entry.name === 'teamdetail.html')!.content;
    expect(detail).toContain('BB parts heard');

    // Round aggregate: 9 + 10 parts heard, 3 converted; 40 + 30 lightning at 35.0/team/game.
    const snapshot = buildCanonicalSnapshot(state, undefined, at);
    const rounds = deriveRoundStats(snapshot.games);
    expect(rounds.rows[0]).toMatchObject({
      bouncebackPartsHeard: 19,
      bouncebackPartsConverted: 3,
      lightningPoints: 70,
      lightningRate: 35,
    });

    // CSV/JSON: honest knowns, never null-poisoned by the N/A game.
    const csv = exportStatsCsv(snapshot, 'teams');
    expect(csv).toContain('bounceback_conversion_pct');
    expect(csv).toContain('33.3%');
    expect(csv).toContain('lightning_points');
    const presented = presentedSnapshot(state);
    const parsed = JSON.parse(exportStatsJson(presented, false));
    expect(parsed.teams.find((entry: { teamId: string }) => entry.teamId === 'a')).toMatchObject({
      bouncebackPoints: 30,
      bouncebackPartsHeard: 9,
      lightningPoints: 40,
      pointsPerX: 325,
    });

    // QBLive: identical values and rounding to Director and print.
    const live = buildStandingsTable(state, scope, naming);
    expect(live.columns.map((column) => column.id)).toEqual(expect.arrayContaining(['ppx']));
    expect(cellText(live, 0, 'bbconv')).toBe('33.3%');
    expect(cellText(live, 0, 'lightning')).toBe('40');
    expect(cellText(live, 0, 'lightningpg')).toBe('40.0');
    expect(cellText(live, 0, 'ppx')).toBe('325.00');
    const teamStats = buildTeamStatisticsTable(state, scope, naming);
    expect(cellText(teamStats, 0, 'ppx')).toBe('325.00');
  });

  test('overtime known split: Pts/X excludes overtime on every surface', () => {
    const state = overtimeKnownMode();
    const team = deriveTeamStandings(state, undefined, {}).find((entry) => entry.teamId === 'a')!;
    // 330 total minus 30 overtime over 18 regulation TUH, scaled to 20.
    expect(teamStatCell('ppx', team, { pointsTossups: 20 })).toBe('333.33');

    const pages = presentedBundle(state, { ...defaultReportOptions, pointsMetric: 'pointsPerX' });
    expect(pages.find((entry) => entry.name === 'standings.html')!.content).toContain('333.33');

    const parsed = JSON.parse(exportStatsJson(presentedSnapshot(state), false));
    const jsonTeam = parsed.teams.find((entry: { teamId: string }) => entry.teamId === 'a');
    expect(jsonTeam).toMatchObject({ regulationPoints: 300 });
    expect(jsonTeam.pointsPerX).toBeCloseTo((300 / 18) * 20, 12);

    const live = buildStandingsTable(state, scope, naming);
    expect(cellText(live, 0, 'ppx')).toBe('333.33');
  });

  test('overtime unknown split: Pts/X declines on every surface, PPTUH stands', () => {
    const state = overtimeUnknownMode();
    const team = deriveTeamStandings(state, undefined, {}).find((entry) => entry.teamId === 'a')!;
    expect(teamStatCell('ppx', team, { pointsTossups: 20 })).toBe('—');
    expect(teamStatCell('pptuh', team)).not.toBe('—');

    const pages = presentedBundle(state, { ...defaultReportOptions, pointsMetric: 'pointsPerX' });
    expect(pages.find((entry) => entry.name === 'standings.html')!.content).toContain('—');

    const parsed = JSON.parse(exportStatsJson(presentedSnapshot(state), false));
    expect(parsed.teams.find((entry: { teamId: string }) => entry.teamId === 'a')!.pointsPerX).toBeNull();

    const live = buildStandingsTable(state, scope, naming);
    expect(live.columns.map((column) => column.id)).toContain('ppx');
    expect(cellText(live, 0, 'ppx')).toBe('—');
    expect(cellText(live, 0, 'pptuh')).not.toBe('—');
  });
});
