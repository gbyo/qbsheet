/**
 * The canonical operational truth: who and what is operating where, now and next.
 *
 * # Why this exists
 *
 * Rooms, Staff, Equipment, Schedule, Overview, preflight, release validation, and QBTCP recovery
 * all used to answer "is this room usable?" by reconstructing it from `Room.status`, the schedule,
 * and the session list independently. They drifted, because `Room.status` is written by six
 * different workflows and is therefore partly stored and partly derived.
 *
 * Everything here is *derived*. The persisted document keeps durable operator intent —
 * `Room.available`, `StaffMember.available`, `EquipmentResource.available`, and the explicit
 * per-round `OperationalAssignment` records — and readiness is computed from facts. There is no
 * second readiness algorithm anywhere else; surfaces that need one import from this module.
 *
 * # The effective assignment
 *
 * A round is operated through `OperationalAssignment` records. Documents that predate them, and
 * tournaments whose director never opens Operations, have none — so every read resolves an
 * *effective* assignment: the explicit record when one exists, otherwise one synthesized from the
 * scheduled game's room plus that room's defaults. This is what keeps a manual, room-less
 * tournament valid: no assignment record is ever required for a tournament to work.
 */

import {
  orderDayItems,
  type DirectorId,
  type DirectorState,
  type EquipmentResource,
  type OperationalAssignment,
  type OperationalAssignmentKind,
  type QbtcpHelpRequest,
  type QbtcpRoomSession,
  type Room,
  type Round,
  type ScheduledGame,
  type StaffMember,
  type StaffRole,
} from './model';
import {
  qbtcpSessionHasUnresolvedWork,
  roomHasUnresolvedWork,
  scheduledGameHasUnresolvedWork,
} from './scheduling';

/**
 * Derived operational state. Replaces ad hoc reads of the persisted `Room.status`.
 *
 * The order matters: `operationalReadinessRank` sorts by urgency, and the derivation picks the
 * most urgent state that applies rather than the most recent event to touch the room.
 */
export type OperationalReadiness =
  | 'blocked'
  | 'help'
  | 'offline'
  | 'awaiting-result'
  | 'playing'
  | 'connected'
  | 'assigned'
  | 'ready';

const readinessRank: Record<OperationalReadiness, number> = {
  blocked: 0,
  help: 1,
  offline: 2,
  'awaiting-result': 3,
  playing: 4,
  connected: 5,
  assigned: 6,
  ready: 7,
};

export function operationalReadinessRank(readiness: OperationalReadiness): number {
  return readinessRank[readiness];
}

export function operationalReadinessLabel(readiness: OperationalReadiness): string {
  switch (readiness) {
    case 'ready':
      return 'Ready';
    case 'assigned':
      return 'Assigned';
    case 'connected':
      return 'Connected';
    case 'playing':
      return 'Playing';
    case 'awaiting-result':
      return 'Awaiting result';
    case 'help':
      return 'Needs help';
    case 'offline':
      return 'Unavailable';
    case 'blocked':
      return 'Blocked';
  }
}

/**
 * Where the fix for an operational problem is.
 *
 * Deliberately not `DirectorNavigationTarget`: the domain must not depend on the application's
 * section ids. The UI maps these onto navigation targets in one place.
 */
export interface OperationalTarget {
  entityType: 'room' | 'staff' | 'equipment' | 'game' | 'round';
  entityId: DirectorId;
  parentId?: DirectorId;
}

export interface OperationalIssue {
  id: string;
  severity: 'blocker' | 'warning';
  message: string;
  /** The single action that resolves it, phrased as a button label. */
  action?: string;
  target?: OperationalTarget;
}

/** Whether an assignment is a stored director decision or inherited from room defaults. */
export type AssignmentOrigin = 'explicit' | 'inherited';

export interface EffectiveAssignment {
  id: DirectorId | null;
  roundId: DirectorId;
  kind: OperationalAssignmentKind;
  scheduledGameId: DirectorId | null;
  roomId: DirectorId | null;
  moderatorId: DirectorId | null;
  scorekeeperId: DirectorId | null;
  staffIds: DirectorId[];
  equipmentIds: DirectorId[];
  origin: AssignmentOrigin;
  pinned: {
    room: boolean;
    moderator: boolean;
    scorekeeper: boolean;
    equipmentIds: DirectorId[];
    staffIds: DirectorId[];
  };
}

export interface OperationalRoomView {
  room: Room;
  round: Round | null;
  game: ScheduledGame | null;
  assignment: EffectiveAssignment | null;
  moderator: StaffMember | null;
  scorekeeper: StaffMember | null;
  equipment: EquipmentResource[];
  qbtcpSession: QbtcpRoomSession | null;
  qbtcpDevice: string | null;
  /** The staff member actually operating the connected scorer, when Director can identify them. */
  qbtcpStaff: StaffMember | null;
  helpRequest: QbtcpHelpRequest | null;
  readiness: OperationalReadiness;
  blockers: OperationalIssue[];
  warnings: OperationalIssue[];
  nextGame: ScheduledGame | null;
  nextRound: Round | null;
  /** True when the room can take a *new* future assignment right now. */
  assignable: boolean;
  hasUnresolvedWork: boolean;
}

export interface StaffDutyView {
  round: Round;
  kind: OperationalAssignmentKind;
  role: StaffRole | null;
  roomId: DirectorId | null;
  roomName: string | null;
  scheduledGameId: DirectorId | null;
  matchup: string | null;
  assignmentId: DirectorId | null;
}

export interface OperationalStaffView {
  staff: StaffMember;
  roles: StaffRole[];
  available: boolean;
  current: StaffDutyView | null;
  next: StaffDutyView | null;
  /** Every duty in scope, in day order. */
  duties: StaffDutyView[];
  qbtcpSession: QbtcpRoomSession | null;
  blockers: OperationalIssue[];
  warnings: OperationalIssue[];
}

export interface EquipmentUseView {
  round: Round;
  roomId: DirectorId | null;
  roomName: string | null;
  scheduledGameId: DirectorId | null;
  assignmentId: DirectorId | null;
}

export interface OperationalEquipmentView {
  equipment: EquipmentResource;
  available: boolean;
  current: EquipmentUseView | null;
  next: EquipmentUseView | null;
  uses: EquipmentUseView[];
  blockers: OperationalIssue[];
  warnings: OperationalIssue[];
}

export interface OperationalDutyView {
  assignment: OperationalAssignment;
  kind: Exclude<OperationalAssignmentKind, 'room'>;
  staff: StaffMember[];
  blockers: OperationalIssue[];
  warnings: OperationalIssue[];
}

export interface RoundOperationsSummary {
  games: number;
  gamesWithRooms: number;
  staffPositionsRequired: number;
  staffPositionsFilled: number;
  scorekeepersExpected: number;
  scorekeepersConnected: number;
  moderators: number;
  scorekeepers: number;
  runners: number;
  hq: number;
  unstaffedActiveRooms: number;
  issues: number;
}

export interface RoundOperations {
  round: Round | null;
  rooms: OperationalRoomView[];
  staff: OperationalStaffView[];
  equipment: OperationalEquipmentView[];
  duties: OperationalDutyView[];
  summary: RoundOperationsSummary;
  blockers: OperationalIssue[];
  warnings: OperationalIssue[];
}

/* -------------------------------------------------------------------------- */
/* Round scope                                                                 */
/* -------------------------------------------------------------------------- */

/** Rounds in the persisted tournament-day sequence. */
export function operationalRoundOrder(state: DirectorState): Round[] {
  return orderDayItems(state.rounds, state.timeline).flatMap((item) => (item.round ? [item.round] : []));
}

/**
 * The round the tournament is operating right now.
 *
 * A released round wins over the operator's stored pointer: generating nine rounds ahead must not
 * make Round 9 the current one. Mirrors `currentOperationalRound` in the transfers module, which
 * cannot be imported here without a cycle.
 */
export function currentOperationsRound(state: DirectorState): Round | null {
  const rounds = operationalRoundOrder(state);
  const selected = rounds.find((round) => round.id === state.tournament?.currentRoundId);
  if (selected?.status === 'released') return selected;
  return (
    rounds.find((round) => round.status === 'released') ??
    rounds.find((round) => round.status !== 'closed') ??
    null
  );
}

/** The round a director would prepare next: the first non-closed round after the current one. */
export function nextOperationsRound(state: DirectorState): Round | null {
  const rounds = operationalRoundOrder(state);
  const current = currentOperationsRound(state);
  if (!current) return null;
  const index = rounds.findIndex((round) => round.id === current.id);
  if (index < 0) return null;
  return rounds.slice(index + 1).find((round) => round.status !== 'closed') ?? null;
}

/** Rounds that auto-fill and repair may safely rewrite: planned or prepared, never released. */
export function repairableRounds(state: DirectorState): Round[] {
  return operationalRoundOrder(state).filter(
    (round) => round.status === 'planned' || round.status === 'prepared',
  );
}

/**
 * Whether a round's operational assignments may be rewritten automatically.
 *
 * Released, live, and closed rounds are excluded outright. Automatic convenience must never be the
 * thing that splits scorer state or rewrites accepted history; those moves stay behind the explicit
 * recovery actions that already exist.
 */
export function roundIsAutoRepairable(state: DirectorState, roundId: DirectorId): boolean {
  const round = state.rounds.find((entry) => entry.id === roundId);
  return round?.status === 'planned' || round?.status === 'prepared';
}

/**
 * Whether one game's operational assignment may be rewritten automatically.
 *
 * A game that has been released, started, submitted, accepted, or that carries a scorer session
 * with unresolved work is off limits even inside an otherwise repairable round.
 */
export function gameIsAutoRepairable(state: DirectorState, game: ScheduledGame): boolean {
  if (!roundIsAutoRepairable(state, game.roundId)) return false;
  if (game.status !== 'scheduled') return false;
  if (state.games.some((record) => record.scheduledGameId === game.id && record.status !== 'scheduled')) {
    return false;
  }
  return !state.qbtcpSessions.some(
    (session) => session.matchId === game.id && qbtcpSessionHasUnresolvedWork(state, session),
  );
}

/* -------------------------------------------------------------------------- */
/* Effective assignments                                                       */
/* -------------------------------------------------------------------------- */

/** A room's default equipment, tolerating the pre-v9 single-resource field. */
export function roomDefaultEquipmentIds(room: Room): DirectorId[] {
  if (room.defaultEquipmentIds && room.defaultEquipmentIds.length > 0) {
    return [...new Set(room.defaultEquipmentIds)];
  }
  return room.equipmentId ? [room.equipmentId] : [];
}

function normalizePins(assignment: OperationalAssignment): EffectiveAssignment['pinned'] {
  return {
    room: assignment.pinned?.room === true,
    moderator: assignment.pinned?.moderator === true,
    scorekeeper: assignment.pinned?.scorekeeper === true,
    equipmentIds: [...new Set(assignment.pinned?.equipmentIds ?? [])],
    staffIds: [...new Set(assignment.pinned?.staffIds ?? [])],
  };
}

function fromRecord(assignment: OperationalAssignment): EffectiveAssignment {
  return {
    id: assignment.id,
    roundId: assignment.roundId,
    kind: assignment.kind,
    scheduledGameId: assignment.scheduledGameId ?? null,
    roomId: assignment.roomId ?? null,
    moderatorId: assignment.moderatorId ?? null,
    scorekeeperId: assignment.scorekeeperId ?? null,
    staffIds: [...(assignment.staffIds ?? [])],
    equipmentIds: [...(assignment.equipmentIds ?? [])],
    origin: 'explicit',
    pinned: normalizePins(assignment),
  };
}

/** The stored room-duty assignment for one scheduled game, when the director has made one. */
export function storedAssignmentForGame(
  state: DirectorState,
  scheduledGameId: DirectorId,
): OperationalAssignment | null {
  return (
    state.operationalAssignments.find(
      (entry) => entry.kind === 'room' && entry.scheduledGameId === scheduledGameId,
    ) ?? null
  );
}

/**
 * How a scheduled game is actually operated.
 *
 * Falls back to the game's own `roomId` and that room's defaults, which is what every document
 * written before assignment records looks like, and what a director who never opens Operations
 * keeps looking like.
 */
export function effectiveAssignmentForGame(
  state: DirectorState,
  game: ScheduledGame,
): EffectiveAssignment {
  const stored = storedAssignmentForGame(state, game.id);
  if (stored) {
    // The schedule row stays authoritative for *where* a released game is: recovery moves write
    // `ScheduledGame.roomId`, and the assignment record must not shadow that with a stale room.
    const roomId = game.roomId ?? stored.roomId ?? null;
    return { ...fromRecord(stored), roomId, scheduledGameId: game.id };
  }
  const room = game.roomId ? (state.rooms.find((entry) => entry.id === game.roomId) ?? null) : null;
  return {
    id: null,
    roundId: game.roundId,
    kind: 'room',
    scheduledGameId: game.id,
    roomId: game.roomId ?? null,
    moderatorId: room?.moderatorId ?? null,
    scorekeeperId: room?.scorekeeperId ?? null,
    staffIds: [],
    equipmentIds: room ? roomDefaultEquipmentIds(room) : [],
    origin: 'inherited',
    pinned: { room: false, moderator: false, scorekeeper: false, equipmentIds: [], staffIds: [] },
  };
}

/** Every effective room-duty assignment in a round, one per non-bye, non-cancelled game. */
export function roundAssignments(state: DirectorState, roundId: DirectorId): EffectiveAssignment[] {
  return state.scheduledGames
    .filter((game) => game.roundId === roundId && !game.bye && game.status !== 'cancelled')
    .map((game) => effectiveAssignmentForGame(state, game));
}

/** Non-room duties (runner, HQ) recorded for a round. */
export function roundDutyAssignments(state: DirectorState, roundId: DirectorId): OperationalAssignment[] {
  return state.operationalAssignments.filter(
    (entry) => entry.roundId === roundId && entry.kind !== 'room',
  );
}

/* -------------------------------------------------------------------------- */
/* Room derivation                                                             */
/* -------------------------------------------------------------------------- */

function unresolvedGameInRoom(state: DirectorState, roomId: DirectorId): ScheduledGame | null {
  return (
    state.scheduledGames.find(
      (game) => game.roomId === roomId && scheduledGameHasUnresolvedWork(state, game),
    ) ?? null
  );
}

function sessionForRoom(state: DirectorState, roomId: DirectorId): QbtcpRoomSession | null {
  const sessions = state.qbtcpSessions.filter((session) => session.roomId === roomId);
  if (sessions.length === 0) return null;
  // Prefer the session that still reserves the room; among equals the most recently seen one.
  const unresolved = sessions.filter((session) => qbtcpSessionHasUnresolvedWork(state, session));
  const pool = unresolved.length > 0 ? unresolved : sessions;
  return [...pool].sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))[0] ?? null;
}

function openHelpForRoom(state: DirectorState, roomId: DirectorId): QbtcpHelpRequest | null {
  const open = state.qbtcpHelpRequests.filter(
    (request) => request.roomId === roomId && request.status === 'open',
  );
  return [...open].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
}

/**
 * Which staff member a scorer session belongs to.
 *
 * An explicit `staffId` wins. Otherwise an operator name is matched, case-insensitively, and only
 * when it matches exactly one staff member: a name that matches two people is treated as unknown
 * rather than resolved arbitrarily, because the operations layer would then report the wrong
 * person as being in the wrong room.
 */
export function staffForSession(state: DirectorState, session: QbtcpRoomSession): StaffMember | null {
  if (session.staffId) {
    return state.staff.find((member) => member.id === session.staffId) ?? null;
  }
  const name = session.operatorName?.trim().toLocaleLowerCase();
  if (!name) return null;
  const matches = state.staff.filter((member) => member.name.trim().toLocaleLowerCase() === name);
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function matchupLabel(state: DirectorState, game: ScheduledGame | null): string | null {
  if (!game) return null;
  const name = (teamId: DirectorId | null | undefined) =>
    teamId ? (state.teams.find((team) => team.id === teamId)?.displayName ?? 'Unknown team') : null;
  const left = name(game.leftTeamId);
  if (game.bye) return left ? `${left} · Bye` : 'Bye';
  const right = name(game.rightTeamId);
  return left && right ? `${left} vs ${right}` : (left ?? right ?? null);
}

export function operationalMatchupLabel(state: DirectorState, game: ScheduledGame | null): string | null {
  return matchupLabel(state, game);
}

/**
 * Everything true about one room, optionally scoped to one round.
 *
 * With no round the view describes the room's live situation: the game that currently occupies it,
 * the scorer connected to it, and the next game scheduled into it. With a round it describes that
 * round's plan for the room, which is what lets a director prepare Round 5 while Round 4 runs.
 */
export function deriveOperationalRoom(
  state: DirectorState,
  roomId: DirectorId,
  roundId?: DirectorId,
): OperationalRoomView | null {
  const room = state.rooms.find((entry) => entry.id === roomId);
  if (!room) return null;

  const roundOrder = operationalRoundOrder(state);
  const scopedRound = roundId ? (state.rounds.find((entry) => entry.id === roundId) ?? null) : null;

  const gameInRound = (round: Round | null) =>
    round
      ? (state.scheduledGames.find(
          (entry) =>
            entry.roundId === round.id &&
            entry.roomId === roomId &&
            !entry.bye &&
            entry.status !== 'cancelled',
        ) ?? null)
      : null;
  // Unscoped, the room's game is whatever is unresolved in it, and otherwise whatever the current
  // round has planned there. A round that has not been released yet still has a matchup to show.
  const game = scopedRound
    ? gameInRound(scopedRound)
    : (unresolvedGameInRoom(state, roomId) ?? gameInRound(currentOperationsRound(state)));
  const round = game
    ? (state.rounds.find((entry) => entry.id === game.roundId) ?? scopedRound)
    : scopedRound;

  const assignment = game ? effectiveAssignmentForGame(state, game) : null;
  const moderator = assignment?.moderatorId
    ? (state.staff.find((member) => member.id === assignment.moderatorId) ?? null)
    : null;
  const scorekeeper = assignment?.scorekeeperId
    ? (state.staff.find((member) => member.id === assignment.scorekeeperId) ?? null)
    : null;
  const equipment = (assignment?.equipmentIds ?? [])
    .map((id) => state.equipment.find((item) => item.id === id))
    .filter((item): item is EquipmentResource => Boolean(item));

  const session = sessionForRoom(state, roomId);
  const helpRequest = openHelpForRoom(state, roomId);
  const qbtcpStaff = session ? staffForSession(state, session) : null;

  // The next game in this room after whatever occupies it now, in persisted day order.
  const referenceIndex = round ? roundOrder.findIndex((entry) => entry.id === round.id) : -1;
  const nextGame =
    state.scheduledGames
      .filter(
        (candidate) =>
          candidate.roomId === roomId &&
          !candidate.bye &&
          candidate.status !== 'cancelled' &&
          candidate.id !== game?.id,
      )
      .map((candidate) => ({
        game: candidate,
        index: roundOrder.findIndex((entry) => entry.id === candidate.roundId),
      }))
      .filter((entry) => entry.index > referenceIndex)
      .sort((left, right) => left.index - right.index)[0]?.game ?? null;
  const nextRound = nextGame
    ? (state.rounds.find((entry) => entry.id === nextGame.roundId) ?? null)
    : null;

  const hasUnresolvedWork = roomHasUnresolvedWork(state, roomId);
  const assignable = room.available && !hasUnresolvedWork;

  const blockers: OperationalIssue[] = [];
  const warnings: OperationalIssue[] = [];
  const roomTarget: OperationalTarget = { entityType: 'room', entityId: room.id };

  if (!room.available) {
    warnings.push({
      id: `room-unavailable-${room.id}`,
      severity: 'warning',
      message: `${room.name} is marked unavailable.`,
      action: 'Mark available',
      target: roomTarget,
    });
  }

  if (game) {
    if (!room.available) {
      blockers.push({
        id: `room-unavailable-assigned-${room.id}`,
        severity: 'blocker',
        message: `${room.name} is unavailable but hosts ${matchupLabel(state, game) ?? 'a game'}.`,
        action: 'Reassign room',
        target: { entityType: 'game', entityId: game.id, parentId: game.roundId },
      });
    }
    blockers.push(...staffSlotIssues(state, room, game, assignment, 'moderator'));
    blockers.push(...staffSlotIssues(state, room, game, assignment, 'scorekeeper'));
    for (const item of assignment?.equipmentIds ?? []) {
      const resource = state.equipment.find((entry) => entry.id === item);
      if (!resource) {
        blockers.push({
          id: `equipment-missing-${room.id}-${item}`,
          severity: 'blocker',
          message: `${room.name} references equipment that is no longer in the tournament workspace.`,
          action: 'Choose equipment',
          target: roomTarget,
        });
        continue;
      }
      if (!resource.available) {
        blockers.push({
          id: `equipment-unavailable-${room.id}-${resource.id}`,
          severity: 'blocker',
          message: `${resource.name} is unavailable but assigned to ${room.name}.`,
          action: 'Replace equipment',
          target: { entityType: 'equipment', entityId: resource.id },
        });
      }
    }
    warnings.push(...qbtcpIdentityIssues(state, room, assignment, session, qbtcpStaff));
  }

  if (helpRequest) {
    blockers.push({
      id: `room-help-${room.id}`,
      severity: 'blocker',
      message: `${room.name} has asked for help: ${helpRequest.message || helpRequest.category}.`,
      action: 'Open request',
      target: roomTarget,
    });
  }

  const readiness = deriveReadiness({
    room,
    game,
    session,
    helpRequest,
    hasUnresolvedWork,
    blocked: blockers.length > 0,
  });

  return {
    room,
    round,
    game,
    assignment,
    moderator,
    scorekeeper,
    equipment,
    qbtcpSession: session,
    qbtcpDevice: session?.deviceId ?? null,
    qbtcpStaff,
    helpRequest,
    readiness,
    blockers,
    warnings,
    nextGame,
    nextRound,
    assignable,
    hasUnresolvedWork,
  };
}

function staffSlotIssues(
  state: DirectorState,
  room: Room,
  game: ScheduledGame,
  assignment: EffectiveAssignment | null,
  role: 'moderator' | 'scorekeeper',
): OperationalIssue[] {
  const staffId = role === 'moderator' ? assignment?.moderatorId : assignment?.scorekeeperId;
  if (!staffId) return [];
  const member = state.staff.find((entry) => entry.id === staffId);
  if (!member) {
    return [
      {
        id: `staff-missing-${room.id}-${role}`,
        severity: 'blocker',
        message: `${room.name} references a ${role} who is no longer in the tournament workspace.`,
        action: `Assign ${role}`,
        target: { entityType: 'game', entityId: game.id, parentId: game.roundId },
      },
    ];
  }
  const issues: OperationalIssue[] = [];
  if (!member.available) {
    issues.push({
      id: `staff-unavailable-${member.id}-${room.id}`,
      severity: 'blocker',
      message: `${member.name} is unavailable for ${room.name}.`,
      action: `Replace ${member.name}`,
      target: { entityType: 'staff', entityId: member.id },
    });
  }
  if (!member.roles.includes(role)) {
    issues.push({
      id: `staff-role-${member.id}-${role}-${room.id}`,
      severity: 'blocker',
      message: `${member.name} is assigned as ${role} in ${room.name} but is not marked for that role.`,
      action: `Replace ${member.name}`,
      target: { entityType: 'staff', entityId: member.id },
    });
  }
  return issues;
}

/**
 * Mismatches between who Director expects in a room and who is actually connected.
 *
 * These are operational facts about an assignment, not network diagnostics, so they are attached
 * to the room and the staff member rather than reported as QBTCP health.
 */
function qbtcpIdentityIssues(
  state: DirectorState,
  room: Room,
  assignment: EffectiveAssignment | null,
  session: QbtcpRoomSession | null,
  sessionStaff: StaffMember | null,
): OperationalIssue[] {
  const issues: OperationalIssue[] = [];
  const expectedId = assignment?.scorekeeperId ?? null;
  const expected = expectedId ? (state.staff.find((entry) => entry.id === expectedId) ?? null) : null;

  if (expected && !session) {
    issues.push({
      id: `scorer-not-connected-${room.id}`,
      severity: 'warning',
      message: `${expected.name} is assigned to score ${room.name} but has not connected.`,
      action: 'Send pairing link',
      target: { entityType: 'room', entityId: room.id },
    });
    return issues;
  }
  if (!session) return issues;

  if (session.state === 'abandoned' && session.resumable === true) {
    issues.push({
      id: `scorer-stale-${room.id}`,
      severity: 'warning',
      message: `${room.name} has a disconnected scorer with resumable work.`,
      action: 'Open room',
      target: { entityType: 'room', entityId: room.id },
    });
  }
  if (expected && sessionStaff && sessionStaff.id !== expected.id) {
    issues.push({
      id: `scorer-mismatch-${room.id}`,
      severity: 'warning',
      message: `${sessionStaff.name} is connected to ${room.name}, but ${expected.name} is assigned to score it.`,
      action: 'Review assignment',
      target: { entityType: 'staff', entityId: sessionStaff.id },
    });
  }
  if (sessionStaff) {
    // The same person appearing in two rooms is the condition that silently produces two
    // scoresheets for one match, so it is reported from both ends.
    const elsewhere = state.qbtcpSessions.find(
      (other) =>
        other.sessionId !== session.sessionId &&
        other.roomId !== room.id &&
        qbtcpSessionHasUnresolvedWork(state, other) &&
        staffForSession(state, other)?.id === sessionStaff.id,
    );
    if (elsewhere) {
      const otherRoom = state.rooms.find((entry) => entry.id === elsewhere.roomId);
      issues.push({
        id: `scorer-two-rooms-${sessionStaff.id}`,
        severity: 'warning',
        message: `${sessionStaff.name} appears connected to both ${room.name} and ${otherRoom?.name ?? 'another room'}.`,
        action: 'Review connections',
        target: { entityType: 'staff', entityId: sessionStaff.id },
      });
    }
  }
  return issues;
}

function deriveReadiness(input: {
  room: Room;
  game: ScheduledGame | null;
  session: QbtcpRoomSession | null;
  helpRequest: QbtcpHelpRequest | null;
  hasUnresolvedWork: boolean;
  blocked: boolean;
}): OperationalReadiness {
  const { room, game, session, helpRequest, hasUnresolvedWork, blocked } = input;
  if (helpRequest) return 'help';
  if (blocked) return 'blocked';
  if (!room.available && !hasUnresolvedWork) return 'offline';
  if (game?.status === 'submitted' || session?.state === 'result-received') return 'awaiting-result';
  if (game?.status === 'live' || session?.state === 'live') return 'playing';
  if (session && (session.state === 'paired' || session.state === 'assigned')) return 'connected';
  // A room with a game but no scorer connection is assigned, not ready: "ready" means free.
  if (game) return 'assigned';
  if (!room.available) return 'offline';
  return 'ready';
}

/* -------------------------------------------------------------------------- */
/* Staff and equipment derivation                                              */
/* -------------------------------------------------------------------------- */

function dutyForAssignment(
  state: DirectorState,
  round: Round,
  assignment: EffectiveAssignment,
  role: StaffRole | null,
): StaffDutyView {
  const room = assignment.roomId
    ? (state.rooms.find((entry) => entry.id === assignment.roomId) ?? null)
    : null;
  const game = assignment.scheduledGameId
    ? (state.scheduledGames.find((entry) => entry.id === assignment.scheduledGameId) ?? null)
    : null;
  return {
    round,
    kind: assignment.kind,
    role,
    roomId: room?.id ?? assignment.roomId ?? null,
    roomName: room?.name ?? null,
    scheduledGameId: game?.id ?? null,
    matchup: matchupLabel(state, game),
    assignmentId: assignment.id,
  };
}

/**
 * Where one staff member is working, now and next.
 *
 * The inverse relationship the product never modeled: rooms knew their moderator, but a moderator
 * could not be asked where they are. Scoped to a round when one is given, otherwise across the
 * whole remaining day in persisted order.
 */
export function deriveOperationalStaff(
  state: DirectorState,
  staffId: DirectorId,
  roundId?: DirectorId,
): OperationalStaffView | null {
  const staff = state.staff.find((member) => member.id === staffId);
  if (!staff) return null;

  const roundOrder = operationalRoundOrder(state);
  const scoped = roundId ? roundOrder.filter((round) => round.id === roundId) : roundOrder;
  const duties: StaffDutyView[] = [];
  for (const round of scoped) {
    if (round.status === 'closed' && !roundId) continue;
    for (const assignment of roundAssignments(state, round.id)) {
      if (assignment.moderatorId === staffId) {
        duties.push(dutyForAssignment(state, round, assignment, 'moderator'));
      }
      if (assignment.scorekeeperId === staffId) {
        duties.push(dutyForAssignment(state, round, assignment, 'scorekeeper'));
      }
    }
    for (const duty of roundDutyAssignments(state, round.id)) {
      if (!(duty.staffIds ?? []).includes(staffId)) continue;
      duties.push(
        dutyForAssignment(state, round, fromRecord(duty), duty.kind === 'hq' ? 'hq' : 'runner'),
      );
    }
  }

  const currentRound = currentOperationsRound(state);
  const currentIndex = currentRound ? roundOrder.findIndex((entry) => entry.id === currentRound.id) : -1;
  const indexOf = (duty: StaffDutyView) => roundOrder.findIndex((entry) => entry.id === duty.round.id);
  const current = duties.find((duty) => indexOf(duty) === currentIndex) ?? null;
  const next =
    duties
      .filter((duty) => indexOf(duty) > currentIndex)
      .sort((left, right) => indexOf(left) - indexOf(right))[0] ?? null;

  const session =
    state.qbtcpSessions.find((entry) => staffForSession(state, entry)?.id === staffId) ?? null;

  const blockers: OperationalIssue[] = [];
  const warnings: OperationalIssue[] = [];
  const target: OperationalTarget = { entityType: 'staff', entityId: staff.id };

  if (!staff.available && duties.length > 0) {
    blockers.push({
      id: `staff-unavailable-with-duties-${staff.id}`,
      severity: 'blocker',
      message: `${staff.name} is unavailable but has ${duties.length} assignment(s).`,
      action: 'Find replacements',
      target,
    });
  }
  // Two duties in the same round is the simultaneity conflict; different rounds are a normal day.
  const byRound = new Map<DirectorId, StaffDutyView[]>();
  for (const duty of duties) {
    byRound.set(duty.round.id, [...(byRound.get(duty.round.id) ?? []), duty]);
  }
  for (const [, roundDuties] of byRound) {
    if (roundDuties.length < 2) continue;
    const first = roundDuties[0]!;
    blockers.push({
      id: `staff-conflict-${staff.id}-${first.round.id}`,
      severity: 'blocker',
      message: `${staff.name} has ${roundDuties.length} simultaneous duties in ${first.round.name}: ${roundDuties
        .map((duty) => duty.roomName ?? dutyKindLabel(duty.kind))
        .join(', ')}.`,
      action: 'Resolve conflict',
      target,
    });
  }
  for (const duty of duties) {
    if (duty.role && duty.role !== 'runner' && duty.role !== 'hq' && !staff.roles.includes(duty.role)) {
      blockers.push({
        id: `staff-role-missing-${staff.id}-${duty.round.id}-${duty.role}`,
        severity: 'blocker',
        message: `${staff.name} is assigned as ${duty.role} in ${duty.roomName ?? duty.round.name} but is not marked for that role.`,
        action: 'Fix roles',
        target,
      });
    }
  }
  if (session && session.roomId) {
    const connectedRoom = state.rooms.find((entry) => entry.id === session.roomId);
    const expectedRoomIds = new Set(duties.map((duty) => duty.roomId).filter(Boolean));
    if (expectedRoomIds.size > 0 && !expectedRoomIds.has(session.roomId)) {
      warnings.push({
        id: `staff-wrong-room-${staff.id}`,
        severity: 'warning',
        message: `${staff.name} is connected in ${connectedRoom?.name ?? 'another room'} but is assigned elsewhere.`,
        action: 'Open room',
        target: { entityType: 'room', entityId: session.roomId },
      });
    }
  }

  return {
    staff,
    roles: staff.roles,
    available: staff.available,
    current,
    next,
    duties,
    qbtcpSession: session,
    blockers,
    warnings,
  };
}

export function dutyKindLabel(kind: OperationalAssignmentKind): string {
  return kind === 'hq' ? 'HQ' : kind === 'runner' ? 'Runner' : 'Room';
}

/** Where one equipment resource is being used, now and next. */
export function deriveOperationalEquipment(
  state: DirectorState,
  equipmentId: DirectorId,
  roundId?: DirectorId,
): OperationalEquipmentView | null {
  const equipment = state.equipment.find((item) => item.id === equipmentId);
  if (!equipment) return null;

  const roundOrder = operationalRoundOrder(state);
  const scoped = roundId ? roundOrder.filter((round) => round.id === roundId) : roundOrder;
  const uses: EquipmentUseView[] = [];
  for (const round of scoped) {
    if (round.status === 'closed' && !roundId) continue;
    for (const assignment of roundAssignments(state, round.id)) {
      if (!assignment.equipmentIds.includes(equipmentId)) continue;
      const room = assignment.roomId
        ? (state.rooms.find((entry) => entry.id === assignment.roomId) ?? null)
        : null;
      uses.push({
        round,
        roomId: assignment.roomId,
        roomName: room?.name ?? null,
        scheduledGameId: assignment.scheduledGameId,
        assignmentId: assignment.id,
      });
    }
  }

  const currentRound = currentOperationsRound(state);
  const currentIndex = currentRound ? roundOrder.findIndex((entry) => entry.id === currentRound.id) : -1;
  const indexOf = (use: EquipmentUseView) => roundOrder.findIndex((entry) => entry.id === use.round.id);
  const current = uses.find((use) => indexOf(use) === currentIndex) ?? null;
  const next =
    uses.filter((use) => indexOf(use) > currentIndex).sort((left, right) => indexOf(left) - indexOf(right))[0] ??
    null;

  const blockers: OperationalIssue[] = [];
  const target: OperationalTarget = { entityType: 'equipment', entityId: equipment.id };
  if (!equipment.available && uses.length > 0) {
    blockers.push({
      id: `equipment-unavailable-with-uses-${equipment.id}`,
      severity: 'blocker',
      message: `${equipment.name} is unavailable but assigned to ${uses.length} room(s).`,
      action: 'Find replacements',
      target,
    });
  }
  const byRound = new Map<DirectorId, EquipmentUseView[]>();
  for (const use of uses) byRound.set(use.round.id, [...(byRound.get(use.round.id) ?? []), use]);
  for (const [, roundUses] of byRound) {
    if (roundUses.length < 2) continue;
    const first = roundUses[0]!;
    blockers.push({
      id: `equipment-conflict-${equipment.id}-${first.round.id}`,
      severity: 'blocker',
      message: `${equipment.name} is assigned to ${roundUses
        .map((use) => use.roomName ?? 'a room')
        .join(' and ')} in ${first.round.name}.`,
      action: 'Resolve conflict',
      target,
    });
  }

  return {
    equipment,
    available: equipment.available,
    current,
    next,
    uses,
    blockers,
    warnings: [],
  };
}

/* -------------------------------------------------------------------------- */
/* Round operations                                                            */
/* -------------------------------------------------------------------------- */

function dedupeIssues(issues: OperationalIssue[]): OperationalIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => (seen.has(issue.id) ? false : (seen.add(issue.id), true)));
}

/**
 * The whole operational picture for one round.
 *
 * Overview's readiness summary, the Operations page, preflight, and round-start validation all read
 * this. Adding a second readiness algorithm anywhere else is the failure mode this replaces.
 */
export function deriveRoundOperations(state: DirectorState, roundId?: DirectorId): RoundOperations {
  const round = roundId
    ? (state.rounds.find((entry) => entry.id === roundId) ?? null)
    : currentOperationsRound(state);

  const games = round
    ? state.scheduledGames.filter(
        (game) => game.roundId === round.id && !game.bye && game.status !== 'cancelled',
      )
    : [];
  const assignments = round ? roundAssignments(state, round.id) : [];
  const duties = round ? roundDutyAssignments(state, round.id) : [];

  const roomIds = new Set<DirectorId>();
  for (const assignment of assignments) if (assignment.roomId) roomIds.add(assignment.roomId);
  // Rooms with no game this round still belong in the view: they are the supply auto-fill draws on.
  for (const room of state.rooms) roomIds.add(room.id);

  const rooms = [...roomIds]
    .map((id) => deriveOperationalRoom(state, id, round?.id))
    .filter((view): view is OperationalRoomView => Boolean(view))
    .sort((left, right) => left.room.name.localeCompare(right.room.name));

  const staffIds = new Set<DirectorId>(state.staff.map((member) => member.id));
  const staff = [...staffIds]
    .map((id) => deriveOperationalStaff(state, id, round?.id))
    .filter((view): view is OperationalStaffView => Boolean(view))
    .sort((left, right) => left.staff.name.localeCompare(right.staff.name));

  const equipment = state.equipment
    .map((item) => deriveOperationalEquipment(state, item.id, round?.id))
    .filter((view): view is OperationalEquipmentView => Boolean(view));

  const dutyViews: OperationalDutyView[] = duties.map((assignment) => {
    const members = (assignment.staffIds ?? [])
      .map((id) => state.staff.find((member) => member.id === id))
      .filter((member): member is StaffMember => Boolean(member));
    const blockers: OperationalIssue[] = [];
    for (const member of members) {
      if (!member.available) {
        blockers.push({
          id: `duty-staff-unavailable-${assignment.id}-${member.id}`,
          severity: 'blocker',
          message: `${member.name} is unavailable but assigned to ${dutyKindLabel(assignment.kind)} duty.`,
          action: 'Find replacement',
          target: { entityType: 'staff', entityId: member.id },
        });
      }
    }
    return {
      assignment,
      kind: assignment.kind as Exclude<OperationalAssignmentKind, 'room'>,
      staff: members,
      blockers,
      warnings: [],
    };
  });

  const gamesWithRooms = assignments.filter((assignment) => Boolean(assignment.roomId)).length;
  const staffPositionsRequired = games.length * 2;
  const staffPositionsFilled = assignments.reduce(
    (total, assignment) =>
      total + (assignment.moderatorId ? 1 : 0) + (assignment.scorekeeperId ? 1 : 0),
    0,
  );
  const scorekeepersExpected = assignments.filter((assignment) => Boolean(assignment.scorekeeperId)).length;
  const scorekeepersConnected = assignments.filter((assignment) => {
    if (!assignment.scorekeeperId || !assignment.roomId) return false;
    const session = sessionForRoom(state, assignment.roomId);
    return Boolean(session && session.state !== 'abandoned');
  }).length;
  const unstaffedActiveRooms = assignments.filter(
    (assignment) => assignment.roomId && (!assignment.moderatorId || !assignment.scorekeeperId),
  ).length;

  const roomBlockers = rooms.flatMap((view) => (view.game ? view.blockers : []));
  const roomWarnings = rooms.flatMap((view) => (view.game ? view.warnings : []));
  const staffBlockers = staff.flatMap((view) => view.blockers);
  const staffWarnings = staff.flatMap((view) => view.warnings);
  const equipmentBlockers = equipment.flatMap((view) => view.blockers);
  const dutyBlockers = dutyViews.flatMap((view) => view.blockers);

  const missingRoomGames = games.filter(
    (game) => !assignments.find((assignment) => assignment.scheduledGameId === game.id)?.roomId,
  );
  const structuralBlockers: OperationalIssue[] = [];
  if (state.rooms.length > 0) {
    for (const game of missingRoomGames) {
      structuralBlockers.push({
        id: `game-without-room-${game.id}`,
        severity: 'blocker',
        message: `${matchupLabel(state, game) ?? 'A game'} in ${round?.name ?? 'this round'} has no room.`,
        action: 'Assign room',
        target: { entityType: 'game', entityId: game.id, parentId: game.roundId },
      });
    }
    for (const assignment of assignments) {
      if (!assignment.roomId) continue;
      const room = state.rooms.find((entry) => entry.id === assignment.roomId);
      const game = assignment.scheduledGameId
        ? state.scheduledGames.find((entry) => entry.id === assignment.scheduledGameId)
        : undefined;
      if (!game) continue;
      if (!assignment.scorekeeperId && state.staff.length > 0) {
        structuralBlockers.push({
          id: `room-without-scorekeeper-${assignment.roomId}-${assignment.roundId}`,
          severity: 'blocker',
          message: `${room?.name ?? 'A room'} needs a scorekeeper for ${round?.name ?? 'this round'}.`,
          action: 'Assign scorekeeper',
          target: { entityType: 'game', entityId: game.id, parentId: game.roundId },
        });
      }
      if (!assignment.moderatorId && state.staff.length > 0) {
        structuralBlockers.push({
          id: `room-without-moderator-${assignment.roomId}-${assignment.roundId}`,
          severity: 'blocker',
          message: `${room?.name ?? 'A room'} needs a moderator for ${round?.name ?? 'this round'}.`,
          action: 'Assign moderator',
          target: { entityType: 'game', entityId: game.id, parentId: game.roundId },
        });
      }
    }
    // Two games in one room in the same round is the invariant that must never survive a save.
    const roomUse = new Map<DirectorId, EffectiveAssignment[]>();
    for (const assignment of assignments) {
      if (!assignment.roomId) continue;
      roomUse.set(assignment.roomId, [...(roomUse.get(assignment.roomId) ?? []), assignment]);
    }
    for (const [usedRoomId, entries] of roomUse) {
      if (entries.length < 2) continue;
      const room = state.rooms.find((entry) => entry.id === usedRoomId);
      structuralBlockers.push({
        id: `room-double-booked-${usedRoomId}-${round?.id ?? 'round'}`,
        severity: 'blocker',
        message: `${room?.name ?? 'A room'} hosts ${entries.length} games in ${round?.name ?? 'this round'}.`,
        action: 'Reassign rooms',
        target: { entityType: 'room', entityId: usedRoomId },
      });
    }
  }

  const blockers = dedupeIssues([
    ...structuralBlockers,
    ...roomBlockers,
    ...staffBlockers,
    ...equipmentBlockers,
    ...dutyBlockers,
  ]);
  const warnings = dedupeIssues([...roomWarnings, ...staffWarnings]);

  return {
    round,
    rooms,
    staff,
    equipment,
    duties: dutyViews,
    summary: {
      games: games.length,
      gamesWithRooms,
      staffPositionsRequired,
      staffPositionsFilled,
      scorekeepersExpected,
      scorekeepersConnected,
      moderators: new Set(assignments.map((entry) => entry.moderatorId).filter(Boolean)).size,
      scorekeepers: new Set(assignments.map((entry) => entry.scorekeeperId).filter(Boolean)).size,
      runners: duties.filter((entry) => entry.kind === 'runner').flatMap((entry) => entry.staffIds ?? [])
        .length,
      hq: duties.filter((entry) => entry.kind === 'hq').flatMap((entry) => entry.staffIds ?? []).length,
      unstaffedActiveRooms,
      issues: blockers.length + warnings.length,
    },
    blockers,
    warnings,
  };
}
