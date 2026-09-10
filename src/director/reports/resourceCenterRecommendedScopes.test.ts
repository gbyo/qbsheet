/**
 * The HSQuizbowl Recommended preset must remain safe while later phases are
 * configured ahead of time. Empty future stages stay available for explicit
 * selection, but they cannot poison the normal after-each-round export.
 */
import { expect, test } from 'vitest';
import type { DirectorState, Phase } from '../domain';
import { acceptedGame, playedTournament, scheduledGame, score } from '../../../tests/directorFixtures';
import {
  buildCanonicalResourceCenterScopeArtifact,
  buildCanonicalResourceCenterScopeSets,
  resourceCenterRecommendedScopeKeys,
  resourceCenterScopes,
} from './resourceCenterScopes';

const generatedAt = '2026-09-10T19:00:00.000Z';

function addPhase(state: DirectorState, id: string, name: string, order: number): Phase {
  const roundId = `round-${order}`;
  const phase: Phase = {
    id,
    name,
    kind: 'playoff',
    order,
    formatId: 'format-1',
    poolIds: [],
    roundIds: [roundId],
    advancementRule: null,
    carryover: false,
    status: 'active',
  };
  state.phases.push(phase);
  state.rounds.push({
    id: roundId,
    phaseId: id,
    name: `Round ${order}`,
    number: order,
    revision: 1,
    status: 'planned',
    packetId: null,
    scheduledGameIds: [],
    scheduledStart: null,
    releasedAt: null,
    startedAt: null,
    closedAt: null,
  });
  return phase;
}

function acceptGameInPhase(state: DirectorState, phase: Phase, suffix: string): void {
  const roundId = phase.roundIds[0]!;
  const scheduledId = `scheduled-${suffix}`;
  state.scheduledGames.push(scheduledGame(scheduledId, 'team-a', 'team-b', { roundId }));
  const game = acceptedGame(`game-${suffix}`, scheduledId, [score('team-a', 280), score('team-b', 240)]);
  game.roundId = roundId;
  state.games.push(game);
  state.rounds.find((round) => round.id === roundId)!.scheduledGameIds.push(scheduledId);
}

test('Recommended skips empty future phases', () => {
  const state = playedTournament();
  state.phases[0]!.name = 'Prelims';
  const playoffs = addPhase(state, 'phase-2', 'Playoffs', 2);

  expect(resourceCenterScopes(state).map(({ key, gameCount }) => [key, gameCount])).toEqual([
    ['phase:phase-1', 1],
    ['phase:phase-2', 0],
    ['combined', 1],
  ]);
  expect(resourceCenterRecommendedScopeKeys(state)).toEqual(['phase:phase-1', 'combined']);

  const packageBeforePlayoffs = buildCanonicalResourceCenterScopeSets(
    state,
    resourceCenterRecommendedScopeKeys(state),
    generatedAt,
  );
  expect(packageBeforePlayoffs.errors).toEqual([]);
  expect(packageBeforePlayoffs.sets.map((set) => set.scopeKey)).toEqual(['phase:phase-1', 'combined']);

  // Empty scopes are still real scopes. If the director explicitly chooses
  // one, the existing no-data preflight remains the safety net.
  const explicitlyEmpty = buildCanonicalResourceCenterScopeArtifact(state, 'phase:phase-2', generatedAt);
  expect(explicitlyEmpty.blocking.map((entry) => entry.code)).toContain('no-accepted-games');

  acceptGameInPhase(state, playoffs, 'playoff');
  expect(resourceCenterRecommendedScopeKeys(state)).toEqual(['phase:phase-1', 'phase:phase-2', 'combined']);
});

test('several future phases do not block the recommended package', () => {
  const state = playedTournament();
  state.phases[0]!.name = 'Prelims';
  addPhase(state, 'phase-2', 'Playoffs', 2);
  addPhase(state, 'phase-3', 'Finals', 3);

  expect(resourceCenterRecommendedScopeKeys(state)).toEqual(['phase:phase-1', 'combined']);
  const report = buildCanonicalResourceCenterScopeSets(
    state,
    resourceCenterRecommendedScopeKeys(state),
    generatedAt,
  );
  expect(report.errors).toEqual([]);
  expect(report.totalSets).toBe(2);
  expect(report.sets.find((set) => set.scopeKey === 'combined')!.gameCount).toBe(1);
});

test('an entirely empty tournament keeps Combined selected for preflight', () => {
  const state = playedTournament();
  state.games = [];
  state.phases[0]!.name = 'Prelims';
  addPhase(state, 'phase-2', 'Playoffs', 2);

  expect(resourceCenterRecommendedScopeKeys(state)).toEqual(['combined']);
  const combined = buildCanonicalResourceCenterScopeArtifact(state, 'combined', generatedAt);
  expect(combined.blocking.map((entry) => entry.code)).toContain('no-accepted-games');
});
