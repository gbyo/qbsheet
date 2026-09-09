import type { DirectorId, GameRecord, TournamentRules } from './model.js';
import {
  rankTeamStandings,
  teamTiebreakerValue,
  tiebreakerIsComparable,
  type TeamStanding,
} from './stats.js';

/**
 * Return competition-style ranks (1, 1, 3) without making report HTML reverse-engineer ties.
 *
 * The grouping uses the same progressive criterion primitives as the canonical standings engine
 * and verifies that its flattened order exactly matches `rankTeamStandings`. If those two ever
 * drift, reporting fails loudly instead of quietly publishing a different ranking.
 */
export function canonicalCompetitionRanks(
  standings: readonly TeamStanding[],
  games: readonly GameRecord[],
  tiebreakers?: TournamentRules['tiebreakers'],
): Map<DirectorId, number> {
  const order = tiebreakers ?? ['record', 'points', 'margin', 'powers', 'gets'];
  let groups: TeamStanding[][] = [[...standings]];

  for (const key of order) {
    groups = groups.flatMap((group) => {
      if (group.length < 2 || !tiebreakerIsComparable(key, group, games)) return [group];
      const ordered = [...group].sort(
        (left, right) =>
          (teamTiebreakerValue(right, key, group, games) ?? 0) -
          (teamTiebreakerValue(left, key, group, games) ?? 0),
      );
      const partitions: TeamStanding[][] = [];
      for (const standing of ordered) {
        const previous = partitions.at(-1);
        const value = teamTiebreakerValue(standing, key, group, games);
        const previousValue = previous
          ? teamTiebreakerValue(previous[0]!, key, group, games)
          : undefined;
        if (previous && previousValue === value) previous.push(standing);
        else partitions.push([standing]);
      }
      return partitions;
    });
  }

  const normalizedGroups = groups.map((group) =>
    [...group].sort((left, right) => left.teamId.localeCompare(right.teamId)),
  );
  const flattened = normalizedGroups.flat();
  const canonical = rankTeamStandings(standings, games, tiebreakers);
  if (flattened.map((row) => row.teamId).join('\u0000') !== canonical.map((row) => row.teamId).join('\u0000')) {
    throw new Error('Canonical standings tie groups no longer match canonical standings ordering.');
  }

  const ranks = new Map<DirectorId, number>();
  let position = 1;
  for (const group of normalizedGroups) {
    for (const standing of group) ranks.set(standing.teamId, position);
    position += group.length;
  }
  return ranks;
}
