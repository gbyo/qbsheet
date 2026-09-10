import { describe, expect, test } from 'vitest';
import { type OperationalAssignment, type Room, type StaffMember } from './model';
import { operationsFixture, session } from './operations.fixtures';
import {
  currentOperationsRound,
  deriveOperationalEquipment,
  deriveOperationalRoom,
  deriveOperationalStaff,
  deriveRoundOperations,
  effectiveAssignmentForGame,
  gameIsAutoRepairable,
  nextOperationsRound,
  roomDefaultEquipmentIds,
  roundIsAutoRepairable,
  staffForSession,
} from './operations';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function room(id: string, name: string, overrides: Partial<Room> = {}): Room {
  return {
    id,
    name: `Room ${name}`,
    status: 'available',
    moderatorId: null,
    scorekeeperId: null,
    equipmentId: null,
    defaultEquipmentIds: [],
    available: true,
    ...overrides,
  };
}

function staff(id: string, name: string, roles: StaffMember['roles']): StaffMember {
  return { id, name, roles, available: true };
}

function assignment(
  id: string,
  roundId: string,
  scheduledGameId: string | null,
  roomId: string | null,
  moderatorId: string | null,
  scorekeeperId: string | null,
  equipmentIds: string[],
  overrides: Partial<OperationalAssignment> = {},
): OperationalAssignment {
  return {
    id,
    roundId,
    kind: 'room',
    scheduledGameId,
    roomId,
    moderatorId,
    scorekeeperId,
    equipmentIds,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Effective assignments                                                       */
/* -------------------------------------------------------------------------- */

describe('effective assignments', () => {
  test('an explicit record wins over room defaults', () => {
    const state = operationsFixture();
    state.rooms[0]!.moderatorId = 'staff-cara';
    const effective = effectiveAssignmentForGame(state, state.scheduledGames[0]!);
    expect(effective.origin).toBe('explicit');
    expect(effective.moderatorId).toBe('staff-alice');
  });

  test('a document with no assignment records falls back to the room defaults', () => {
    const state = operationsFixture();
    state.operationalAssignments = [];
    state.rooms[0]!.moderatorId = 'staff-alice';
    state.rooms[0]!.scorekeeperId = 'staff-bob';
    state.rooms[0]!.defaultEquipmentIds = ['equipment-1'];
    const effective = effectiveAssignmentForGame(state, state.scheduledGames[0]!);
    expect(effective).toMatchObject({
      origin: 'inherited',
      roomId: 'room-201',
      moderatorId: 'staff-alice',
      scorekeeperId: 'staff-bob',
      equipmentIds: ['equipment-1'],
    });
  });

  test('the schedule row stays authoritative for a released game that recovery moved', () => {
    const state = operationsFixture();
    state.scheduledGames[0]!.roomId = 'room-203';
    const effective = effectiveAssignmentForGame(state, state.scheduledGames[0]!);
    expect(effective.roomId).toBe('room-203');
  });

  test('legacy single-resource equipment reads as a one-item default list', () => {
    const legacy = room('room-legacy', 'Legacy', { equipmentId: 'equipment-9', defaultEquipmentIds: [] });
    expect(roomDefaultEquipmentIds(legacy)).toEqual(['equipment-9']);
  });
});

/* -------------------------------------------------------------------------- */
/* Room derivation                                                             */
/* -------------------------------------------------------------------------- */

describe('deriveOperationalRoom', () => {
  test('reports the current game, staff, equipment, and next game together', () => {
    const state = operationsFixture();
    state.operationalAssignments.push(
      assignment('assignment-2a', 'round-2', 'game-2a', 'room-201', 'staff-alice', 'staff-bob', []),
    );
    state.scheduledGames[2]!.roomId = 'room-201';
    const view = deriveOperationalRoom(state, 'room-201');
    expect(view?.game?.id).toBe('game-1a');
    expect(view?.moderator?.name).toBe('Alice Johnson');
    expect(view?.scorekeeper?.name).toBe('Bob Smith');
    expect(view?.equipment.map((item) => item.name)).toEqual(['Buzzer 1']);
    expect(view?.nextGame?.id).toBe('game-2a');
    expect(view?.nextRound?.name).toBe('Round 2');
  });

  test('scoping to a round shows that round only, so the next round can be prepared while one runs', () => {
    const state = operationsFixture();
    state.scheduledGames[2]!.roomId = 'room-201';
    state.operationalAssignments.push(
      assignment('assignment-2a', 'round-2', 'game-2a', 'room-201', 'staff-cara', 'staff-dan', []),
    );
    const next = deriveOperationalRoom(state, 'room-201', 'round-2');
    expect(next?.game?.id).toBe('game-2a');
    expect(next?.moderator?.name).toBe('Cara Diaz');
  });

  test('a live game reads as playing, and a submitted one as awaiting a result', () => {
    const state = operationsFixture();
    state.scheduledGames[0]!.status = 'live';
    expect(deriveOperationalRoom(state, 'room-201')?.readiness).toBe('playing');
    state.scheduledGames[0]!.status = 'submitted';
    expect(deriveOperationalRoom(state, 'room-201')?.readiness).toBe('awaiting-result');
  });

  test('an open help request outranks every other readiness state', () => {
    const state = operationsFixture();
    state.scheduledGames[0]!.status = 'live';
    state.qbtcpHelpRequests = [
      {
        id: 'help-1',
        roomId: 'room-201',
        roomName: 'Room 201',
        category: 'rules',
        message: 'Protest',
        status: 'open',
        createdAt: '2026-09-09T10:10:00.000Z',
        updatedAt: '2026-09-09T10:10:00.000Z',
        deviceId: 'device-1',
      },
    ];
    const view = deriveOperationalRoom(state, 'room-201');
    expect(view?.readiness).toBe('help');
    expect(view?.blockers.some((issue) => issue.id === 'room-help-room-201')).toBe(true);
  });

  test('an empty available room with no game is ready and assignable', () => {
    const state = operationsFixture();
    const view = deriveOperationalRoom(state, 'room-203');
    expect(view?.readiness).toBe('ready');
    expect(view?.assignable).toBe(true);
  });

  test('a resumable abandoned session still reserves its room', () => {
    const state = operationsFixture();
    state.qbtcpSessions = [
      session({ roomId: 'room-203', state: 'abandoned', resumable: true, sessionId: 'session-x' }),
    ];
    const view = deriveOperationalRoom(state, 'room-203');
    expect(view?.hasUnresolvedWork).toBe(true);
    expect(view?.assignable).toBe(false);
  });

  test('an unavailable staff member assigned to a room is a blocker that points at the person', () => {
    const state = operationsFixture();
    state.staff[1]!.available = false;
    const view = deriveOperationalRoom(state, 'room-201');
    const blocker = view?.blockers.find((issue) => issue.id === 'staff-unavailable-staff-bob-room-201');
    expect(blocker?.message).toBe('Bob Smith is unavailable for Room 201.');
    expect(blocker?.target).toEqual({ entityType: 'staff', entityId: 'staff-bob' });
    expect(blocker?.action).toBe('Replace Bob Smith');
  });

  test('a staff member assigned in a role they do not hold is a blocker', () => {
    const state = operationsFixture();
    state.operationalAssignments[0]!.moderatorId = 'staff-bob';
    const view = deriveOperationalRoom(state, 'room-201');
    expect(view?.blockers.some((issue) => issue.id.startsWith('staff-role-staff-bob-moderator'))).toBe(true);
  });

  test('unavailable equipment assigned to a room is a blocker that points at the resource', () => {
    const state = operationsFixture();
    state.equipment[0]!.available = false;
    const view = deriveOperationalRoom(state, 'room-201');
    expect(view?.blockers.some((issue) => issue.id === 'equipment-unavailable-room-201-equipment-1')).toBe(
      true,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* QBTCP identity                                                              */
/* -------------------------------------------------------------------------- */

describe('QBTCP staff identity', () => {
  test('an explicit staffId identifies the operator', () => {
    const state = operationsFixture();
    const entry = session({ roomId: 'room-201', staffId: 'staff-bob' });
    expect(staffForSession(state, entry)?.name).toBe('Bob Smith');
  });

  test('an unambiguous operator name maps onto the roster', () => {
    const state = operationsFixture();
    expect(staffForSession(state, session({ roomId: 'room-201', operatorName: 'bob smith' }))?.id).toBe(
      'staff-bob',
    );
  });

  test('an ambiguous operator name stays unmapped rather than guessed', () => {
    const state = operationsFixture();
    state.staff.push(staff('staff-bob-2', 'Bob Smith', ['scorekeeper']));
    expect(staffForSession(state, session({ roomId: 'room-201', operatorName: 'Bob Smith' }))).toBeNull();
  });

  test('an assigned scorekeeper who has not connected is a warning, not a blocker', () => {
    const state = operationsFixture();
    const view = deriveOperationalRoom(state, 'room-201');
    expect(view?.warnings.map((issue) => issue.id)).toContain('scorer-not-connected-room-201');
    expect(view?.blockers).toHaveLength(0);
  });

  test('a different known staff member connected to the room is surfaced', () => {
    const state = operationsFixture();
    state.qbtcpSessions = [session({ roomId: 'room-201', staffId: 'staff-dan' })];
    const view = deriveOperationalRoom(state, 'room-201');
    const warning = view?.warnings.find((issue) => issue.id === 'scorer-mismatch-room-201');
    expect(warning?.message).toBe('Dan Lee is connected to Room 201, but Bob Smith is assigned to score it.');
    expect(view?.readiness).toBe('connected');
  });

  test('one operator connected to two rooms is surfaced from the room view', () => {
    const state = operationsFixture();
    state.qbtcpSessions = [
      session({ roomId: 'room-201', staffId: 'staff-bob', sessionId: 'session-1' }),
      session({ roomId: 'room-202', staffId: 'staff-bob', sessionId: 'session-2' }),
    ];
    const view = deriveOperationalRoom(state, 'room-201');
    expect(view?.warnings.some((issue) => issue.id === 'scorer-two-rooms-staff-bob')).toBe(true);
  });

  test('a known operator connected in the wrong room is surfaced from the staff view', () => {
    const state = operationsFixture();
    state.qbtcpSessions = [session({ roomId: 'room-203', staffId: 'staff-bob' })];
    const view = deriveOperationalStaff(state, 'staff-bob');
    expect(view?.warnings.some((issue) => issue.id === 'staff-wrong-room-staff-bob')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Staff and equipment inverse relationships                                   */
/* -------------------------------------------------------------------------- */

describe('deriveOperationalStaff', () => {
  test('answers where a person is now and next', () => {
    const state = operationsFixture();
    state.operationalAssignments.push(
      assignment('assignment-2a', 'round-2', 'game-2a', 'room-203', 'staff-alice', 'staff-dan', []),
    );
    state.scheduledGames[2]!.roomId = 'room-203';
    const view = deriveOperationalStaff(state, 'staff-alice');
    expect(view?.current).toMatchObject({ roomName: 'Room 201', role: 'moderator' });
    expect(view?.next).toMatchObject({ roomName: 'Room 203', role: 'moderator' });
  });

  test('the same moderator in two rooms in one round is a conflict', () => {
    const state = operationsFixture();
    state.operationalAssignments[1]!.moderatorId = 'staff-alice';
    const view = deriveOperationalStaff(state, 'staff-alice');
    expect(view?.blockers.some((issue) => issue.id === 'staff-conflict-staff-alice-round-1')).toBe(true);
  });

  test('the same scorekeeper in two rooms in one round is a conflict', () => {
    const state = operationsFixture();
    state.operationalAssignments[1]!.scorekeeperId = 'staff-bob';
    const view = deriveOperationalStaff(state, 'staff-bob');
    expect(view?.blockers.some((issue) => issue.id === 'staff-conflict-staff-bob-round-1')).toBe(true);
  });

  test('the same person in two different rounds is a normal day, not a conflict', () => {
    const state = operationsFixture();
    state.operationalAssignments.push(
      assignment('assignment-2a', 'round-2', 'game-2a', 'room-203', 'staff-alice', 'staff-dan', []),
    );
    state.scheduledGames[2]!.roomId = 'room-203';
    expect(deriveOperationalStaff(state, 'staff-alice')?.blockers).toHaveLength(0);
  });

  test('removing a role that future assignments depend on is a blocker', () => {
    const state = operationsFixture();
    state.staff[0]!.roles = ['runner'];
    const view = deriveOperationalStaff(state, 'staff-alice');
    expect(view?.blockers.some((issue) => issue.id.startsWith('staff-role-missing-staff-alice'))).toBe(true);
  });

  test('marking a person with duties unavailable is a blocker naming the count', () => {
    const state = operationsFixture();
    state.staff[1]!.available = false;
    const view = deriveOperationalStaff(state, 'staff-bob');
    expect(view?.blockers[0]?.message).toBe('Bob Smith is unavailable but has 1 assignment(s).');
  });

  test('a runner duty is represented without a room slot', () => {
    const state = operationsFixture();
    state.operationalAssignments.push({
      id: 'assignment-runner',
      roundId: 'round-1',
      kind: 'runner',
      staffIds: ['staff-cara'],
      equipmentIds: [],
    });
    const view = deriveOperationalStaff(state, 'staff-cara');
    expect(view?.duties.some((duty) => duty.kind === 'runner' && duty.roomId === null)).toBe(true);
  });
});

describe('deriveOperationalEquipment', () => {
  test('answers where a resource is now and next', () => {
    const state = operationsFixture();
    state.operationalAssignments.push(
      assignment('assignment-2a', 'round-2', 'game-2a', 'room-203', null, null, ['equipment-1']),
    );
    state.scheduledGames[2]!.roomId = 'room-203';
    const view = deriveOperationalEquipment(state, 'equipment-1');
    expect(view?.current?.roomName).toBe('Room 201');
    expect(view?.next?.roomName).toBe('Room 203');
  });

  test('one exclusive resource in two rooms in one round is a conflict', () => {
    const state = operationsFixture();
    state.operationalAssignments[1]!.equipmentIds = ['equipment-1'];
    const view = deriveOperationalEquipment(state, 'equipment-1');
    expect(view?.blockers.some((issue) => issue.id === 'equipment-conflict-equipment-1-round-1')).toBe(true);
  });

  test('multiple resources in one room are all reported', () => {
    const state = operationsFixture();
    state.operationalAssignments[0]!.equipmentIds = ['equipment-1', 'equipment-3'];
    expect(deriveOperationalRoom(state, 'room-201')?.equipment.map((item) => item.id)).toEqual([
      'equipment-1',
      'equipment-3',
    ]);
    expect(deriveOperationalEquipment(state, 'equipment-3')?.current?.roomName).toBe('Room 201');
  });
});

/* -------------------------------------------------------------------------- */
/* Round operations                                                            */
/* -------------------------------------------------------------------------- */

describe('deriveRoundOperations', () => {
  test('summarizes a fully staffed round with no issues', () => {
    const state = operationsFixture();
    const operations = deriveRoundOperations(state, 'round-1');
    expect(operations.summary).toMatchObject({
      games: 2,
      gamesWithRooms: 2,
      staffPositionsRequired: 4,
      staffPositionsFilled: 4,
      unstaffedActiveRooms: 0,
    });
    expect(operations.blockers).toHaveLength(0);
  });

  test('reports the exact missing position rather than a room count', () => {
    const state = operationsFixture();
    state.operationalAssignments[0]!.scorekeeperId = null;
    const operations = deriveRoundOperations(state, 'round-1');
    const blocker = operations.blockers.find((issue) => issue.id.startsWith('room-without-scorekeeper'));
    expect(blocker?.message).toBe('Room 201 needs a scorekeeper for Round 1.');
    expect(blocker?.action).toBe('Assign scorekeeper');
    expect(blocker?.target).toEqual({ entityType: 'game', entityId: 'game-1a', parentId: 'round-1' });
  });

  test('a game with no room is reported against the game', () => {
    const state = operationsFixture();
    const operations = deriveRoundOperations(state, 'round-2');
    expect(operations.blockers.some((issue) => issue.id === 'game-without-room-game-2a')).toBe(true);
  });

  test('two games in one room in the same round is a blocker', () => {
    const state = operationsFixture();
    state.scheduledGames[1]!.roomId = 'room-201';
    state.operationalAssignments[1]!.roomId = 'room-201';
    const operations = deriveRoundOperations(state, 'round-1');
    expect(operations.blockers.some((issue) => issue.id.startsWith('room-double-booked-room-201'))).toBe(
      true,
    );
  });

  test('counts connected scorekeepers separately from assigned ones', () => {
    const state = operationsFixture();
    state.qbtcpSessions = [session({ roomId: 'room-201', staffId: 'staff-bob' })];
    const operations = deriveRoundOperations(state, 'round-1');
    expect(operations.summary.scorekeepersExpected).toBe(2);
    expect(operations.summary.scorekeepersConnected).toBe(1);
  });

  test('counts runner and HQ duties in the staffing summary', () => {
    const state = operationsFixture();
    state.operationalAssignments.push(
      { id: 'duty-runner', roundId: 'round-1', kind: 'runner', staffIds: ['staff-cara'], equipmentIds: [] },
      { id: 'duty-hq', roundId: 'round-1', kind: 'hq', staffIds: ['staff-dan'], equipmentIds: [] },
    );
    const operations = deriveRoundOperations(state, 'round-1');
    expect(operations.summary.runners).toBe(1);
    expect(operations.summary.hq).toBe(1);
    expect(operations.duties).toHaveLength(2);
  });

  test('a tournament with no rooms produces no room blockers at all', () => {
    const state = operationsFixture();
    state.rooms = [];
    state.operationalAssignments = [];
    for (const entry of state.scheduledGames) entry.roomId = null;
    const operations = deriveRoundOperations(state, 'round-1');
    expect(operations.blockers).toHaveLength(0);
    expect(operations.summary.games).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* Round scope and repair safety                                               */
/* -------------------------------------------------------------------------- */

describe('round scope', () => {
  test('the released round is current and the next planned round is next', () => {
    const state = operationsFixture();
    expect(currentOperationsRound(state)?.id).toBe('round-1');
    expect(nextOperationsRound(state)?.id).toBe('round-2');
  });

  test('only planned and prepared rounds are auto-repairable', () => {
    const state = operationsFixture();
    expect(roundIsAutoRepairable(state, 'round-1')).toBe(false);
    expect(roundIsAutoRepairable(state, 'round-2')).toBe(true);
  });

  test('a game with a scorer session carrying unresolved work is never auto-repairable', () => {
    const state = operationsFixture();
    state.rounds[1]!.status = 'planned';
    state.qbtcpSessions = [session({ roomId: 'room-203', matchId: 'game-2a', state: 'live' })];
    expect(gameIsAutoRepairable(state, state.scheduledGames[2]!)).toBe(false);
  });

  test('a game with a result record is never auto-repairable', () => {
    const state = operationsFixture();
    state.games = [
      {
        id: 'record-1',
        scheduledGameId: 'game-2a',
        roundId: 'round-2',
        packetId: null,
        status: 'submitted',
        scores: [],
        playerStats: [],
        source: 'manual',
      },
    ];
    expect(gameIsAutoRepairable(state, state.scheduledGames[2]!)).toBe(false);
  });
});
