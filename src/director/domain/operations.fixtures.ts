import {
  defaultRules,
  emptyDirectorState,
  type DirectorState,
  type OperationalAssignment,
  type QbtcpRoomSession,
  type Room,
  type Round,
  type ScheduledGame,
  type StaffMember,
} from './model';

export function operationsFixture(): DirectorState {
  const state = emptyDirectorState();
  state.tournament = {
    id: 'tournament-1',
    name: 'Operations test',
    date: '2026-09-09',
    venue: 'Test hall',
    organizer: 'QBSheet',
    status: 'running',
    timeZone: 'UTC',
    rules: structuredClone(defaultRules),
    formatId: null,
    currentPhaseId: 'phase-1',
    currentPacketId: null,
    currentRoundId: 'round-1',
    createdAt: '2026-09-09T09:00:00.000Z',
    updatedAt: '2026-09-09T09:00:00.000Z',
  };
  state.teams = ['Aiken', 'Lakeside', 'Jefferson', 'Hoover'].map((displayName, index) => ({
    id: `team-${index + 1}`,
    organizationId: null,
    displayName,
    teamLetter: '',
    seed: index + 1,
    status: 'confirmed',
    createdAt: '2026-09-09T09:00:00.000Z',
    updatedAt: '2026-09-09T09:00:00.000Z',
  }));
  state.rooms = [room('room-201', '201'), room('room-202', '202'), room('room-203', '203')];
  state.staff = [
    staff('staff-alice', 'Alice Johnson', ['moderator']),
    staff('staff-bob', 'Bob Smith', ['scorekeeper']),
    staff('staff-cara', 'Cara Diaz', ['moderator', 'scorekeeper']),
    staff('staff-dan', 'Dan Lee', ['scorekeeper']),
  ];
  state.equipment = [
    { id: 'equipment-1', name: 'Buzzer 1', kind: 'buzzer', available: true },
    { id: 'equipment-2', name: 'Buzzer 2', kind: 'buzzer', available: true },
    { id: 'equipment-3', name: 'Buzzer 3', kind: 'buzzer', available: true },
  ];
  state.rounds = [round('round-1', 1, 'released'), round('round-2', 2, 'planned')];
  state.scheduledGames = [
    game('game-1a', 'round-1', 'team-1', 'team-2', 'room-201'),
    game('game-1b', 'round-1', 'team-3', 'team-4', 'room-202'),
    game('game-2a', 'round-2', 'team-1', 'team-3', null),
    game('game-2b', 'round-2', 'team-2', 'team-4', null),
  ];
  state.operationalAssignments = [
    assignment('assignment-1a', 'round-1', 'game-1a', 'room-201', 'staff-alice', 'staff-bob', [
      'equipment-1',
    ]),
    assignment('assignment-1b', 'round-1', 'game-1b', 'room-202', 'staff-cara', 'staff-dan', ['equipment-2']),
  ];
  return state;
}

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

function round(id: string, number: number, status: Round['status']): Round {
  return {
    id,
    phaseId: 'phase-1',
    name: `Round ${number}`,
    number,
    revision: 1,
    status,
    packetId: null,
    scheduledGameIds: [],
    dayOrder: number,
    scheduledStart: null,
    releasedAt: status === 'released' ? '2026-09-09T10:00:00.000Z' : null,
    startedAt: null,
    closedAt: status === 'closed' ? '2026-09-09T11:00:00.000Z' : null,
  };
}

function game(
  id: string,
  roundId: string,
  leftTeamId: string,
  rightTeamId: string | null,
  roomId: string | null,
  overrides: Partial<ScheduledGame> = {},
): ScheduledGame {
  return {
    id,
    roundId,
    roomId,
    packetId: null,
    leftTeamId,
    rightTeamId,
    bye: false,
    status: 'scheduled',
    assignmentRevision: 1,
    ...overrides,
  };
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

export function session(overrides: Partial<QbtcpRoomSession> & { roomId: string }): QbtcpRoomSession {
  return {
    sessionId: `session-${overrides.roomId}`,
    deviceId: 'device-1',
    state: 'paired',
    lastSeenAt: '2026-09-09T10:05:00.000Z',
    progress: null,
    helpRequestId: null,
    ...overrides,
  };
}
