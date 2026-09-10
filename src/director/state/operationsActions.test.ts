import { describe, expect, test } from 'vitest';
import { deriveOperationalRoom, type DirectorState } from '../domain';
import { operationsFixture, session } from '../domain/operations.fixtures';
import { scheduledGame, team, tournamentState } from '../../../tests/directorFixtures';
import {
  applyAssignmentChanges,
  applyAssignmentPin,
  applyDutyChange,
  assignmentChangeBlocker,
  dutyChangeBlocker,
  reconcileSessionStaffIdentity,
} from './operationsActions';

function exclusivityState(): DirectorState {
  const state = tournamentState();
  state.teams.push(team('team-a', 'Alpha'), team('team-b', 'Beta'));
  state.staff.push(
    { id: 'alice', name: 'Alice', roles: ['moderator', 'scorekeeper', 'runner', 'hq'], available: true },
    { id: 'bob', name: 'Bob', roles: ['moderator', 'scorekeeper'], available: true },
  );
  state.scheduledGames.push(scheduledGame('game-1', 'team-a', 'team-b', { status: 'released' }));
  state.operationalAssignments.push({
    id: 'room-1',
    roundId: 'round-1',
    kind: 'room',
    scheduledGameId: 'game-1',
    roomId: 'room-1',
    moderatorId: 'bob',
    scorekeeperId: 'alice',
    equipmentIds: [],
  });
  return state;
}

describe('assignment exclusivity (#708)', () => {
  test('changing only the moderator to the current scorekeeper is refused', () => {
    const state = exclusivityState();
    expect(assignmentChangeBlocker(state, 'game-1', { moderatorId: 'alice' })).toBe(
      'One person cannot moderate and score the same game.',
    );
  });

  test('changing only the scorekeeper to the current moderator is refused', () => {
    const state = exclusivityState();
    expect(assignmentChangeBlocker(state, 'game-1', { scorekeeperId: 'bob' })).toBe(
      'One person cannot moderate and score the same game.',
    );
  });

  test('assigning HQ duty staff to a room in the same round is refused', () => {
    const state = exclusivityState();
    state.operationalAssignments.push({
      id: 'duty-hq',
      roundId: 'round-1',
      kind: 'hq',
      staffIds: ['alice'],
      equipmentIds: [],
    });
    expect(assignmentChangeBlocker(state, 'game-1', { moderatorId: 'alice' })).toBe(
      'Alice is already on HQ duty in this round.',
    );
  });

  test('assigning a runner to a room in the same round is refused', () => {
    const state = exclusivityState();
    state.operationalAssignments.push({
      id: 'duty-runner',
      roundId: 'round-1',
      kind: 'runner',
      staffIds: ['bob'],
      equipmentIds: [],
    });
    expect(assignmentChangeBlocker(state, 'game-1', { scorekeeperId: 'bob' })).toBe(
      'Bob is already on runner duty in this round.',
    );
  });

  test('a valid one-field edit still returns no blocker', () => {
    const state = exclusivityState();
    state.staff.push({ id: 'cara', name: 'Cara', roles: ['moderator'], available: true });
    expect(assignmentChangeBlocker(state, 'game-1', { moderatorId: 'cara' })).toBeNull();
  });
});

/** Round 2 is planned, so its games are the ones an edit may touch. */
function editableState(): DirectorState {
  const state = operationsFixture();
  state.scheduledGames[2]!.roomId = 'room-203';
  return state;
}

describe('assignmentChangeBlocker', () => {
  test('allows an ordinary edit on a planned game', () => {
    expect(assignmentChangeBlocker(editableState(), 'game-2a', { moderatorId: 'staff-alice' })).toBeNull();
  });

  test('refuses to move a released game between rooms', () => {
    const blocker = assignmentChangeBlocker(operationsFixture(), 'game-1a', { roomId: 'room-203' });
    expect(blocker).toMatch(/recovery action/i);
  });

  test('allows correcting staff on a released round', () => {
    // Nobody's scoresheet depends on which person is standing in the room, so swapping a moderator
    // is safe where moving the game itself is not.
    const state = operationsFixture();
    state.staff.push({ id: 'staff-eve', name: 'Eve Novak', roles: ['moderator'], available: true });
    expect(assignmentChangeBlocker(state, 'game-1a', { moderatorId: 'staff-eve' })).toBeNull();
  });

  test('refuses a room that already hosts a game in the same round', () => {
    const state = editableState();
    state.scheduledGames[3]!.roomId = 'room-201';
    expect(assignmentChangeBlocker(state, 'game-2a', { roomId: 'room-201' })).toMatch(
      /already hosts another game/i,
    );
  });

  test('refuses a staff member in a role they do not hold', () => {
    expect(assignmentChangeBlocker(editableState(), 'game-2a', { moderatorId: 'staff-bob' })).toMatch(
      /not marked as a moderator/i,
    );
  });

  test('refuses an unavailable staff member', () => {
    const state = editableState();
    state.staff[0]!.available = false;
    expect(assignmentChangeBlocker(state, 'game-2a', { moderatorId: 'staff-alice' })).toMatch(/unavailable/i);
  });

  test('refuses one person moderating and scoring the same game', () => {
    expect(
      assignmentChangeBlocker(editableState(), 'game-2a', {
        moderatorId: 'staff-cara',
        scorekeeperId: 'staff-cara',
      }),
    ).toMatch(/cannot moderate and score/i);
  });

  test('refuses the same exclusive resource in two rooms in one round', () => {
    const state = editableState();
    state.operationalAssignments.push({
      id: 'assignment-2b',
      roundId: 'round-2',
      kind: 'room',
      scheduledGameId: 'game-2b',
      roomId: 'room-202',
      equipmentIds: ['equipment-3'],
    });
    state.scheduledGames[3]!.roomId = 'room-202';
    expect(assignmentChangeBlocker(state, 'game-2a', { equipmentIds: ['equipment-3'] })).toMatch(
      /already assigned to another room/i,
    );
  });

  test('refuses an edit to a closed round', () => {
    const state = editableState();
    state.rounds[1]!.status = 'closed';
    expect(assignmentChangeBlocker(state, 'game-2a', { moderatorId: 'staff-alice' })).toMatch(/closed/i);
  });
});

describe('applyAssignmentChanges', () => {
  test('materializes an assignment record on first write and pins the explicit choice', () => {
    const state = editableState();
    applyAssignmentChanges(state, 'game-2a', { moderatorId: 'staff-alice' });
    const created = state.operationalAssignments.find((entry) => entry.scheduledGameId === 'game-2a');
    expect(created?.moderatorId).toBe('staff-alice');
    expect(created?.pinned?.moderator).toBe(true);
  });

  test('a room change moves the schedule row too, so the rest of Director agrees', () => {
    const state = editableState();
    applyAssignmentChanges(state, 'game-2a', { roomId: 'room-202' });
    expect(state.scheduledGames.find((entry) => entry.id === 'game-2a')?.roomId).toBe('room-202');
    expect(deriveOperationalRoom(state, 'room-202', 'round-2')?.game?.id).toBe('game-2a');
  });

  test('clearing a slot removes its pin rather than pinning emptiness', () => {
    const state = editableState();
    applyAssignmentChanges(state, 'game-2a', { moderatorId: 'staff-alice' });
    applyAssignmentChanges(state, 'game-2a', { moderatorId: null });
    const entry = state.operationalAssignments.find((item) => item.scheduledGameId === 'game-2a');
    expect(entry?.moderatorId).toBeNull();
    expect(entry?.pinned?.moderator).toBe(false);
  });

  test('a pin can be set without changing what is assigned', () => {
    const state = operationsFixture();
    applyAssignmentPin(state, 'game-1a', 'scorekeeper', true);
    const entry = state.operationalAssignments.find((item) => item.scheduledGameId === 'game-1a');
    expect(entry?.pinned?.scorekeeper).toBe(true);
    expect(entry?.scorekeeperId).toBe('staff-bob');
  });
});

describe('duties', () => {
  test('a runner duty can be set for a round', () => {
    const state = operationsFixture();
    state.staff.push({ id: 'staff-eve', name: 'Eve Novak', roles: ['runner'], available: true });
    expect(dutyChangeBlocker(state, 'round-1', 'runner', ['staff-eve'])).toBeNull();
    applyDutyChange(state, 'round-1', 'runner', ['staff-eve']);
    expect(state.operationalAssignments.some((entry) => entry.kind === 'runner')).toBe(true);
  });

  test('someone already working a room cannot also take a duty', () => {
    const state = operationsFixture();
    state.staff[0]!.roles = ['moderator', 'runner'];
    expect(dutyChangeBlocker(state, 'round-1', 'runner', ['staff-alice'])).toMatch(/already working a room/i);
  });

  test('clearing a duty removes its record instead of leaving an empty one', () => {
    const state = operationsFixture();
    state.staff.push({ id: 'staff-eve', name: 'Eve Novak', roles: ['runner'], available: true });
    applyDutyChange(state, 'round-1', 'runner', ['staff-eve']);
    applyDutyChange(state, 'round-1', 'runner', []);
    expect(state.operationalAssignments.some((entry) => entry.kind === 'runner')).toBe(false);
  });
});

describe('reconcileSessionStaffIdentity', () => {
  test('records who the room expects from its operational assignment', () => {
    const state = operationsFixture();
    state.qbtcpSessions = [session({ roomId: 'room-201' })];
    expect(reconcileSessionStaffIdentity(state)).toBe(true);
    expect(state.qbtcpSessions[0]?.expectedStaffId).toBe('staff-bob');
  });

  test('maps an unambiguous operator name onto the roster', () => {
    const state = operationsFixture();
    state.qbtcpSessions = [session({ roomId: 'room-201', operatorName: 'Bob Smith' })];
    reconcileSessionStaffIdentity(state);
    expect(state.qbtcpSessions[0]?.staffId).toBe('staff-bob');
  });

  test('leaves an ambiguous operator ad hoc rather than guessing', () => {
    const state = operationsFixture();
    state.staff.push({ id: 'staff-bob-2', name: 'Bob Smith', roles: ['scorekeeper'], available: true });
    state.qbtcpSessions = [session({ roomId: 'room-201', operatorName: 'Bob Smith' })];
    reconcileSessionStaffIdentity(state);
    expect(state.qbtcpSessions[0]?.staffId).toBeUndefined();
  });

  test('never overwrites an established identity when the operator renames mid-session', () => {
    const state = operationsFixture();
    state.qbtcpSessions = [session({ roomId: 'room-201', staffId: 'staff-bob', operatorName: 'Dan Lee' })];
    reconcileSessionStaffIdentity(state);
    expect(state.qbtcpSessions[0]?.staffId).toBe('staff-bob');
  });

  test('reassigning the scorekeeper changes who the room expects', () => {
    const state = operationsFixture();
    state.qbtcpSessions = [session({ roomId: 'room-201' })];
    reconcileSessionStaffIdentity(state);
    state.operationalAssignments[0]!.scorekeeperId = 'staff-dan';
    expect(reconcileSessionStaffIdentity(state)).toBe(true);
    expect(state.qbtcpSessions[0]?.expectedStaffId).toBe('staff-dan');
  });

  test('the wrong person connecting is surfaced once identity is reconciled', () => {
    const state = operationsFixture();
    state.qbtcpSessions = [session({ roomId: 'room-201', operatorName: 'Dan Lee' })];
    reconcileSessionStaffIdentity(state);
    const view = deriveOperationalRoom(state, 'room-201');
    expect(view?.warnings.some((issue) => issue.id === 'scorer-mismatch-room-201')).toBe(true);
  });

  test('is idempotent: a second pass reports no change', () => {
    const state = operationsFixture();
    state.qbtcpSessions = [session({ roomId: 'room-201', operatorName: 'Bob Smith' })];
    reconcileSessionStaffIdentity(state);
    expect(reconcileSessionStaffIdentity(state)).toBe(false);
  });
});

describe('reconcileSessionStaffIdentity room-only scope (#790)', () => {
  /** Current round (round-1, released) expects Bob in Room 201; next round expects Dan there. */
  function twoRoundSameRoomState(): DirectorState {
    const state = operationsFixture();
    const future = state.scheduledGames.find((entry) => entry.id === 'game-2a')!;
    future.roomId = 'room-201';
    state.operationalAssignments.push({
      id: 'assignment-2a',
      roundId: 'round-2',
      kind: 'room',
      scheduledGameId: 'game-2a',
      roomId: 'room-201',
      moderatorId: 'staff-alice',
      scorekeeperId: 'staff-dan',
      equipmentIds: [],
    });
    // Future game first in persistence order: the old array-order fallback picked Dan.
    state.scheduledGames.sort((left, right) => {
      if (left.id === 'game-2a') return -1;
      if (right.id === 'game-2a') return 1;
      return 0;
    });
    return state;
  }

  test('a room-only session resolves the current round, not the future game first in array order', () => {
    const state = twoRoundSameRoomState();
    expect(state.scheduledGames[0]?.id).toBe('game-2a');
    state.qbtcpSessions = [session({ roomId: 'room-201', operatorName: 'Bob Smith' })];
    reconcileSessionStaffIdentity(state);
    expect(state.qbtcpSessions[0]?.expectedStaffId).toBe('staff-bob');
    expect(state.qbtcpSessions[0]?.staffId).toBe('staff-bob');
    // No false mismatch: Bob is correctly assigned to the room for the round being operated.
    expect(
      deriveOperationalRoom(state, 'room-201')?.warnings.some(
        (issue) => issue.id === 'scorer-mismatch-room-201',
      ),
    ).toBe(false);
  });

  test('changing scheduledGames array order does not change the answer', () => {
    const forward = twoRoundSameRoomState();
    forward.qbtcpSessions = [session({ roomId: 'room-201' })];
    reconcileSessionStaffIdentity(forward);

    const reversed = twoRoundSameRoomState();
    reversed.scheduledGames.reverse();
    reversed.qbtcpSessions = [session({ roomId: 'room-201' })];
    reconcileSessionStaffIdentity(reversed);

    expect(forward.qbtcpSessions[0]?.expectedStaffId).toBe('staff-bob');
    expect(reversed.qbtcpSessions[0]?.expectedStaffId).toBe('staff-bob');
  });

  test('an explicit matchId remains authoritative over the operational round', () => {
    const state = twoRoundSameRoomState();
    state.qbtcpSessions = [session({ roomId: 'room-201', matchId: 'game-2a', operatorName: 'Dan Lee' })];
    reconcileSessionStaffIdentity(state);
    expect(state.qbtcpSessions[0]?.expectedStaffId).toBe('staff-dan');
  });

  test('no current-round game for the room leaves the expectation unset, not pointed at the future', () => {
    const state = twoRoundSameRoomState();
    // Room 203 has no game in the current round but the future round could host it; the
    // reconciler must not borrow that future assignment.
    const future = state.scheduledGames.find((entry) => entry.id === 'game-2b')!;
    future.roomId = 'room-203';
    state.operationalAssignments.push({
      id: 'assignment-2b',
      roundId: 'round-2',
      kind: 'room',
      scheduledGameId: 'game-2b',
      roomId: 'room-203',
      moderatorId: 'staff-alice',
      scorekeeperId: 'staff-dan',
      equipmentIds: [],
    });
    state.qbtcpSessions = [session({ roomId: 'room-203', operatorName: 'Dan Lee' })];
    reconcileSessionStaffIdentity(state);
    expect(state.qbtcpSessions[0]?.expectedStaffId).toBeUndefined();
  });

  test('an accepted current-round game leaves the expectation unset rather than falling through', () => {
    const state = twoRoundSameRoomState();
    state.scheduledGames.find((entry) => entry.id === 'game-1a')!.status = 'accepted';
    state.qbtcpSessions = [session({ roomId: 'room-201', operatorName: 'Bob Smith' })];
    reconcileSessionStaffIdentity(state);
    expect(state.qbtcpSessions[0]?.expectedStaffId).toBeUndefined();
  });
});
