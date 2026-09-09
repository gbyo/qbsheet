import { describe, expect, test } from 'vitest';
import { emptyDirectorState, type DirectorState } from '../domain';
import { releasedRoundResultBlocker, scheduledGameIdForSubmission } from './tournamentSafety';

function resultState(status: DirectorState['rounds'][number]['status']): DirectorState {
  const state = emptyDirectorState();
  state.rounds.push({
    id: 'round-1',
    phaseId: 'phase-1',
    name: 'Round 1',
    number: 1,
    revision: 1,
    status,
    packetId: null,
    scheduledGameIds: ['scheduled-1'],
    dayOrder: 1,
    scheduledStart: null,
    releasedAt: status === 'released' || status === 'closed' ? '2026-09-12T13:00:00.000Z' : null,
    startedAt: null,
    closedAt: status === 'closed' ? '2026-09-12T14:00:00.000Z' : null,
  });
  state.scheduledGames.push({ id: 'scheduled-1', roundId: 'round-1' } as DirectorState['scheduledGames'][number]);
  return state;
}

describe('tournament result lifecycle safety', () => {
  test.each(['planned', 'prepared'] as const)('blocks canonical settlement while a round is %s', (status) => {
    expect(releasedRoundResultBlocker(resultState(status), 'scheduled-1')).toContain('has not started yet');
  });

  test('allows canonical settlement in a released round', () => {
    expect(releasedRoundResultBlocker(resultState('released'), 'scheduled-1')).toBeNull();
  });

  test('routes closed rounds to correction rather than new settlement', () => {
    expect(releasedRoundResultBlocker(resultState('closed'), 'scheduled-1')).toContain('already closed');
  });

  test('resolves the scheduled target for a staged submission', () => {
    const state = resultState('released');
    state.games.push({ id: 'game-1', scheduledGameId: 'scheduled-1' } as DirectorState['games'][number]);
    state.submissions.push({ id: 'submission-1', gameId: 'game-1' } as DirectorState['submissions'][number]);
    expect(scheduledGameIdForSubmission(state, 'submission-1')).toBe('scheduled-1');
  });
});
