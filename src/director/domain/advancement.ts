import {
  type DirectorId,
  type DirectorState,
  type GameRecord,
  type Phase,
  type Team,
  type TournamentRules,
} from './model';
import { activePhaseTeams, phaseCompetitiveField } from './field';
import {
  acceptedGameRecords,
  deriveTeamStandings,
  rankTeamStandings,
  tiebreakerIsComparable,
  teamTiebreakerValue,
  type DirectorStandingsOptions,
  type TeamStanding,
} from './stats';

export interface AdvancementPreview {
  phaseId: DirectorId;
  /** Stable fingerprint of the competitive inputs used to produce this preview. */
  basisToken: string;
  qualifiers: Team[];
  /** Subset of qualifiers selected as cross-pool wildcards, in selection order. */
  wildcards: Team[];
  unresolved: Array<{ teamIds: DirectorId[]; reason: string }>;
  explanation: string[];
}

export function advancementBasisToken(state: DirectorState, phase: Phase): string {
  const roundIds = new Set(phase.roundIds);
  return JSON.stringify({
    phase: {
      id: phase.id,
      status: phase.status,
      poolIds: phase.poolIds,
      advancementRule: phase.advancementRule,
    },
    pools: phase.poolIds.map((poolId) => state.pools.find((pool) => pool.id === poolId)?.teamIds ?? []),
    teams: state.teams.filter((team) => team.status === 'confirmed').map((team) => team.id),
    games: state.games.filter((game) => roundIds.has(game.roundId)),
    // The standings tiebreakers decide cutoffs, so they are part of the basis (#673). A
    // tiebreaker reorder after a commit must read as a changed basis, never silently
    // current. Scoring point values are deliberately excluded: accepted games resolve
    // under their pinned definitions, so a future-defaults save cannot move history.
    tiebreakers: phase.advancementRule?.tiebreakers ?? state.tournament?.rules.tiebreakers,
  });
}

/** A committed advancement record and whether its basis still verifies. */
export type AdvancementBasisStatus = 'current' | 'stale' | 'unknown' | 'uncommitted';

export function latestAdvancementCommit(
  state: DirectorState,
  sourcePhaseId: DirectorId,
): DirectorState['audit'][number] | undefined {
  return [...state.audit].reverse().find((entry) => {
    if (entry.type !== 'advancement-committed' || !entry.details || typeof entry.details !== 'object') {
      return false;
    }
    return (entry.details as Record<string, unknown>).sourcePhaseId === sourcePhaseId;
  });
}

/**
 * Whether the latest committed advancement for a phase still verifies (#673).
 *
 * Committed advancement is never presented as current unless its stored basis token
 * matches a fresh computation. Commits that predate basis tracking read as `unknown`,
 * which callers treat like `stale` with honest copy.
 */
export function advancementBasisStatus(
  state: DirectorState,
  sourcePhaseId: DirectorId,
): AdvancementBasisStatus {
  const phase = state.phases.find((entry) => entry.id === sourcePhaseId);
  if (!phase) return 'uncommitted';
  const commit = latestAdvancementCommit(state, sourcePhaseId);
  if (!commit) return 'uncommitted';
  const stored =
    commit.details && typeof commit.details === 'object'
      ? (commit.details as Record<string, unknown>).basisToken
      : undefined;
  if (typeof stored !== 'string') return 'unknown';
  return stored === advancementBasisToken(state, phase) ? 'current' : 'stale';
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
  // Omitting poolId is the canonical selector's phase-wide scope. `null` deliberately means
  // unpooled games and would silently discard ordinary pooled preliminary results.
  const phaseWideGames = phaseGames(state, phase);
  const rankedRemaining = rankTeamStandings(remaining, phaseWideGames, tiebreakers);
  const wildcardStandings = wildcardCount > 0 ? rankedRemaining.slice(0, Math.max(0, wildcardCount)) : [];
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
  const wildcardTeams = wildcardStandings.map(toTeam).filter((team): team is Team => team !== undefined);
  const qualifierTeams = qualifiedStandings.map(toTeam).filter((team): team is Team => team !== undefined);
  const wildcardGames = new Set(wildcardStandings.map((standing) => standing.gamesPlayed));
  return {
    phaseId: phase.id,
    basisToken: advancementBasisToken(state, phase),
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
export function standingsForAdvancement(state: DirectorState, phase: Phase): TeamStanding[] {
  return standingsByPool(state, phase).flatMap((entry) => entry.standings);
}

function phaseGames(state: DirectorState, phase: Phase, poolId?: DirectorId | null): GameRecord[] {
  const options: DirectorStandingsOptions = {
    phaseId: phase.id,
    ...(poolId === undefined || poolId === null
      ? {}
      : { poolId, teamIds: state.pools.find((pool) => pool.id === poolId)?.teamIds }),
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
    const teamIds = phaseCompetitiveField(state, phase.id).teams.map((team) => team.id);
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
    const teamIds = (pool?.teamIds ?? []).filter((teamId) =>
      activePhaseTeams(state, phase.id).some((team) => team.id === teamId),
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
    if (!tiebreakerIsComparable(key, group, games)) continue;
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
  return teamTiebreakerValue(standing, key, group, games) ?? 0;
}
