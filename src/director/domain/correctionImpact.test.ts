import { describe, expect, test } from 'vitest';
import {
  acceptedGame,
  player,
  scheduledGame,
  score,
  team,
  tournamentState,
} from '../../../tests/directorFixtures';
import { advancementBasisToken } from './advancement';
import { planResultCorrectionImpact } from './correctionImpact';

function advancementCommitted() {
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
  state.games.push(acceptedGame('game-1', 'scheduled-1', [score('team-a', 100), score('team-b', 90)]));
  state.audit.push({
    id: 'audit-commit-1',
    at: '2026-09-10T00:00:00.000Z',
    actor: 'Director',
    type: 'advancement-committed',
    summary: 'Moved 1 team.',
    entityId: 'phase-2',
    details: {
      sourcePhaseId: 'phase-1',
      basisToken: advancementBasisToken(state, state.phases[0]!),
      qualifierTeamIds: ['team-a'],
      assignments: [{ teamId: 'team-a', targetPoolId: 'pool-2' }],
    },
  });
  return state;
}

function singleElimination() {
  const state = tournamentState();
  state.teams.push(
    team('team-a', 'Alpha'),
    team('team-b', 'Beta'),
    team('team-c', 'Gamma'),
    team('team-d', 'Delta'),
  );
  state.formats.push({
    id: 'format-1',
    name: 'Elimination',
    kind: 'single-elimination',
    phaseIds: ['phase-1'],
    roundsPerTeam: null,
    avoidRematches: false,
    avoidSameOrganization: false,
    allowByes: false,
    editable: false,
    bracket: {
      teamCount: 4,
      bracketSize: 4,
      roundCount: 2,
      seeding: [
        { seed: 1, teamId: 'team-a' },
        { seed: 2, teamId: 'team-c' },
        { seed: 3, teamId: 'team-d' },
        { seed: 4, teamId: 'team-b' },
      ],
      nodes: [
        {
          key: 'A',
          roundIndex: 0,
          sequence: 0,
          label: 'Semifinal',
          kind: 'elimination',
          slotA: { kind: 'seed', seed: 1 },
          slotB: { kind: 'seed', seed: 4 },
        },
        {
          key: 'B',
          roundIndex: 0,
          sequence: 1,
          label: 'Semifinal',
          kind: 'elimination',
          slotA: { kind: 'seed', seed: 2 },
          slotB: { kind: 'seed', seed: 3 },
        },
        {
          key: 'C',
          roundIndex: 1,
          sequence: 0,
          label: 'Final',
          kind: 'elimination',
          slotA: { kind: 'winner', gameKey: 'A' },
          slotB: { kind: 'winner', gameKey: 'B' },
        },
      ],
      byes: [],
      roundNumbers: [1, 2],
      roundIds: {},
    },
  });
  state.scheduledGames.push(
    scheduledGame('semi-1', 'team-a', 'team-b', { bracketKey: 'A' }),
    scheduledGame('semi-2', 'team-c', 'team-d', { bracketKey: 'B' }),
    scheduledGame('final-game', 'team-a', 'team-c', { status: 'scheduled', bracketKey: 'C' }),
  );
  state.games.push(
    acceptedGame('game-semi-1', 'semi-1', [score('team-a', 100), score('team-b', 90)]),
    acceptedGame('game-semi-2', 'semi-2', [score('team-c', 110), score('team-d', 80)]),
  );
  return state;
}

describe('correction impact planner (#673)', () => {
  test('a flipped winner invalidates committed advancement with qualifier changes', () => {
    const state = advancementCommitted();
    const impact = planResultCorrectionImpact(state, 'game-1', [score('team-a', 80), score('team-b', 120)]);

    expect(impact.empty).toBe(false);
    expect(impact.winnerChanged).toBe(true);
    expect(impact.staleAdvancement).toEqual([
      { phaseId: 'phase-1', phaseName: 'Preliminary', qualifiersChange: true },
    ]);
    expect(impact.bracketUpdates).toEqual([]);
    expect(impact.issue).toBeUndefined();
  });

  test('a same-winner score change still stales the basis without moving qualifiers', () => {
    const state = advancementCommitted();
    const impact = planResultCorrectionImpact(state, 'game-1', [score('team-a', 150), score('team-b', 90)]);

    expect(impact.winnerChanged).toBe(false);
    expect(impact.staleAdvancement).toEqual([
      { phaseId: 'phase-1', phaseName: 'Preliminary', qualifiersChange: false },
    ]);
  });

  test('no committed advancement means no advancement impact', () => {
    const state = advancementCommitted();
    state.audit = [];
    const impact = planResultCorrectionImpact(state, 'game-1', [score('team-a', 80), score('team-b', 120)]);

    expect(impact.staleAdvancement).toEqual([]);
  });

  test('a flipped semifinal previews the final re-seed', () => {
    const state = singleElimination();
    const impact = planResultCorrectionImpact(state, 'game-semi-1', [
      score('team-a', 70),
      score('team-b', 130),
    ]);

    expect(impact.issue).toBeUndefined();
    expect(impact.bracketUpdates).toEqual([
      { scheduledGameId: 'final-game', leftTeamId: 'team-b', rightTeamId: 'team-c' },
    ]);
  });

  test('a released dependent bracket game blocks the preview with its issue', () => {
    const state = singleElimination();
    state.scheduledGames.find((game) => game.id === 'final-game')!.status = 'released';
    const impact = planResultCorrectionImpact(state, 'game-semi-1', [
      score('team-a', 70),
      score('team-b', 130),
    ]);

    expect(impact.bracketUpdates).toEqual([]);
    expect(impact.issue).toMatch(/already been released or has a result/);
  });

  test('a same-winner bracket correction previews no updates', () => {
    const state = singleElimination();
    const impact = planResultCorrectionImpact(state, 'game-semi-1', [
      score('team-a', 150),
      score('team-b', 90),
    ]);

    expect(impact.issue).toBeUndefined();
    expect(impact.bracketUpdates).toEqual([]);
  });

  test('unknown or unaccepted games plan empty', () => {
    const state = advancementCommitted();
    expect(planResultCorrectionImpact(state, 'no-such-game', []).empty).toBe(true);
    state.games[0]!.status = 'live';
    expect(planResultCorrectionImpact(state, 'game-1', []).empty).toBe(true);
  });
});
