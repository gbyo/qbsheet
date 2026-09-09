import { describe, expect, test } from 'vitest';
import { emptyDirectorState, type DirectorState } from './model';
import { deferredEmptyRoundIsExpected } from './validation';

function stateWithFutureRound(): DirectorState {
  const state = emptyDirectorState();
  state.tournament = {
    id: 'tournament',
    name: 'Tournament',
    currentPhaseId: 'prelims',
  } as DirectorState['tournament'];
  state.phases.push(
    { id: 'prelims', name: 'Prelims', order: 1 } as DirectorState['phases'][number],
    { id: 'playoffs', name: 'Playoffs', order: 2 } as DirectorState['phases'][number],
  );
  state.rounds.push(
    { id: 'prelim-round', phaseId: 'prelims', status: 'planned' } as DirectorState['rounds'][number],
    { id: 'playoff-round', phaseId: 'playoffs', status: 'planned' } as DirectorState['rounds'][number],
  );
  return state;
}

describe('deferred future round preflight', () => {
  test('treats an empty planned round in a later phase as deferred', () => {
    expect(deferredEmptyRoundIsExpected(stateWithFutureRound(), 'playoff-round')).toBe(true);
  });

  test('keeps an empty round in the current phase strict', () => {
    expect(deferredEmptyRoundIsExpected(stateWithFutureRound(), 'prelim-round')).toBe(false);
  });

  test('does not suppress validation once a future round has partial pairings', () => {
    const state = stateWithFutureRound();
    state.scheduledGames.push({
      id: 'game',
      roundId: 'playoff-round',
    } as DirectorState['scheduledGames'][number]);
    expect(deferredEmptyRoundIsExpected(state, 'playoff-round')).toBe(false);
  });
});
