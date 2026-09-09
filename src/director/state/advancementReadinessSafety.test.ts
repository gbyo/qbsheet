import { describe, expect, test } from 'vitest';
import { emptyDirectorState, type DirectorState } from '../domain';
import { advancementCommitBlocker } from './tournamentSafety';

function advancementState(
  status: DirectorState['phases'][number]['status'],
  gameStatus = 'accepted',
): DirectorState {
  const state = emptyDirectorState();
  state.phases.push({
    id: 'prelims',
    name: 'Preliminary phase',
    status,
  } as DirectorState['phases'][number]);
  state.rounds.push({ id: 'round-1', phaseId: 'prelims' } as DirectorState['rounds'][number]);
  state.scheduledGames.push({
    id: 'game-1',
    roundId: 'round-1',
    bye: false,
    status: gameStatus,
  } as DirectorState['scheduledGames'][number]);
  return state;
}

describe('advancement readiness safety', () => {
  test.each(['planned', 'active'] as const)('blocks advancement while source phase is %s', (status) => {
    expect(advancementCommitBlocker(advancementState(status), 'prelims')).toContain(
      'Finish Preliminary phase',
    );
  });

  test('reports unresolved source games', () => {
    expect(advancementCommitBlocker(advancementState('active', 'released'), 'prelims')).toContain(
      '1 game remain',
    );
  });

  test('allows advancement only after the source phase is complete', () => {
    expect(advancementCommitBlocker(advancementState('complete'), 'prelims')).toBeNull();
  });
});
