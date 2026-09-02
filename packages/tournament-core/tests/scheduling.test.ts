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
    expect(schedule.issues.filter((issue) => issue.severity === 'error')).toHaveLength(0);
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
});
