import { describe, expect, test } from 'vitest';
import { type DirectorState } from './model';
import { operationsFixture, session } from './operations.fixtures';
import {
  planRoundOperations,
  planToAssignments,
  repairScope,
  resourceUnavailabilityImpact,
} from './operationsPlanner';

/** The fixture with Round 2 as the round under test: two games, no rooms or staff yet. */
function plannableState(): DirectorState {
  const state = operationsFixture();
  state.rounds[0]!.status = 'closed';
  state.rounds[0]!.closedAt = '2026-09-09T11:00:00.000Z';
  for (const game of state.scheduledGames) {
    if (game.roundId === 'round-1') game.status = 'accepted';
  }
  return state;
}

describe('planRoundOperations', () => {
  test('fills every room, staff position, and equipment slot for a planned round', () => {
    const plan = planRoundOperations(plannableState(), 'round-2');
    expect(plan.planned).toBe(true);
    expect(plan.unresolved).toHaveLength(0);
    expect(plan.assignments).toHaveLength(2);
    for (const entry of plan.assignments) {
      expect(entry.roomId).toBeTruthy();
      expect(entry.moderatorId).toBeTruthy();
      expect(entry.scorekeeperId).toBeTruthy();
    }
  });

  test('is deterministic: the same state produces byte-identical proposals', () => {
    const state = plannableState();
    expect(planRoundOperations(state, 'round-2')).toEqual(planRoundOperations(state, 'round-2'));
  });

  test('never assigns one room to two games', () => {
    const plan = planRoundOperations(plannableState(), 'round-2');
    const rooms = plan.assignments.map((entry) => entry.roomId);
    expect(new Set(rooms).size).toBe(rooms.length);
  });

  test('never assigns one staff member to two simultaneous duties', () => {
    const plan = planRoundOperations(plannableState(), 'round-2');
    const staff = plan.assignments.flatMap((entry) => [entry.moderatorId, entry.scorekeeperId]);
    expect(new Set(staff).size).toBe(staff.length);
  });

  test('never assigns one exclusive equipment resource to two rooms', () => {
    const state = plannableState();
    const plan = planRoundOperations(state, 'round-2', { equipmentPerRoom: 1 });
    const equipment = plan.assignments.flatMap((entry) => entry.equipmentIds);
    expect(equipment).toHaveLength(2);
    expect(new Set(equipment).size).toBe(2);
  });

  test('supports multiple equipment resources per room', () => {
    const plan = planRoundOperations(plannableState(), 'round-2', { equipmentPerRoom: 2 });
    expect(plan.assignments[0]!.equipmentIds).toHaveLength(2);
    // Three resources cannot cover two rooms needing two each; the shortfall is explicit.
    expect(plan.unresolved.some((entry) => entry.slot === 'equipment')).toBe(true);
  });

  test('honours roles: a scorekeeper-only member is never proposed as moderator', () => {
    const plan = planRoundOperations(plannableState(), 'round-2');
    expect(plan.assignments.map((entry) => entry.moderatorId)).not.toContain('staff-bob');
    expect(plan.assignments.map((entry) => entry.moderatorId)).not.toContain('staff-dan');
  });

  test('never proposes an unavailable staff member, room, or resource', () => {
    const state = plannableState();
    state.staff[0]!.available = false;
    state.rooms[0]!.available = false;
    state.equipment[0]!.available = false;
    const plan = planRoundOperations(state, 'round-2', { equipmentPerRoom: 1 });
    const chosen = plan.assignments.flatMap((entry) => [
      entry.roomId,
      entry.moderatorId,
      entry.scorekeeperId,
      ...entry.equipmentIds,
    ]);
    expect(chosen).not.toContain('staff-alice');
    expect(chosen).not.toContain('room-201');
    expect(chosen).not.toContain('equipment-1');
  });

  test('excludes a room holding unresolved QBTCP work', () => {
    const state = plannableState();
    state.qbtcpSessions = [session({ roomId: 'room-201', state: 'live', matchId: 'game-1a' })];
    const plan = planRoundOperations(state, 'round-2');
    expect(plan.assignments.map((entry) => entry.roomId)).not.toContain('room-201');
  });

  test('a resumable abandoned session still reserves its room against auto-fill', () => {
    const state = plannableState();
    state.qbtcpSessions = [session({ roomId: 'room-202', state: 'abandoned', resumable: true })];
    const plan = planRoundOperations(state, 'round-2');
    expect(plan.assignments.map((entry) => entry.roomId)).not.toContain('room-202');
  });

  test('a result-received session cannot be displaced by auto-repair', () => {
    const state = plannableState();
    state.qbtcpSessions = [session({ roomId: 'room-203', state: 'result-received' })];
    const plan = planRoundOperations(state, 'round-2');
    expect(plan.assignments.map((entry) => entry.roomId)).not.toContain('room-203');
  });

  test('refuses to plan a released round at all', () => {
    const state = operationsFixture();
    const plan = planRoundOperations(state, 'round-1');
    expect(plan.planned).toBe(false);
    expect(plan.assignments).toHaveLength(0);
    expect(plan.reason).toContain('released');
  });

  test('refuses to plan a closed round', () => {
    const state = plannableState();
    expect(planRoundOperations(state, 'round-1').planned).toBe(false);
  });

  test('a live game inside an otherwise planned round is copied through untouched', () => {
    const state = plannableState();
    state.rounds[1]!.status = 'prepared';
    state.scheduledGames[2]!.status = 'live';
    state.scheduledGames[2]!.roomId = 'room-201';
    state.operationalAssignments.push({
      id: 'assignment-2a',
      roundId: 'round-2',
      kind: 'room',
      scheduledGameId: 'game-2a',
      roomId: 'room-201',
      moderatorId: 'staff-alice',
      scorekeeperId: 'staff-bob',
      equipmentIds: ['equipment-1'],
    });
    const plan = planRoundOperations(state, 'round-2');
    const live = plan.assignments.find((entry) => entry.scheduledGameId === 'game-2a');
    expect(live).toMatchObject({
      locked: true,
      changed: false,
      roomId: 'room-201',
      moderatorId: 'staff-alice',
      scorekeeperId: 'staff-bob',
    });
    // Its resources are reserved, so the movable game cannot take them.
    const other = plan.assignments.find((entry) => entry.scheduledGameId === 'game-2b');
    expect(other?.roomId).not.toBe('room-201');
    expect(other?.moderatorId).not.toBe('staff-alice');
  });
});

describe('pins', () => {
  function pinnedState(): DirectorState {
    const state = plannableState();
    state.scheduledGames[2]!.roomId = 'room-203';
    state.operationalAssignments.push({
      id: 'assignment-2a',
      roundId: 'round-2',
      kind: 'room',
      scheduledGameId: 'game-2a',
      roomId: 'room-203',
      moderatorId: 'staff-cara',
      scorekeeperId: 'staff-dan',
      equipmentIds: ['equipment-3'],
      pinned: { room: true, moderator: true, scorekeeper: true, equipmentIds: ['equipment-3'] },
    });
    return state;
  }

  test('pinned choices survive a planner run', () => {
    const plan = planRoundOperations(pinnedState(), 'round-2');
    expect(plan.assignments.find((entry) => entry.scheduledGameId === 'game-2a')).toMatchObject({
      roomId: 'room-203',
      moderatorId: 'staff-cara',
      scorekeeperId: 'staff-dan',
      equipmentIds: ['equipment-3'],
      changed: false,
    });
  });

  test('pinned choices survive repeated runs', () => {
    const state = pinnedState();
    const first = planRoundOperations(state, 'round-2');
    const second = planRoundOperations(state, 'round-2');
    expect(second).toEqual(first);
  });

  test('a pinned resource is not handed to another game', () => {
    const plan = planRoundOperations(pinnedState(), 'round-2');
    const other = plan.assignments.find((entry) => entry.scheduledGameId === 'game-2b');
    expect(other?.roomId).not.toBe('room-203');
    expect(other?.moderatorId).not.toBe('staff-cara');
    expect(other?.scorekeeperId).not.toBe('staff-dan');
  });

  test('an impossible pin becomes an explicit decision rather than a silent replacement', () => {
    const state = pinnedState();
    state.staff[2]!.available = false;
    const plan = planRoundOperations(state, 'round-2');
    expect(plan.assignments.find((entry) => entry.scheduledGameId === 'game-2a')?.moderatorId).toBe(
      'staff-cara',
    );
    expect(plan.unresolved.some((entry) => entry.id === 'pinned-moderator-unusable-game-2a')).toBe(true);
  });

  test('applying a plan does not invent pins', () => {
    const state = plannableState();
    const plan = planRoundOperations(state, 'round-2');
    const applied = planToAssignments(state, plan, (prefix) => `${prefix}-generated`);
    expect(applied.every((entry) => entry.pinned === undefined)).toBe(true);
  });

  test('applying a plan preserves pins the director already made', () => {
    const state = pinnedState();
    const plan = planRoundOperations(state, 'round-2');
    const applied = planToAssignments(state, plan, (prefix) => `${prefix}-generated`);
    const pinned = applied.find((entry) => entry.scheduledGameId === 'game-2a');
    expect(pinned?.id).toBe('assignment-2a');
    expect(pinned?.pinned).toMatchObject({ room: true, moderator: true });
  });
});

describe('continuity', () => {
  test('prefers to keep staff in the room they worked last round', () => {
    const state = operationsFixture();
    state.rounds[0]!.status = 'closed';
    state.rounds[0]!.closedAt = '2026-09-09T11:00:00.000Z';
    for (const game of state.scheduledGames) if (game.roundId === 'round-1') game.status = 'accepted';
    // Round 1 had Alice/Bob in 201 and Cara/Dan in 202. Round 2 should reproduce that pairing.
    const plan = planRoundOperations(state, 'round-2');
    const in201 = plan.assignments.find((entry) => entry.roomId === 'room-201');
    expect(in201?.moderatorId).toBe('staff-alice');
    expect(in201?.scorekeeperId).toBe('staff-bob');
  });

  test('fillOnly leaves an existing valid choice alone', () => {
    const state = plannableState();
    state.scheduledGames[2]!.roomId = 'room-203';
    state.operationalAssignments.push({
      id: 'assignment-2a',
      roundId: 'round-2',
      kind: 'room',
      scheduledGameId: 'game-2a',
      roomId: 'room-203',
      moderatorId: 'staff-cara',
      scorekeeperId: null,
      equipmentIds: [],
    });
    const plan = planRoundOperations(state, 'round-2', { fillOnly: true });
    const entry = plan.assignments.find((item) => item.scheduledGameId === 'game-2a');
    expect(entry?.roomId).toBe('room-203');
    expect(entry?.moderatorId).toBe('staff-cara');
    expect(entry?.scorekeeperId).toBeTruthy();
  });
});

describe('resourceUnavailabilityImpact', () => {
  test('names the future assignments a staff member would break', () => {
    const state = operationsFixture();
    state.operationalAssignments.push({
      id: 'assignment-2a',
      roundId: 'round-2',
      kind: 'room',
      scheduledGameId: 'game-2a',
      roomId: 'room-203',
      moderatorId: null,
      scorekeeperId: 'staff-bob',
      equipmentIds: [],
    });
    state.scheduledGames[2]!.roomId = 'room-203';
    const impact = resourceUnavailabilityImpact(state, 'staff', 'staff-bob');
    expect(impact.resourceName).toBe('Bob Smith');
    expect(impact.affected).toHaveLength(2);
    // Round 1 is released, so only the Round 2 assignment can be repaired automatically.
    expect(impact.repairable.map((entry) => entry.roundId)).toEqual(['round-2']);
    expect(impact.lockedRoundIds).toEqual(['round-1']);
  });

  test('a role change counts only the roles the member would lose', () => {
    const state = operationsFixture();
    state.operationalAssignments[1]!.moderatorId = 'staff-cara';
    state.operationalAssignments[1]!.scorekeeperId = 'staff-cara';
    const impact = resourceUnavailabilityImpact(state, 'staff', 'staff-cara', {
      retainedRoles: ['moderator'],
    });
    expect(impact.affected.map((entry) => entry.slot)).toEqual(['scorekeeper']);
  });

  test('names the future games a disabled room would break', () => {
    const state = operationsFixture();
    state.rounds[0]!.status = 'planned';
    const impact = resourceUnavailabilityImpact(state, 'room', 'room-201');
    expect(impact.affected.map((entry) => entry.scheduledGameId)).toEqual(['game-1a']);
    expect(impact.repairable).toHaveLength(1);
  });

  test('names the future rooms disabled equipment would break', () => {
    const state = operationsFixture();
    state.rounds[0]!.status = 'planned';
    const impact = resourceUnavailabilityImpact(state, 'equipment', 'equipment-1');
    expect(impact.affected.map((entry) => entry.roomName)).toEqual(['Room 201']);
  });

  test('a runner duty is counted in a staff impact', () => {
    const state = operationsFixture();
    state.rounds[0]!.status = 'planned';
    state.operationalAssignments.push({
      id: 'duty-runner',
      roundId: 'round-1',
      kind: 'runner',
      staffIds: ['staff-cara'],
      equipmentIds: [],
    });
    const impact = resourceUnavailabilityImpact(state, 'staff', 'staff-cara');
    expect(impact.affected.some((entry) => entry.slot === 'duty')).toBe(true);
  });

  test('runner and HQ duty equipment is counted in an equipment impact', () => {
    const state = operationsFixture();
    state.rounds[0]!.status = 'planned';
    state.operationalAssignments.push(
      {
        id: 'duty-runner',
        roundId: 'round-1',
        kind: 'runner',
        staffIds: [],
        equipmentIds: ['equipment-3'],
      },
      {
        id: 'duty-hq',
        roundId: 'round-1',
        kind: 'hq',
        staffIds: [],
        equipmentIds: ['equipment-3'],
      },
    );
    const impact = resourceUnavailabilityImpact(state, 'equipment', 'equipment-3');
    expect(
      impact.affected.filter((entry) => entry.slot === 'duty').map((entry) => entry.scheduledGameId),
    ).toEqual(['duty-runner', 'duty-hq']);
  });

  test('closed rounds are never counted', () => {
    const state = operationsFixture();
    state.rounds[0]!.status = 'closed';
    const impact = resourceUnavailabilityImpact(state, 'staff', 'staff-bob');
    expect(impact.affected).toHaveLength(0);
  });
});

describe('repairScope', () => {
  test('covers only planned and prepared rounds from the current one onward', () => {
    const state = operationsFixture();
    expect(repairScope(state)).toEqual(['round-2']);
  });

  test('a repair of the next round leaves the current round untouched', () => {
    const state = operationsFixture();
    const before = structuredClone(state.operationalAssignments.filter((e) => e.roundId === 'round-1'));
    const plan = planRoundOperations(state, 'round-2');
    const applied = planToAssignments(state, plan, (prefix) => `${prefix}-generated`);
    expect(applied.every((entry) => entry.roundId === 'round-2')).toBe(true);
    expect(state.operationalAssignments.filter((e) => e.roundId === 'round-1')).toEqual(before);
  });
});