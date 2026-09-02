/**
 * Forming afternoon playoff divisions from preliminary standings.
 *
 * `advancement.ts` answers "which teams move on and into which target pool" for a rebracket whose
 * target pools are interchangeable. A playoff division is not interchangeable: its membership is a
 * statement about the morning ("first and second from each pool"), and its internal order is a seed
 * that decides who receives a first-round bye. So this module produces an ordered, explained
 * membership list rather than a set.
 *
 * The one rule that shapes everything here: preliminary pools of different sizes play different
 * numbers of games, so **raw win totals are not comparable across them**. Every global comparison
 * therefore requires an explicitly configured basis, and asking for `wins` across unequal schedules
 * is refused rather than quietly answered.
 */

import type { EntityId, TiePolicy } from './model';
import type { TeamStandingRow } from './statistics';

export type DivisionPlacementMethod = 'pool-placement' | 'global-seed';

/**
 * How teams from different preliminary pools are compared to each other.
 *
 * `wins` is offered because a tournament whose pools all played the same number of games may
 * legitimately want it; it is rejected when the schedules are unequal.
 */
export type GlobalRankingBasis = 'win-percentage' | 'points-per-game' | 'points-per-tossup-heard' | 'wins';

export interface DivisionDefinition {
  readonly id: EntityId;
  readonly name: string;
  readonly order: number;
  /**
   * Pool-placement method: the finishing places this division takes from every preliminary pool,
   * 1-based. `Championship: [1, 2]`.
   */
  readonly placements?: readonly number[];
  /** Global-seed method: the inclusive overall seed range, `to: null` meaning "and below". */
  readonly seedRange?: { readonly from: number; readonly to: number | null };
  /** Take whatever teams the earlier divisions did not. At most one division may set this. */
  readonly remainder?: boolean;
}

export interface DivisionOverride {
  readonly teamId: EntityId;
  readonly divisionId: EntityId;
  /** 1-based seed inside the target division. Omit to append at the end of that division. */
  readonly seed?: number;
  readonly reason: string;
  readonly actor: string;
}

export interface PoolStandings {
  readonly poolId: EntityId;
  readonly poolName: string;
  readonly rows: readonly TeamStandingRow[];
}

export interface DivisionPlacementIssue {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly teamIds: readonly EntityId[];
  readonly divisionId: EntityId | null;
  readonly poolId: EntityId | null;
}

export type PlacementReasonKind = 'pool-placement' | 'global-seed' | 'remainder' | 'manual-override';

export interface DivisionMember {
  readonly teamId: EntityId;
  /** 1-based seed inside this division; drives the bracket draw. */
  readonly seed: number;
  readonly sourcePoolId: EntityId | null;
  readonly sourcePoolName: string;
  /** Finishing place inside the preliminary pool, 1-based. */
  readonly sourceRank: number;
  /** Overall rank across every preliminary pool, when a ranking basis was computed. */
  readonly overallRank: number | null;
  readonly reasonKind: PlacementReasonKind;
  /** Short, operator-facing: `Pool A · 1st`, `Overall seed 5`, `Manual override`. */
  readonly reason: string;
  readonly manual: boolean;
  readonly tieStatus: TeamStandingRow['tieStatus'];
}

export interface DivisionPreview {
  readonly id: EntityId;
  readonly name: string;
  readonly order: number;
  readonly members: readonly DivisionMember[];
}

export interface UnresolvedPlacementTie {
  readonly teamIds: readonly EntityId[];
  readonly poolId: EntityId | null;
  /** What the unresolved tie would decide if left alone. */
  readonly affects: 'division-membership' | 'bracket-seed';
  readonly message: string;
}

export interface DivisionPlacementPreview {
  readonly method: DivisionPlacementMethod;
  readonly rankingBasis: GlobalRankingBasis | null;
  readonly divisions: readonly DivisionPreview[];
  /** Teams that no division claimed, which is a configuration error rather than a silent drop. */
  readonly unplacedTeamIds: readonly EntityId[];
  readonly issues: readonly DivisionPlacementIssue[];
  readonly unresolvedTies: readonly UnresolvedPlacementTie[];
  readonly overrides: readonly DivisionOverride[];
  readonly blocked: boolean;
}

export interface DivisionPlacementInput {
  readonly method: DivisionPlacementMethod;
  readonly divisions: readonly DivisionDefinition[];
  readonly poolStandings: readonly PoolStandings[];
  /**
   * Required whenever teams from different pools are compared: always for `global-seed`, and for
   * `pool-placement` to order the teams that share a finishing place.
   */
  readonly rankingBasis?: GlobalRankingBasis;
  readonly tiePolicy?: TiePolicy;
  readonly overrides?: readonly DivisionOverride[];
}

function issue(
  code: string,
  severity: DivisionPlacementIssue['severity'],
  message: string,
  extra: Partial<Pick<DivisionPlacementIssue, 'teamIds' | 'divisionId' | 'poolId'>> = {},
): DivisionPlacementIssue {
  return {
    code,
    severity,
    message,
    teamIds: extra.teamIds ?? [],
    divisionId: extra.divisionId ?? null,
    poolId: extra.poolId ?? null,
  };
}

function ordinal(value: number): string {
  const remainderHundred = value % 100;
  if (remainderHundred >= 11 && remainderHundred <= 13) return `${value}th`;
  switch (value % 10) {
    case 1:
      return `${value}st`;
    case 2:
      return `${value}nd`;
    case 3:
      return `${value}rd`;
    default:
      return `${value}th`;
  }
}

function basisValue(row: TeamStandingRow, basis: GlobalRankingBasis): number {
  switch (basis) {
    case 'win-percentage':
      return row.winPercentage;
    case 'points-per-game':
      return row.pointsPerGame;
    case 'points-per-tossup-heard':
      return row.pointsPerTossupHeard;
    case 'wins':
      return row.wins;
  }
}

export function describeRankingBasis(basis: GlobalRankingBasis): string {
  switch (basis) {
    case 'win-percentage':
      return 'winning percentage';
    case 'points-per-game':
      return 'points per game';
    case 'points-per-tossup-heard':
      return 'points per tossup heard';
    case 'wins':
      return 'raw wins';
  }
}

interface Candidate {
  readonly row: TeamStandingRow;
  readonly poolId: EntityId;
  readonly poolName: string;
}

/** Every distinct games-played value across the preliminary pools. */
function gamesPlayedSpread(poolStandings: readonly PoolStandings[]): number[] {
  const counts = new Set<number>();
  for (const pool of poolStandings) {
    for (const row of pool.rows) counts.add(row.gamesPlayed);
  }
  return [...counts].sort((left, right) => left - right);
}

/**
 * Rank every team across every preliminary pool on one explicit basis.
 *
 * Ordering inside an equal basis value falls back to the finishing place inside the pool, which is
 * the only comparison that is definitely fair: it was decided by the tournament's own tiebreakers
 * against opponents that team actually played.
 */
function globalOrder(candidates: readonly Candidate[], basis: GlobalRankingBasis): Candidate[] {
  return [...candidates].sort(
    (left, right) =>
      basisValue(right.row, basis) - basisValue(left.row, basis) ||
      left.row.rank - right.row.rank ||
      right.row.margin - left.row.margin ||
      right.row.pointsFor - left.row.pointsFor ||
      left.row.teamId.localeCompare(right.row.teamId),
  );
}

function sameBasisValue(left: number, right: number): boolean {
  return Math.abs(left - right) < 1e-9;
}

/**
 * Which statistic actually put one of these two teams ahead of the other, if any did.
 *
 * Two teams from different preliminary pools never played the same opponents, so nothing about
 * their pool finish orders them; only these cross-pool statistics do. When none of them separates
 * the pair, their seed order — and therefore, near the top of a division, who receives a protected
 * first-round bye — would be decided by identifier order, which is not a tiebreak. That case is
 * reported instead.
 */
function separatingStatistic(
  left: TeamStandingRow,
  right: TeamStandingRow,
  basis: GlobalRankingBasis,
): string | null {
  if (!sameBasisValue(basisValue(left, basis), basisValue(right, basis))) return describeRankingBasis(basis);
  if (left.margin !== right.margin) return 'point differential';
  if (left.pointsFor !== right.pointsFor) return 'points scored';
  return null;
}

/**
 * Preview the afternoon's divisions without changing anything.
 *
 * Nothing here is committed and nothing is guessed: a tie that would decide division membership, a
 * bracket seed, or therefore a first-round bye is reported and blocks, rather than being broken by
 * whichever team happens to sort first.
 */
export function previewDivisionPlacement(input: DivisionPlacementInput): DivisionPlacementPreview {
  const issues: DivisionPlacementIssue[] = [];
  const unresolvedTies: UnresolvedPlacementTie[] = [];
  const overrides = input.overrides ?? [];
  const tiePolicy: TiePolicy = input.tiePolicy ?? 'block';
  const divisions = [...input.divisions].sort(
    (left, right) => left.order - right.order || left.id.localeCompare(right.id),
  );

  if (divisions.length === 0) {
    issues.push(issue('no-divisions', 'error', 'Configure at least one playoff division.'));
  }
  if (new Set(divisions.map((division) => division.id)).size !== divisions.length) {
    issues.push(issue('duplicate-division', 'error', 'Playoff divisions must have unique identifiers.'));
  }
  if (divisions.filter((division) => division.remainder).length > 1) {
    issues.push(
      issue('multiple-remainder-divisions', 'error', 'Only one division can take the remaining teams.'),
    );
  }

  const candidates: Candidate[] = input.poolStandings.flatMap((pool) =>
    pool.rows.map((row) => ({ row, poolId: pool.poolId, poolName: pool.poolName })),
  );
  if (candidates.length === 0) {
    issues.push(issue('no-standings', 'error', 'Preliminary standings are required before placement.'));
  }
  const duplicateTeams = candidates
    .map((candidate) => candidate.row.teamId)
    .filter((teamId, index, all) => all.indexOf(teamId) !== index);
  if (duplicateTeams.length > 0) {
    issues.push(
      issue('duplicate-team', 'error', 'A team appears in more than one preliminary pool.', {
        teamIds: [...new Set(duplicateTeams)],
      }),
    );
  }

  const spread = gamesPlayedSpread(input.poolStandings);
  const unequalSchedules = spread.length > 1;
  const basis = input.rankingBasis ?? null;

  if (input.method === 'global-seed') {
    if (!basis) {
      issues.push(
        issue(
          'missing-ranking-basis',
          'error',
          'A global seeded ranking needs an explicit ranking basis before it can compare pools.',
        ),
      );
    } else if (unequalSchedules && basis === 'wins') {
      issues.push(
        issue(
          'unequal-schedule-raw-wins',
          'error',
          `Preliminary pools played ${spread.join(' and ')} games, so raw wins cannot rank teams across them. Choose winning percentage or a per-game basis.`,
        ),
      );
    } else if (unequalSchedules) {
      issues.push(
        issue(
          'unequal-schedule-note',
          'warning',
          `Preliminary pools played ${spread.join(' and ')} games; teams are ranked by ${describeRankingBasis(basis)}.`,
        ),
      );
    }
  } else if (unequalSchedules && basis === 'wins') {
    issues.push(
      issue(
        'unequal-schedule-raw-wins',
        'error',
        `Preliminary pools played ${spread.join(' and ')} games, so raw wins cannot order teams that finished in the same place. Choose winning percentage or a per-game basis.`,
      ),
    );
  }

  const overrideByTeam = new Map<EntityId, DivisionOverride>();
  const knownTeamIds = new Set(candidates.map((candidate) => candidate.row.teamId));
  const divisionIds = new Set(divisions.map((division) => division.id));
  for (const override of overrides) {
    if (overrideByTeam.has(override.teamId)) {
      issues.push(
        issue('duplicate-override', 'error', 'A team has more than one division override.', {
          teamIds: [override.teamId],
        }),
      );
    }
    if (!knownTeamIds.has(override.teamId)) {
      issues.push(
        issue('unknown-override-team', 'error', 'A division override names a team with no standings row.', {
          teamIds: [override.teamId],
        }),
      );
    }
    if (!divisionIds.has(override.divisionId)) {
      issues.push(
        issue('unknown-override-division', 'error', 'A division override names an unknown division.', {
          teamIds: [override.teamId],
          divisionId: override.divisionId,
        }),
      );
    }
    if (!override.reason.trim() || !override.actor.trim()) {
      issues.push(
        issue(
          'incomplete-override',
          'error',
          'A manual division change needs a reason and the operator who made it.',
          { teamIds: [override.teamId], divisionId: override.divisionId },
        ),
      );
    }
    overrideByTeam.set(override.teamId, override);
  }

  const effectiveBasis: GlobalRankingBasis = basis ?? 'win-percentage';
  const ranked = globalOrder(candidates, effectiveBasis);
  const overallRankByTeam = new Map<EntityId, number>();
  ranked.forEach((candidate, index) => overallRankByTeam.set(candidate.row.teamId, index + 1));

  interface Draft {
    readonly definition: DivisionDefinition;
    readonly members: DivisionMember[];
  }
  const drafts: Draft[] = divisions.map((definition) => ({ definition, members: [] }));
  const draftById = new Map(drafts.map((draft) => [draft.definition.id, draft]));
  const claimed = new Set<EntityId>();

  const pushMember = (
    draft: Draft,
    candidate: Candidate,
    reasonKind: PlacementReasonKind,
    reason: string,
  ): void => {
    claimed.add(candidate.row.teamId);
    draft.members.push({
      teamId: candidate.row.teamId,
      seed: 0,
      sourcePoolId: candidate.poolId,
      sourcePoolName: candidate.poolName,
      sourceRank: candidate.row.rank,
      overallRank: overallRankByTeam.get(candidate.row.teamId) ?? null,
      reasonKind,
      reason,
      manual: false,
      tieStatus: candidate.row.tieStatus,
    });
  };

  const candidateByTeam = new Map(candidates.map((candidate) => [candidate.row.teamId, candidate]));

  // A pool's finishing places are *positions*, not rank values: two teams tied for first occupy
  // places one and two, and there is no row whose rank is two. Reading places off positions is what
  // lets an unresolved tie still produce a complete preview for the director to rule on.
  const poolPositions = new Map<EntityId, Candidate[]>(
    input.poolStandings.map((pool) => [
      pool.poolId,
      globalOrder(
        pool.rows.map((row) => ({ row, poolId: pool.poolId, poolName: pool.poolName })),
        effectiveBasis,
      ).sort((left, right) => left.row.rank - right.row.rank),
    ]),
  );

  if (input.method === 'pool-placement') {
    for (const draft of drafts) {
      if (draft.definition.remainder) continue;
      const placements = [...(draft.definition.placements ?? [])].sort((left, right) => left - right);
      if (placements.length === 0) {
        issues.push(
          issue(
            'missing-placements',
            'error',
            `Division “${draft.definition.name}” takes no finishing places from the preliminary pools.`,
            { divisionId: draft.definition.id },
          ),
        );
        continue;
      }
      for (const placement of placements) {
        if (!Number.isInteger(placement) || placement < 1) {
          issues.push(
            issue('invalid-placement', 'error', 'Finishing places must be positive whole numbers.', {
              divisionId: draft.definition.id,
            }),
          );
          continue;
        }
        const atPlacement = input.poolStandings
          .map((pool) => poolPositions.get(pool.poolId)?.[placement - 1] ?? null)
          .filter((entry): entry is Candidate => entry !== null);
        // Teams that finished in the same place in different pools are ordered against each other by
        // the configured basis, never by raw wins across unequal schedules.
        for (const candidate of globalOrder(atPlacement, effectiveBasis)) {
          if (claimed.has(candidate.row.teamId)) continue;
          pushMember(draft, candidate, 'pool-placement', `${candidate.poolName} · ${ordinal(placement)}`);
        }
      }
    }
  } else {
    for (const draft of drafts) {
      if (draft.definition.remainder) continue;
      const range = draft.definition.seedRange;
      if (!range || !Number.isInteger(range.from) || range.from < 1) {
        issues.push(
          issue(
            'missing-seed-range',
            'error',
            `Division “${draft.definition.name}” has no overall seed range.`,
            { divisionId: draft.definition.id },
          ),
        );
        continue;
      }
      const to = range.to ?? ranked.length;
      if (to < range.from) {
        issues.push(
          issue(
            'invalid-seed-range',
            'error',
            `Division “${draft.definition.name}” has an empty seed range.`,
            {
              divisionId: draft.definition.id,
            },
          ),
        );
        continue;
      }
      for (let position = range.from; position <= to; position += 1) {
        const candidate = ranked[position - 1];
        if (!candidate || claimed.has(candidate.row.teamId)) continue;
        pushMember(draft, candidate, 'global-seed', `Overall seed ${position}`);
      }
    }
  }

  const remainderDraft = drafts.find((draft) => draft.definition.remainder);
  if (remainderDraft) {
    for (const candidate of ranked) {
      if (claimed.has(candidate.row.teamId)) continue;
      const place =
        (poolPositions
          .get(candidate.poolId)
          ?.findIndex((entry) => entry.row.teamId === candidate.row.teamId) ?? -1) + 1;
      pushMember(
        remainderDraft,
        candidate,
        'remainder',
        input.method === 'pool-placement' && place > 0
          ? `${candidate.poolName} · ${ordinal(place)}`
          : `Overall seed ${overallRankByTeam.get(candidate.row.teamId) ?? 0}`,
      );
    }
  }

  // Manual moves are applied last so they win against the automatic placement, and are marked so a
  // later recompute cannot quietly erase them.
  for (const override of overrides) {
    const target = draftById.get(override.divisionId);
    const candidate = candidateByTeam.get(override.teamId);
    if (!target || !candidate) continue;
    for (const draft of drafts) {
      const index = draft.members.findIndex((member) => member.teamId === override.teamId);
      if (index >= 0) draft.members.splice(index, 1);
    }
    const member: DivisionMember = {
      teamId: candidate.row.teamId,
      seed: 0,
      sourcePoolId: candidate.poolId,
      sourcePoolName: candidate.poolName,
      sourceRank: candidate.row.rank,
      overallRank: overallRankByTeam.get(candidate.row.teamId) ?? null,
      reasonKind: 'manual-override',
      reason: `Manual override · ${override.reason.trim()}`,
      manual: true,
      tieStatus: candidate.row.tieStatus,
    };
    const seat =
      override.seed && override.seed >= 1
        ? Math.min(override.seed - 1, target.members.length)
        : target.members.length;
    target.members.splice(seat, 0, member);
    claimed.add(override.teamId);
  }

  const unplacedTeamIds = candidates
    .map((candidate) => candidate.row.teamId)
    .filter((teamId) => !claimed.has(teamId));
  if (unplacedTeamIds.length > 0) {
    issues.push(
      issue(
        'unplaced-teams',
        'error',
        `${unplacedTeamIds.length} team${unplacedTeamIds.length === 1 ? '' : 's'} did not land in any division. Add a division that takes the remaining teams, or widen the configured places.`,
        { teamIds: unplacedTeamIds },
      ),
    );
  }

  // Ties are reported against what they would decide, because that is what a director must weigh:
  // a tie inside a division that changes nobody's bye is a different problem from one at a cut line.
  if (tiePolicy === 'block') {
    for (const pool of input.poolStandings) {
      const groups = new Map<number, TeamStandingRow[]>();
      for (const row of pool.rows) {
        if (row.tieStatus !== 'unresolved') continue;
        const group = groups.get(row.rank) ?? [];
        group.push(row);
        groups.set(row.rank, group);
      }
      for (const group of groups.values()) {
        if (group.length < 2) continue;
        if (group.every((row) => overrideByTeam.has(row.teamId))) continue;
        const memberships = new Set(
          group.map(
            (row) =>
              drafts.find((draft) => draft.members.some((member) => member.teamId === row.teamId))?.definition
                .id ?? 'none',
          ),
        );
        const affects: UnresolvedPlacementTie['affects'] =
          memberships.size > 1 ? 'division-membership' : 'bracket-seed';
        unresolvedTies.push({
          teamIds: group.map((row) => row.teamId),
          poolId: pool.poolId,
          affects,
          message:
            affects === 'division-membership'
              ? `An unresolved tie in ${pool.poolName} decides which playoff division these teams enter.`
              : `An unresolved tie in ${pool.poolName} decides a playoff seed, and therefore who receives a first-round bye.`,
        });
        issues.push(
          issue('unresolved-tie', 'error', unresolvedTies[unresolvedTies.length - 1].message, {
            teamIds: group.map((row) => row.teamId),
            poolId: pool.poolId,
          }),
        );
      }
    }

    // A global cut line can also fall inside teams the pools each separated cleanly but the chosen
    // basis does not. That tie is invisible in any single pool's standings, so it is checked here.
    if (input.method === 'global-seed' && basis) {
      for (const draft of drafts) {
        const range = draft.definition.seedRange;
        if (!range) continue;
        const cut = range.to;
        if (cut === null || cut === undefined || cut >= ranked.length) continue;
        const inside = ranked[cut - 1];
        const outside = ranked[cut];
        if (!inside || !outside) continue;
        if (!sameBasisValue(basisValue(inside.row, basis), basisValue(outside.row, basis))) continue;
        if (overrideByTeam.has(inside.row.teamId) && overrideByTeam.has(outside.row.teamId)) continue;
        const message = `${inside.poolName} and ${outside.poolName} teams are level on ${describeRankingBasis(basis)} across the division cut line at overall seed ${cut}.`;
        unresolvedTies.push({
          teamIds: [inside.row.teamId, outside.row.teamId],
          poolId: null,
          affects: 'division-membership',
          message,
        });
        issues.push(
          issue('ambiguous-cutoff', 'error', message, {
            teamIds: [inside.row.teamId, outside.row.teamId],
            divisionId: draft.definition.id,
          }),
        );
      }
    }
  }

  // Seeds inside a division decide byes, so an ordering that no statistic actually made is a
  // decision the director has to take, not one this function may take on their behalf.
  if (tiePolicy === 'block') {
    for (const draft of drafts) {
      for (let index = 1; index < draft.members.length; index += 1) {
        const ahead = draft.members[index - 1];
        const behind = draft.members[index];
        if (ahead.manual || behind.manual) continue;
        if (ahead.sourcePoolId === behind.sourcePoolId) continue;
        const aheadRow = candidateByTeam.get(ahead.teamId)?.row;
        const behindRow = candidateByTeam.get(behind.teamId)?.row;
        if (!aheadRow || !behindRow) continue;
        if (separatingStatistic(aheadRow, behindRow, effectiveBasis) !== null) continue;
        const message = `${ahead.sourcePoolName} and ${behind.sourcePoolName} teams are level on every configured cross-pool statistic at seeds ${index} and ${index + 1} of ${draft.definition.name}.`;
        unresolvedTies.push({
          teamIds: [ahead.teamId, behind.teamId],
          poolId: null,
          affects: 'bracket-seed',
          message,
        });
        issues.push(
          issue('arbitrary-seed-order', 'error', message, {
            teamIds: [ahead.teamId, behind.teamId],
            divisionId: draft.definition.id,
          }),
        );
      }
    }
  }

  const previews: DivisionPreview[] = drafts.map((draft) => ({
    id: draft.definition.id,
    name: draft.definition.name,
    order: draft.definition.order,
    members: draft.members.map((member, index) => ({ ...member, seed: index + 1 })),
  }));

  return {
    method: input.method,
    rankingBasis: basis,
    divisions: previews,
    unplacedTeamIds,
    issues,
    unresolvedTies,
    overrides,
    blocked: issues.some((entry) => entry.severity === 'error'),
  };
}

/**
 * Default divisions for a "top N from each pool, then the next N, then the rest" afternoon.
 *
 * The names are suggestions and every caller may rename them; nothing downstream reads a name.
 */
export function suggestPoolPlacementDivisions(
  divisionCount: number,
  qualifiersPerDivision = 2,
  names: readonly string[] = ['Championship', 'Division II', 'Division III', 'Division IV', 'Division V'],
): DivisionDefinition[] {
  const divisions: DivisionDefinition[] = [];
  for (let index = 0; index < Math.max(0, divisionCount); index += 1) {
    const last = index === divisionCount - 1;
    const from = index * qualifiersPerDivision + 1;
    divisions.push({
      id: `division-${index + 1}`,
      name: names[index] ?? `Division ${index + 1}`,
      order: index + 1,
      ...(last
        ? { remainder: true }
        : {
            placements: Array.from({ length: qualifiersPerDivision }, (_, offset) => from + offset),
          }),
    });
  }
  return divisions;
}
