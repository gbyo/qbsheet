import {
  type DirectorId,
  type DirectorState,
  type GameRecord,
  type Phase,
  type Team,
  type TournamentRules,
} from './model';
import {
  acceptedGameRecords,
  deriveTeamStandings,
  type DirectorStandingsOptions,
  type TeamStanding,
} from './stats';

export interface AdvancementPreview {
  phaseId: DirectorId;
  qualifiers: Team[];
  /** Subset of qualifiers selected as cross-pool wildcards, in selection order. */
  wildcards: Team[];
  unresolved: Array<{ teamIds: DirectorId[]; reason: string }>;
  explanation: string[];
}

export function previewAdvancement(state: DirectorState, phase: Phase): AdvancementPreview {
  const rule = phase.advancementRule;
  const qualifiersPerPool = rule?.qualifiersPerPool ?? 0;
  const unresolved: AdvancementPreview['unresolved'] = [];
  const poolStandings = standingsByPool(state, phase);
  const qualifiedStandings = poolStandings.flatMap(({ poolId, standings }) => {
    const selected = rule ? standings.slice(0, qualifiersPerPool) : [];
    if (rule && selected.length > 0 && selected.length < standings.length) {
      const cutoffTies = unresolvedCutoffTeams(
        standings,
        selected.length,
        phaseGames(state, phase, poolId),
        rule.tiebreakers ?? state.tournament?.rules.tiebreakers,
      );
      if (cutoffTies.length > 0) {
        unresolved.push({
          teamIds: cutoffTies,
          reason: 'The qualification cutoff is tied after the configured standings tiebreakers.',
        });
      }
    }
    return selected;
  });
  const tiebreakers = rule?.tiebreakers ?? state.tournament?.rules.tiebreakers;
  const wildcardCount = rule?.wildcards ?? 0;
  const qualifiedIds = new Set(qualifiedStandings.map((standing) => standing.teamId));
  const remaining = poolStandings.flatMap((entry) =>
    entry.standings.filter((standing) => !qualifiedIds.has(standing.teamId)),
  );
  const phaseWideGames = phaseGames(state, phase, null);
  const rankedRemaining = [...remaining].sort((left, right) =>
    compareWildcardStandings(left, right, remaining, phaseWideGames, tiebreakers),
  );
  const wildcardStandings =
    wildcardCount > 0 ? rankedRemaining.slice(0, Math.max(0, wildcardCount)) : [];
  if (wildcardStandings.length > 0 && wildcardStandings.length < rankedRemaining.length) {
    const cutoffTies = unresolvedCutoffTeams(
      rankedRemaining,
      wildcardStandings.length,
      phaseWideGames,
      tiebreakers,
    );
    if (cutoffTies.length > 0) {
      unresolved.push({
        teamIds: cutoffTies,
        reason: 'The wildcard cutoff is tied after the configured standings tiebreakers.',
      });
    }
  }
  const toTeam = (standing: TeamStanding): Team | undefined =>
    state.teams.find((team) => team.id === standing.teamId);
  const wildcardTeams = wildcardStandings
    .map(toTeam)
    .filter((team): team is Team => team !== undefined);
  const qualifierTeams = qualifiedStandings
    .map(toTeam)
    .filter((team): team is Team => team !== undefined);
  const wildcardGames = new Set(wildcardStandings.map((standing) => standing.gamesPlayed));
  return {
    phaseId: phase.id,
    qualifiers: [...qualifierTeams, ...wildcardTeams],
    wildcards: wildcardTeams,
    unresolved,
    explanation: [
      `Ranked ${poolStandings.reduce((count, entry) => count + entry.standings.length, 0)} eligible teams using the configured record and tiebreak order.`,
      rule
        ? `Preview includes ${rule.qualifiersPerPool} qualifier(s) per pool.`
        : 'No advancement rule is configured.',
      wildcardCount > 0
        ? `Preview includes ${wildcardTeams.length} wildcard(s) selected across pools.` +
          (wildcardGames.size > 1
            ? ' Caution: wildcard candidates have played different numbers of games.'
            : '')
        : 'No wildcards are configured.',
      unresolved.length === 0
        ? 'No unresolved cutoff tie was found.'
        : 'Director decision required before committing advancement.',
    ],
  };
}

/**
 * Order non-qualifiers across pools with the same criterion cascade the
 * canonical standings use, so wildcard selection never disagrees with pool
 * rankings about what "best remaining" means.
 */
function compareWildcardStandings(
  left: TeamStanding,
  right: TeamStanding,
  group: readonly TeamStanding[],
  games: readonly GameRecord[],
  configuredTiebreakers: TournamentRules['tiebreakers'] | undefined,
): number {
  const order = configuredTiebreakers ?? ['record', 'points', 'margin', 'powers', 'gets'];
  for (const key of order) {
    const difference =
      criterionValue(right, key, group, games) - criterionValue(left, key, group, games);
    if (difference !== 0) return difference;
  }
  return left.teamId.localeCompare(right.teamId);
}

export function standingsForAdvancement(state: DirectorState, phase: Phase): TeamStanding[] {
  return standingsByPool(state, phase).flatMap((entry) => entry.standings);
}

function phaseGames(state: DirectorState, phase: Phase, poolId: DirectorId | null): GameRecord[] {
  const options: DirectorStandingsOptions = {
    phaseId: phase.id,
    poolId,
    teamIds: poolId ? state.pools.find((pool) => pool.id === poolId)?.teamIds : undefined,
    includeDroppedTeams: true,
  };
  return acceptedGameRecords(state, options);
}

function standingsByPool(
  state: DirectorState,
  phase: Phase,
): Array<{ poolId: DirectorId | null; standings: TeamStanding[] }> {
  const tiebreakers = phase.advancementRule?.tiebreakers ?? state.tournament?.rules.tiebreakers;
  if (phase.poolIds.length === 0) {
    const teamIds = state.teams.filter((team) => team.status === 'confirmed').map((team) => team.id);
    return [
      {
        poolId: null,
        standings: deriveTeamStandings(state, undefined, {
          phaseId: phase.id,
          teamIds,
          includeDroppedTeams: false,
          tiebreakers,
        }),
      },
    ];
  }
  return phase.poolIds.map((poolId) => {
    const pool = state.pools.find((entry) => entry.id === poolId);
    const teamIds = (pool?.teamIds ?? []).filter(
      (teamId) => state.teams.find((team) => team.id === teamId)?.status === 'confirmed',
    );
    return {
      poolId,
      standings: deriveTeamStandings(state, undefined, {
        phaseId: phase.id,
        poolId,
        teamIds,
        includeDroppedTeams: false,
        tiebreakers,
      }),
    };
  });
}

/**
 * Return only the teams in the unresolved group that crosses the qualification cutoff.
 * Head-to-head is evaluated against the group that remains tied after earlier criteria, rather
 * than against the whole field. This mirrors the ranking procedure in deriveTeamStandings.
 */
function unresolvedCutoffTeams(
  standings: readonly TeamStanding[],
  cutoffCount: number,
  games: readonly GameRecord[],
  configuredTiebreakers: TournamentRules['tiebreakers'] | undefined,
): DirectorId[] {
  const order = configuredTiebreakers ?? ['record', 'points', 'margin', 'powers', 'gets'];
  if (cutoffCount <= 0 || cutoffCount >= standings.length) return [];
  let group = [...standings];
  for (const key of order) {
    const partitions: TeamStanding[][] = [];
    for (const standing of group) {
      const value = criterionValue(standing, key, group, games);
      const previous = partitions.at(-1);
      if (previous && criterionValue(previous[0], key, group, games) === value) previous.push(standing);
      else partitions.push([standing]);
    }
    const cutoffTeamId = standings[cutoffCount - 1]?.teamId;
    const partition = partitions.find((entry) => entry.some((standing) => standing.teamId === cutoffTeamId));
    if (!partition) return [];
    const positions = partition.map((standing) => standings.indexOf(standing));
    const crossesCutoff =
      positions.some((position) => position < cutoffCount) &&
      positions.some((position) => position >= cutoffCount);
    if (!crossesCutoff) return [];
    if (partition.length === 1) return [];
    group = partition;
  }
  return group.map((standing) => standing.teamId);
}

function criterionValue(
  standing: TeamStanding,
  key: TournamentRules['tiebreakers'][number],
  group: readonly TeamStanding[],
  games: readonly GameRecord[],
): number {
  if (key === 'head-to-head') {
    const groupIds = new Set(group.map((entry) => entry.teamId));
    let points = 0;
    let played = 0;
    for (const game of games) {
      const own = game.scores.find((score) => score.teamId === standing.teamId);
      const opponent = game.scores.find(
        (score) => score.teamId !== standing.teamId && groupIds.has(score.teamId),
      );
      if (!own || !opponent) continue;
      played += 1;
      points += own.score > opponent.score ? 1 : own.score === opponent.score ? 0.5 : 0;
    }
    return played === 0 ? 0 : points / played;
  }
  if (key === 'record') return standing.winPercentage;
  if (key === 'points') return standing.pointsFor;
  if (key === 'margin') return standing.margin;
  if (key === 'powers') return standing.powers;
  if (key === 'gets') return standing.gets;
  return 0;
}
