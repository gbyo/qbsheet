/**
 * Prelim finishing order, the way YellowFruit itself would rank it.
 *
 * # Transcribed, not invented
 *
 * The sort below mirrors `PoolStats.sortTeams` / `rankSortedTeams` in stock YellowFruit's
 * `src/renderer/DataModel/StatSummaries.ts` (ANadig/YellowFruit):
 *
 * - order by win share (`wins + ties/2` over decided games; a team with no decided games sorts
 *   as −1, below every team that played), then by points per regulation tossup heard;
 * - display ranks (`1`, `2=`) key on equal win share only — two teams with the same record
 *   share a rank even when their tossup numbers differ;
 * - a forfeit counts as a win/loss but contributes no tossups or points
 *   (`PoolTeamStats.addMatchTeam` returns early on `match.isForfeit()`, after the result);
 * - points per tossup excludes overtime exactly when YellowFruit excludes it:
 *   `ScoringRules.useOvertimeInPPTUH()` is `overtimeIncludesBonuses || !useBonuses`, and
 *   `MatchTeam.getPointsForPPG` subtracts overtime tossup points otherwise, where overtime
 *   points come from the `YfData.overTimeBuzzes` answer counts.
 *
 * # What this is used for — and what it is not
 *
 * This derives a *suggested* F1–F6 / B1–B6 order so the operator can check it against the
 * advancement YellowFruit shows. It never writes standings anywhere. Any adjacent pair the
 * data cannot separate on win share is reported as an unresolved tie and must be ordered by
 * the operator (who is told to prefer resolving it in YellowFruit first); the manual choice
 * only labels the printed schedule.
 */

import type { JsonObject } from '@qbsheet/tournament-formats';
import type { PlayoffLabel } from './schedule';
import type { ShuttleTournament } from './tournament';

export interface PoolStanding {
  teamId: string;
  teamName: string;
  wins: number;
  losses: number;
  ties: number;
  /** (wins + ties/2) / decided, or NaN when the team has no decided games. */
  winShare: number;
  pointsForPpg: number;
  tossupsHeard: number;
  pptuh: number;
  /** YellowFruit-style rank label: `1`, or `2=` when the win share ties the team above. */
  rankLabel: string;
}

export interface PoolOrder {
  poolId: string;
  poolName: string;
  standings: PoolStanding[];
  /**
   * Consecutive groups the data cannot separate: same win share (YellowFruit gives them the
   * same rank label). Each group needs an operator decision before labels are assigned.
   */
  tiedGroups: string[][];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function refId(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (isRecord(value)) {
    if (typeof value.$ref === 'string') return value.$ref;
    if (typeof value.id === 'string') return value.id;
  }
  return undefined;
}

interface RawMatch {
  match_teams?: unknown;
  tossups_read?: unknown;
  overtime_tossups_read?: unknown;
}

function rawList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function rawPhases(rawTournament: JsonObject): Record<string, unknown>[] {
  return rawList(rawTournament.phases);
}

function rawRounds(phase: Record<string, unknown>): Record<string, unknown>[] {
  return rawList(phase.rounds);
}

function rawMatches(round: Record<string, unknown>): Record<string, unknown>[] {
  return rawList(round.matches);
}

function rawPools(phase: Record<string, unknown>): Record<string, unknown>[] {
  return rawList(phase.pools);
}

function poolMemberIds(pool: Record<string, unknown>): string[] {
  if (!Array.isArray(pool.pool_teams)) return [];
  const ids: string[] = [];
  for (const entry of pool.pool_teams) {
    if (!isRecord(entry)) continue;
    const id = refId(entry.team);
    if (id) ids.push(id);
  }
  return ids;
}

function roundNumberOf(round: Record<string, unknown>): number | undefined {
  const data = isRecord(round.YfData) ? round.YfData : null;
  const fromData = data ? finiteNumber(data.number) : undefined;
  if (fromData !== undefined && Number.isSafeInteger(fromData)) return fromData;
  if (typeof round.number === 'number' && Number.isSafeInteger(round.number)) return round.number;
  if (typeof round.name === 'string') {
    const parsed = Number.parseInt(round.name, 10);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

/** Match result for one side, mirroring YellowFruit `Match.getResult`. */
function sideResult(
  side: Record<string, unknown>,
  other: Record<string, unknown>,
): 'win' | 'loss' | 'tie' | null {
  const forfeit = side.forfeit_loss === true;
  const otherForfeit = other.forfeit_loss === true;
  if (forfeit && !otherForfeit) return 'loss';
  if (otherForfeit && !forfeit) return 'win';
  if (forfeit && otherForfeit) return null;
  const points = finiteNumber(side.points);
  const otherPoints = finiteNumber(other.points);
  if (points === undefined || otherPoints === undefined) return null;
  if (points > otherPoints) return 'win';
  if (points < otherPoints) return 'loss';
  return 'tie';
}

function isForfeitMatch(sides: Record<string, unknown>[]): boolean {
  return sides.some((side) => side.forfeit_loss === true);
}

/**
 * Overtime tossup points for one side, from `YfData.overTimeBuzzes` answer counts valued
 * against the tournament's own answer types — the data `MatchTeam.getOvertimePoints` sums.
 */
function overtimePoints(
  side: Record<string, unknown>,
  answerValueById: ReadonlyMap<string, number>,
): number {
  const data = isRecord(side.YfData) ? side.YfData : null;
  const buzzes = data && Array.isArray(data.overTimeBuzzes) ? data.overTimeBuzzes : [];
  let total = 0;
  for (const entry of buzzes) {
    if (!isRecord(entry)) continue;
    const count = finiteNumber(entry.number) ?? 0;
    const answerId = refId(entry.answer_type);
    const value = answerId !== undefined ? (answerValueById.get(answerId) ?? 0) : 0;
    total += count * value;
  }
  return total;
}

export interface ScoringContext {
  /** `overtimeIncludesBonuses || !useBonuses` — YellowFruit `useOvertimeInPPTUH`. */
  overtimeCountsInPptuh: boolean;
  answerValueById: Map<string, number>;
}

export function scoringContextOf(tournament: ShuttleTournament): ScoringContext {
  const rules = tournament.rules as Record<string, unknown>;
  const overtimeIncludesBonuses = rules.overtime_includes_bonuses === true;
  const useBonuses = rules.maximum_bonus_score !== undefined;
  const answerValueById = new Map<string, number>();
  const answerTypes = Array.isArray(rules.answer_types) ? rules.answer_types : [];
  for (const entry of answerTypes) {
    if (!isRecord(entry)) continue;
    if (typeof entry.id === 'string' && typeof entry.value === 'number') {
      answerValueById.set(entry.id, entry.value);
    }
  }
  return { overtimeCountsInPptuh: overtimeIncludesBonuses || !useBonuses, answerValueById };
}

/**
 * Order one prelim pool's six teams by the prelim-phase games in the file.
 *
 * Only matches in the prelim phase's rounds 1–5 count. Carryover duplicates are impossible
 * there (carryovers point forward into playoff phases), so every listed game counts once.
 */
export function orderPrelimPool(input: {
  tournament: ShuttleTournament;
  prelimPhaseId: string;
  poolId: string;
  prelimRoundNumbers?: readonly number[];
}): PoolOrder {
  const { tournament, prelimPhaseId, poolId } = input;
  const roundNumbers = input.prelimRoundNumbers ?? [1, 2, 3, 4, 5];
  const scoring = scoringContextOf(tournament);

  const phases = rawPhases(tournament.rawTournament);
  const phase = phases.find((entry) => entry.id === prelimPhaseId);
  const poolName =
    tournament.pools.find((pool) => pool.id === poolId)?.name ??
    (phase ? rawPools(phase).find((pool) => pool.id === poolId) : undefined)?.name ??
    'Prelim pool';
  const poolTeamIds = new Set(
    tournament.pools.find((entry) => entry.id === poolId)?.teamIds ??
      (phase ? poolMemberIds(rawPools(phase).find((pool) => pool.id === poolId) ?? {}) : []),
  );

  interface Accumulator {
    wins: number;
    losses: number;
    ties: number;
    tuhTotal: number;
    tuhRegulation: number;
    pointsForPpg: number;
  }
  const table = new Map<string, Accumulator>();
  const accFor = (teamId: string): Accumulator => {
    let acc = table.get(teamId);
    if (!acc) {
      acc = { wins: 0, losses: 0, ties: 0, tuhTotal: 0, tuhRegulation: 0, pointsForPpg: 0 };
      table.set(teamId, acc);
    }
    return acc;
  };

  if (phase) {
    for (const round of rawRounds(phase)) {
      const number = roundNumberOf(round);
      if (number === undefined || !roundNumbers.includes(number)) continue;
      for (const match of rawMatches(round)) {
        const sides = (
          Array.isArray((match as RawMatch).match_teams) ? (match.match_teams as unknown[]) : []
        ).filter(isRecord);
        if (sides.length !== 2) continue;
        const ids = sides.map((side) => refId(side.team));
        if (ids.some((id) => !id)) continue;
        const tossups = finiteNumber(match.tossups_read) ?? 0;
        const overtime = finiteNumber(match.overtime_tossups_read) ?? 0;
        const forfeit = isForfeitMatch(sides);
        const results: ('win' | 'loss' | 'tie' | null)[] = [
          sideResult(sides[0], sides[1]),
          sideResult(sides[1], sides[0]),
        ];
        sides.forEach((side, index) => {
          const teamId = ids[index]!;
          if (!poolTeamIds.has(teamId)) return;
          const acc = accFor(teamId);
          const result = results[index];
          if (result === 'win') acc.wins += 1;
          else if (result === 'loss') acc.losses += 1;
          else if (result === 'tie') acc.ties += 1;
          // A forfeit decides the game but contributes no tossups or points.
          if (forfeit) return;
          acc.tuhTotal += tossups;
          acc.tuhRegulation += tossups - overtime;
          const points = finiteNumber(side.points) ?? 0;
          acc.pointsForPpg += scoring.overtimeCountsInPptuh
            ? points
            : points - overtimePoints(side, scoring.answerValueById);
        });
      }
    }
  }

  const nameOf = (teamId: string): string =>
    tournament.teams.find((team) => team.id === teamId)?.name ?? teamId;

  const standings: PoolStanding[] = [...poolTeamIds].map((teamId) => {
    const acc = table.get(teamId) ?? {
      wins: 0,
      losses: 0,
      ties: 0,
      tuhTotal: 0,
      tuhRegulation: 0,
      pointsForPpg: 0,
    };
    const decided = acc.wins + acc.losses + acc.ties;
    const winShare = decided === 0 ? Number.NaN : (acc.wins + acc.ties / 2) / decided;
    const tuh = scoring.overtimeCountsInPptuh ? acc.tuhTotal : acc.tuhRegulation;
    const pptuh = tuh === 0 ? Number.NaN : acc.pointsForPpg / tuh;
    return {
      teamId,
      teamName: nameOf(teamId),
      wins: acc.wins,
      losses: acc.losses,
      ties: acc.ties,
      winShare,
      pointsForPpg: acc.pointsForPpg,
      tossupsHeard: tuh,
      pptuh,
      rankLabel: '',
    };
  });

  // YellowFruit `PoolStats.sortTeams`: win share, then points per regulation tossup heard.
  // Missing values sort below every real one.
  standings.sort((a, b) => {
    const aShare = Number.isNaN(a.winShare) ? -1 : a.winShare;
    const bShare = Number.isNaN(b.winShare) ? -1 : b.winShare;
    if (aShare !== bShare) return bShare - aShare;
    const aPptuh = Number.isNaN(a.pptuh) ? -9999999 : a.pptuh;
    const bPptuh = Number.isNaN(b.pptuh) ? -9999999 : b.pptuh;
    return bPptuh - aPptuh;
  });

  // YellowFruit `rankSortedTeams`: the label keys on win share alone, NaN matching NaN.
  let previousShare = 2;
  let previousNaN = false;
  let previousRank = 0;
  standings.forEach((standing, index) => {
    const position = index + 1;
    const tied =
      standing.winShare === previousShare ||
      (Number.isNaN(standing.winShare) && previousNaN && previousShare !== 2);
    if (index === 0) {
      standing.rankLabel = '1';
      previousRank = 1;
    } else if (tied) {
      standing.rankLabel = `${previousRank}=`;
      standings[index - 1].rankLabel = `${previousRank}=`;
    } else {
      standing.rankLabel = String(position);
      previousRank = position;
    }
    previousShare = standing.winShare;
    previousNaN = Number.isNaN(standing.winShare);
  });

  // Consecutive teams sharing a rank label cannot be ordered by this data.
  const tiedGroups: string[][] = [];
  let group: string[] = [];
  for (const standing of standings) {
    if (standing.rankLabel.endsWith('=')) {
      group.push(standing.teamId);
    } else {
      if (group.length > 1) tiedGroups.push(group);
      group = [];
    }
  }
  if (group.length > 1) tiedGroups.push(group);

  return {
    poolId,
    poolName: typeof poolName === 'string' ? poolName : 'Prelim pool',
    standings,
    tiedGroups,
  };
}

/** How many decided prelim games the file holds (both sides' result, or a forfeit). */
export function countDecidedPrelimGames(input: {
  tournament: ShuttleTournament;
  prelimPhaseId: string;
  prelimRoundNumbers?: readonly number[];
}): number {
  const roundNumbers = input.prelimRoundNumbers ?? [1, 2, 3, 4, 5];
  const phase = rawPhases(input.tournament.rawTournament).find((entry) => entry.id === input.prelimPhaseId);
  if (!phase) return 0;
  let decided = 0;
  for (const round of rawRounds(phase)) {
    const number = roundNumberOf(round);
    if (number === undefined || !roundNumbers.includes(number)) continue;
    for (const match of rawMatches(round)) {
      const sides = (
        Array.isArray((match as RawMatch).match_teams) ? (match.match_teams as unknown[]) : []
      ).filter(isRecord);
      if (sides.length !== 2) continue;
      if (isForfeitMatch(sides)) {
        decided += 1;
        continue;
      }
      const points = sides.map((side) => finiteNumber(side.points));
      if (points.every((value) => value !== undefined)) decided += 1;
    }
  }
  return decided;
}

export type SlotLetter = 'F' | 'B';

/**
 * Assign F1–F6 (or B1–B6) labels down a pool order.
 *
 * `manualOrder` reorders teams inside unresolved ties only: every team listed there must belong
 * to one tied group, and the group must appear in full. Anything else is rejected rather than
 * guessed at — the labels feed the printed schedule.
 */
export function assignSlotLabels(
  order: PoolOrder,
  letter: SlotLetter,
  manualOrder?: readonly string[],
): { ok: true; slots: Record<string, string> } | { ok: false; error: string } {
  const finalOrder = [...order.standings.map((standing) => standing.teamId)];
  if (manualOrder && manualOrder.length > 0) {
    const remaining = [...manualOrder];
    for (const group of order.tiedGroups) {
      const taken = group.filter((teamId) => remaining.includes(teamId));
      if (taken.length === 0) continue;
      if (taken.length !== group.length) {
        return {
          ok: false,
          error: `The tied teams ${group
            .map((teamId) => `“${nameIn(order, teamId)}”`)
            .join(', ')} must be ordered together.`,
        };
      }
      // The group's table positions, filled in the operator's order.
      const positions = group.map((teamId) => finalOrder.indexOf(teamId)).sort((a, b) => a - b);
      positions.forEach((position, index) => {
        finalOrder[position] = taken[index];
      });
      for (const teamId of taken) remaining.splice(remaining.indexOf(teamId), 1);
    }
    if (remaining.length > 0) {
      return { ok: false, error: 'Only tied teams can be reordered; the rest follow the standings.' };
    }
  }
  const slots: Record<string, string> = {};
  finalOrder.forEach((teamId, index) => {
    slots[`${letter}${index + 1}`] = teamId;
  });
  return { ok: true, slots };
}

function nameIn(order: PoolOrder, teamId: string): string {
  return order.standings.find((standing) => standing.teamId === teamId)?.teamName ?? teamId;
}

/**
 * Verify the playoff pools YellowFruit shows against the confirmed slots.
 *
 * One pool must hold exactly F1–F3 + B1–B3 (Gold) and the other exactly F4–F6 + B4–B6
 * (Maroon). Pools are matched by membership, never by name. Anything else stops playoff
 * generation with an explanation instead of printing games YellowFruit disagrees with.
 */
export function verifyPlayoffPools(input: {
  tournament: ShuttleTournament;
  playoffPhaseId: string;
  slots: Record<PlayoffLabel | string, string>;
}):
  | { ok: true; goldPoolName: string; maroonPoolName: string }
  | { ok: false; error: string } {
  const { tournament, playoffPhaseId, slots } = input;
  const gold = new Set(
    ['F1', 'F2', 'F3', 'B1', 'B2', 'B3'].map((label) => slots[label]).filter(Boolean),
  );
  const maroon = new Set(
    ['F4', 'F5', 'F6', 'B4', 'B5', 'B6'].map((label) => slots[label]).filter(Boolean),
  );
  if (gold.size !== 6 || maroon.size !== 6) {
    return { ok: false, error: 'The playoff slots are incomplete; confirm all twelve F/B labels first.' };
  }
  const pools = tournament.pools.filter((pool) => pool.phaseId === playoffPhaseId);
  if (pools.length !== 2) {
    return {
      ok: false,
      error: `The playoff phase has ${pools.length} pools; YellowFruit advancement cannot be verified.`,
    };
  }
  const sameSet = (members: readonly string[], expected: ReadonlySet<string>): boolean => {
    if (members.length !== expected.size) return false;
    return members.every((member) => expected.has(member));
  };
  let goldPoolName: string | undefined;
  let maroonPoolName: string | undefined;
  for (const pool of pools) {
    if (sameSet(pool.teamIds, gold)) goldPoolName = pool.name;
    else if (sameSet(pool.teamIds, maroon)) maroonPoolName = pool.name;
  }
  if (!goldPoolName || !maroonPoolName) {
    const describe = (pool: { name: string; teamIds: readonly string[] }): string =>
      `“${pool.name}” holds ${pool.teamIds
        .map((id) => tournament.teams.find((team) => team.id === id)?.name ?? id)
        .join(', ')}`;
    return {
      ok: false,
      error:
        'YellowFruit’s playoff pools do not match the confirmed slots. ' +
        'Confirm advancement in YellowFruit first — F1–F3 and B1–B3 belong in one pool, ' +
        'F4–F6 and B4–B6 in the other. ' +
        pools.map(describe).join(' ')
    };
  }
  return { ok: true, goldPoolName, maroonPoolName };
}
