import fc from 'fast-check';
import { generateRoundRobinSchedule } from '../src';
import type { ScheduledMatch } from '../src';
import { makeTeams } from './helpers';

function matchesOf(games: readonly { readonly kind: string }[]): ScheduledMatch[] {
  return games.filter((game): game is ScheduledMatch => game.kind !== 'bye');
}

describe('schedule invariants', () => {
  it('holds round-robin invariants across arbitrary field sizes and seeds', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 12 }), fc.string(), (count, seed) => {
        const teams = makeTeams(count);
        const first = generateRoundRobinSchedule({ phaseId: 'phase-1', teams, seed });
        const second = generateRoundRobinSchedule({ phaseId: 'phase-1', teams, seed });
        const games = matchesOf(first.games);
        const expectedGames = (count * (count - 1)) / 2;
        const pairKeys = new Set(games.map((game) => [game.teamAId, game.teamBId].sort().join('|')));

        expect(first.issues.some((issue) => issue.severity === 'error')).toBe(false);
        expect(first.games).toEqual(second.games);
        expect(games).toHaveLength(expectedGames);
        expect(pairKeys).toHaveLength(expectedGames);
        expect(first.expectedGamesPerTeam).toBe(count - 1);
        for (const roundId of new Set(first.games.map((game) => game.roundId))) {
          const roundEntries = first.games.filter((game) => game.roundId === roundId);
          const seen = new Set<string>();
          for (const game of roundEntries) {
            const teamId = game.kind === 'bye' ? game.byeTeamId : game.teamAId;
            const secondTeamId = game.kind === 'bye' ? null : game.teamBId;
            expect(seen.has(teamId)).toBe(false);
            seen.add(teamId);
            if (secondTeamId) {
              expect(seen.has(secondTeamId)).toBe(false);
              seen.add(secondTeamId);
            }
          }
          expect(seen).toHaveLength(count);
        }
      }),
      { numRuns: 40 },
    );
  });

  it('preserves per-team game counts and no same-round rematches in repeated schedules', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 8 }), (count) => {
        const teams = makeTeams(count);
        const schedule = generateRoundRobinSchedule({
          phaseId: 'phase-1',
          teams,
          repetitions: 2,
          seed: `repeat-${count}`,
        });
        const games = matchesOf(schedule.games);
        const counts = new Map(teams.map((team) => [team.id, 0]));
        const pairsByRound = new Map<string, Set<string>>();
        for (const game of games) {
          counts.set(game.teamAId, (counts.get(game.teamAId) ?? 0) + 1);
          counts.set(game.teamBId, (counts.get(game.teamBId) ?? 0) + 1);
          const pairs = pairsByRound.get(game.roundId) ?? new Set<string>();
          pairs.add([game.teamAId, game.teamBId].sort().join('|'));
          pairsByRound.set(game.roundId, pairs);
        }
        expect([...counts.values()]).toEqual(Array.from({ length: count }, () => (count - 1) * 2));
        for (const [roundId, pairs] of pairsByRound) {
          const roundGames = games.filter((game) => game.roundId === roundId);
          expect(pairs.size).toBe(roundGames.length);
        }
        expect(schedule.issues.some((issue) => issue.code === 'same-round-rematch')).toBe(false);
      }),
      { numRuns: 24 },
    );
  });
});
