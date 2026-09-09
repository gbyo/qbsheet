import { describe, expect, test } from 'vitest';
import { emptyDirectorState, type DirectorState } from '../domain';
import { unresolvedReleasedRoundBlocker } from './tournamentSafety';

function stateWithRounds(firstGameStatus: string): DirectorState {
  const state = emptyDirectorState();
  state.rounds.push(
    { id: 'round-1', name: 'Round 1', status: 'released' } as DirectorState['rounds'][number],
    { id: 'round-2', name: 'Round 2', status: 'prepared' } as DirectorState['rounds'][number],
  );
  state.scheduledGames.push({
    id: 'game-1',
    roundId: 'round-1',
    bye: false,
    status: firstGameStatus,
  } as DirectorState['scheduledGames'][number]);
  return state;
}

describe('single active round safety', () => {
  test.each(['released', 'live', 'submitted'] as const)(
    'blocks another round while a released round has a %s game',
    (status) => {
      expect(unresolvedReleasedRoundBlocker(stateWithRounds(status), 'round-2')).toContain('Round 1');
    },
  );

  test.each(['accepted', 'cancelled'] as const)(
    'does not block when prior competitive work is %s',
    (status) => {
      expect(unresolvedReleasedRoundBlocker(stateWithRounds(status), 'round-2')).toBeNull();
    },
  );

  test('does not consider the target round its own blocker', () => {
    expect(unresolvedReleasedRoundBlocker(stateWithRounds('released'), 'round-1')).toBeNull();
  });
});
