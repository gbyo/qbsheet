import { describe, expect, test } from 'vitest';
import {
  buildRoundAwareStatReportBundle,
  deriveRoundStats,
  type GameStatsRow,
  type GameTeamStatsRow,
  type RoundStatDefinition,
  type StatsSnapshot,
} from '../src/index';

const baseDefinition: RoundStatDefinition = {
  regulationTossups: 20,
  regulationLengthFixed: true,
  overtimeEnabled: false,
  powers: true,
  superpowers: false,
  bonuses: true,
  maximumBonusScore: 30,
  source: 'game',
};

function team(teamId: string, points: number, values: Partial<GameTeamStatsRow> = {}): GameTeamStatsRow {
  return {
    teamId,
    teamName: teamId,
    points,
    superpowers: 0,
    powers: 0,
    gets: 0,
    negs: 0,
    tossupsHeard: null,
    bonusesHeard: 0,
    bonusPoints: 0,
    ppb: null,
    bouncebacks: 0,
    ...values,
  };
}

function game(options: {
  id: string;
  round?: string;
  roundName?: string;
  phaseId?: string;
  phaseName?: string;
  packetName?: string;
  leftPoints?: number;
  rightPoints?: number;
  tossupsRead?: number | null;
  left?: Partial<GameTeamStatsRow>;
  right?: Partial<GameTeamStatsRow>;
  definition?: Partial<RoundStatDefinition>;
  status?: string;
  forfeitedTeamId?: string;
  detail?: string;
}): GameStatsRow {
  const leftPoints = options.leftPoints ?? 300;
  const rightPoints = options.rightPoints ?? 200;
  const definition = { ...baseDefinition, ...options.definition };
  const left = team('A', leftPoints, options.left);
  const right = team('B', rightPoints, options.right);
  return {
    gameId: options.id,
    roundId: options.round ?? 'round-1',
    roundName: options.roundName ?? 'Round 1',
    phaseId: options.phaseId ?? 'phase-1',
    phaseName: options.phaseName ?? 'Preliminary',
    packetName: options.packetName,
    teamOneId: 'A',
    teamOneName: 'A',
    teamOnePoints: leftPoints,
    teamTwoId: 'B',
    teamTwoName: 'B',
    teamTwoPoints: rightPoints,
    status: options.status ?? 'accepted',
    detail: options.detail ?? 'complete',
    tossupsRead: options.tossupsRead === undefined ? definition.regulationTossups : options.tossupsRead,
    teamStats: [left, right],
    roundStatDefinition: definition,
    ...(options.forfeitedTeamId ? { forfeitedTeamId: options.forfeitedTeamId } : {}),
  };
}

function standardGames(): GameStatsRow[] {
  return [
    game({
      id: 'g1',
      packetName: 'Packet 1',
      leftPoints: 300,
      rightPoints: 200,
      left: { powers: 2, gets: 8, negs: 1, bonusesHeard: 10, bonusPoints: 180 },
      right: { powers: 1, gets: 7, negs: 2, bonusesHeard: 8, bonusPoints: 150 },
    }),
    game({
      id: 'g2',
      packetName: 'Packet 1',
      leftPoints: 250,
      rightPoints: 150,
      left: { powers: 1, gets: 6, negs: 1, bonusesHeard: 7, bonusPoints: 120 },
      right: { powers: 0, gets: 5, negs: 1, bonusesHeard: 5, bonusPoints: 80 },
    }),
  ];
}

function snapshot(games: GameStatsRow[]): StatsSnapshot {
  return {
    format: 'qbsheet-stats',
    version: 1,
    generatedAt: '2026-09-09T20:00:00.000Z',
    tournament: { id: 'tournament', name: 'Round Report Test' },
    teams: [],
    players: [],
    games,
    extensions: { scopeLabel: 'Overall' },
  };
}

describe('deriveRoundStats', () => {
  test('hand-checks the standard round formulas', () => {
    const report = deriveRoundStats(standardGames());
    expect(report.rows).toHaveLength(1);
    const row = report.rows[0]!;
    expect(row).toMatchObject({
      roundId: 'round-1',
      roundName: 'Round 1',
      phaseName: 'Preliminary',
      packetName: 'Packet 1',
      games: 2,
      results: 2,
      teams: 2,
      regulationTossups: 20,
      tossupsRead: 40,
      detailGames: 2,
      partial: false,
    });
    // Average normalized team score: ((300+200)/2 + (250+150)/2) / 2.
    expect(row.pointsPerTeamPerXTuh).toBeCloseTo(225);
    // 30 positive conversions over 40 tossups read.
    expect(row.tossupConversionRate).toBeCloseTo(30 / 40);
    // 4 powers among the same 30 positive conversions.
    expect(row.powerRate).toBeCloseTo(4 / 30);
    // 5 negs per 40 tossups, normalized to 20.
    expect(row.negRatePerXTuh).toBeCloseTo((5 / 40) * 20);
    // 530 bonus points on 30 bonuses heard.
    expect(row.ppb).toBeCloseTo(530 / 30);
    expect(row.bonusConversionRate).toBeCloseTo(530 / (30 * 30));
  });

  test('recomputes weighted tournament totals instead of averaging round rates', () => {
    const roundOne = game({
      id: 'weighted-1',
      round: 'r1',
      roundName: 'Round 1',
      left: { powers: 1, gets: 4, bonusesHeard: 1, bonusPoints: 30 },
      right: { gets: 4, bonusesHeard: 1, bonusPoints: 30 },
    });
    const roundTwoA = game({
      id: 'weighted-2a',
      round: 'r2',
      roundName: 'Round 2',
      left: { powers: 1, gets: 4, bonusesHeard: 5, bonusPoints: 50 },
      right: { gets: 4, bonusesHeard: 5, bonusPoints: 50 },
    });
    const roundTwoB = game({
      id: 'weighted-2b',
      round: 'r2',
      roundName: 'Round 2',
      left: { gets: 5, bonusesHeard: 5, bonusPoints: 50 },
      right: { gets: 4, bonusesHeard: 5, bonusPoints: 50 },
    });
    const report = deriveRoundStats([roundOne, roundTwoA, roundTwoB]);
    expect(report.rows[0]!.ppb).toBeCloseTo(30);
    expect(report.rows[1]!.ppb).toBeCloseTo(10);
    expect(report.total.ppb).toBeCloseTo(260 / 22);
    expect(report.total.ppb).not.toBeCloseTo((30 + 10) / 2);
  });

  test('declines whole-round ratios when one included game lacks required detail', () => {
    const complete = standardGames()[0]!;
    const partial = game({
      id: 'partial',
      detail: 'partial',
      leftPoints: 240,
      rightPoints: 180,
      left: { powers: null, gets: null, negs: null, bonusesHeard: null, bonusPoints: null },
      right: { powers: null, gets: null, negs: null, bonusesHeard: null, bonusPoints: null },
    });
    const row = deriveRoundStats([complete, partial]).rows[0]!;
    // Score and exact TU counts are still known, so normalized points remain honest.
    expect(row.pointsPerTeamPerXTuh).not.toBeNull();
    expect(row.tossupConversionRate).toBeNull();
    expect(row.powerRate).toBeNull();
    expect(row.negRatePerXTuh).toBeNull();
    expect(row.ppb).toBeNull();
    expect(row.partial).toBe(true);
  });

  test('counts a pure forfeit as a result but not as a played-stat denominator', () => {
    const played = standardGames()[0]!;
    const forfeit = game({
      id: 'forfeit',
      status: 'forfeit',
      forfeitedTeamId: 'B',
      leftPoints: 0,
      rightPoints: 0,
      tossupsRead: null,
      left: { powers: 0, gets: 0, negs: 0, bonusesHeard: 0, bonusPoints: 0 },
      right: { powers: 0, gets: 0, negs: 0, bonusesHeard: 0, bonusPoints: 0 },
    });
    const row = deriveRoundStats([played, forfeit]).rows[0]!;
    expect(row.results).toBe(2);
    expect(row.games).toBe(1);
    expect(row.excludedForfeits).toBe(1);
    expect(row.ppb).toBeCloseTo(330 / 18);
  });

  test('uses a custom regulation X instead of hard-coding 20', () => {
    const row = deriveRoundStats([
      game({
        id: 'eighteen',
        definition: { regulationTossups: 18 },
        tossupsRead: 18,
        leftPoints: 180,
        rightPoints: 90,
        left: { powers: 1, gets: 6, negs: 1, bonusesHeard: 5, bonusPoints: 80 },
        right: { gets: 5, negs: 1, bonusesHeard: 4, bonusPoints: 60 },
      }),
    ]).rows[0]!;
    expect(row.regulationTossups).toBe(18);
    expect(row.pointsPerTeamPerXTuh).toBeCloseTo(135);
    expect(row.negRatePerXTuh).toBeCloseTo(2);
  });

  test('marks per-X metrics unavailable for incompatible definitions within a round', () => {
    const eighteen = game({
      id: 'mixed-18',
      definition: { regulationTossups: 18 },
      tossupsRead: 18,
      left: { powers: 1, gets: 5, bonusesHeard: 4, bonusPoints: 60 },
      right: { gets: 5, bonusesHeard: 4, bonusPoints: 60 },
    });
    const twenty = game({
      id: 'mixed-20',
      definition: { regulationTossups: 20 },
      tossupsRead: 20,
      left: { powers: 1, gets: 6, bonusesHeard: 5, bonusPoints: 80 },
      right: { gets: 6, bonusesHeard: 5, bonusPoints: 80 },
    });
    const row = deriveRoundStats([eighteen, twenty]).rows[0]!;
    expect(row.regulationTossups).toBeNull();
    expect(row.pointsPerTeamPerXTuh).toBeNull();
    expect(row.negRatePerXTuh).toBeNull();
    // Definition-independent weighted metrics remain valid.
    expect(row.tossupConversionRate).not.toBeNull();
    expect(row.powerRate).not.toBeNull();
    expect(row.ppb).not.toBeNull();
  });

  test('uses each game maximum bonus value for overall bonus conversion', () => {
    const thirty = game({
      id: 'bonus-30',
      left: { bonusesHeard: 1, bonusPoints: 30 },
      right: { bonusesHeard: 1, bonusPoints: 0 },
    });
    const twenty = game({
      id: 'bonus-20',
      definition: { maximumBonusScore: 20 },
      left: { bonusesHeard: 2, bonusPoints: 20 },
      right: { bonusesHeard: 2, bonusPoints: 20 },
    });
    const report = deriveRoundStats([thirty, twenty]);
    expect(report.total.bonusConversionRate).toBeCloseTo(70 / (2 * 30 + 4 * 20));
  });

  test('represents packet disagreement honestly and suppresses Stage for one stage', () => {
    const samePacket = deriveRoundStats(standardGames());
    expect(samePacket.rows[0]!.packetName).toBe('Packet 1');
    expect(samePacket.showPhase).toBe(false);

    const mixed = deriveRoundStats([
      game({ id: 'packet-a', packetName: 'Packet A' }),
      game({ id: 'packet-b', packetName: 'Packet B' }),
    ]);
    expect(mixed.rows[0]!.packetName).toBe('Mixed');
    expect(mixed.rows[0]!.packetMixed).toBe(true);

    const multipleStages = deriveRoundStats([
      game({ id: 'stage-a', round: 'r1', phaseId: 'p1', phaseName: 'Preliminary' }),
      game({ id: 'stage-b', round: 'r2', roundName: 'Round 2', phaseId: 'p2', phaseName: 'Playoff' }),
    ]);
    expect(multipleStages.showPhase).toBe(true);
  });

  test('deduplicates the same canonical game identity before scope totals', () => {
    const one = standardGames()[0]!;
    const report = deriveRoundStats([one, one]);
    expect(report.rows[0]!.results).toBe(1);
    expect(report.total.games).toBe(1);
  });
});

describe('printable Round Report', () => {
  test('replaces grouped score lists with a linked statistical table and weighted footer', () => {
    const games = standardGames();
    const pages = buildRoundAwareStatReportBundle(snapshot(games));
    const rounds = pages.find((page) => page.name === 'rounds.html')!.content;
    const scoreboard = pages.find((page) => page.name === 'games.html')!.content;

    expect(rounds).toContain('<caption>Round statistics</caption>');
    expect(rounds).toContain('Pts/team/X TUH');
    expect(rounds).toContain('TU Conv %');
    expect(rounds).toContain('Power %');
    expect(rounds).toContain('Negs/X');
    expect(rounds).toContain('PPB');
    expect(rounds).toContain('<tfoot><tr><th scope="row">Overall</th>');
    expect(rounds).toContain('href="games.html#round-round-1"');
    expect(rounds).not.toContain('<section aria-label="Round 1"><h2>Round 1</h2>');
    expect(rounds).toContain('does not report a known-subset value');
    expect(scoreboard).toContain('id="round-round-1"');
  });

  test('omits irrelevant Stage and bonus columns and renders unknowns as em dashes', () => {
    const tossupOnly = game({
      id: 'tu-only',
      definition: { bonuses: false, maximumBonusScore: null },
      left: { bonusesHeard: null, bonusPoints: null },
      right: { bonusesHeard: null, bonusPoints: null },
    });
    const pages = buildRoundAwareStatReportBundle(snapshot([tossupOnly]));
    const rounds = pages.find((page) => page.name === 'rounds.html')!.content;
    expect(rounds).not.toContain('<th scope="col">Stage</th>');
    expect(rounds).not.toContain('>PPB</abbr>');
    expect(rounds).not.toContain('Bonus Conv %');

    const partial = game({
      id: 'unknowns',
      detail: 'partial',
      left: { powers: null, gets: null, negs: null, bonusesHeard: null, bonusPoints: null },
      right: { powers: null, gets: null, negs: null, bonusesHeard: null, bonusPoints: null },
    });
    const partialRounds = buildRoundAwareStatReportBundle(snapshot([partial])).find(
      (page) => page.name === 'rounds.html',
    )!.content;
    expect(partialRounds).toContain('>—</td>');
  });
});
