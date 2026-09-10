import { describe, expect, test } from 'vitest';
import { acceptedGame, player, scheduledGame, team, tournamentState } from '../../../tests/directorFixtures';
import {
  advancementBasisStatus,
  advancementBasisTeams,
  advancementBasisToken,
  advancementBasisTokenV1,
  latestAdvancementCommit,
  previewAdvancement,
  resultRevisionOf,
  resultRevisionsForPhase,
} from './advancement';

function committedState() {
  const state = tournamentState();
  state.teams.push(team('team-a', 'Ninety Six'), team('team-b', 'Greenwood'));
  state.players.push(player('player-a', 'team-a', 'Gibson'), player('player-b', 'team-b', 'Emma'));
  state.phases[0]!.advancementRule = {
    qualifiersPerPool: 1,
    wildcards: 0,
    tiebreakers: state.tournament!.rules.tiebreakers,
    manualOverrideAllowed: false,
  };
  state.scheduledGames.push(scheduledGame('scheduled-1', 'team-a', 'team-b'));
  state.games.push(acceptedGame('game-1', 'scheduled-1', []));
  const phase = state.phases[0]!;
  state.audit.push({
    id: 'audit-commit-1',
    at: '2026-09-10T00:00:00.000Z',
    actor: 'Director',
    type: 'advancement-committed',
    summary: 'Moved 1 team.',
    entityId: 'phase-2',
    details: {
      sourcePhaseId: 'phase-1',
      basisToken: advancementBasisToken(state, phase),
      qualifierTeamIds: ['team-a'],
      assignments: [{ teamId: 'team-a', targetPoolId: 'pool-2' }],
    },
  });
  return state;
}

describe('advancement basis (#673)', () => {
  test('a fresh commit verifies as current', () => {
    const state = committedState();
    expect(advancementBasisStatus(state, 'phase-1')).toBe('current');
    expect(latestAdvancementCommit(state, 'phase-1')?.id).toBe('audit-commit-1');
  });

  test('a changed qualifying score invalidates the basis', () => {
    const state = committedState();
    state.games[0]!.scores = [
      {
        teamId: 'team-a',
        score: 9999,
        superpowers: 0,
        powers: 0,
        gets: 0,
        negs: 0,
        bonuses: 0,
        bonusPoints: 0,
        bouncebacks: 0,
      },
    ];
    expect(advancementBasisStatus(state, 'phase-1')).toBe('stale');
  });

  test('a tiebreaker reorder invalidates the basis', () => {
    const state = committedState();
    state.phases[0]!.advancementRule!.tiebreakers = [
      'points',
      'record',
      'margin',
      'powers',
      'gets',
      'playoff',
    ];
    expect(advancementBasisStatus(state, 'phase-1')).toBe('stale');
  });

  test('a future-defaults scoring edit does not invalidate the basis', () => {
    const state = committedState();
    state.tournament!.rules.tossupValue = 99;
    expect(advancementBasisStatus(state, 'phase-1')).toBe('current');
  });

  test('a commit that predates basis tracking reads as unknown, never current', () => {
    const state = committedState();
    const details = latestAdvancementCommit(state, 'phase-1')!.details as Record<string, unknown>;
    delete details.basisToken;
    expect(advancementBasisStatus(state, 'phase-1')).toBe('unknown');
  });

  test('a phase with no commit is uncommitted', () => {
    const state = tournamentState();
    expect(advancementBasisStatus(state, 'phase-1')).toBe('uncommitted');
    expect(advancementBasisStatus(state, 'no-such-phase')).toBe('uncommitted');
  });

  test('records without revision tracking read as revision 1', () => {
    const state = committedState();
    expect(resultRevisionOf(state.games[0]!)).toBe(1);
    expect(resultRevisionsForPhase(state, state.phases[0]!)).toEqual({ 'game-1': 1 });
  });

  test('a commit names the result revisions it verified against', () => {
    const state = committedState();
    const details = latestAdvancementCommit(state, 'phase-1')!.details as Record<string, unknown>;
    details.resultRevisions = resultRevisionsForPhase(state, state.phases[0]!);
    expect(advancementBasisStatus(state, 'phase-1')).toBe('current');
  });

  test('a revision newer than the recorded map reads as stale', () => {
    const state = committedState();
    const details = latestAdvancementCommit(state, 'phase-1')!.details as Record<string, unknown>;
    // The token was re-verified after the correction, but the commit saw revision 1.
    state.games[0]!.resultRevision = 2;
    details.basisToken = advancementBasisToken(state, state.phases[0]!);
    details.resultRevisions = { 'game-1': 1 };
    expect(advancementBasisStatus(state, 'phase-1')).toBe('stale');
  });

  test('a malformed revision map reads as unknown, never current', () => {
    const state = committedState();
    const details = latestAdvancementCommit(state, 'phase-1')!.details as Record<string, unknown>;
    details.resultRevisions = 'revision-1';
    expect(advancementBasisStatus(state, 'phase-1')).toBe('unknown');
  });
});

describe('advancement basis team scope (#727)', () => {
  function pooledCommit() {
    const state = committedState();
    state.pools.push({
      id: 'pool-1',
      phaseId: 'phase-1',
      name: 'Pool 1',
      teamIds: ['team-a', 'team-b'],
      order: 1,
    });
    state.phases[0]!.poolIds = ['pool-1'];
    // Re-stamp the commit under the pool-scoped field.
    const phase = state.phases[0]!;
    const details = latestAdvancementCommit(state, 'phase-1')!.details as Record<string, unknown>;
    details.basisToken = advancementBasisToken(state, phase);
    expect(advancementBasisStatus(state, 'phase-1')).toBe('current');
    return state;
  }

  test('an unrelated confirmed team does not invalidate the basis', () => {
    const state = pooledCommit();
    const qualifiersBefore = previewAdvancement(state, state.phases[0]!).qualifiers.map((team) => team.id);
    state.teams.push(team('team-c', 'Cedar Rapids'));
    expect(advancementBasisTeams(state, state.phases[0]!).map((entry) => entry.id)).toEqual([
      'team-a',
      'team-b',
    ]);
    expect(advancementBasisStatus(state, 'phase-1')).toBe('current');
    expect(previewAdvancement(state, state.phases[0]!).qualifiers.map((team) => team.id)).toEqual(
      qualifiersBefore,
    );
  });

  test('an eligibility change inside the field invalidates the basis', () => {
    const state = pooledCommit();
    state.teams.find((entry) => entry.id === 'team-b')!.status = 'dropped';
    expect(advancementBasisStatus(state, 'phase-1')).toBe('stale');
  });

  test('a pool membership change invalidates the basis', () => {
    const state = pooledCommit();
    state.teams.push(team('team-c', 'Cedar Rapids'));
    state.pools.find((entry) => entry.id === 'pool-1')!.teamIds.push('team-c');
    expect(advancementBasisStatus(state, 'phase-1')).toBe('stale');
  });

  test('a legacy global-teams token still verifies without mass-invalidation', () => {
    const state = pooledCommit();
    const phase = state.phases[0]!;
    const details = latestAdvancementCommit(state, 'phase-1')!.details as Record<string, unknown>;
    details.basisToken = advancementBasisTokenV1(state, phase);
    // Untouched since the upgrade: verifies under the semantics it committed with.
    expect(advancementBasisStatus(state, 'phase-1')).toBe('current');
    // Under legacy semantics an unrelated team still moves the basis.
    state.teams.push(team('team-c', 'Cedar Rapids'));
    expect(advancementBasisStatus(state, 'phase-1')).toBe('stale');
  });
});
