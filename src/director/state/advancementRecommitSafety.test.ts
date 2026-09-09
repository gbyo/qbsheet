import { describe, expect, test } from 'vitest';
import { emptyDirectorState, type DirectorState } from '../domain';
import { partialAdvancementCommitBlocker } from './tournamentSafety';

/** A target stage with two pools: Championship A holds team-1, Championship B holds team-2. */
function recommitState(): DirectorState {
  const state = emptyDirectorState();
  state.phases.push({
    id: 'playoffs',
    name: 'Playoffs',
    poolIds: ['pool-a', 'pool-b'],
  } as DirectorState['phases'][number]);
  state.pools.push({
    id: 'pool-a',
    phaseId: 'playoffs',
    name: 'Championship A',
    teamIds: ['team-1'],
  } as DirectorState['pools'][number]);
  state.pools.push({
    id: 'pool-b',
    phaseId: 'playoffs',
    name: 'Championship B',
    teamIds: ['team-2'],
  } as DirectorState['pools'][number]);
  return state;
}

describe('advancement recommit safety', () => {
  test('refuses a recommit that would leave a committed team in a second target pool', () => {
    // Moving team-2 into Championship A while omitting Championship B would duplicate team-2.
    expect(
      partialAdvancementCommitBlocker(recommitState(), 'playoffs', [
        { teamId: 'team-2', targetPoolId: 'pool-a' },
      ]),
    ).toContain('Championship B');
  });

  test('allows an override commit that does not touch the omitted pool members', () => {
    // team-3 is not in any target pool, so Championship B cannot end up duplicating it.
    expect(
      partialAdvancementCommitBlocker(recommitState(), 'playoffs', [
        { teamId: 'team-3', targetPoolId: 'pool-a' },
      ]),
    ).toBeNull();
  });

  test('allows a commit that names every populated target pool', () => {
    expect(
      partialAdvancementCommitBlocker(recommitState(), 'playoffs', [
        { teamId: 'team-1', targetPoolId: 'pool-a' },
        { teamId: 'team-2', targetPoolId: 'pool-b' },
      ]),
    ).toBeNull();
  });
});
