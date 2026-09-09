import { describe, expect, test } from 'vitest';
import { emptyDirectorState, type DirectorState } from '../domain';
import { finalPlacementCommitObserved } from './finalPlacementSafety';

function placementState(): DirectorState {
  const state = emptyDirectorState();
  state.tournament = { id: 'tournament', name: 'Tournament' } as DirectorState['tournament'];
  state.teams.push({ id: 'team-a' } as DirectorState['teams'][number]);
  state.teams.push({ id: 'team-b' } as DirectorState['teams'][number]);
  return state;
}

describe('final placement commit verification', () => {
  test('rejects the false-success case where the snapshot never changed', () => {
    const before = placementState();
    expect(finalPlacementCommitObserved(before, structuredClone(before), ['team-a', 'team-b'])).toBe(false);
  });

  test('requires both the requested canonical order and a new audit event', () => {
    const before = placementState();
    const after = structuredClone(before);
    if (!after.tournament) throw new Error('fixture tournament missing');
    after.tournament.finalPlacement = {
      order: ['team-a', 'team-b'],
      actor: 'Director',
      at: '2026-09-12T22:00:00.000Z',
    };
    after.audit.push({
      id: 'audit-final-placement',
      at: '2026-09-12T22:00:00.000Z',
      actor: 'Director',
      type: 'final-placement-set',
      summary: 'Set final placement.',
    });
    expect(finalPlacementCommitObserved(before, after, ['team-a', 'team-b'])).toBe(true);
    expect(finalPlacementCommitObserved(before, after, ['team-b', 'team-a'])).toBe(false);
  });

  test('accepts the canonical order the commit path stores for a messy request', () => {
    // Repeated teams collapse and unknown teams drop, so the stored order is shorter than the
    // request. That is a successful commit, not a silent failure.
    const before = placementState();
    const after = structuredClone(before);
    if (!after.tournament) throw new Error('fixture tournament missing');
    after.tournament.finalPlacement = {
      order: ['team-a', 'team-b'],
      actor: 'Director',
      at: '2026-09-12T22:00:00.000Z',
    };
    after.audit.push({
      id: 'audit-final-placement',
      at: '2026-09-12T22:00:00.000Z',
      actor: 'Director',
      type: 'final-placement-set',
      summary: 'Set final placement.',
    });
    expect(finalPlacementCommitObserved(before, after, ['team-a', 'team-a', 'ghost-team', 'team-b'])).toBe(
      true,
    );
  });
});
