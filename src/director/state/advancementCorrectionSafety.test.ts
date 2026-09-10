import { describe, expect, test } from 'vitest';
import { emptyDirectorState, type DirectorState } from '../domain';
import { advancementCorrectionBlocker, classifyResultCorrectionTier } from './tournamentSafety';

type Downstream = 'none' | 'bare' | 'generated' | 'issued' | 'live';

function tierState(downstream: Downstream): DirectorState {
  const state = emptyDirectorState();
  state.phases.push(
    { id: 'prelims', name: 'Prelims', roundIds: ['round-1'] } as DirectorState['phases'][number],
    { id: 'playoffs', name: 'Playoffs', roundIds: ['downstream-round'] } as DirectorState['phases'][number],
  );
  state.rounds.push({ id: 'round-1', phaseId: 'prelims' } as DirectorState['rounds'][number]);
  state.scheduledGames.push({
    id: 'scheduled-1',
    roundId: 'round-1',
  } as DirectorState['scheduledGames'][number]);
  state.games.push({ id: 'game-1', scheduledGameId: 'scheduled-1' } as DirectorState['games'][number]);
  if (downstream === 'none') return state;
  state.audit.push({
    id: 'audit-1',
    at: '2026-09-12T18:00:00.000Z',
    actor: 'Director',
    type: 'advancement-committed',
    entityId: 'playoffs',
    summary: 'Committed advancement.',
    details: { sourcePhaseId: 'prelims' },
  });
  if (downstream === 'bare') {
    state.phases.find((phase) => phase.id === 'playoffs')!.roundIds = [];
    return state;
  }
  state.rounds.push({
    id: 'downstream-round',
    phaseId: 'playoffs',
    name: 'Playoff Round 1',
    status: downstream === 'issued' ? 'released' : 'planned',
  } as DirectorState['rounds'][number]);
  state.scheduledGames.push({
    id: 'downstream-game',
    roundId: 'downstream-round',
    status: downstream === 'live' ? 'accepted' : 'scheduled',
  } as DirectorState['scheduledGames'][number]);
  return state;
}

describe('result correction tiers', () => {
  test('tier 1 allows correction before advancement has been committed', () => {
    const state = tierState('none');
    expect(classifyResultCorrectionTier(state, 'game-1').tier).toBe(1);
    expect(advancementCorrectionBlocker(state, 'game-1')).toBeNull();
  });

  test('tier 2 allows correction when advancement is committed but nothing is issued', () => {
    for (const downstream of ['bare', 'generated'] as const) {
      const state = tierState(downstream);
      expect(classifyResultCorrectionTier(state, 'game-1').tier).toBe(2);
      expect(advancementCorrectionBlocker(state, 'game-1')).toBeNull();
    }
  });

  test('tier 3 refuses correction naming the exact issued games', () => {
    const state = tierState('issued');
    const classification = classifyResultCorrectionTier(state, 'game-1');
    expect(classification.tier).toBe(3);
    expect(classification.issued.map((entry) => entry.scheduledGameId)).toEqual(['downstream-game']);
    const blocker = advancementCorrectionBlocker(state, 'game-1');
    expect(blocker).toContain('Prelims already has committed advancement into Playoffs');
    expect(blocker).toContain('downstream-game');
    expect(blocker).toContain('reissue');
  });

  test('tier 4 refuses correction with recovery choices, never a silent rewrite', () => {
    const state = tierState('live');
    const classification = classifyResultCorrectionTier(state, 'game-1');
    expect(classification.tier).toBe(4);
    expect(classification.live.map((entry) => entry.scheduledGameId)).toEqual(['downstream-game']);
    const blocker = advancementCorrectionBlocker(state, 'game-1');
    expect(blocker).toContain('committed advancement');
    expect(blocker).toContain('downstream-game');
    expect(blocker).toContain('recovery action');
  });
});
