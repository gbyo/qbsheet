/**
 * What the operator intends to run, round by round — kept apart from what the relay is holding.
 *
 * # The separation this file exists for
 *
 * A `Room` used to carry `leftTeamId` and `rightTeamId`, which made one object mean three things
 * at once: a physical room in a school building, the assignment the relay currently serves, and
 * the matchup being typed for whichever round the dropdown happened to show. Those three change
 * for unrelated reasons and at unrelated times, so the only way to keep them consistent was to
 * wipe the third whenever the round selector moved — which is exactly why a whole tournament's
 * prelims could not be entered the night before.
 *
 * Here, a room is a room. A `RoundPlan` is the operator's intent for one round, and it references
 * rooms and teams by id and holds nothing else.
 *
 * # What a plan deliberately does not contain
 *
 * Room names, team names, phase and pool names, YellowFruit `Match` objects, QBJ match ids,
 * assignment revisions, publication flags, and timestamps are all absent. Every one of them is
 * either owned by the loaded `.yft` (which is reread and authoritative) or by the `Room` (which is
 * what the relay actually accepted). A copy here would be a second answer to a question that
 * already has one, and the copy is the one that goes stale — a team renamed in YellowFruit, a room
 * renamed locally, a republish that moved a revision.
 *
 * Whether a planned game is live on the relay is likewise *derived*, never stored: `pairingMatchId`
 * is a pure function of the pairing, so comparing it against what the room says it published
 * answers the question exactly. A persisted `published` flag would be a fourth thing to keep in
 * sync and the first thing to be wrong after a failed publish.
 *
 * # Sparse on purpose
 *
 * A room appears in a round's plan only once a side is chosen, and the entry is deleted again when
 * the last side is cleared. Preallocating every room for every round would turn "twelve rooms,
 * eleven prelim rounds" into 132 rows that mostly say nothing, and would make "has the operator
 * entered anything for round 7" a question about contents rather than existence.
 *
 * # Not a schedule
 *
 * Nothing here generates a pairing, reads pool membership, or predicts advancement. YellowFruit's
 * pool metadata is evidence for a warning and nothing more; playoffs are entered by hand after the
 * file is reloaded with the teams that actually advanced. See `schedule.ts`.
 */

import { pairingMatchId } from './identity';
import type { Room } from './rooms';

/** One room's intended matchup in one round. Ids only; both sides may be null while being typed. */
export interface PlannedPairing {
  roomId: string;
  leftTeamId: string | null;
  rightTeamId: string | null;
}

/** Everything the operator has entered for one round. Sparse: only rooms with a side chosen. */
export interface RoundPlan {
  roundId: string;
  pairings: PlannedPairing[];
}

export type PairingSide = 'left' | 'right';

/** A pairing with both sides chosen and distinct — the only kind that becomes an assignment. */
export interface CompletePairing {
  roomId: string;
  leftTeamId: string;
  rightTeamId: string;
}

/** Whether this pairing names two different teams, and can therefore be built into a game. */
export function isCompletePairing(pairing: PlannedPairing | undefined): pairing is PlannedPairing & {
  leftTeamId: string;
  rightTeamId: string;
} {
  return (
    pairing !== undefined &&
    pairing.leftTeamId !== null &&
    pairing.rightTeamId !== null &&
    pairing.leftTeamId !== pairing.rightTeamId
  );
}

/** The plan for one round, or undefined when the operator has entered nothing for it. */
export function planForRound(plans: readonly RoundPlan[], roundId: string | null): RoundPlan | undefined {
  if (roundId === null) return undefined;
  return plans.find((plan) => plan.roundId === roundId);
}

/** The pairings for one round. Empty rather than undefined, because every caller wants a list. */
export function pairingsForRound(
  plans: readonly RoundPlan[],
  roundId: string | null,
): readonly PlannedPairing[] {
  return planForRound(plans, roundId)?.pairings ?? [];
}

/** One room's entry in one round's plan, if the operator has chosen anything for it. */
export function pairingFor(
  plans: readonly RoundPlan[],
  roundId: string | null,
  roomId: string,
): PlannedPairing | undefined {
  return pairingsForRound(plans, roundId).find((pairing) => pairing.roomId === roomId);
}

/** One room's chosen sides in one round. Both null when nothing has been chosen. */
export function plannedTeams(
  plans: readonly RoundPlan[],
  roundId: string | null,
  roomId: string,
): { leftTeamId: string | null; rightTeamId: string | null } {
  const pairing = pairingFor(plans, roundId, roomId);
  return {
    leftTeamId: pairing?.leftTeamId ?? null,
    rightTeamId: pairing?.rightTeamId ?? null,
  };
}

/** How many rooms in this round have a complete, playable matchup. */
export function assignedRoomCount(plans: readonly RoundPlan[], roundId: string | null): number {
  return pairingsForRound(plans, roundId).filter((pairing) => isCompletePairing(pairing)).length;
}

function withoutEmptyPairings(plan: RoundPlan): RoundPlan | null {
  const pairings = plan.pairings.filter(
    (pairing) => pairing.leftTeamId !== null || pairing.rightTeamId !== null,
  );
  return pairings.length === 0 ? null : { roundId: plan.roundId, pairings };
}

/**
 * Replace one round's plan in place, dropping it entirely when nothing is left in it.
 *
 * Position is preserved rather than the plan being moved to the end: the array is persisted, and a
 * list that reshuffles itself every time a dropdown changes makes every saved state a different
 * string for the same meaning.
 */
function replacePlan(plans: readonly RoundPlan[], next: RoundPlan): RoundPlan[] {
  const trimmed = withoutEmptyPairings(next);
  const index = plans.findIndex((plan) => plan.roundId === next.roundId);
  if (index === -1) return trimmed === null ? [...plans] : [...plans, trimmed];
  const copy = [...plans];
  if (trimmed === null) copy.splice(index, 1);
  else copy[index] = trimmed;
  return copy;
}

/**
 * Choose (or clear) one side of one room's matchup in one round.
 *
 * Every other round is returned untouched by construction — this only ever rewrites the plan whose
 * `roundId` matches. Clearing the last remaining side deletes the sparse entry rather than leaving
 * a row of two nulls behind, so "is anything planned here" stays a question about existence.
 */
export function setPlannedSide(
  plans: readonly RoundPlan[],
  roundId: string,
  roomId: string,
  side: PairingSide,
  teamId: string | null,
): RoundPlan[] {
  const existing = planForRound(plans, roundId) ?? { roundId, pairings: [] };
  const current = existing.pairings.find((pairing) => pairing.roomId === roomId) ?? {
    roomId,
    leftTeamId: null,
    rightTeamId: null,
  };
  const updated: PlannedPairing = {
    ...current,
    ...(side === 'left' ? { leftTeamId: teamId } : { rightTeamId: teamId }),
  };
  const pairings = existing.pairings.some((pairing) => pairing.roomId === roomId)
    ? existing.pairings.map((pairing) => (pairing.roomId === roomId ? updated : pairing))
    : [...existing.pairings, updated];
  return replacePlan(plans, { roundId, pairings });
}

/**
 * Forget a room everywhere.
 *
 * Called when a physical room is removed. The room's relay identity is handled separately by the
 * tombstone path in `rooms.ts` — this only drops the planning intent, which no longer refers to
 * anything. A room id is never reused (`retiredRoomIds`), so this cannot resurrect later.
 */
export function removeRoomFromPlans(plans: readonly RoundPlan[], roomId: string): RoundPlan[] {
  const next: RoundPlan[] = [];
  for (const plan of plans) {
    const trimmed = withoutEmptyPairings({
      roundId: plan.roundId,
      pairings: plan.pairings.filter((pairing) => pairing.roomId !== roomId),
    });
    if (trimmed !== null) next.push(trimmed);
  }
  return next;
}

/**
 * Index a round's pairings by room, with the first entry winning.
 *
 * This matches the `find(...)` lookup the UI reads, so a duplicate row that reaches this point
 * in memory cannot display one pairing while publishing another. Persisted duplicates are removed
 * earlier by `dedupeRoundPlans`; this is the second fence, not the first.
 */
export function pairingsByRoom(pairings: readonly PlannedPairing[]): Map<string, PlannedPairing> {
  const byRoom = new Map<string, PlannedPairing>();
  for (const pairing of pairings) {
    if (!byRoom.has(pairing.roomId)) byRoom.set(pairing.roomId, pairing);
  }
  return byRoom;
}

/**
 * Restore the canonical plan shape: one plan per round, one row per room.
 *
 * Persisted state is a trust boundary — a stale build, a partial write, a hand edit, or a future
 * migration can produce duplicate `roundId` or `roomId` entries that parse cleanly. Normal editing
 * never creates them, so every duplicate here is treated as corruption, not intent:
 *
 * - exact duplicate rows collapse to one;
 * - a room with conflicting rows is left unplanned rather than guessed at, because shipping either
 *   matchup would be choosing a game the operator may not have meant;
 * - duplicate round ids merge into a single plan under the same per-room rule;
 * - rows with nothing chosen and rounds left with nothing planned are dropped, as elsewhere.
 *
 * Only the ambiguous plan data is discarded. Rooms, relay state, and results pass through
 * untouched — see `persistence.ts`.
 */
export function dedupeRoundPlans(plans: readonly RoundPlan[]): RoundPlan[] {
  const roomsByRound = new Map<string, Map<string, PlannedPairing>>();
  const conflictedByRound = new Map<string, Set<string>>();
  const roundOrder: string[] = [];
  for (const plan of plans) {
    let rooms = roomsByRound.get(plan.roundId);
    if (!rooms) {
      rooms = new Map();
      roomsByRound.set(plan.roundId, rooms);
      roundOrder.push(plan.roundId);
    }
    let conflicted = conflictedByRound.get(plan.roundId);
    if (!conflicted) {
      conflicted = new Set();
      conflictedByRound.set(plan.roundId, conflicted);
    }
    for (const pairing of plan.pairings) {
      if (pairing.leftTeamId === null && pairing.rightTeamId === null) continue;
      if (conflicted.has(pairing.roomId)) continue;
      const existing = rooms.get(pairing.roomId);
      if (!existing) {
        rooms.set(pairing.roomId, {
          roomId: pairing.roomId,
          leftTeamId: pairing.leftTeamId,
          rightTeamId: pairing.rightTeamId,
        });
        continue;
      }
      if (existing.leftTeamId === pairing.leftTeamId && existing.rightTeamId === pairing.rightTeamId) {
        continue;
      }
      rooms.delete(pairing.roomId);
      conflicted.add(pairing.roomId);
    }
  }
  const next: RoundPlan[] = [];
  for (const roundId of roundOrder) {
    const pairings = [...roomsByRound.get(roundId)!.values()];
    if (pairings.length > 0) next.push({ roundId, pairings });
  }
  return next;
}

/** What reconciliation against a reloaded `.yft` had to drop or clear. */
export interface PlanReconciliation {
  plans: RoundPlan[];
  /** Round ids whose whole plan was dropped because the round is gone. */
  removedRoundIds: string[];
  /** Room ids dropped from at least one plan because the room is gone. */
  removedRoomIds: string[];
  /** How many individual sides were cleared because the team no longer exists. */
  clearedSideCount: number;
  /** How many pairings disappeared entirely once their sides were cleared. */
  removedPairingCount: number;
}

/** True when reconciliation changed anything the operator would want to be told about. */
export function reconciliationChangedAnything(report: PlanReconciliation): boolean {
  return (
    report.removedRoundIds.length > 0 ||
    report.removedRoomIds.length > 0 ||
    report.clearedSideCount > 0 ||
    report.removedPairingCount > 0
  );
}

/**
 * Bring saved plans back into agreement with the reloaded file and the configured rooms.
 *
 * **By id, and only by id.** A round, room, or team that is not present by its stable id is gone,
 * full stop. Matching on a team's name, a room's name, a round's display label, an array index, a
 * pool seed or a position would each be a guess about identity, and the failure mode of a wrong
 * guess here is a real, correctly formatted assignment sending two teams to play a game nobody
 * scheduled. Clearing a side costs the operator one dropdown; guessing costs a round.
 *
 * The report is what the caller turns into a single notice. It is deliberately counts and ids
 * rather than prose, so the UI decides the wording.
 */
export function reconcilePlans(
  plans: readonly RoundPlan[],
  known: {
    roundIds: ReadonlySet<string>;
    roomIds: ReadonlySet<string>;
    teamIds: ReadonlySet<string>;
  },
): PlanReconciliation {
  const next: RoundPlan[] = [];
  const removedRoundIds: string[] = [];
  const removedRoomIds = new Set<string>();
  let clearedSideCount = 0;
  let removedPairingCount = 0;

  for (const plan of plans) {
    if (!known.roundIds.has(plan.roundId)) {
      removedRoundIds.push(plan.roundId);
      continue;
    }
    const pairings: PlannedPairing[] = [];
    for (const pairing of plan.pairings) {
      if (!known.roomIds.has(pairing.roomId)) {
        removedRoomIds.add(pairing.roomId);
        continue;
      }
      const leftTeamId =
        pairing.leftTeamId !== null && !known.teamIds.has(pairing.leftTeamId) ? null : pairing.leftTeamId;
      const rightTeamId =
        pairing.rightTeamId !== null && !known.teamIds.has(pairing.rightTeamId) ? null : pairing.rightTeamId;
      if (leftTeamId !== pairing.leftTeamId) clearedSideCount += 1;
      if (rightTeamId !== pairing.rightTeamId) clearedSideCount += 1;
      if (leftTeamId === null && rightTeamId === null) {
        // Only counts as a lost pairing if it held something before this pass.
        if (pairing.leftTeamId !== null || pairing.rightTeamId !== null) removedPairingCount += 1;
        continue;
      }
      pairings.push({ roomId: pairing.roomId, leftTeamId, rightTeamId });
    }
    if (pairings.length > 0) next.push({ roundId: plan.roundId, pairings });
  }

  return {
    plans: next,
    removedRoundIds,
    removedRoomIds: [...removedRoomIds],
    clearedSideCount,
    removedPairingCount,
  };
}

/**
 * How one room's planned game for the selected round relates to what the relay is holding.
 *
 * - `no-game` — nothing planned here for this round, and the relay holds nothing for this room.
 * - `planned` — a complete matchup is entered but has never been published.
 * - `live` — the relay is serving exactly this round's planned pairing.
 * - `edited` — the relay is serving this round, but the plan has changed since it was published.
 * - `other-round` — the relay is serving a different round's assignment for this room.
 *
 * `other-round` is the case that made this function necessary. The room-level `waiting` status is
 * about whatever the relay currently holds, so while round 1 is live, *every* future round would
 * otherwise render as though its plan were already published — the operator entering round 5 would
 * be told round 5 was on the relay.
 */
export type PlanPublicationStatus = 'no-game' | 'planned' | 'live' | 'edited' | 'other-round';

/** The `Match.id` a planned pairing would be published under. Null when it is not playable. */
export function plannedMatchId(input: {
  tournamentId: string;
  roundId: string;
  pairing: PlannedPairing | undefined;
}): string | null {
  if (!isCompletePairing(input.pairing)) return null;
  return pairingMatchId({
    tournamentId: input.tournamentId,
    roundId: input.roundId,
    roomId: input.pairing.roomId,
    leftTeamId: input.pairing.leftTeamId,
    rightTeamId: input.pairing.rightTeamId,
  });
}

export function planPublicationStatus(input: {
  tournamentId: string;
  roundId: string | null;
  room: Pick<Room, 'id' | 'publishedMatchId' | 'publishedRoundId'>;
  pairing: PlannedPairing | undefined;
}): PlanPublicationStatus {
  const expected =
    input.roundId === null
      ? null
      : plannedMatchId({
          tournamentId: input.tournamentId,
          roundId: input.roundId,
          pairing: input.pairing,
        });
  const live = input.room.publishedMatchId;
  if (live === null) return expected === null ? 'no-game' : 'planned';
  if (input.room.publishedRoundId !== input.roundId) return 'other-round';
  return expected === live ? 'live' : 'edited';
}

/** The complete pairings of one round, in the configured rooms' order. Input to a publish. */
export function completePairingsFor(
  plans: readonly RoundPlan[],
  roundId: string | null,
  rooms: readonly Pick<Room, 'id'>[],
): CompletePairing[] {
  const pairings = pairingsForRound(plans, roundId);
  const complete: CompletePairing[] = [];
  for (const room of rooms) {
    const pairing = pairings.find((entry) => entry.roomId === room.id);
    if (isCompletePairing(pairing)) {
      complete.push({
        roomId: room.id,
        leftTeamId: pairing.leftTeamId,
        rightTeamId: pairing.rightTeamId,
      });
    }
  }
  return complete;
}
