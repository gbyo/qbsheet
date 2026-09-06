import { describe, expect, it } from 'vitest';
import type { DirectorState } from '../src/director/domain';
import { buildStatsScopes } from '../src/director/standings/statsDisplay';

describe('buildStatsScopes', () => {
  it('does not offer pools from archived phases', () => {
    const state = {
      phases: [
        { id: 'phase-prelims', name: 'Prelims', archived: false },
        { id: 'phase-playoffs', name: 'Playoffs', archived: false },
        { id: 'phase-old', name: 'Old stage', archived: true },
      ],
      pools: [
        { id: 'pool-a', name: 'A', phaseId: 'phase-prelims', archived: false },
        { id: 'pool-b', name: 'B', phaseId: 'phase-playoffs', archived: false },
        { id: 'pool-old', name: 'Old pool', phaseId: 'phase-old', archived: false },
      ],
    } as unknown as DirectorState;

    const { scopes } = buildStatsScopes(state);

    expect(scopes.map((scope) => scope.id)).toEqual([
      'overall',
      'phase:phase-prelims',
      'phase:phase-playoffs',
      'pool:pool-a',
      'pool:pool-b',
    ]);
  });
});
