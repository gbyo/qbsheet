import { describe, expect, test } from 'vitest';
import { emptyDirectorState, type DirectorState } from '../domain';
import { advancementCorrectionBlocker } from './tournamentSafety';

function correctionState(withAdvancement: boolean): DirectorState {
  const state = emptyDirectorState();
  state.phases.push(
    { id: 'prelims', name: 'Prelims' } as DirectorState['phases'][number],
    { id: 'playoffs', name: 'Playoffs' } as DirectorState['phases'][number],
  );
  state.rounds.push({ id: 'round-1', phaseId: 'prelims' } as DirectorState['rounds'][number]);
  state.scheduledGames.push({
    id: 'scheduled-1',
    roundId: 'round-1',
  } as DirectorState['scheduledGames'][number]);
  state.games.push({ id: 'game-1', scheduledGameId: 'scheduled-1' } as DirectorState['games'][number]);
  if (withAdvancement) {
    state.audit.push({
      id: 'audit-1',
      at: '2026-09-12T18:00:00.000Z',
      actor: 'Director',
      type: 'advancement-committed',
      entityId: 'playoffs',
      summary: 'Committed advancement.',
      details: { sourcePhaseId: 'prelims' },
    });
  }
  return state;
}

describe('advancement correction dependency safety', () => {
  test('blocks rewriting a source result after advancement has been committed', () => {
    const blocker = advancementCorrectionBlocker(correctionState(true), 'game-1');
    expect(blocker).toContain('Prelims already has committed advancement into Playoffs');
    expect(blocker).toContain('recommit advancement');
  });

  test('allows normal correction before advancement has been committed', () => {
    expect(advancementCorrectionBlocker(correctionState(false), 'game-1')).toBeNull();
  });
});
