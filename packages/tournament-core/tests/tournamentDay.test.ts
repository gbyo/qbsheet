import { describe, expect, it } from 'vitest';
import type { EntityId, ScheduledGame, ScheduledMatch } from '../src/model';
import { bracketAwards } from '../src/brackets';
import {
  betterSeedWins,
  generatePrelims,
  playAll,
  playBracket,
  poolStandings,
  runMorning,
  seededTeams,
  snakePools,
  standingsFor,
} from './tournamentDay';

function byRound(games: readonly ScheduledGame[]): Map<EntityId, ScheduledGame[]> {
  const map = new Map<EntityId, ScheduledGame[]>();
  for (const game of games) {
    const list = map.get(game.roundId) ?? [];
    list.push(game);
    map.set(game.roundId, list);
  }
  return map;
}

function appearancesFor(games: readonly ScheduledGame[], teamId: EntityId): ScheduledGame[] {
  return games.filter((game) =>
    game.kind === 'bye' ? game.byeTeamId === teamId : game.teamAId === teamId || game.teamBId === teamId,
  );
}

describe.each([
  ['18 teams', 18, [6, 6, 6], [6, 6, 6]],
  ['17 teams', 17, [6, 6, 5], [6, 6, 5]],
  ['16 teams', 16, [6, 5, 5], [6, 6, 4]],
] as const)('preliminary pools · %s', (_label, teamCount, poolSizes, _divisionSizes) => {
  const teams = seededTeams(teamCount);
  const pools = snakePools(teams, poolSizes);
  const schedule = generatePrelims(teams, pools, 5, 9);

  it('assigns every team to exactly one preliminary pool', () => {
    const assigned = pools.flatMap((pool) => pool.teamIds);
    expect(new Set(assigned).size).toBe(teamCount);
    expect(pools.map((pool) => pool.teamIds.length)).toEqual([...poolSizes]);
  });

  it('generates exactly five synchronized rounds', () => {
    expect(schedule.roundCount).toBe(5);
    expect([...byRound(schedule.games).keys()].sort()).toEqual([
      'round-1',
      'round-2',
      'round-3',
      'round-4',
      'round-5',
    ]);
  });

  it('generates a valid schedule with no blocking issues', () => {
    expect(schedule.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('gives every team exactly one appearance per round', () => {
    for (const [roundId, games] of byRound(schedule.games)) {
      for (const team of teams) {
        expect(appearancesFor(games, team.id), `${team.id} in ${roundId}`).toHaveLength(1);
      }
    }
  });

  it('never gives a team both a game and a bye in the same round', () => {
    for (const games of byRound(schedule.games).values()) {
      const byeTeams = games.filter((game) => game.kind === 'bye').map((game) => game.byeTeamId);
      const playingTeams = games
        .filter((game): game is ScheduledMatch => game.kind !== 'bye')
        .flatMap((game) => [game.teamAId, game.teamBId]);
      expect(byeTeams.filter((teamId) => playingTeams.includes(teamId))).toEqual([]);
    }
  });

  it('plays a full round robin inside each pool with the right number of games and byes', () => {
    for (const pool of pools) {
      const poolGames = schedule.games.filter((game) => game.poolId === pool.id);
      const expectedGames = pool.teamIds.length - 1;
      const expectedByes = pool.teamIds.length % 2 === 1 ? 1 : 0;
      for (const teamId of pool.teamIds) {
        const played = poolGames.filter(
          (game): game is ScheduledMatch =>
            game.kind !== 'bye' && (game.teamAId === teamId || game.teamBId === teamId),
        );
        const byes = poolGames.filter((game) => game.kind === 'bye' && game.byeTeamId === teamId);
        expect(played, `${teamId} games`).toHaveLength(expectedGames);
        expect(byes, `${teamId} byes`).toHaveLength(expectedByes);
      }
    }
  });

  it('never repeats a preliminary matchup', () => {
    const seen = new Set<string>();
    for (const game of schedule.games) {
      if (game.kind === 'bye') continue;
      const key = [game.teamAId, game.teamBId].sort().join('|');
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('never schedules a preliminary game across pools', () => {
    const poolOf = new Map<EntityId, EntityId>();
    for (const pool of pools) for (const teamId of pool.teamIds) poolOf.set(teamId, pool.id);
    for (const game of schedule.games) {
      if (game.kind === 'bye') continue;
      expect(poolOf.get(game.teamAId)).toBe(poolOf.get(game.teamBId));
      expect(game.poolId).toBe(poolOf.get(game.teamAId));
    }
  });

  it('never double-books a room', () => {
    for (const games of byRound(schedule.games).values()) {
      const roomIds = games
        .filter((game) => game.kind !== 'bye')
        .map((game) => game.roomId)
        .filter((roomId): roomId is EntityId => roomId !== null);
      expect(new Set(roomIds).size).toBe(roomIds.length);
    }
  });

  it('gives a bye no room at all', () => {
    for (const game of schedule.games) {
      if (game.kind === 'bye') expect('roomId' in game).toBe(false);
    }
  });

  it('ranks each pool separately rather than comparing raw wins across unequal schedules', () => {
    const results = playAll(schedule.games);
    const standings = poolStandings(teams, pools, schedule.games, results);
    for (const pool of standings) {
      const poolSize = pools.find((entry) => entry.id === pool.poolId)?.teamIds.length ?? 0;
      expect(pool.rows).toHaveLength(poolSize);
      expect(pool.rows.map((row) => row.rank)).toEqual(
        Array.from({ length: poolSize }, (_, index) => index + 1),
      );
      expect(new Set(pool.rows.map((row) => row.gamesPlayed))).toEqual(new Set([poolSize - 1]));
    }
  });
});

describe.each([
  [
    '18 teams',
    18,
    [6, 6, 6],
    [6, 6, 6],
    [
      [1, 2],
      [1, 2],
      [1, 2],
    ],
  ],
  [
    '17 teams',
    17,
    [6, 6, 5],
    [6, 6, 5],
    [
      [1, 2],
      [1, 2],
      [1, 2, 3],
    ],
  ],
  ['16 teams', 16, [6, 5, 5], [6, 6, 4], [[1, 2], [1, 2], []]],
] as const)(
  'tournament day · %s',
  (_label, teamCount, poolSizes, expectedDivisionSizes, expectedByeSeeds) => {
    const day = runMorning(teamCount, poolSizes);

    it('places every team into exactly one playoff division', () => {
      expect(day.placement.blocked).toBe(false);
      expect(day.placement.divisions.map((division) => division.members.length)).toEqual([
        ...expectedDivisionSizes,
      ]);
      const placed = day.placement.divisions.flatMap((division) =>
        division.members.map((member) => member.teamId),
      );
      expect(new Set(placed).size).toBe(teamCount);
      expect(day.placement.unplacedTeamIds).toEqual([]);
    });

    it('records why every team landed in its division', () => {
      for (const division of day.placement.divisions) {
        for (const member of division.members) {
          expect(member.reason).toMatch(/^Pool [A-Z] · \d+(st|nd|rd|th)$/);
          expect(member.sourcePoolId).not.toBeNull();
        }
      }
    });

    it('draws the byes each division size mathematically requires', () => {
      expect(day.brackets.map((division) => division.plan.byes.map((bye) => bye.seed))).toEqual(
        expectedByeSeeds.map((seeds) => [...seeds]),
      );
    });

    it('numbers every playoff round 6, 7, or 8 and never restarts at 1', () => {
      for (const division of day.brackets) {
        expect(division.roundNumbers.every((roundNumber) => roundNumber >= 6 && roundNumber <= 8)).toBe(true);
        expect(division.roundNumbers).not.toContain(1);
      }
    });

    it('rests a four-team division rather than inventing a filler game', () => {
      const short = day.brackets.filter((division) => division.plan.teamCount === 4);
      for (const division of short) {
        expect(division.roundNumbers).toEqual([6, 8]);
        expect(division.unusedRoundNumbers).toEqual([7]);
      }
    });

    it('carries winners through rounds 7 and 8 without any manual game creation', () => {
      for (const division of day.brackets) {
        const { bracket, perRound } = playBracket(division, betterSeedWins);
        // Before anything is played, a game is schedulable only if both of its slots are fixed
        // seeds. In a five-team division that includes the #2 v #3 semifinal, which is genuinely
        // known at lunch; every game that names a winner is not.
        const beforeRound6 = perRound[0];
        for (const game of beforeRound6.games) {
          const bothSeeds = game.slotA.source.kind === 'seed' && game.slotB.source.kind === 'seed';
          expect(game.ready).toBe(bothSeeds);
        }
        expect(bracket.complete).toBe(true);
        expect(bracket.games.every((game) => game.ready)).toBe(true);
      }
    });

    it('names a champion and a runner-up in every division', () => {
      for (const division of day.brackets) {
        const { bracket } = playBracket(division, betterSeedWins);
        expect(bracket.championTeamId).not.toBeNull();
        expect(bracket.runnerUpTeamId).not.toBeNull();
        expect(bracket.championTeamId).not.toBe(bracket.runnerUpTeamId);
        expect(bracketAwards(bracket).map((award) => award.place)).toEqual(['champion', 'runner-up']);
      }
    });

    it('gives every division a distinct champion and never one overall winner', () => {
      const champions = day.brackets.map(
        (division) => playBracket(division, betterSeedWins).bracket.championTeamId,
      );
      expect(new Set(champions).size).toBe(day.brackets.length);
    });

    it('keeps the preliminary standings intact after the playoffs are played', () => {
      const before = day.poolStandings.map((pool) => pool.rows.map((row) => row.teamId));
      for (const division of day.brackets) playBracket(division, betterSeedWins);
      const after = day.pools.map((pool) =>
        standingsFor(day.teams, pool, day.schedule.games, day.results).rows.map((row) => row.teamId),
      );
      expect(after).toEqual(before);
    });

    it('never lets playoff results reorder the preliminary advancement table', () => {
      // The bracket's own games are not in the preliminary phase, so a preliminary standings query
      // scoped to the preliminary phase can only see the morning.
      const preliminaryGameIds = new Set(day.schedule.games.map((game) => game.id));
      for (const result of day.results) expect(preliminaryGameIds.has(result.scheduledGameId)).toBe(true);
    });
  },
);

describe('a corrected first-round result', () => {
  const day = runMorning(18, [6, 6, 6]);
  const championship = day.brackets[0];

  it('changes the semifinal opponent when the result is corrected before round 7', () => {
    const original = playBracket(championship, betterSeedWins);
    const firstRound = original.bracket.games.filter((game) => game.roundIndex === 0);
    const flipped = playBracket(championship, (teamAId, teamBId) => {
      const first = firstRound[0];
      if (
        (first.slotA.teamId === teamAId && first.slotB.teamId === teamBId) ||
        (first.slotA.teamId === teamBId && first.slotB.teamId === teamAId)
      ) {
        // The upset: the worse seed wins the first-round game after all.
        return betterSeedWins(teamAId, teamBId) === teamAId ? teamBId : teamAId;
      }
      return betterSeedWins(teamAId, teamBId);
    });
    const originalSemifinal = original.bracket.games.find(
      (game) => game.roundIndex === 1 && game.slotB.source.kind === 'winner',
    );
    const flippedSemifinal = flipped.bracket.games.find(
      (game) => game.roundIndex === 1 && game.slotB.source.kind === 'winner',
    );
    expect(flippedSemifinal?.slotB.teamId).not.toBe(originalSemifinal?.slotB.teamId);
  });
});

describe('a pool that cannot fill the configured rounds', () => {
  it('reports the mismatch rather than generating a broken five-round schedule', () => {
    const teams = seededTeams(8);
    const pools = snakePools(teams, [4, 4]);
    const schedule = generatePrelims(teams, pools, 5, 4);
    // A four-team pool exhausts its round robin in three rounds; the generator stops there rather
    // than inventing rematches, and the missing rounds are visible in the round count.
    expect(schedule.roundCount).toBe(3);
    expect(schedule.games.some((game) => game.roundId === 'round-4')).toBe(false);
  });
});
