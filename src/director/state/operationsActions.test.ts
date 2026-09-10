import { describe, expect, test } from 'vitest';
import type { DirectorState } from '../domain';
import { scheduledGame, team, tournamentState } from '../../../tests/directorFixtures';
import { assignmentChangeBlocker } from './operationsActions';

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
