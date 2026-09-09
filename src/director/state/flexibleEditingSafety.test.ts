import { describe, expect, test } from 'vitest';
import { emptyDirectorState, type DirectorState } from '../domain';
import { roundRemovalBlocker, roundRemovalImpact } from './flexibleEditing';

function roundState(status: DirectorState['rounds'][number]['status']): DirectorState {
  const state = emptyDirectorState();
  state.rounds.push({
    id: 'round-1',
    name: 'Round 1',
    status,
    scheduledGameIds: ['scheduled-1'],
  } as DirectorState['rounds'][number]);
  state.scheduledGames.push({
    id: 'scheduled-1',
    roundId: 'round-1',
  } as DirectorState['scheduledGames'][number]);
  return state;
}

describe('flexible round removal safety', () => {
  test('allows ordinary removal of an unplayed planned round', () => {
    expect(roundRemovalBlocker(roundState('planned'), 'round-1')).toBeNull();
  });

  test('blocks removal of a released round even before a result is accepted', () => {
    expect(roundRemovalBlocker(roundState('released'), 'round-1')).toContain('competitive history');
  });

  test('blocks a corrupted/planned round that already contains an accepted result', () => {
    const state = roundState('planned');
    state.games.push({
      id: 'game-1',
      roundId: 'round-1',
      scheduledGameId: 'scheduled-1',
      status: 'accepted',
    } as DirectorState['games'][number]);
    expect(roundRemovalImpact(state, 'round-1')?.acceptedResults).toBe(1);
    expect(roundRemovalBlocker(state, 'round-1')).toContain('1 accepted/forfeit result');
  });
});
