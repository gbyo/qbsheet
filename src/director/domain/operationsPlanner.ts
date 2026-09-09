/**
 * Deterministic operational planning: fill a future round's rooms, staff, and equipment.
 *
 * # What this is for
 *
 * Director was good at saying "this combination is unsafe" and bad at saying "here is a safe one".
 * The planner closes that gap for *planned* and *prepared* rounds only. It returns a proposal and
 * the choices it could not make; it never mutates state. The controller applies a proposal in one
 * commit, which is what makes the whole operation undoable and auditable as a single decision.
 *
 * # Determinism
 *
 * Every candidate list is sorted by a stable key before selection, and preference is expressed as
 * an explicit score rather than iteration order. The same document produces the same proposal, so
 * a director who runs Prepare twice sees no churn and the tests can assert exact output.
 *
 * # Safety
 *
 * A game that has been released, started, submitted, accepted, or that carries a scorer session
 * with unresolved work is never touched — see `gameIsAutoRepairable`. Released and closed rounds
 * are excluded entirely. Unavailable rooms, staff, and equipment are never selected. Pins are
 * preserved even when they are the reason a round cannot be completed; an impossible pin becomes
 * an explicit unresolved decision rather than a silent replacement.
 */

import { type DirectorId, type DirectorState, type OperationalAssignment, type StaffRole } from './model';
import {
  currentOperationsRound,
  effectiveAssignmentForGame,
  gameIsAutoRepairable,
  operationalMatchupLabel,
  operationalRoundOrder,
  roomDefaultEquipmentIds,
  roundAssignments,
  roundIsAutoRepairable,
  type EffectiveAssignment,
  type OperationalTarget,
} from './operations';
import { qbtcpSessionHasUnresolvedWork, scheduledGameHasUnresolvedWork } from './scheduling';

export interface PlanRoundOptions {
  /**
   * How many equipment resources each room should end up with. Defaults to the number the room's
   * defaults name, which keeps a tournament that never configured equipment at zero.
   */
  equipmentPerRoom?: number;
  /** Leave existing valid choices alone and fill only empty slots. */
  fillOnly?: boolean;
  /** Treat these resources as unavailable, to preview the effect of marking them so. */
  excludeStaffIds?: readonly DirectorId[];
  excludeRoomIds?: readonly DirectorId[];
  excludeEquipmentIds?: readonly DirectorId[];
  /** Role capabilities to assume for a staff member, overriding the stored roles. */
  staffRoleOverrides?: Readonly<Record<DirectorId, readonly StaffRole[]>>;
}

/** One game's proposed operation, and how it differs from what is stored today. */
export interface PlannedAssignment {
  scheduledGameId: DirectorId;
  roundId: DirectorId;
  roomId: DirectorId | null;
  moderatorId: DirectorId | null;
  scorekeeperId: DirectorId | null;
  equipmentIds: DirectorId[];
  /** True when the proposal differs from what is stored. */
  changed: boolean;
  /** True when the game is released/live/result-bearing and was copied through untouched. */
  locked: boolean;
}

export interface UnresolvedPlanDecision {
  id: string;
  slot: 'room' | 'moderator' | 'scorekeeper' | 'equipment';
  scheduledGameId: DirectorId;
  message: string;
  action: string;
  target?: OperationalTarget;
}

export interface RoundOperationsPlan {
  roundId: DirectorId;
  /** False when the round is released or closed: nothing may be planned into it automatically. */
  planned: boolean;
  reason: string | null;
  assignments: PlannedAssignment[];
  unresolved: UnresolvedPlanDecision[];
  changeCount: number;
}

/* -------------------------------------------------------------------------- */
/* Candidate supply                                                            */
/* -------------------------------------------------------------------------- */

function byId<T extends { id: DirectorId }>(items: readonly T[]): Map<DirectorId, T> {
  return new Map(items.map((item) => [item.id, item]));
}

/**
 * Rooms this round may be planned into.
 *
 * A room with unresolved game or scorer work from *another* round still reserves itself: that is
 * the QBTCP occupancy rule, and auto-fill must not be the thing that quietly overrides it.
 */
function candidateRooms(state: DirectorState, roundId: DirectorId, options: PlanRoundOptions): DirectorId[] {
  const excluded = new Set(options.excludeRoomIds ?? []);
  return state.rooms
    .filter((room) => {
      if (excluded.has(room.id) || !room.available) return false;
      const foreignGame = state.scheduledGames.some(
        (game) =>
          game.roomId === room.id && game.roundId !== roundId && scheduledGameHasUnresolvedWork(state, game),
      );
      if (foreignGame) return false;
      return !state.qbtcpSessions.some(
        (session) => session.roomId === room.id && qbtcpSessionHasUnresolvedWork(state, session),
      );
    })
    .map((room) => room.id)
    .sort();
}

function staffRolesFor(
  state: DirectorState,
  staffId: DirectorId,
  options: PlanRoundOptions,
): readonly StaffRole[] {
  const override = options.staffRoleOverrides?.[staffId];
  if (override) return override;
  return state.staff.find((member) => member.id === staffId)?.roles ?? [];
}

function candidateStaff(
  state: DirectorState,
  role: 'moderator' | 'scorekeeper',
  options: PlanRoundOptions,
): DirectorId[] {
  const excluded = new Set(options.excludeStaffIds ?? []);
  return state.staff
    .filter(
      (member) =>
        !excluded.has(member.id) &&
        member.available &&
        staffRolesFor(state, member.id, options).includes(role),
    )
    .map((member) => member.id)
    .sort();
}

function candidateEquipment(state: DirectorState, options: PlanRoundOptions): DirectorId[] {
  const excluded = new Set(options.excludeEquipmentIds ?? []);
  return state.equipment
    .filter((item) => !excluded.has(item.id) && item.available)
    .map((item) => item.id)
    .sort();
}

/* -------------------------------------------------------------------------- */
/* Continuity preferences                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What each resource did in the previous round.
 *
 * Movement between rounds costs a tournament real time — people walk, buzzer systems get carried —
 * so the planner prefers to leave everyone where they were. This is a preference, never a
 * constraint: it breaks the moment it would produce an unsafe or conflicting assignment.
 */
interface Continuity {
  roomForModerator: Map<DirectorId, DirectorId>;
  roomForScorekeeper: Map<DirectorId, DirectorId>;
  roomForEquipment: Map<DirectorId, DirectorId>;
  moderatorForRoom: Map<DirectorId, DirectorId>;
  scorekeeperForRoom: Map<DirectorId, DirectorId>;
}

function previousRoundContinuity(state: DirectorState, roundId: DirectorId): Continuity {
  const order = operationalRoundOrder(state);
  const index = order.findIndex((round) => round.id === roundId);
  const continuity: Continuity = {
    roomForModerator: new Map(),
    roomForScorekeeper: new Map(),
    roomForEquipment: new Map(),
    moderatorForRoom: new Map(),
    scorekeeperForRoom: new Map(),
  };
  if (index <= 0) return continuity;
  const previous = order[index - 1]!;
  for (const assignment of roundAssignments(state, previous.id)) {
    if (!assignment.roomId) continue;
    if (assignment.moderatorId) {
      continuity.roomForModerator.set(assignment.moderatorId, assignment.roomId);
      continuity.moderatorForRoom.set(assignment.roomId, assignment.moderatorId);
    }
    if (assignment.scorekeeperId) {
      continuity.roomForScorekeeper.set(assignment.scorekeeperId, assignment.roomId);
      continuity.scorekeeperForRoom.set(assignment.roomId, assignment.scorekeeperId);
    }
    for (const item of assignment.equipmentIds) continuity.roomForEquipment.set(item, assignment.roomId);
  }
  return continuity;
}

/* -------------------------------------------------------------------------- */
/* The planner                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Propose a complete, safe operation for one round.
 *
 * Returns a proposal rather than mutating: the caller decides whether to apply it, and the same
 * function backs both "Prepare operations" and the preview shown before a resource is marked
 * unavailable.
 */
export function planRoundOperations(
  state: DirectorState,
  roundId: DirectorId,
  options: PlanRoundOptions = {},
): RoundOperationsPlan {
  const round = state.rounds.find((entry) => entry.id === roundId);
  if (!round) {
    return {
      roundId,
      planned: false,
      reason: 'That round is no longer in the tournament workspace.',
      assignments: [],
      unresolved: [],
      changeCount: 0,
    };
  }
  if (!roundIsAutoRepairable(state, roundId)) {
    return {
      roundId,
      planned: false,
      reason:
        round.status === 'released'
          ? `${round.name} has been released; its assignments change through recovery, not automatically.`
          : `${round.name} is ${round.status}; only planned and prepared rounds can be filled automatically.`,
      assignments: [],
      unresolved: [],
      changeCount: 0,
    };
  }

  const games = state.scheduledGames
    .filter((game) => game.roundId === roundId && !game.bye && game.status !== 'cancelled')
    .sort((left, right) => left.id.localeCompare(right.id));
  const existing = new Map(
    roundAssignments(state, roundId).map((assignment) => [assignment.scheduledGameId ?? '', assignment]),
  );

  const rooms = candidateRooms(state, roundId, options);
  const moderators = candidateStaff(state, 'moderator', options);
  const scorekeepers = candidateStaff(state, 'scorekeeper', options);
  const equipmentPool = candidateEquipment(state, options);
  const continuity = previousRoundContinuity(state, roundId);
  const roomById = byId(state.rooms);
  const staffById = byId(state.staff);
  const equipmentById = byId(state.equipment);

  const takenRooms = new Set<DirectorId>();
  const takenStaff = new Set<DirectorId>();
  const takenEquipment = new Set<DirectorId>();
  const unresolved: UnresolvedPlanDecision[] = [];
  const results: PlannedAssignment[] = [];

  // Non-room duties already recorded for this round hold their people out of the room pool.
  for (const duty of state.operationalAssignments) {
    if (duty.roundId !== roundId || duty.kind === 'room') continue;
    for (const staffId of duty.staffIds ?? []) takenStaff.add(staffId);
  }

  // Pass one reserves everything the planner may not move, so later passes cannot claim it.
  const locked = new Map<DirectorId, PlannedAssignment>();
  for (const game of games) {
    if (gameIsAutoRepairable(state, game)) continue;
    const current = existing.get(game.id) ?? effectiveAssignmentForGame(state, game);
    const entry: PlannedAssignment = {
      scheduledGameId: game.id,
      roundId,
      roomId: current.roomId,
      moderatorId: current.moderatorId,
      scorekeeperId: current.scorekeeperId,
      equipmentIds: [...current.equipmentIds].sort(),
      changed: false,
      locked: true,
    };
    locked.set(game.id, entry);
    if (entry.roomId) takenRooms.add(entry.roomId);
    if (entry.moderatorId) takenStaff.add(entry.moderatorId);
    if (entry.scorekeeperId) takenStaff.add(entry.scorekeeperId);
    for (const item of entry.equipmentIds) takenEquipment.add(item);
  }

  // Pass two reserves pinned choices on movable games, so an unpinned game cannot steal them.
  const pinnedByGame = new Map<DirectorId, EffectiveAssignment>();
  for (const game of games) {
    if (locked.has(game.id)) continue;
    const current = existing.get(game.id) ?? effectiveAssignmentForGame(state, game);
    pinnedByGame.set(game.id, current);
    if (current.pinned.room && current.roomId) takenRooms.add(current.roomId);
    if (current.pinned.moderator && current.moderatorId) takenStaff.add(current.moderatorId);
    if (current.pinned.scorekeeper && current.scorekeeperId) takenStaff.add(current.scorekeeperId);
    for (const item of current.pinned.equipmentIds) {
      if (current.equipmentIds.includes(item)) takenEquipment.add(item);
    }
  }

  const pick = (
    candidates: readonly DirectorId[],
    taken: ReadonlySet<DirectorId>,
    score: (id: DirectorId) => number,
  ): DirectorId | null => {
    let best: DirectorId | null = null;
    let bestScore = -Infinity;
    for (const id of candidates) {
      if (taken.has(id)) continue;
      const value = score(id);
      // Strictly greater keeps the tie-break on the sorted candidate order, which is what makes
      // repeated runs identical.
      if (value > bestScore) {
        best = id;
        bestScore = value;
      }
    }
    return best;
  };

  for (const game of games) {
    const lockedEntry = locked.get(game.id);
    if (lockedEntry) {
      results.push(lockedEntry);
      continue;
    }
    const current = pinnedByGame.get(game.id)!;
    const matchup = operationalMatchupLabel(state, game) ?? 'This game';

    /* Room --------------------------------------------------------------- */
    let roomId: DirectorId | null = null;
    if (current.pinned.room) {
      roomId = current.roomId;
      if (roomId && !rooms.includes(roomId)) {
        unresolved.push({
          id: `pinned-room-unusable-${game.id}`,
          slot: 'room',
          scheduledGameId: game.id,
          message: `${matchup} is pinned to ${roomById.get(roomId)?.name ?? 'a room'}, which is not usable for ${round.name}.`,
          action: 'Choose another room',
          target: { entityType: 'game', entityId: game.id, parentId: roundId },
        });
      }
    } else if (
      options.fillOnly &&
      current.roomId &&
      rooms.includes(current.roomId) &&
      !takenRooms.has(current.roomId)
    ) {
      roomId = current.roomId;
    } else {
      const preferredRoom = current.roomId;
      roomId = pick(rooms, takenRooms, (id) => {
        // Keeping a game where it already is beats every other consideration; after that, keeping
        // its previous-round moderator and scorekeeper in place beats an arbitrary free room.
        let score = 0;
        if (id === preferredRoom) score += 100;
        if (current.moderatorId && continuity.roomForModerator.get(current.moderatorId) === id) score += 10;
        if (current.scorekeeperId && continuity.roomForScorekeeper.get(current.scorekeeperId) === id) {
          score += 10;
        }
        if (continuity.moderatorForRoom.has(id) || continuity.scorekeeperForRoom.has(id)) score += 1;
        return score;
      });
      if (!roomId) {
        unresolved.push({
          id: `no-room-${game.id}`,
          slot: 'room',
          scheduledGameId: game.id,
          message: `${matchup} has no usable room in ${round.name}.`,
          action: 'Add or free a room',
          target: { entityType: 'game', entityId: game.id, parentId: roundId },
        });
      }
    }
    if (roomId) takenRooms.add(roomId);
    const room = roomId ? (roomById.get(roomId) ?? null) : null;

    /* Staff -------------------------------------------------------------- */
    const chooseStaff = (
      slot: 'moderator' | 'scorekeeper',
      pool: readonly DirectorId[],
      pinned: boolean,
      currentId: DirectorId | null,
    ): DirectorId | null => {
      if (pinned) {
        if (currentId && !pool.includes(currentId)) {
          const member = staffById.get(currentId);
          unresolved.push({
            id: `pinned-${slot}-unusable-${game.id}`,
            slot,
            scheduledGameId: game.id,
            message: `${member?.name ?? `The pinned ${slot}`} is pinned to ${matchup} but cannot serve as ${slot}.`,
            action: `Choose another ${slot}`,
            target: { entityType: 'staff', entityId: currentId },
          });
        }
        return currentId;
      }
      if (options.fillOnly && currentId && pool.includes(currentId) && !takenStaff.has(currentId)) {
        return currentId;
      }
      const roomDefault = slot === 'moderator' ? room?.moderatorId : room?.scorekeeperId;
      const previousHere = roomId
        ? slot === 'moderator'
          ? continuity.moderatorForRoom.get(roomId)
          : continuity.scorekeeperForRoom.get(roomId)
        : undefined;
      const chosen = pick(pool, takenStaff, (id) => {
        let score = 0;
        if (id === currentId) score += 100;
        if (id === previousHere) score += 25;
        if (id === roomDefault) score += 10;
        // A single-role specialist is worth more in that role than someone who can also moderate.
        if (staffRolesFor(state, id, options).length === 1) score += 2;
        return score;
      });
      if (!chosen) {
        unresolved.push({
          id: `no-${slot}-${game.id}`,
          slot,
          scheduledGameId: game.id,
          message: `${room?.name ?? matchup} needs a ${slot} for ${round.name} and no available ${slot} is free.`,
          action: `Assign ${slot}`,
          target: { entityType: 'game', entityId: game.id, parentId: roundId },
        });
      }
      return chosen;
    };

    const moderatorId = chooseStaff('moderator', moderators, current.pinned.moderator, current.moderatorId);
    if (moderatorId) takenStaff.add(moderatorId);
    const scorekeeperId = chooseStaff(
      'scorekeeper',
      scorekeepers,
      current.pinned.scorekeeper,
      current.scorekeeperId,
    );
    if (scorekeeperId) takenStaff.add(scorekeeperId);

    /* Equipment ---------------------------------------------------------- */
    const pinnedEquipment = current.pinned.equipmentIds.filter((id) => current.equipmentIds.includes(id));
    for (const item of pinnedEquipment) {
      if (equipmentPool.includes(item)) continue;
      unresolved.push({
        id: `pinned-equipment-unusable-${game.id}-${item}`,
        slot: 'equipment',
        scheduledGameId: game.id,
        message: `${equipmentById.get(item)?.name ?? 'Pinned equipment'} is pinned to ${room?.name ?? matchup} but is not available.`,
        action: 'Choose other equipment',
        target: { entityType: 'equipment', entityId: item },
      });
    }
    const wanted =
      options.equipmentPerRoom ??
      Math.max(
        pinnedEquipment.length,
        room ? roomDefaultEquipmentIds(room).length : 0,
        current.equipmentIds.length,
      );
    const equipmentIds = [...pinnedEquipment];
    for (const item of equipmentIds) takenEquipment.add(item);
    while (equipmentIds.length < wanted) {
      const preferredDefaults = room ? roomDefaultEquipmentIds(room) : [];
      const chosen = pick(equipmentPool, takenEquipment, (id) => {
        let score = 0;
        if (current.equipmentIds.includes(id)) score += 100;
        if (roomId && continuity.roomForEquipment.get(id) === roomId) score += 25;
        if (preferredDefaults.includes(id)) score += 10;
        return score;
      });
      if (!chosen) {
        unresolved.push({
          id: `no-equipment-${game.id}-${equipmentIds.length}`,
          slot: 'equipment',
          scheduledGameId: game.id,
          message: `${room?.name ?? matchup} needs ${wanted} equipment resource(s) and only ${equipmentIds.length} could be assigned.`,
          action: 'Free equipment',
          target: { entityType: 'game', entityId: game.id, parentId: roundId },
        });
        break;
      }
      equipmentIds.push(chosen);
      takenEquipment.add(chosen);
    }
    equipmentIds.sort();

    const changed =
      roomId !== current.roomId ||
      moderatorId !== current.moderatorId ||
      scorekeeperId !== current.scorekeeperId ||
      equipmentIds.join('') !== [...current.equipmentIds].sort().join('');

    results.push({
      scheduledGameId: game.id,
      roundId,
      roomId,
      moderatorId,
      scorekeeperId,
      equipmentIds,
      changed,
      locked: false,
    });
  }

  return {
    roundId,
    planned: true,
    reason: null,
    assignments: results,
    unresolved,
    changeCount: results.filter((entry) => entry.changed).length,
  };
}

/* -------------------------------------------------------------------------- */
/* Resource impact                                                             */
/* -------------------------------------------------------------------------- */

export type OperationalResourceKind = 'staff' | 'room' | 'equipment';

export interface AffectedAssignment {
  roundId: DirectorId;
  roundName: string;
  /** The scheduled game, or the duty assignment id for a runner/HQ duty. */
  scheduledGameId: DirectorId;
  roomId: DirectorId | null;
  roomName: string | null;
  matchup: string | null;
  slot: 'room' | 'moderator' | 'scorekeeper' | 'equipment' | 'duty';
  /** True when the round or game cannot be repaired automatically. */
  locked: boolean;
}

export interface ResourceImpact {
  kind: OperationalResourceKind;
  resourceId: DirectorId;
  resourceName: string;
  /** Future assignments that would break. */
  affected: AffectedAssignment[];
  /** Of those, the ones a repair can actually change. */
  repairable: AffectedAssignment[];
  /** Rounds a repair would touch, in day order. */
  roundIds: DirectorId[];
  /** Rounds that reference the resource but cannot be repaired automatically. */
  lockedRoundIds: DirectorId[];
}

/**
 * What breaks if a resource becomes unavailable, or loses a role.
 *
 * Shown before the change is committed, which is the difference between "Director told me after the
 * fact that Round 5 is broken" and "Director offered to fix Round 5 while I was still deciding".
 * Only planned and prepared rounds count as repairable; a released round's assignments are still
 * surfaced, but left to the existing explicit recovery actions.
 *
 * `retainedRoles` narrows a staff impact to a role change: only assignments in a role the member
 * would no longer hold are counted.
 */
export function resourceUnavailabilityImpact(
  state: DirectorState,
  kind: OperationalResourceKind,
  resourceId: DirectorId,
  options: { retainedRoles?: readonly StaffRole[] } = {},
): ResourceImpact {
  const order = operationalRoundOrder(state);
  const currentRound = currentOperationsRound(state);
  const currentIndex = currentRound ? order.findIndex((round) => round.id === currentRound.id) : -1;
  const name =
    kind === 'staff'
      ? (state.staff.find((member) => member.id === resourceId)?.name ?? 'This staff member')
      : kind === 'room'
        ? (state.rooms.find((room) => room.id === resourceId)?.name ?? 'This room')
        : (state.equipment.find((item) => item.id === resourceId)?.name ?? 'This equipment');
  const retained = options.retainedRoles ? new Set(options.retainedRoles) : null;
  const stillHolds = (role: StaffRole) => (retained ? retained.has(role) : false);

  const affected: AffectedAssignment[] = [];
  order.forEach((round, index) => {
    if (round.status === 'closed') return;
    // The current round counts: a person who walks out mid-round still has to be replaced. What
    // differs is that a released round cannot be repaired automatically.
    if (currentIndex >= 0 && index < currentIndex) return;
    const repairableRound = roundIsAutoRepairable(state, round.id);
    for (const assignment of roundAssignments(state, round.id)) {
      const game = assignment.scheduledGameId
        ? state.scheduledGames.find((entry) => entry.id === assignment.scheduledGameId)
        : undefined;
      if (!game) continue;
      const room = assignment.roomId ? state.rooms.find((entry) => entry.id === assignment.roomId) : undefined;
      const locked = !repairableRound || !gameIsAutoRepairable(state, game);
      const record = (slot: AffectedAssignment['slot']) => {
        affected.push({
          roundId: round.id,
          roundName: round.name,
          scheduledGameId: game.id,
          roomId: assignment.roomId,
          roomName: room?.name ?? null,
          matchup: operationalMatchupLabel(state, game),
          slot,
          locked,
        });
      };
      if (kind === 'room' && assignment.roomId === resourceId) record('room');
      if (kind === 'staff') {
        if (assignment.moderatorId === resourceId && !stillHolds('moderator')) record('moderator');
        if (assignment.scorekeeperId === resourceId && !stillHolds('scorekeeper')) record('scorekeeper');
      }
      if (kind === 'equipment' && assignment.equipmentIds.includes(resourceId)) record('equipment');
    }
    if (kind === 'staff') {
      for (const duty of state.operationalAssignments) {
        if (duty.roundId !== round.id || duty.kind === 'room') continue;
        if (!(duty.staffIds ?? []).includes(resourceId)) continue;
        if (stillHolds(duty.kind === 'hq' ? 'hq' : 'runner')) continue;
        affected.push({
          roundId: round.id,
          roundName: round.name,
          scheduledGameId: duty.id,
          roomId: null,
          roomName: null,
          matchup: duty.kind === 'hq' ? 'HQ duty' : 'Runner duty',
          slot: 'duty',
          locked: !repairableRound,
        });
      }
    }
  });

  const repairable = affected.filter((entry) => !entry.locked);
  return {
    kind,
    resourceId,
    resourceName: name,
    affected,
    repairable,
    roundIds: [...new Set(repairable.map((entry) => entry.roundId))],
    lockedRoundIds: [...new Set(affected.filter((entry) => entry.locked).map((entry) => entry.roundId))],
  };
}

/**
 * Turn a proposal into the assignment records a commit should store.
 *
 * Kept separate from `planRoundOperations` so the planner stays a pure function of state and the
 * controller owns identity generation.
 */
export function planToAssignments(
  state: DirectorState,
  plan: RoundOperationsPlan,
  newId: (prefix: string) => DirectorId,
): OperationalAssignment[] {
  return plan.assignments.map((entry) => {
    const stored = state.operationalAssignments.find(
      (candidate) => candidate.kind === 'room' && candidate.scheduledGameId === entry.scheduledGameId,
    );
    const assignment: OperationalAssignment = {
      id: stored?.id ?? newId('assignment'),
      roundId: entry.roundId,
      kind: 'room',
      scheduledGameId: entry.scheduledGameId,
      roomId: entry.roomId,
      moderatorId: entry.moderatorId,
      scorekeeperId: entry.scorekeeperId,
      equipmentIds: entry.equipmentIds,
    };
    // Auto-fill produces unpinned choices. Only pins the director already made survive, which is
    // what lets the same round be re-planned without accumulating frozen decisions.
    if (stored?.pinned) assignment.pinned = stored.pinned;
    if (stored?.notes) assignment.notes = stored.notes;
    return assignment;
  });
}

/** Every planned/prepared round from the given round onward, for cascading repair. */
export function repairScope(state: DirectorState, fromRoundId?: DirectorId): DirectorId[] {
  const order = operationalRoundOrder(state);
  const currentId = fromRoundId ?? currentOperationsRound(state)?.id;
  const start = currentId ? order.findIndex((round) => round.id === currentId) : 0;
  return order
    .slice(Math.max(0, start))
    .filter((round) => roundIsAutoRepairable(state, round.id))
    .map((round) => round.id);
}

/** True when a plan proposes a change to one game's assignment. */
export function planChangesGame(plan: RoundOperationsPlan, scheduledGameId: DirectorId): boolean {
  return plan.assignments.some((entry) => entry.scheduledGameId === scheduledGameId && entry.changed);
}
