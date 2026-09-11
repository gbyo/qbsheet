/**
 * Read-only schedule context for the manual pairing screen.
 *
 * YellowFruit's phase and pool records are evidence about the file, not an executable schedule.
 * These helpers deliberately produce labels and warnings only; they never calculate standings,
 * advance teams, or invent a missing game.
 */

import type { YellowFruitPhaseSchedule } from '@qbsheet/tournament-formats';
import type { PairingWarning, Room } from './rooms';
import type { BridgeRound, BridgeTournament } from './tournament';

export interface RoundGroup {
  label: string;
  phaseId?: string;
  rounds: BridgeRound[];
}

/** Group the existing rounds by their imported phase identity for display only. */
export function roundGroups(tournament: Pick<BridgeTournament, 'rounds' | 'schedule'>): RoundGroup[] {
  const groups: RoundGroup[] = [];
  const assigned = new Set<string>();

  for (const phase of tournament.schedule.phases) {
    const rounds = tournament.rounds.filter((round) => round.phaseId === phase.id);
    if (rounds.length === 0) continue;
    groups.push({ label: phase.name, phaseId: phase.id, rounds });
    rounds.forEach((round) => assigned.add(round.id));
  }

  const ungrouped = tournament.rounds.filter((round) => !assigned.has(round.id));
  for (const round of ungrouped) {
    const label = round.phaseName || 'Other rounds';
    const existing = groups.find((group) => group.phaseId === undefined && group.label === label);
    if (existing) existing.rounds.push(round);
    else groups.push({ label, rounds: [round] });
  }
  return groups;
}

export function phaseForRound(
  tournament: Pick<BridgeTournament, 'schedule'>,
  round: Pick<BridgeRound, 'phaseId'> | null,
): YellowFruitPhaseSchedule | undefined {
  if (!round?.phaseId) return undefined;
  return tournament.schedule.phases.find((phase) => phase.id === round.phaseId);
}

/** Return the pool names that YellowFruit lists for a team in this phase. */
export function phasePoolNames(phase: YellowFruitPhaseSchedule | undefined, teamId: string): string[] {
  return phase?.pools.filter((pool) => pool.teamIds.includes(teamId)).map((pool) => pool.name) ?? [];
}

export interface CarryoverSourcePool {
  phaseName: string;
  poolId: string;
  poolName: string;
}

export interface PhaseTeamPoolContext {
  destinationPoolNames: string[];
  /** Present only when the selected destination pool actually carries prior results forward. */
  carryover: boolean;
  sourcePhaseName: string | null;
  sourcePoolNames: string[];
}

function precedingPhase(
  tournament: Pick<BridgeTournament, 'schedule'>,
  phase: YellowFruitPhaseSchedule | undefined,
): YellowFruitPhaseSchedule | undefined {
  if (!phase) return undefined;
  const index = tournament.schedule.phases.findIndex((entry) => entry.id === phase.id);
  return index > 0 ? tournament.schedule.phases[index - 1] : undefined;
}

/**
 * Describe only the provenance the loaded YellowFruit file can prove for one selected team.
 *
 * The immediately preceding phase is the source because that is the boundary YellowFruit's
 * carryover flag applies to. Empty and multiply-listed memberships stay visible as unknown or
 * ambiguous context; neither is collapsed into a guessed source pool.
 */
export function phaseTeamPoolContext(
  tournament: Pick<BridgeTournament, 'schedule'>,
  round: Pick<BridgeRound, 'phaseId'> | null,
  teamId: string,
): PhaseTeamPoolContext {
  const phase = phaseForRound(tournament, round);
  const destinationPools = phase?.pools.filter((pool) => pool.teamIds.includes(teamId)) ?? [];
  const carryover = destinationPools.some((pool) => pool.hasCarryover === true);
  const sourcePhase = carryover ? precedingPhase(tournament, phase) : undefined;
  return {
    destinationPoolNames: destinationPools.map((pool) => pool.name),
    carryover,
    sourcePhaseName: sourcePhase?.name ?? null,
    sourcePoolNames:
      sourcePhase?.pools.filter((pool) => pool.teamIds.includes(teamId)).map((pool) => pool.name) ?? [],
  };
}

/**
 * Return a team's source pool only when YellowFruit gives one unambiguous answer.
 *
 * A playoff pool can be present before advancement has populated its teams, and a wildcard or
 * unusual format can place a team in more than one source pool. Both cases are intentionally
 * treated as unknown: a safety warning is useful only when the file itself proves the provenance.
 */
export function carryoverSourcePool(
  tournament: Pick<BridgeTournament, 'schedule'>,
  round: Pick<BridgeRound, 'phaseId'> | null,
  teamId: string,
): CarryoverSourcePool | null {
  const phase = phaseForRound(tournament, round);
  const sourcePhase = precedingPhase(tournament, phase);
  if (!phase || !sourcePhase) return null;
  const destinationPools = phase.pools.filter(
    (pool) => pool.hasCarryover === true && pool.teamIds.includes(teamId),
  );
  if (destinationPools.length !== 1) return null;
  const sourcePools = sourcePhase.pools.filter((pool) => pool.teamIds.includes(teamId));
  if (sourcePools.length !== 1) return null;
  const source = sourcePools[0];
  if (!source) return null;
  return { phaseName: sourcePhase.name, poolId: source.id, poolName: source.name };
}

function carryoverConflict(
  tournament: Pick<BridgeTournament, 'schedule'>,
  round: Pick<BridgeRound, 'phaseId'> | null,
  leftTeamId: string,
  rightTeamId: string,
): { destinationPoolName: string; source: CarryoverSourcePool } | null {
  const phase = phaseForRound(tournament, round);
  const sourcePhase = precedingPhase(tournament, phase);
  if (!phase || !sourcePhase) return null;
  const destinationPools = phase.pools.filter(
    (pool) =>
      pool.hasCarryover === true && pool.teamIds.includes(leftTeamId) && pool.teamIds.includes(rightTeamId),
  );
  if (destinationPools.length !== 1) return null;
  const leftSources = sourcePhase.pools.filter((pool) => pool.teamIds.includes(leftTeamId));
  const rightSources = sourcePhase.pools.filter((pool) => pool.teamIds.includes(rightTeamId));
  if (leftSources.length !== 1 || rightSources.length !== 1) return null;
  const leftSource = leftSources[0];
  const rightSource = rightSources[0];
  if (!leftSource || !rightSource || leftSource.id !== rightSource.id) return null;
  return {
    destinationPoolName: destinationPools[0]?.name ?? phase.name,
    source: { phaseName: sourcePhase.name, poolId: leftSource.id, poolName: leftSource.name },
  };
}

/**
 * Warn when both teams are known to occupy different pools in the selected phase.
 *
 * The warning is intentionally advisory. A cross-pool matchup can be a legitimate tiebreaker or
 * custom exception, so `publishableRooms` and the publish path remain unchanged.
 */
export function schedulePairingWarnings(
  tournament: Pick<BridgeTournament, 'schedule'>,
  round: Pick<BridgeRound, 'phaseId'> | null,
  rooms: readonly Room[],
): PairingWarning[] {
  const phase = phaseForRound(tournament, round);
  if (!phase) return [];

  const warnings: PairingWarning[] = [];
  if (phase.pools.length >= 2) {
    for (const room of rooms) {
      const leftTeamId = room.leftTeamId;
      const rightTeamId = room.rightTeamId;
      if (!leftTeamId || !rightTeamId || leftTeamId === rightTeamId) continue;
      const leftPools = phase.pools.filter((pool) => pool.teamIds.includes(leftTeamId));
      const rightPools = phase.pools.filter((pool) => pool.teamIds.includes(rightTeamId));
      if (leftPools.length === 0 || rightPools.length === 0) continue;
      const samePool = leftPools.some((left) => rightPools.some((right) => left.id === right.id));
      if (samePool) continue;
      const leftNames = leftPools.map((pool) => pool.name).join(' / ');
      const rightNames = rightPools.map((pool) => pool.name).join(' / ');
      warnings.push({
        roomId: room.id,
        message: `This matchup crosses pools in ${phase.name}: ${leftNames} versus ${rightNames}. It remains publishable; verify that the exception is intentional.`,
      });
    }
  }

  // A same-source playoff pairing can be different from an ordinary rematch: when the selected
  // destination pool carries over the source round, YellowFruit has already counted that game.
  // The warning remains an operator override rather than a schedule engine, but it must be part
  // of the exact pre-publication review.
  for (const room of rooms) {
    const leftTeamId = room.leftTeamId;
    const rightTeamId = room.rightTeamId;
    if (!leftTeamId || !rightTeamId || leftTeamId === rightTeamId) continue;
    const conflict = carryoverConflict(tournament, round, leftTeamId, rightTeamId);
    if (!conflict) continue;
    warnings.push({
      roomId: room.id,
      message: `This matchup in ${conflict.destinationPoolName} would replay a game already satisfied by carryover from ${conflict.source.poolName} in ${conflict.source.phaseName}. Publish only as an explicit exceptional override.`,
    });
  }
  return warnings;
}

/** Format a rank list without turning it into a standings calculation. */
export function formatRanks(ranks: readonly number[]): string {
  if (ranks.length === 0) return 'no listed ranks';
  if (ranks.length === 1) return `rank ${ranks[0]}`;
  const sorted = [...ranks].sort((left, right) => left - right);
  const contiguous = sorted.every((rank, index) => index === 0 || rank === sorted[index - 1] + 1);
  return contiguous ? `ranks ${sorted[0]}–${sorted[sorted.length - 1]}` : `ranks ${sorted.join(', ')}`;
}

/** Resolve a metadata tier to a following phase's named pool when that mapping is unambiguous. */
export function destinationPoolName(
  tournament: Pick<BridgeTournament, 'schedule'>,
  phase: YellowFruitPhaseSchedule,
  tier: number,
): string {
  const index = tournament.schedule.phases.findIndex((entry) => entry.id === phase.id);
  const next = index >= 0 ? tournament.schedule.phases[index + 1] : undefined;
  const matches = next?.pools.filter((pool) => pool.tier === tier) ?? [];
  return matches.length === 1 ? matches[0].name : `tier ${tier}`;
}
