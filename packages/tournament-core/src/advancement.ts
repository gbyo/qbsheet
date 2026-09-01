import type {
  AdvancementRule,
  AuditContext,
  EntityId,
  GameResult,
  Phase,
  Pool,
  ScheduledGame,
  TournamentSnapshot,
} from './model';
import { DomainError, recordAuditEvent } from './model';
import type { StandingsReport, TeamStandingRow } from './statistics';

export interface AdvancementOverride {
  readonly teamId: EntityId;
  readonly sourcePoolId: EntityId;
  readonly rank: number;
  readonly reason: string;
  readonly actor: string;
}

export interface AdvancementIssue {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly teamIds: readonly EntityId[];
  readonly poolId: EntityId | null;
}

export interface AdvancementAssignment {
  readonly teamId: EntityId;
  readonly sourcePoolId: EntityId;
  readonly sourceRank: number;
  readonly targetPoolId: EntityId;
  readonly targetPosition: number;
}

export interface CarryoverPreview {
  readonly sourceGameId: EntityId;
  readonly sourcePoolId: EntityId;
  readonly targetPoolId: EntityId;
  readonly teamAId: EntityId;
  readonly teamBId: EntityId;
  readonly scoreA: number;
  readonly scoreB: number;
}

export interface AdvancementPreview {
  readonly sourcePhaseId: EntityId;
  readonly targetPhaseId: EntityId;
  readonly assignments: readonly AdvancementAssignment[];
  readonly carryovers: readonly CarryoverPreview[];
  readonly issues: readonly AdvancementIssue[];
  readonly blocked: boolean;
}

export interface AdvancementInput {
  readonly sourcePhase: Phase;
  readonly sourcePools: readonly Pool[];
  readonly targetPhase: Phase;
  readonly targetPools: readonly Pool[];
  readonly standings: StandingsReport | readonly StandingsReport[];
  readonly scheduledGames: readonly ScheduledGame[];
  readonly acceptedResults: readonly GameResult[];
  readonly overrides?: readonly AdvancementOverride[];
}

function issue(
  code: string,
  severity: AdvancementIssue['severity'],
  message: string,
  poolId: EntityId | null = null,
  teamIds: readonly EntityId[] = [],
): AdvancementIssue {
  return { code, severity, message, poolId, teamIds };
}

function ruleForPhase(phase: Phase): AdvancementRule {
  return (
    phase.advancement ?? {
      qualifiersPerPool: null,
      totalQualifiers: null,
      targetPoolCount: null,
      seeding: 'snake',
      tiePolicy: 'block',
      carryover: 'none',
    }
  );
}

function reportsByPool(
  standings: StandingsReport | readonly StandingsReport[],
  sourcePools: readonly Pool[],
): Map<EntityId, TeamStandingRow[]> {
  const reports: readonly StandingsReport[] = Array.isArray(standings) ? standings : [standings];
  const byPool = new Map<EntityId, TeamStandingRow[]>();
  for (const pool of sourcePools) {
    const direct = reports.find((report) => report.rows.some((row) => row.poolId === pool.id));
    const report = direct ?? (reports.length === 1 ? reports[0] : undefined);
    const rows =
      report?.rows.filter(
        (row) =>
          row.poolId === pool.id ||
          (report.rows.length === pool.teamIds.length && report.rows.every((row) => row.poolId === null)),
      ) ?? [];
    byPool.set(
      pool.id,
      [...rows].sort((left, right) => left.rank - right.rank || left.teamId.localeCompare(right.teamId)),
    );
  }
  return byPool;
}

function overrideFor(
  overrides: readonly AdvancementOverride[],
  teamId: EntityId,
  poolId: EntityId,
): AdvancementOverride | undefined {
  return overrides.find((override) => override.teamId === teamId && override.sourcePoolId === poolId);
}

function sortWithOverrides(
  rows: readonly TeamStandingRow[],
  poolId: EntityId,
  overrides: readonly AdvancementOverride[],
  tiePolicy: AdvancementRule['tiePolicy'],
): TeamStandingRow[] {
  return [...rows].sort((left, right) => {
    const leftOverride = overrideFor(overrides, left.teamId, poolId);
    const rightOverride = overrideFor(overrides, right.teamId, poolId);
    const leftRank =
      leftOverride?.rank ??
      (tiePolicy === 'use-seed' && left.tieStatus === 'unresolved' && left.seed !== null
        ? left.seed
        : left.rank);
    const rightRank =
      rightOverride?.rank ??
      (tiePolicy === 'use-seed' && right.tieStatus === 'unresolved' && right.seed !== null
        ? right.seed
        : right.rank);
    return leftRank - rightRank || left.teamId.localeCompare(right.teamId);
  });
}

function unresolvedTieCrossingCutoff(
  rows: readonly TeamStandingRow[],
  cutoff: number,
  poolId: EntityId,
  overrides: readonly AdvancementOverride[],
  tiePolicy: AdvancementRule['tiePolicy'],
): EntityId[] {
  if (tiePolicy === 'use-seed' || cutoff < 1) return [];
  const ordered = sortWithOverrides(rows, poolId, overrides, tiePolicy);
  const groups = new Map<number, TeamStandingRow[]>();
  for (const row of rows) {
    if (row.tieStatus !== 'unresolved') continue;
    const group = groups.get(row.rank) ?? [];
    group.push(row);
    groups.set(row.rank, group);
  }
  for (const group of groups.values()) {
    if (group.length < 2 || group.every((row) => overrideFor(overrides, row.teamId, poolId))) continue;
    const positions = group.map((row) => ordered.indexOf(row));
    const firstPosition = Math.min(...positions);
    const lastPosition = Math.max(...positions);
    if (firstPosition < cutoff && lastPosition >= cutoff) return group.map((row) => row.teamId);
  }
  return [];
}

function completeTieGroup(rows: readonly TeamStandingRow[], teamIds: readonly EntityId[]): boolean {
  const tieIds = new Set(teamIds);
  return rows.filter((row) => tieIds.has(row.teamId)).every((row) => row.tieStatus === 'unresolved');
}

function targetPoolOrder(targetPools: readonly Pool[]): Pool[] {
  return [...targetPools].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

function assignTargetPool(
  targetPools: readonly Pool[],
  index: number,
  seeding: AdvancementRule['seeding'],
): { readonly pool: Pool; readonly position: number } {
  const pools = targetPoolOrder(targetPools);
  const poolCount = pools.length;
  if (poolCount === 0)
    throw new DomainError('Advancement needs at least one target pool.', 'missing-target-pool');
  const row = Math.floor(index / poolCount);
  const slot = index % poolCount;
  const poolIndex = seeding === 'snake' && row % 2 === 1 ? poolCount - 1 - slot : slot;
  return { pool: pools[poolIndex], position: row * poolCount + slot + 1 };
}

function buildCarryovers(
  rule: AdvancementRule,
  sourcePhase: Phase,
  assignments: readonly AdvancementAssignment[],
  scheduledGames: readonly ScheduledGame[],
  acceptedResults: readonly GameResult[],
): CarryoverPreview[] {
  if (rule.carryover === 'none') return [];
  const assignmentByTeam = new Map(assignments.map((assignment) => [assignment.teamId, assignment]));
  const gamesById = new Map(scheduledGames.map((game) => [game.id, game]));
  const resultsByGame = new Map<string, GameResult>();
  for (const result of acceptedResults) {
    if (result.reviewStatus === 'accepted') resultsByGame.set(result.scheduledGameId, result);
  }
  const carryovers: CarryoverPreview[] = [];
  for (const [gameId, result] of resultsByGame) {
    const game = gamesById.get(gameId);
    if (!game || game.kind === 'bye' || game.phaseId !== sourcePhase.id) continue;
    const left = assignmentByTeam.get(game.teamAId);
    const right = assignmentByTeam.get(game.teamBId);
    if (!left || !right || left.targetPoolId !== right.targetPoolId) continue;
    if (rule.carryover === 'intra-pool' && left.sourcePoolId !== right.sourcePoolId) continue;
    const scoreA = result.teamScores.find((score) => score.teamId === game.teamAId);
    const scoreB = result.teamScores.find((score) => score.teamId === game.teamBId);
    if (!scoreA || !scoreB) continue;
    carryovers.push({
      sourceGameId: game.id,
      sourcePoolId: left.sourcePoolId,
      targetPoolId: left.targetPoolId,
      teamAId: game.teamAId,
      teamBId: game.teamBId,
      scoreA: scoreA.score,
      scoreB: scoreB.score,
    });
  }
  return carryovers.sort((left, right) => left.sourceGameId.localeCompare(right.sourceGameId));
}

/** Preview advancement/rebracketing and report ambiguous cut lines instead of guessing. */
export function previewAdvancement(input: AdvancementInput): AdvancementPreview {
  const rule = ruleForPhase(input.sourcePhase);
  const issues: AdvancementIssue[] = [];
  const byPool = reportsByPool(input.standings, input.sourcePools);
  const overrides = input.overrides ?? [];
  const selected: { row: TeamStandingRow; sourcePoolId: EntityId }[] = [];

  if (input.sourcePhase.id === input.targetPhase.id) {
    issues.push(issue('same-phase', 'error', 'Advancement source and target phases must differ.'));
  }
  if (input.targetPools.length === 0) {
    issues.push(issue('missing-target-pool', 'error', 'Advancement needs at least one target pool.', null));
  }
  if (
    rule.qualifiersPerPool !== null &&
    (!Number.isInteger(rule.qualifiersPerPool) || rule.qualifiersPerPool < 1)
  ) {
    issues.push(issue('invalid-qualifier-count', 'error', 'qualifiersPerPool must be a positive integer.'));
  }
  if (
    rule.totalQualifiers !== null &&
    (!Number.isInteger(rule.totalQualifiers) || rule.totalQualifiers < 1)
  ) {
    issues.push(issue('invalid-qualifier-count', 'error', 'totalQualifiers must be a positive integer.'));
  }
  if (rule.qualifiersPerPool !== null && rule.totalQualifiers !== null) {
    issues.push(
      issue(
        'conflicting-qualifier-counts',
        'error',
        'Configure either qualifiersPerPool or totalQualifiers, not both.',
      ),
    );
  }
  const sourcePoolIds = new Set(input.sourcePools.map((pool) => pool.id));
  const targetPoolIds = new Set(input.targetPools.map((pool) => pool.id));
  if (sourcePoolIds.size !== input.sourcePools.length) {
    issues.push(issue('duplicate-source-pool', 'error', 'Source pools must have unique ids.'));
  }
  if (targetPoolIds.size !== input.targetPools.length) {
    issues.push(issue('duplicate-target-pool', 'error', 'Target pools must have unique ids.'));
  }
  if (input.sourcePools.some((pool) => pool.phaseId !== input.sourcePhase.id)) {
    issues.push(issue('invalid-source-pool', 'error', 'Every source pool must belong to the source phase.'));
  }
  if (input.targetPools.some((pool) => pool.phaseId !== input.targetPhase.id)) {
    issues.push(issue('invalid-target-pool', 'error', 'Every target pool must belong to the target phase.'));
  }
  const seenOverrideTeams = new Set<string>();
  for (const override of overrides) {
    const key = `${override.sourcePoolId}\u0000${override.teamId}`;
    if (seenOverrideTeams.has(key)) {
      issues.push(
        issue(
          'duplicate-override',
          'error',
          `Team “${override.teamId}” has more than one advancement override.`,
          override.sourcePoolId,
          [override.teamId],
        ),
      );
    }
    seenOverrideTeams.add(key);
    if (!sourcePoolIds.has(override.sourcePoolId)) {
      issues.push(
        issue(
          'invalid-override-pool',
          'error',
          `Advancement override references source pool “${override.sourcePoolId}”.`,
          override.sourcePoolId,
          [override.teamId],
        ),
      );
    } else if (
      !input.sourcePools.find((pool) => pool.id === override.sourcePoolId)?.teamIds.includes(override.teamId)
    ) {
      issues.push(
        issue(
          'invalid-override-team',
          'error',
          `Advancement override team “${override.teamId}” is not in source pool “${override.sourcePoolId}”.`,
          override.sourcePoolId,
          [override.teamId],
        ),
      );
    }
    if (!Number.isInteger(override.rank) || override.rank < 1) {
      issues.push(
        issue(
          'invalid-override-rank',
          'error',
          `Advancement override for “${override.teamId}” must use a positive integer rank.`,
          override.sourcePoolId,
          [override.teamId],
        ),
      );
    }
    if (!override.reason.trim() || !override.actor.trim()) {
      issues.push(
        issue(
          'incomplete-override',
          'error',
          `Advancement override for “${override.teamId}” needs a reason and operator.`,
          override.sourcePoolId,
          [override.teamId],
        ),
      );
    }
  }

  if (rule.totalQualifiers !== null) {
    const allRows = [...byPool.entries()].flatMap(([sourcePoolId, rows]) =>
      rows.map((row) => ({ row, sourcePoolId })),
    );
    for (const pool of input.sourcePools) {
      const rows = byPool.get(pool.id) ?? [];
      if (rows.length !== pool.teamIds.length) {
        issues.push(
          issue(
            'incomplete-standings',
            'error',
            `Pool “${pool.name}” has standings for ${rows.length} of ${pool.teamIds.length} teams.`,
            pool.id,
            pool.teamIds.filter((teamId) => !rows.some((row) => row.teamId === teamId)),
          ),
        );
      }
    }
    const globalRank = (candidate: {
      readonly row: TeamStandingRow;
      readonly sourcePoolId: EntityId;
    }): number => {
      const override = overrideFor(overrides, candidate.row.teamId, candidate.sourcePoolId);
      if (override) return override.rank;
      if (
        rule.tiePolicy === 'use-seed' &&
        candidate.row.tieStatus === 'unresolved' &&
        candidate.row.seed !== null
      )
        return candidate.row.seed;
      return candidate.row.rank;
    };
    allRows.sort(
      (left, right) =>
        globalRank(left) - globalRank(right) ||
        left.sourcePoolId.localeCompare(right.sourcePoolId) ||
        left.row.teamId.localeCompare(right.row.teamId),
    );
    const cutoff = rule.totalQualifiers;
    if (cutoff > allRows.length) {
      issues.push(
        issue(
          'too-many-qualifiers',
          'error',
          `The advancement requests ${cutoff} qualifiers, but only ${allRows.length} standings rows exist.`,
        ),
      );
    }
    const unresolvedGroups = new Map<
      string,
      { readonly row: TeamStandingRow; readonly sourcePoolId: EntityId }[]
    >();
    for (const candidate of allRows) {
      if (candidate.row.tieStatus !== 'unresolved') continue;
      const key = `${candidate.sourcePoolId}\u0000${candidate.row.rank}`;
      const group = unresolvedGroups.get(key) ?? [];
      group.push(candidate);
      unresolvedGroups.set(key, group);
    }
    for (const group of unresolvedGroups.values()) {
      if (
        group.length < 2 ||
        group.every((candidate) => overrideFor(overrides, candidate.row.teamId, candidate.sourcePoolId))
      )
        continue;
      const positions = group.map((candidate) => allRows.indexOf(candidate));
      if (
        Math.min(...positions) < cutoff &&
        Math.max(...positions) >= cutoff &&
        rule.tiePolicy !== 'use-seed'
      ) {
        issues.push(
          issue(
            'ambiguous-cutoff',
            'error',
            'The total qualifier cut line contains an unresolved tie; a tiebreaker or complete override is required.',
            null,
            group.map((candidate) => candidate.row.teamId),
          ),
        );
      }
    }
    selected.push(...allRows.slice(0, cutoff));
  } else {
    const qualifiersPerPool = rule.qualifiersPerPool ?? 0;
    if (qualifiersPerPool === 0)
      issues.push(
        issue(
          'missing-qualifier-count',
          'error',
          'Configure qualifiersPerPool or totalQualifiers before advancing.',
        ),
      );
    for (const pool of input.sourcePools) {
      const rows = byPool.get(pool.id) ?? [];
      if (rows.length !== pool.teamIds.length) {
        issues.push(
          issue(
            'incomplete-standings',
            'error',
            `Pool “${pool.name}” has standings for ${rows.length} of ${pool.teamIds.length} teams.`,
            pool.id,
            pool.teamIds.filter((teamId) => !rows.some((row) => row.teamId === teamId)),
          ),
        );
      }
      if (qualifiersPerPool > rows.length) {
        issues.push(
          issue(
            'too-many-qualifiers',
            'error',
            `Pool “${pool.name}” has only ${rows.length} standings rows for ${qualifiersPerPool} qualifiers.`,
            pool.id,
          ),
        );
      }
      const cutoffTeamIds = unresolvedTieCrossingCutoff(
        rows,
        qualifiersPerPool,
        pool.id,
        overrides,
        rule.tiePolicy,
      );
      if (cutoffTeamIds.length > 0) {
        issues.push(
          issue(
            'ambiguous-cutoff',
            'error',
            `Pool “${pool.name}” has an unresolved tie at the advancement cut line.`,
            pool.id,
            cutoffTeamIds,
          ),
        );
      }
      const ordered = sortWithOverrides(rows, pool.id, overrides, rule.tiePolicy);
      selected.push(...ordered.slice(0, qualifiersPerPool).map((row) => ({ row, sourcePoolId: pool.id })));
      const tieGroupIds = ordered
        .filter((row) => row.rank === qualifiersPerPool && row.tieStatus === 'unresolved')
        .map((row) => row.teamId);
      if (tieGroupIds.length > 1 && !completeTieGroup(ordered, tieGroupIds)) {
        issues.push(
          issue(
            'incomplete-standings',
            'warning',
            `Pool “${pool.name}” standings contain a tie marker without a complete tie group.`,
            pool.id,
            tieGroupIds,
          ),
        );
      }
    }
  }

  const targetPoolCount = rule.targetPoolCount ?? input.targetPools.length;
  if (targetPoolCount !== input.targetPools.length) {
    issues.push(
      issue(
        'target-pool-count-mismatch',
        'error',
        `Advancement expects ${targetPoolCount} target pools but received ${input.targetPools.length}.`,
      ),
    );
  }
  const assignments: AdvancementAssignment[] = [];
  if (issues.every((current) => current.severity !== 'error')) {
    const orderedSelected = [...selected].sort(
      (left, right) =>
        left.row.rank - right.row.rank ||
        left.sourcePoolId.localeCompare(right.sourcePoolId) ||
        left.row.teamId.localeCompare(right.row.teamId),
    );
    orderedSelected.forEach((candidate, index) => {
      const target = assignTargetPool(input.targetPools, index, rule.seeding);
      assignments.push({
        teamId: candidate.row.teamId,
        sourcePoolId: candidate.sourcePoolId,
        sourceRank: candidate.row.rank,
        targetPoolId: target.pool.id,
        targetPosition: target.position,
      });
    });
  }
  const carryovers = buildCarryovers(
    rule,
    input.sourcePhase,
    assignments,
    input.scheduledGames,
    input.acceptedResults,
  );
  return {
    sourcePhaseId: input.sourcePhase.id,
    targetPhaseId: input.targetPhase.id,
    assignments,
    carryovers,
    issues,
    blocked: issues.some((current) => current.severity === 'error'),
  };
}

/** Commit a previously-reviewed preview to a snapshot, retaining a durable audit event. */
export function commitAdvancementPreview(
  snapshot: TournamentSnapshot,
  preview: AdvancementPreview,
  context: AuditContext = {},
): TournamentSnapshot {
  if (preview.blocked)
    throw new DomainError('Cannot commit a blocked advancement preview.', 'advancement-blocked');
  const sourcePhase = snapshot.phases.find((phase) => phase.id === preview.sourcePhaseId);
  if (!sourcePhase) throw new DomainError('Advancement source phase does not exist.', 'missing-phase');
  const targetPhase = snapshot.phases.find((phase) => phase.id === preview.targetPhaseId);
  if (!targetPhase) throw new DomainError('Advancement target phase does not exist.', 'missing-phase');
  const poolsById = new Map(snapshot.pools.map((pool) => [pool.id, pool]));
  const teamsById = new Set(snapshot.teams.map((team) => team.id));
  const assignedTeams = new Set<EntityId>();
  for (const assignment of preview.assignments) {
    const sourcePool = poolsById.get(assignment.sourcePoolId);
    const targetPool = poolsById.get(assignment.targetPoolId);
    if (!teamsById.has(assignment.teamId)) {
      throw new DomainError(`Advanced team “${assignment.teamId}” does not exist.`, 'missing-team');
    }
    if (
      !sourcePool ||
      sourcePool.phaseId !== sourcePhase.id ||
      !sourcePool.teamIds.includes(assignment.teamId)
    ) {
      throw new DomainError(
        `Team “${assignment.teamId}” is not in the advancement source pool.`,
        'invalid-source-pool',
      );
    }
    if (!targetPool || targetPool.phaseId !== targetPhase.id) {
      throw new DomainError(
        `Advancement target pool “${assignment.targetPoolId}” is invalid.`,
        'invalid-target-pool',
      );
    }
    if (assignedTeams.has(assignment.teamId)) {
      throw new DomainError(
        `Team “${assignment.teamId}” appears more than once in the advancement preview.`,
        'duplicate-advancement-team',
      );
    }
    assignedTeams.add(assignment.teamId);
  }
  const targetPoolIds = new Set(preview.assignments.map((assignment) => assignment.targetPoolId));
  const assignmentsByPool = new Map<EntityId, EntityId[]>();
  for (const assignment of preview.assignments) {
    const teamIds = assignmentsByPool.get(assignment.targetPoolId) ?? [];
    teamIds.push(assignment.teamId);
    assignmentsByPool.set(assignment.targetPoolId, teamIds);
  }
  const updatedPools = snapshot.pools.map((pool) =>
    targetPoolIds.has(pool.id) ? { ...pool, teamIds: assignmentsByPool.get(pool.id) ?? [] } : pool,
  );
  const now = context.clock?.now() ?? new Date().toISOString();
  const updatedPhases = snapshot.phases.map((phase) =>
    phase.id === preview.targetPhaseId ? { ...phase, status: 'scheduled' as const } : phase,
  );
  return recordAuditEvent(
    { ...snapshot, pools: updatedPools, phases: updatedPhases },
    {
      actor: context.actor?.trim() || 'system',
      type: 'advancement-committed',
      entityType: 'phase',
      entityId: preview.targetPhaseId,
      summary: `Committed advancement into ${assignmentsByPool.size} target pools.`,
      details: {
        sourcePhaseId: preview.sourcePhaseId,
        targetPhaseId: preview.targetPhaseId,
        assignments: preview.assignments.map((assignment) => ({
          teamId: assignment.teamId,
          sourcePoolId: assignment.sourcePoolId,
          targetPoolId: assignment.targetPoolId,
          sourceRank: assignment.sourceRank,
        })),
        carryovers: preview.carryovers.map((carryover) => carryover.sourceGameId),
        committedAt: now,
      },
      undoable: false,
    },
    context,
  );
}
