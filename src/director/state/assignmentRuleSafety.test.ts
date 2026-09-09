import { describe, expect, test } from 'vitest';
import { emptyDirectorState, type DirectorState } from '../domain';
import { assignmentRuleChangeBlocker } from './tournamentSafety';

function assignmentState(
  roundStatus: DirectorState['rounds'][number]['status'],
  gameStatus: string,
): DirectorState {
  const state = emptyDirectorState();
  state.rounds.push({
    id: 'round-1',
    name: 'Round 1',
    status: roundStatus,
  } as DirectorState['rounds'][number]);
  state.scheduledGames.push({
    id: 'game-1',
    roundId: 'round-1',
    bye: false,
    status: gameStatus,
  } as DirectorState['scheduledGames'][number]);
  return state;
}

describe('scorer assignment rule safety', () => {
  test.each(['prepared', 'released'] as const)(
    'blocks rules changes while an unresolved %s round may be in scorer hands',
    (status) => {
      expect(assignmentRuleChangeBlocker(assignmentState(status, 'released'))).toContain('Round 1');
    },
  );

  test('allows rules changes before assignments are prepared', () => {
    expect(assignmentRuleChangeBlocker(assignmentState('planned', 'scheduled'))).toBeNull();
  });

  test.each(['accepted', 'cancelled'] as const)(
    'allows changes after the prepared/released work is %s',
    (status) => {
      expect(assignmentRuleChangeBlocker(assignmentState('released', status))).toBeNull();
    },
  );
});
