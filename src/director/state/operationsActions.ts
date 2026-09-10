/**
 * Mutations over the operational assignment layer.
 *
 * These are plain functions over a draft document rather than controller methods, so the same
 * logic is testable without React and the controller stays a thin wrapper that owns commits,
 * errors, and audit. Each returns an error string when the change is refused, or `null` when the
 * draft has been updated — the controller turns that into its usual boolean result.
 *
 * Every function here refuses to touch released, live, submitted, or result-bearing work. That
 * boundary is not enforced by the UI: it is enforced here, so a deep link, a keyboard shortcut, or
 * a future caller cannot get around it.
 */

import {
  effectiveAssignmentForGame,
  gameIsAutoRepairable,
  newDirectorId,
  planRoundOperations,
  planToAssignments,
  roomDefaultEquipmentIds,
  roundIsAutoRepairable,
  type DirectorId,
  type DirectorState,
  type OperationalAssignment,
  type OperationalAssignmentKind,
  type PlanRoundOptions,
  type RoundOperationsPlan,
  type ScheduledGame,
} from '../domain';

export type AssignmentSlot = 'room' | 'moderator' | 'scorekeeper' | 'equipment';

export interface AssignmentChanges {
  roomId?: DirectorId | null;
  moderatorId?: DirectorId | null;
  scorekeeperId?: DirectorId | null;
  equipmentIds?: DirectorId[];
}

/** Why an assignment cannot be edited, or null when it can. */
export function assignmentChangeBlocker(
  state: DirectorState,
  scheduledGameId: DirectorId,
  changes: AssignmentChanges,
): string | null {
  const game = state.scheduledGames.find((entry) => entry.id === scheduledGameId);
  if (!game) return 'That scheduled game is no longer in the tournament workspace.';
  if (game.bye) return 'A bye has no operational assignment.';
  if (game.status === 'cancelled') return 'This game was cancelled; its assignment cannot be changed.';
  if (game.status === 'accepted') return 'This game is complete; its assignment cannot be changed.';

  const round = state.rounds.find((entry) => entry.id === game.roundId);
  if (!round) return 'That round is no longer in the tournament workspace.';
  if (round.status === 'closed') return 'This round is closed; its assignments are historical.';

  // A released round's *room* is recovery's business, because moving a released game can split
  // scorer state. Staff and equipment on a released round are safe to correct: nobody's scoresheet
  // depends on which person is standing in the room.
  const movingRoom = changes.roomId !== undefined && changes.roomId !== game.roomId;
  if (movingRoom && round.status === 'released') {
    return 'This round has been released; move a game between rooms with the recovery action so scorer state cannot split.';
  }
  if (movingRoom && game.status !== 'scheduled') {
    return 'This game has already started; changing its room could split scorer state.';
  }
  if (
    movingRoom &&
    state.games.some((record) => record.scheduledGameId === game.id && record.status !== 'scheduled')
  ) {
    return 'A result exists for this game; its room cannot be changed here.';
  }
  if (movingRoom && changes.roomId) {
    const destination = state.rooms.find((entry) => entry.id === changes.roomId);
    if (!destination) return 'Choose an existing room.';
    if (!destination.available) return `${destination.name} is marked unavailable.`;
    const occupant = state.scheduledGames.find(
      (entry) =>
        entry.id !== game.id &&
        entry.roomId === changes.roomId &&
        entry.roundId === game.roundId &&
        !entry.bye &&
        entry.status !== 'cancelled',
    );
    if (occupant) return `${destination.name} already hosts another game in this round.`;
  }

  const roundDuty = (staffId: DirectorId): 'HQ' | 'runner' | null => {
    const duty = state.operationalAssignments.find(
      (entry) =>
        entry.roundId === game.roundId &&
        (entry.kind === 'hq' || entry.kind === 'runner') &&
        entry.staffIds.includes(staffId),
    );
    if (!duty) return null;
    return duty.kind === 'hq' ? 'HQ' : 'runner';
  };
  const roleBlocker = (staffId: DirectorId | null | undefined, role: 'moderator' | 'scorekeeper') => {
    if (!staffId) return null;
    const member = state.staff.find((entry) => entry.id === staffId);
    if (!member) return 'Choose a staff member who is in the tournament workspace.';
    if (!member.available) return `${member.name} is marked unavailable.`;
    if (!member.roles.includes(role)) return `${member.name} is not marked as a ${role}.`;
    const duty = roundDuty(staffId);
    if (duty) return `${member.name} is already on ${duty} duty in this round.`;
    const clash = state.scheduledGames.find((entry) => {
      if (entry.id === game.id || entry.roundId !== game.roundId || entry.bye) return false;
      if (entry.status === 'cancelled') return false;
      const other = effectiveAssignmentForGame(state, entry);
      return other.moderatorId === staffId || other.scorekeeperId === staffId;
    });
    if (clash) return `${member.name} is already assigned elsewhere in this round.`;
    return null;
  };
  const moderatorBlocker = roleBlocker(changes.moderatorId, 'moderator');
  if (changes.moderatorId !== undefined && moderatorBlocker) return moderatorBlocker;
  const scorekeeperBlocker = roleBlocker(changes.scorekeeperId, 'scorekeeper');
  if (changes.scorekeeperId !== undefined && scorekeeperBlocker) return scorekeeperBlocker;
  // Validate the resulting effective assignment, not just the changed fields: a
  // one-field staff edit must not leave one person in both room roles (#708).
  if (changes.moderatorId !== undefined || changes.scorekeeperId !== undefined) {
    const current = effectiveAssignmentForGame(state, game);
    const nextModerator = changes.moderatorId !== undefined ? changes.moderatorId : current.moderatorId;
    const nextScorekeeper =
      changes.scorekeeperId !== undefined ? changes.scorekeeperId : current.scorekeeperId;
    if (nextModerator && nextModerator === nextScorekeeper) {
      return 'One person cannot moderate and score the same game.';
    }
  }

  if (changes.equipmentIds) {
    if (new Set(changes.equipmentIds).size !== changes.equipmentIds.length) {
      return 'Each equipment resource can only be assigned to a room once.';
    }
    for (const equipmentId of changes.equipmentIds) {
      const resource = state.equipment.find((entry) => entry.id === equipmentId);
      if (!resource) return 'Choose equipment that is in the tournament workspace.';
      if (!resource.available) return `${resource.name} is marked unavailable.`;
      const clash = state.scheduledGames.find((entry) => {
        if (entry.id === game.id || entry.roundId !== game.roundId || entry.bye) return false;
        if (entry.status === 'cancelled') return false;
        return effectiveAssignmentForGame(state, entry).equipmentIds.includes(equipmentId);
      });
      if (clash) return `${resource.name} is already assigned to another room in this round.`;
    }
  }
  return null;
}

/** The assignment record for a game, materializing the inherited one on first write. */
function ensureAssignment(draft: DirectorState, game: ScheduledGame): OperationalAssignment {
  const existing = draft.operationalAssignments.find(
    (entry) => entry.kind === 'room' && entry.scheduledGameId === game.id,
  );
  if (existing) return existing;
  const room = game.roomId ? draft.rooms.find((entry) => entry.id === game.roomId) : undefined;
  const created: OperationalAssignment = {
    id: newDirectorId('assignment'),
    roundId: game.roundId,
    kind: 'room',
    scheduledGameId: game.id,
    roomId: game.roomId ?? null,
    moderatorId: room?.moderatorId ?? null,
    scorekeeperId: room?.scorekeeperId ?? null,
    equipmentIds: room ? roomDefaultEquipmentIds(room) : [],
  };
  draft.operationalAssignments.push(created);
  return created;
}

/**
 * Apply an explicit director choice to one game's assignment.
 *
 * A hand-made choice is pinned by definition: the whole point of pinning is to distinguish what a
 * person decided from what auto-fill guessed, and the moment to record that is the moment they
 * decide it.
 */
export function applyAssignmentChanges(
  draft: DirectorState,
  scheduledGameId: DirectorId,
  changes: AssignmentChanges,
): void {
  const game = draft.scheduledGames.find((entry) => entry.id === scheduledGameId);
  if (!game) return;
  const assignment = ensureAssignment(draft, game);
  const pinned = { ...(assignment.pinned ?? {}) };
  if (changes.roomId !== undefined) {
    assignment.roomId = changes.roomId;
    // The schedule row stays the authority on where a game is played; the assignment mirrors it.
    game.roomId = changes.roomId;
    pinned.room = changes.roomId !== null;
  }
  if (changes.moderatorId !== undefined) {
    assignment.moderatorId = changes.moderatorId;
    pinned.moderator = changes.moderatorId !== null;
  }
  if (changes.scorekeeperId !== undefined) {
    assignment.scorekeeperId = changes.scorekeeperId;
    pinned.scorekeeper = changes.scorekeeperId !== null;
  }
  if (changes.equipmentIds !== undefined) {
    assignment.equipmentIds = [...changes.equipmentIds];
    pinned.equipmentIds = [...changes.equipmentIds];
  }
  assignment.pinned = pinned;
}

/** Turn one slot's pin on or off without changing what is assigned. */
export function applyAssignmentPin(
  draft: DirectorState,
  scheduledGameId: DirectorId,
  slot: AssignmentSlot,
  pinned: boolean,
): void {
  const game = draft.scheduledGames.find((entry) => entry.id === scheduledGameId);
  if (!game) return;
  const assignment = ensureAssignment(draft, game);
  const pins = { ...(assignment.pinned ?? {}) };
  if (slot === 'equipment') {
    pins.equipmentIds = pinned ? [...assignment.equipmentIds] : [];
  } else {
    pins[slot] = pinned;
  }
  assignment.pinned = pins;
}

/**
 * Replace a round's non-room duty roster.
 *
 * Runner and HQ are round-scoped rather than room-shaped, which is what stops them being forced
 * into a moderator or scorekeeper slot they do not belong in.
 */
export function dutyChangeBlocker(
  state: DirectorState,
  roundId: DirectorId,
  kind: Exclude<OperationalAssignmentKind, 'room'>,
  staffIds: readonly DirectorId[],
): string | null {
  const round = state.rounds.find((entry) => entry.id === roundId);
  if (!round) return 'That round is no longer in the tournament workspace.';
  if (round.status === 'closed') return 'This round is closed; its duties are historical.';
  const role = kind === 'hq' ? 'hq' : 'runner';
  for (const staffId of staffIds) {
    const member = state.staff.find((entry) => entry.id === staffId);
    if (!member) return 'Choose a staff member who is in the tournament workspace.';
    if (!member.available) return `${member.name} is marked unavailable.`;
    if (!member.roles.includes(role)) return `${member.name} is not marked for ${role} duty.`;
    const inRoom = state.scheduledGames.some((game) => {
      if (game.roundId !== roundId || game.bye || game.status === 'cancelled') return false;
      const assignment = effectiveAssignmentForGame(state, game);
      return assignment.moderatorId === staffId || assignment.scorekeeperId === staffId;
    });
    if (inRoom) return `${member.name} is already working a room in this round.`;
    const otherDuty = state.operationalAssignments.find(
      (entry) =>
        entry.roundId === roundId &&
        entry.kind !== 'room' &&
        entry.kind !== kind &&
        (entry.staffIds ?? []).includes(staffId),
    );
    if (otherDuty) return `${member.name} already has another duty in this round.`;
  }
  return null;
}

export function applyDutyChange(
  draft: DirectorState,
  roundId: DirectorId,
  kind: Exclude<OperationalAssignmentKind, 'room'>,
  staffIds: readonly DirectorId[],
): void {
  const index = draft.operationalAssignments.findIndex(
    (entry) => entry.roundId === roundId && entry.kind === kind,
  );
  if (staffIds.length === 0) {
    if (index >= 0) draft.operationalAssignments.splice(index, 1);
    return;
  }
  if (index >= 0) {
    draft.operationalAssignments[index] = {
      ...draft.operationalAssignments[index]!,
      staffIds: [...staffIds],
    };
    return;
  }
  draft.operationalAssignments.push({
    id: newDirectorId('assignment'),
    roundId,
    kind,
    staffIds: [...staffIds],
    equipmentIds: [],
  });
}

/**
 * Write a planner proposal into the draft.
 *
 * The proposal's own locked entries are written back unchanged, which is deliberate: the plan is a
 * complete description of the round, so applying it twice is idempotent and a partially applied
 * plan cannot exist.
 */
export function applyRoundPlan(draft: DirectorState, plan: RoundOperationsPlan): number {
  if (!plan.planned) return 0;
  const produced = planToAssignments(draft, plan, newDirectorId);
  const producedGameIds = new Set(produced.map((entry) => entry.scheduledGameId));
  draft.operationalAssignments = [
    ...draft.operationalAssignments.filter(
      (entry) =>
        entry.kind !== 'room' ||
        entry.roundId !== plan.roundId ||
        !entry.scheduledGameId ||
        !producedGameIds.has(entry.scheduledGameId),
    ),
    ...produced,
  ];
  // The schedule row is where the rest of Director reads a game's room, so it moves with the plan.
  // Only movable games are touched; a locked entry keeps the room it already has.
  for (const entry of plan.assignments) {
    if (entry.locked) continue;
    const game = draft.scheduledGames.find((candidate) => candidate.id === entry.scheduledGameId);
    if (!game || game.roomId === entry.roomId) continue;
    game.roomId = entry.roomId;
    game.assignmentRevision += 1;
  }
  return plan.changeCount;
}

/**
 * Plan and apply several rounds in one pass.
 *
 * Each round is planned against the draft as it stands after the previous one, so a repair that
 * frees a room in Round 5 is visible when Round 6 is planned. Rounds that cannot be planned are
 * skipped rather than failing the whole repair.
 */
export function applyRoundPlans(
  draft: DirectorState,
  roundIds: readonly DirectorId[],
  options: PlanRoundOptions = {},
): { changed: number; unresolved: RoundOperationsPlan['unresolved'] } {
  let changed = 0;
  const unresolved: RoundOperationsPlan['unresolved'] = [];
  for (const roundId of roundIds) {
    if (!roundIsAutoRepairable(draft, roundId)) continue;
    const plan = planRoundOperations(draft, roundId, options);
    if (!plan.planned) continue;
    changed += applyRoundPlan(draft, plan);
    unresolved.push(...plan.unresolved);
  }
  return { changed, unresolved };
}

/** True when at least one game in the round can still be moved by the planner. */
export function roundHasMovableGames(state: DirectorState, roundId: DirectorId): boolean {
  return state.scheduledGames.some(
    (game) =>
      game.roundId === roundId &&
      !game.bye &&
      game.status !== 'cancelled' &&
      gameIsAutoRepairable(state, game),
  );
}
