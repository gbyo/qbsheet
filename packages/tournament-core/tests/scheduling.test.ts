import { generatePoolSchedule, generateRoundRobinSchedule, validateSchedule } from '../src';
import type { ScheduledMatch } from '../src';
import { makePool, makeTeams } from './helpers';

function matchGames(games: readonly { readonly kind: string }[]): ScheduledMatch[] {
  return games.filter((game): game is ScheduledMatch => game.kind !== 'bye');
}

describe('deterministic tournament scheduling', () => {
  it('generates a complete eight-team round robin with one game per team per round', () => {
    const teams = makeTeams(8);
    const first = generateRoundRobinSchedule({
      phaseId: 'phase-1',
      teams,
      roomIds: ['room-1', 'room-2', 'room-3', 'room-4'],
      rounds: Array.from({ length: 7 }, (_, index) => ({ id: `round-${index + 1}`, number: index + 1 })),
      seed: 'fixed-seed',
      requireRoomAssignments: true,
    });
    const second = generateRoundRobinSchedule({
      phaseId: 'phase-1',
      teams,
      roomIds: ['room-1', 'room-2', 'room-3', 'room-4'],
      rounds: Array.from({ length: 7 }, (_, index) => ({ id: `round-${index + 1}`, number: index + 1 })),
      seed: 'fixed-seed',
      requireRoomAssignments: true,
    });
    const games = matchGames(first.games);
    const pairs = new Set(games.map((game) => [game.teamAId, game.teamBId].sort().join('|')));

    expect(first.games).toHaveLength(28);
    expect(games).toHaveLength(28);
    expect(pairs).toHaveLength(28);
    expect(first.issues.filter((issue) => issue.severity === 'error')).toHaveLength(0);
    expect(first.expectedGamesPerTeam).toBe(7);
    expect(second.games).toEqual(first.games);
    for (const roundId of Array.from(new Set(games.map((game) => game.roundId)))) {
      const round = games.filter((game) => game.roundId === roundId);
      expect(round).toHaveLength(4);
      expect(new Set(round.flatMap((game) => [game.teamAId, game.teamBId]))).toHaveLength(8);
      expect(new Set(round.map((game) => game.roomId))).toHaveLength(4);
    }
  });

  it('represents every bye explicitly for an odd-sized field', () => {
    const teams = makeTeams(5);
    const schedule = generateRoundRobinSchedule({
      phaseId: 'phase-1',
      teams,
      roomIds: ['room-1', 'room-2'],
      seed: 17,
      requireRoomAssignments: true,
    });
    const games = matchGames(schedule.games);
    const byes = schedule.games.filter((game) => game.kind === 'bye');
    const byeTeams = new Set(byes.map((game) => game.byeTeamId));
    const counts = new Map(teams.map((team) => [team.id, 0]));
    for (const game of games) {
      counts.set(game.teamAId, (counts.get(game.teamAId) ?? 0) + 1);
      counts.set(game.teamBId, (counts.get(game.teamBId) ?? 0) + 1);
    }

    expect(schedule.roundCount).toBe(5);
    expect(games).toHaveLength(10);
    expect(byes).toHaveLength(5);
    expect(byeTeams).toHaveLength(5);
    expect([...counts.values()]).toEqual([4, 4, 4, 4, 4]);
    for (const roundId of new Set(schedule.games.map((game) => game.roundId))) {
      const roundGames = schedule.games.filter((game) => game.roundId === roundId);
      expect(roundGames.filter((game) => game.kind === 'bye')).toHaveLength(1);
      expect(roundGames.filter((game) => game.kind !== 'bye').every((game) => game.roomId)).toBe(true);
      expect(
        new Set(roundGames.filter((game) => game.kind !== 'bye').map((game) => game.roomId)),
      ).toHaveLength(2);
    }
    expect(schedule.issues.filter((issue) => issue.severity === 'error')).toHaveLength(0);
  });

  it.each([2, 3, 4, 5, 6, 7, 8])(
    'keeps every team in exactly one pairing or bye for every round (%i teams)',
    (teamCount) => {
      for (const seed of ['property-a', 'property-b', 19]) {
        const teams = makeTeams(teamCount);
        const schedule = generateRoundRobinSchedule({ phaseId: 'phase-1', teams, seed });

        expect(schedule.issues.filter((issue) => issue.severity === 'error')).toHaveLength(0);
        for (const roundId of new Set(schedule.games.map((game) => game.roundId))) {
          const roundGames = schedule.games.filter((game) => game.roundId === roundId);
          const participants = roundGames.flatMap((game) =>
            game.kind === 'bye' ? [game.byeTeamId] : [game.teamAId, game.teamBId],
          );
          expect(new Set(participants)).toHaveLength(teamCount);
          expect(roundGames.filter((game) => game.kind === 'bye')).toHaveLength(teamCount % 2);
        }
      }
    },
  );

  it('does not emit a partial schedule when an odd field forbids byes', () => {
    const schedule = generateRoundRobinSchedule({
      phaseId: 'phase-1',
      teams: makeTeams(5),
      allowByes: false,
      seed: 'no-byes',
    });

    expect(schedule.games).toEqual([]);
    expect(schedule.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'byes-not-allowed', severity: 'error' })]),
    );
  });

  it('solves organization constraints for the whole round without dropping displaced teams', () => {
    const teams = makeTeams(6, ['org-a', 'org-b', 'org-c']);
    const schedule = generateRoundRobinSchedule({
      phaseId: 'phase-1',
      teams,
      roundCount: 1,
      avoidSameOrganization: true,
      seed: 'whole-round-matching',
    });
    const round = schedule.games.filter((game) => game.roundId === schedule.games[0]?.roundId);
    const participants = round.flatMap((game) =>
      game.kind === 'bye' ? [game.byeTeamId] : [game.teamAId, game.teamBId],
    );

    expect(round).toHaveLength(3);
    expect(new Set(participants)).toHaveLength(6);
    expect(
      round.every(
        (game) =>
          game.kind === 'bye' ||
          teams.find((team) => team.id === game.teamAId)?.organizationId !==
            teams.find((team) => team.id === game.teamBId)?.organizationId,
      ),
    ).toBe(true);
    expect(schedule.issues.some((issue) => issue.code === 'team-double-booked')).toBe(false);
  });

  it('honors roundsPerTeam for a partial even-field schedule', () => {
    const schedule = generateRoundRobinSchedule({
      phaseId: 'phase-1',
      teams: makeTeams(4),
      roundsPerTeam: 2,
      seed: 'partial-round-robin',
    });
    const counts = new Map<string, number>();
    for (const game of schedule.games) {
      if (game.kind === 'bye') continue;
      counts.set(game.teamAId, (counts.get(game.teamAId) ?? 0) + 1);
      counts.set(game.teamBId, (counts.get(game.teamBId) ?? 0) + 1);
    }

    expect(schedule.roundCount).toBe(2);
    expect(schedule.expectedGamesPerTeam).toBe(2);
    expect([...counts.values()]).toEqual([2, 2, 2, 2]);
  });

  it('passes roundsPerTeam through every pool plan', () => {
    const teams = makeTeams(8);
    const pools = [
      makePool('pool-a', ['team-1', 'team-2', 'team-3', 'team-4'], 0),
      makePool('pool-b', ['team-5', 'team-6', 'team-7', 'team-8'], 1),
    ];
    const schedule = generatePoolSchedule({
      phaseId: 'phase-1',
      pools,
      teams,
      roundsPerTeam: 2,
      seed: 'pool-partial-round-robin',
    });
    const counts = new Map(teams.map((team) => [team.id, 0]));
    for (const game of matchGames(schedule.games)) {
      counts.set(game.teamAId, (counts.get(game.teamAId) ?? 0) + 1);
      counts.set(game.teamBId, (counts.get(game.teamBId) ?? 0) + 1);
    }

    expect(schedule.roundCount).toBe(2);
    expect(schedule.expectedGamesPerTeam).toBe(2);
    expect([...counts.values()]).toEqual([2, 2, 2, 2, 2, 2, 2, 2]);
    expect(schedule.issues.filter((issue) => issue.severity === 'error')).toHaveLength(0);
  });

  it('validates bye parity per pool without consuming rooms for byes', () => {
    const teams = makeTeams(6);
    const schedule = generatePoolSchedule({
      phaseId: 'phase-1',
      pools: [
        makePool('pool-a', ['team-1', 'team-2', 'team-3'], 0),
        makePool('pool-b', ['team-4', 'team-5', 'team-6'], 1),
      ],
      teams,
      roomIds: ['room-1', 'room-2'],
      rounds: Array.from({ length: 3 }, (_, index) => ({
        id: `round-${index + 1}`,
        number: index + 1,
      })),
      requireRoomAssignments: true,
      seed: 'odd-pools',
    });

    expect(schedule.games.filter((game) => game.kind === 'bye')).toHaveLength(6);
    expect(matchGames(schedule.games)).toHaveLength(6);
    expect(matchGames(schedule.games).every((game) => game.roomId)).toBe(true);
    expect(schedule.issues.filter((issue) => issue.severity === 'error')).toHaveLength(0);
  });

  it('returns no games and leaves invalid pool inputs unchanged', () => {
    const teams = makeTeams(3);
    const pools = [makePool('pool-a', ['team-1', 'missing-team', 'team-2'])];
    const originalTeams = structuredClone(teams);
    const originalPools = structuredClone(pools);
    const schedule = generatePoolSchedule({
      phaseId: 'phase-1',
      pools,
      teams,
      seed: 'invalid-pool',
    });

    expect(schedule.games).toEqual([]);
    expect(schedule.issues.some((issue) => issue.code === 'missing-pool-team')).toBe(true);
    expect(teams).toEqual(originalTeams);
    expect(pools).toEqual(originalPools);
  });

  it('supports repeated round robin while making an explicit forbid policy fail loudly', () => {
    const teams = makeTeams(4);
    const repeated = generateRoundRobinSchedule({
      phaseId: 'phase-1',
      teams,
      repetitions: 2,
      seed: 'repeat',
    });
    const forbidden = generateRoundRobinSchedule({
      phaseId: 'phase-1',
      teams,
      repetitions: 2,
      seed: 'repeat',
      rematchPolicy: 'forbid',
    });

    expect(matchGames(repeated.games)).toHaveLength(12);
    expect(repeated.expectedGamesPerTeam).toBe(6);
    expect(repeated.issues.some((issue) => issue.code === 'same-round-rematch')).toBe(false);
    expect(forbidden.games).toEqual([]);
    expect(forbidden.issues.some((issue) => issue.code === 'rematches-required')).toBe(true);
    expect(forbidden.issues.some((issue) => issue.code === 'rematch-forbidden')).toBe(true);
  });

  it('synchronizes multiple pools without double-booking rooms', () => {
    const teams = makeTeams(8);
    const pools = [
      makePool('pool-a', ['team-1', 'team-2', 'team-3', 'team-4'], 0),
      makePool('pool-b', ['team-5', 'team-6', 'team-7', 'team-8'], 1),
    ];
    const schedule = generatePoolSchedule({
      phaseId: 'phase-1',
      pools,
      teams,
      roomIds: ['room-1', 'room-2', 'room-3', 'room-4'],
      seed: 'pools',
      requireRoomAssignments: true,
    });
    const games = matchGames(schedule.games);

    expect(games).toHaveLength(12);
    expect(schedule.expectedGamesPerTeam).toBe(3);
    for (const roundId of Array.from(new Set(games.map((game) => game.roundId)))) {
      const roundGames = games.filter((game) => game.roundId === roundId);
      expect(new Set(roundGames.map((game) => game.roomId))).toHaveLength(roundGames.length);
    }
    expect(schedule.issues.filter((issue) => issue.severity === 'error')).toHaveLength(0);
  });

  it('reports invalid manual schedules rather than silently repairing them', () => {
    const teams = makeTeams(4);
    const invalid: ScheduledMatch[] = [
      {
        id: 'game-1',
        phaseId: 'phase-1',
        roundId: 'round-1',
        poolId: null,
        sequence: 0,
        kind: 'game',
        teamAId: 'team-1',
        teamBId: 'team-1',
        roomId: 'room-1',
        packetId: null,
        status: 'scheduled',
        notes: '',
      },
      {
        id: 'game-2',
        phaseId: 'phase-1',
        roundId: 'round-1',
        poolId: null,
        sequence: 0,
        kind: 'game',
        teamAId: 'team-2',
        teamBId: 'team-3',
        roomId: 'room-1',
        packetId: null,
        status: 'scheduled',
        notes: '',
      },
    ];
    const issues = validateSchedule(invalid, teams, { roomIds: ['room-1'], rematchPolicy: 'forbid' });

    expect(issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['self-match', 'duplicate-sequence', 'room-double-booked']),
    );
  });

  it('distinguishes a team game plus bye and malformed round membership', () => {
    const teams = makeTeams(3);
    const issues = validateSchedule(
      [
        {
          id: 'bye-1',
          phaseId: 'phase-1',
          roundId: 'round-1',
          poolId: 'pool-a',
          sequence: 0,
          kind: 'bye',
          byeTeamId: 'team-1',
          status: 'scheduled',
          notes: '',
        },
        {
          id: 'game-1',
          phaseId: 'phase-2',
          roundId: 'round-1',
          poolId: 'pool-b',
          sequence: 1,
          kind: 'game',
          teamAId: 'team-1',
          teamBId: 'team-2',
          roomId: null,
          packetId: null,
          status: 'scheduled',
          notes: '',
        },
      ],
      teams,
      { requireExplicitByes: true },
    );

    expect(issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['team-game-and-bye', 'mixed-round-membership']),
    );
  });

  it('reports missing opponents, unknown rounds, and incomplete round membership', () => {
    const teams = makeTeams(4);
    const issues = validateSchedule(
      [
        {
          id: 'game-1',
          phaseId: 'phase-1',
          roundId: 'round-1',
          poolId: null,
          sequence: 0,
          kind: 'game',
          teamAId: 'team-1',
          teamBId: '' as ScheduledMatch['teamBId'],
          roomId: null,
          packetId: null,
          status: 'scheduled',
          notes: '',
        },
        {
          id: 'game-2',
          phaseId: 'phase-1',
          roundId: 'unknown-round',
          poolId: null,
          sequence: 1,
          kind: 'game',
          teamAId: 'team-2',
          teamBId: 'team-3',
          roomId: null,
          packetId: null,
          status: 'scheduled',
          notes: '',
        },
      ],
      teams,
      {
        phaseId: 'phase-1',
        poolId: null,
        rounds: [{ id: 'round-1', number: 1, poolId: null }],
        requireCompleteRounds: true,
      },
    );

    expect(issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['missing-opponent', 'unknown-round', 'missing-team-in-round']),
    );
  });
});
