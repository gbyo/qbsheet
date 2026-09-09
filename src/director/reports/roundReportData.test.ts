import { describe, expect, test } from 'vitest';
import {
  defaultRules,
  emptyDirectorState,
  type DirectorState,
  type GameRecord,
  type TeamGameScore,
} from '../domain';
import { deriveRoundReportData } from './roundReportData';

const at = '2026-09-09T12:00:00.000Z';

function score(
  teamId: string,
  points: number,
  detail: Partial<TeamGameScore> = {},
): TeamGameScore {
  return {
    teamId,
    score: points,
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

interface RawOptions {
  x?: number;
  tossupsRead?: number;
  powers?: [number, number];
  gets?: [number, number];
  negs?: [number, number];
  superpowers?: [number, number];
  bonuses?: boolean;
  bouncebacks?: boolean;
  lightning?: boolean;
  lightningPoints?: [number, number];
}

function rawQbj(options: RawOptions = {}): unknown {
  const x = options.x ?? 20;
  const power = options.powers ?? [0, 0];
  const get = options.gets ?? [8, 8];
  const neg = options.negs ?? [0, 0];
  const superpower = options.superpowers ?? [0, 0];
  const answerTypes = [
    ...(superpower.some((count) => count > 0)
      ? [{ type: 'AnswerType', id: 'superpower', label: 'Superpower', value: 20, awards_bonus: true }]
      : []),
    ...(power.some((count) => count > 0)
      ? [{ type: 'AnswerType', id: 'power', label: 'Power', value: 15, awards_bonus: true }]
      : []),
    { type: 'AnswerType', id: 'get', label: 'Correct', value: 10, awards_bonus: true },
    { type: 'AnswerType', id: 'neg', label: 'Neg', value: -5, awards_bonus: false },
  ];
  const answerCounts = (side: 0 | 1) => [
    ...(superpower[side] > 0
      ? [{ number: superpower[side], answer_type: { id: 'superpower', value: 20, label: 'Superpower' } }]
      : []),
    ...(power[side] > 0
      ? [{ number: power[side], answer_type: { id: 'power', value: 15, label: 'Power' } }]
      : []),
    ...(get[side] > 0 ? [{ number: get[side], answer_type: { id: 'get', value: 10 } }] : []),
    ...(neg[side] > 0 ? [{ number: neg[side], answer_type: { id: 'neg', value: -5 } }] : []),
  ];
  const bonuses = options.bonuses !== false;
  return {
    version: '2.2.0',
    objects: [
      {
        type: 'ScoringRules',
        id: 'rules',
        regulation_tossup_count: x,
        maximum_regulation_tossup_count: x,
        answer_types: answerTypes,
        ...(bonuses
          ? {
              maximum_bonus_score: 30,
              bonus_divisor: 10,
              minimum_parts_per_bonus: 3,
              maximum_parts_per_bonus: 3,
              bonuses_bounce_back: options.bouncebacks === true,
            }
          : {}),
        ...(options.lightning
          ? { lightning_count_per_team: 1, lightning_divisor: 10 }
          : {}),
      },
      {
        type: 'Match',
        id: 'match',
        tossups_read: options.tossupsRead ?? x,
        match_teams: [0, 1].map((side) => ({
          team: { id: `team-${side + 1}` },
          lightning_points: options.lightningPoints?.[side as 0 | 1] ?? 0,
          match_players: [
            {
              player: { id: `player-${side + 1}` },
              answer_counts: answerCounts(side as 0 | 1),
            },
          ],
        })),
      },
    ],
  };
}

function game(
  id: string,
  roundId: string,
  scores: TeamGameScore[],
  raw: unknown | null,
  extra: Partial<GameRecord> = {},
): GameRecord {
  return {
    id,
    scheduledGameId: `scheduled-${id}`,
    roundId,
    packetId: null,
    status: 'accepted',
    scores,
    playerStats: [],
    source: 'qbtcp',
    detailedStats: 'complete',
    rawQbj: raw ?? undefined,
    acceptedAt: at,
    ...extra,
  };
}

function baseState(): DirectorState {
  const state = emptyDirectorState();
  state.tournament = {
    id: 'tournament',
    name: 'Round report test',
    date: '2026-09-09',
    venue: 'Test hall',
    organizer: 'QBSheet',
    status: 'running',
    timeZone: 'UTC',
    rules: structuredClone(defaultRules),
    formatId: null,
    currentPhaseId: 'phase-prelims',
    currentPacketId: null,
    currentRoundId: 'round-1',
    createdAt: at,
    updatedAt: at,
  };
  state.phases = [
    {
      id: 'phase-prelims',
      name: 'Preliminary',
      kind: 'preliminary',
      order: 1,
      formatId: 'format',
      poolIds: [],
      roundIds: ['round-1', 'round-2'],
      advancementRule: null,
      carryover: false,
      status: 'active',
    },
    {
      id: 'phase-playoffs',
      name: 'Playoffs',
      kind: 'playoff',
      order: 2,
      formatId: 'format',
      poolIds: [],
      roundIds: ['round-3'],
      advancementRule: null,
      carryover: false,
      status: 'planned',
    },
  ];
  state.rounds = [
    ['round-1', 'phase-prelims', 'Round 1', 1],
    ['round-2', 'phase-prelims', 'Round 2', 2],
    ['round-3', 'phase-playoffs', 'Final', 3],
  ].map(([id, phaseId, name, number]) => ({
    id: id as string,
    phaseId: phaseId as string,
    name: name as string,
    number: number as number,
    revision: 1,
    status: 'closed' as const,
    packetId: null,
    scheduledGameIds: [],
    dayOrder: number as number,
    scheduledStart: null,
    releasedAt: at,
    startedAt: at,
    closedAt: at,
  }));
  state.packets = [
    { id: 'packet-1', name: 'Packet 1', source: '', version: '', status: 'available', notes: '' },
    { id: 'packet-2', name: 'Packet 2', source: '', version: '', status: 'available', notes: '' },
  ];
  return state;
}

describe('canonical round report data', () => {
  test('hand-checks base metrics and recomputes weighted totals from game numerators', () => {
    const state = baseState();
    const r1a = game(
      'r1-a',
      'round-1',
      [
        score('team-1', 300, { powers: 3, gets: 7, negs: 1, bonuses: 10, bonusPoints: 240 }),
        score('team-2', 200, { powers: 2, gets: 6, negs: 1, bonuses: 8, bonusPoints: 160 }),
      ],
      rawQbj({ powers: [3, 2], gets: [7, 6], negs: [1, 1] }),
      { packetId: 'packet-1' },
    );
    const r1b = game(
      'r1-b',
      'round-1',
      [
        score('team-1', 230, { powers: 2, gets: 6, negs: 2, bonuses: 9, bonusPoints: 180 }),
        score('team-2', 170, { powers: 2, gets: 6, negs: 2, bonuses: 7, bonusPoints: 140 }),
      ],
      rawQbj({ powers: [2, 2], gets: [6, 6], negs: [2, 2] }),
      { packetId: 'packet-1' },
    );
    const r2 = game(
      'r2-a',
      'round-2',
      [
        score('team-1', 350, { powers: 2, gets: 8, bonuses: 10, bonusPoints: 220 }),
        score('team-2', 250, { powers: 2, gets: 7, bonuses: 9, bonusPoints: 180 }),
      ],
      rawQbj({ x: 24, tossupsRead: 24, powers: [2, 2], gets: [8, 7] }),
      { packetId: 'packet-2' },
    );
    state.games = [r1a, r1b, r2];

    const report = deriveRoundReportData(state, { label: 'Overall' });
    const round1 = report.rows[0]!;
    const round2 = report.rows[1]!;

    expect(round1.roundName).toBe('Round 1');
    expect(round1.packetLabel).toBe('Packet 1');
    expect(round1.games).toBe(2);
    expect(round1.regulationTossups).toBe(20);
    expect(round1.pointsPerTeamPerXTuh).toBeCloseTo(225, 8); // 900 pts / four team-game equivalents
    expect(round1.tossupConversionRate).toBeCloseTo(34 / 40, 8);
    expect(round1.powerRate).toBeCloseTo(9 / 34, 8);
    expect(round1.negRatePerXTuh).toBeCloseTo(3, 8); // 6 negs / two 20-TU game equivalents
    expect(round1.ppb).toBeCloseTo(720 / 34, 8);
    expect(round1.bonusConversionRate).toBeCloseTo(720 / (34 * 30), 8);

    expect(round2.regulationTossups).toBe(24);
    expect(round2.pointsPerTeamPerXTuh).toBeCloseTo(300, 8);

    // Total is 1500 points / (4 team equivalents at X=20 + 2 at X=24), not mean(225, 300).
    expect(report.total.pointsPerTeamPerXTuh).toBeCloseTo(250, 8);
    expect(report.total.pointsPerTeamPerXTuh).not.toBeCloseTo((225 + 300) / 2, 8);
    expect(report.total.mixedDefinitions).toBe(true);
  });

  test('counts an administrative forfeit as a result but not a scoring denominator and refuses partial PPB', () => {
    const state = baseState();
    state.games = [
      game(
        'played',
        'round-1',
        [
          score('team-1', 300, { powers: 2, gets: 7, bonuses: 9, bonusPoints: 210 }),
          score('team-2', 200, { powers: 1, gets: 6, bonuses: 7, bonusPoints: 140 }),
        ],
        rawQbj({ powers: [2, 1], gets: [7, 6] }),
      ),
      game(
        'forfeit',
        'round-1',
        [score('team-1', 0), score('team-2', 0)],
        null,
        { status: 'forfeit', forfeitedTeamId: 'team-2', detailedStats: 'unknown' },
      ),
      game(
        'partial',
        'round-2',
        [score('team-1', 250), score('team-2', 150)],
        rawQbj({ powers: [1, 1], gets: [7, 6] }),
        { detailedStats: 'unknown' },
      ),
    ];

    const report = deriveRoundReportData(state, { label: 'Overall' });
    expect(report.rows[0]!.games).toBe(2);
    expect(report.rows[0]!.playedGames).toBe(1);
    expect(report.rows[0]!.pointsPerTeamPerXTuh).toBeCloseTo(250, 8);
    expect(report.rows[1]!.detailGames).toBe(0);
    expect(report.rows[1]!.ppb).toBeNull();
    expect(report.total.ppb).toBeNull();
  });

  test('uses historical optional-system evidence, reports mixed packets honestly, and respects scope', () => {
    const state = baseState();
    const playoff = game(
      'playoff',
      'round-3',
      [
        score('team-1', 320, { superpowers: 1, powers: 1, gets: 6, bonuses: 8, bonusPoints: 180, bouncebacks: 30 }),
        score('team-2', 280, { powers: 2, gets: 6, bonuses: 8, bonusPoints: 160, bouncebacks: 20 }),
      ],
      rawQbj({
        superpowers: [1, 0],
        powers: [1, 2],
        gets: [6, 6],
        bouncebacks: true,
        lightning: true,
        lightningPoints: [40, 30],
      }),
      { packetId: 'packet-2' },
    );
    const mixedPacket = game(
      'mixed-packet',
      'round-3',
      [
        score('team-1', 200, { gets: 7, bonuses: 7, bonusPoints: 130 }),
        score('team-2', 180, { gets: 7, bonuses: 7, bonusPoints: 120 }),
      ],
      rawQbj({ gets: [7, 7], bouncebacks: true, lightning: true, lightningPoints: [20, 10] }),
      { packetId: 'packet-1' },
    );
    state.games = [
      game('prelim', 'round-1', [score('team-1', 300), score('team-2', 200)], rawQbj()),
      playoff,
      mixedPacket,
    ];

    const scoped = deriveRoundReportData(state, { phaseId: 'phase-playoffs', label: 'Playoffs' });
    expect(scoped.rows).toHaveLength(1);
    const row = scoped.rows[0]!;
    expect(row.phaseName).toBe('Playoffs');
    expect(row.packetLabel).toBe('Mixed (Packet 2, Packet 1)');
    expect(row.applicability.superpower).toBe(true);
    expect(row.applicability.bouncebacks).toBe(true);
    expect(row.applicability.lightning).toBe(true);
    expect(row.lightningPointsPerTeamPerGame).toBeCloseTo(100 / 4, 8);
    expect(scoped.total.games).toBe(2);
  });
});