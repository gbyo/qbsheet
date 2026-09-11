import {
  isoNow,
  newDirectorId,
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
  exhibitionTeamIdsOf,
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

/**
 * The team inputs that can move a source phase's advancement preview (#727).
 *
 * This mirrors the selectors `previewAdvancement` reads: the phase competitive
 * field (which already applies confirmed/active semantics, including the
 * tournament-field fallback for a first phase with no pools) union the pool
 * memberships that feed the per-pool previews. Each entry carries its
 * eligibility status, because confirming, dropping, or restoring a team inside
 * the field changes qualification while an unrelated team elsewhere in the
 * tournament cannot.
 */
export function advancementBasisTeams(
  state: DirectorState,
  phase: Phase,
): Array<{ id: DirectorId; status: string }> {
  const ids = new Set<DirectorId>();
  for (const team of phaseCompetitiveField(state, phase.id).teams) ids.add(team.id);
  for (const poolId of phase.poolIds) {
    const pool = state.pools.find((entry) => entry.id === poolId);
    for (const teamId of pool?.teamIds ?? []) ids.add(teamId);
  }
  const statuses = new Map(state.teams.map((team) => [team.id, team.status]));
  return [...ids].sort().map((id) => ({ id, status: statuses.get(id) ?? 'missing' }));
}

export function advancementBasisToken(state: DirectorState, phase: Phase): string {
  const roundIds = new Set(phase.roundIds);
  return JSON.stringify({
    phase: {
      id: phase.id,
      status: phase.status,
      poolIds: phase.poolIds,
      advancementRule: phase.advancementRule,
      // An explicitly committed advancement field selects the preview outright.
      ...(phase.teamIds === undefined ? {} : { teamIds: phase.teamIds }),
    },
    pools: phase.poolIds.map((poolId) => state.pools.find((pool) => pool.id === poolId)?.teamIds ?? []),
    teams: advancementBasisTeams(state, phase),
    games: state.games.filter((game) => roundIds.has(game.roundId)),
    // The standings tiebreakers decide cutoffs, so they are part of the basis (#673). A
    // tiebreaker reorder after a commit must read as a changed basis, never silently
    // current. Scoring point values are deliberately excluded: accepted games resolve
    // under their pinned definitions, so a future-defaults save cannot move history.
    tiebreakers: phase.advancementRule?.tiebreakers ?? state.tournament?.rules.tiebreakers,
  });
}

/**
 * Which accepted truth a result record carries (#673). Records written before
 * revision tracking read as revision 1, so legacy tournaments verify exactly as
 * before until their first tracked correction.
 */
export function resultRevisionOf(game: Pick<GameRecord, 'resultRevision'>): number {
  return game.resultRevision ?? 1;
}

/** The accepted-result revisions a phase's advancement basis was verified against. */
export function resultRevisionsForPhase(state: DirectorState, phase: Phase): Record<DirectorId, number> {
  const roundIds = new Set(phase.roundIds);
  const revisions: Record<DirectorId, number> = {};
  for (const game of state.games) {
    if (roundIds.has(game.roundId)) revisions[game.id] = resultRevisionOf(game);
  }
  return revisions;
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
 * The pre-#727 basis token, which scoped games and pools to the phase but read
 * every confirmed tournament team. Kept so commits stored before the team
 * scoping still verify under the semantics they were committed with instead of
 * reading stale after the upgrade.
 */
export function advancementBasisTokenV1(state: DirectorState, phase: Phase): string {
  const roundIds = new Set(phase.roundIds);
  return JSON.stringify({
    phase: {
      id: phase.id,
      status: phase.status,
      poolIds: phase.poolIds,
      advancementRule: phase.advancementRule,
    },
    pools: phase.poolIds.map((poolId) => state.pools.find((pool) => pool.id === poolId)?.teamIds ?? []),
    teams: state.teams
      .filter((team) => team.status === 'confirmed' || team.status === 'exhibition')
      .map((team) => team.id),
    games: state.games.filter((game) => roundIds.has(game.roundId)),
    tiebreakers: phase.advancementRule?.tiebreakers ?? state.tournament?.rules.tiebreakers,
  });
}

/**
 * Whether the latest committed advancement for a phase still verifies (#673).
 *
 * Committed advancement is never presented as current unless its stored basis token
 * matches a fresh computation. Commits that predate basis tracking read as `unknown`,
 * which callers treat like `stale` with honest copy. Commits stored under the
 * pre-#727 global-teams token verify against that same computation, so the team
 * scoping upgrade never mass-invalidates existing bases.
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
  if (stored !== advancementBasisToken(state, phase) && stored !== advancementBasisTokenV1(state, phase)) {
    return 'stale';
  }
  // Commits that recorded the accepted-result revisions they verified against
  // (#673) also prove those revisions are still the canonical ones. Commits
  // that predate revision tracking skip this proof and verify by token alone.
  const storedRevisions =
    commit.details && typeof commit.details === 'object'
      ? (commit.details as Record<string, unknown>).resultRevisions
      : undefined;
  if (storedRevisions === undefined) return 'current';
  if (!isResultRevisionMap(storedRevisions)) return 'unknown';
  const currentRevisions = resultRevisionsForPhase(state, phase);
  const storedIds = Object.keys(storedRevisions);
  if (storedIds.length !== Object.keys(currentRevisions).length) return 'stale';
  return storedIds.every((gameId) => storedRevisions[gameId] === currentRevisions[gameId])
    ? 'current'
    : 'stale';
}

function isResultRevisionMap(value: unknown): value is Record<DirectorId, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === 'number');
}

/**
 * Invalidate the committed advancement bases a mutation retired (#673).
 *
 * The basis-token comparison stays the proof; this is the explicit record plus
 * the downstream repair signal: generated rounds in the commit target are
 * revision-bumped so prepared artifacts cut from them read stale and the round
 * must be repaired or regenerated, never silently kept. Only a basis that
 * verified before the mutation is invalidated by it; an already-stale basis
 * keeps its original invalidation record. Returns the invalidated source phase
 * ids.
 */
export function invalidateDependentAdvancementBases(
  before: DirectorState,
  draft: DirectorState,
  cause: string,
  details: Record<string, unknown> = {},
): DirectorId[] {
  const invalidated: DirectorId[] = [];
  for (const phase of draft.phases) {
    if (advancementBasisStatus(before, phase.id) !== 'current') continue;
    if (advancementBasisStatus(draft, phase.id) === 'current') continue;
    const commit = latestAdvancementCommit(draft, phase.id);
    const markedRoundIds = markGeneratedDownstreamStale(draft, commit?.entityId);
    invalidated.push(phase.id);
    draft.audit.push({
      id: newDirectorId('audit'),
      at: isoNow(),
      actor: 'Director',
      type: 'advancement-stale',
      summary: `Committed advancement from ${phase.name} no longer verifies against its source basis (${cause}). Recommit before downstream play.`,
      entityId: commit?.entityId,
      details: { sourcePhaseId: phase.id, cause, markedRoundIds, ...details },
    });
  }
  return invalidated;
}

/**
 * Revision-bump generated rounds in an advancement target so anything cut from
 * them (assignments, artifacts, sessions) reads stale after the basis moved.
 * Rounds with accepted/live results are left alone: played history is never
 * rewritten by an upstream correction (Tier 4 refuses before this runs).
 */
function markGeneratedDownstreamStale(
  draft: DirectorState,
  targetPhaseId: DirectorId | undefined,
): DirectorId[] {
  if (!targetPhaseId) return [];
  const target = draft.phases.find((entry) => entry.id === targetPhaseId);
  if (!target || !Array.isArray(target.roundIds)) return [];
  const marked: DirectorId[] = [];
  for (const roundId of target.roundIds) {
    const round = draft.rounds.find((entry) => entry.id === roundId);
    if (!round) continue;
    const hasGames = draft.scheduledGames.some((game) => game.roundId === roundId);
    if (!hasGames) continue;
    const hasPlayed = draft.scheduledGames.some(
      (game) =>
        game.roundId === roundId &&
        (game.status === 'accepted' || game.status === 'live' || game.status === 'submitted'),
    );
    if (hasPlayed) continue;
    round.revision += 1;
    marked.push(round.id);
  }
  return marked;
}

export function previewAdvancement(state: DirectorState, phase: Phase): AdvancementPreview {
  const rule = phase.advancementRule;
  const qualifiersPerPool = rule?.qualifiersPerPool ?? 0;
  const unresolved: AdvancementPreview['unresolved'] = [];
  // Exhibition teams keep their own aggregates but can never qualify out of a
  // phase on results; only an explicit TD assignment may place one in a later
  // phase (#895).
  const exhibitionIds = exhibitionTeamIdsOf(state);
  const excludedExhibition = new Set<DirectorId>();
  const poolStandings = standingsByPool(state, phase).map(({ poolId, standings }) => ({
    poolId,
    standings: standings.filter((standing) => {
      if (!exhibitionIds.has(standing.teamId)) return true;
      excludedExhibition.add(standing.teamId);
      return false;
    }),
  }));
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
      ...(excludedExhibition.size > 0
        ? [
            `${excludedExhibition.size} exhibition team(s) (${[...excludedExhibition]
              .map((teamId) => state.teams.find((team) => team.id === teamId)?.displayName ?? teamId)
              .join(
                ', ',
              )}) keep their own results but cannot qualify: exhibition teams advance only by explicit assignment.`,
          ]
        : []),
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
