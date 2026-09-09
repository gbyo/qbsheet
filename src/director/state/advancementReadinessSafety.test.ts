import { describe, expect, test } from 'vitest';
import { emptyDirectorState, type DirectorState } from '../domain';
import { advancementCommitBlocker } from './tournamentSafety';

type Pairing = [string, string];

function readinessState(
  kind: DirectorState['formats'][number]['kind'],
  roundsPerTeam: number | null,
  teamCount: number,
): DirectorState {
  const state = emptyDirectorState();
  const teamIds = Array.from({ length: teamCount }, (_, index) => `team-${index + 1}`);
  state.teams = teamIds.map(
    (id, index) =>
      ({ id, displayName: `Team ${index + 1}`, status: 'confirmed' }) as DirectorState['teams'][number],
  );
  state.formats.push({
    id: 'format-1',
    name: kind,
    kind,
    phaseIds: ['phase-1'],
    roundsPerTeam,
  } as DirectorState['formats'][number]);
  state.phases.push({
    id: 'phase-1',
    name: 'Preliminaries',
    kind: 'preliminary',
    order: 0,
    formatId: 'format-1',
    teamIds,
    poolIds: [],
    roundIds: [],
    advancementRule: null,
    carryover: false,
    status: 'active',
  });
  return state;
}

function addClosedRound(
  state: DirectorState,
  pairings: Pairing[],
  status: 'closed' | 'released' = 'closed',
): void {
  const roundId = `round-${state.rounds.length + 1}`;
  const scheduledGameIds: string[] = [];
  state.phases[0]!.roundIds.push(roundId);
  state.rounds.push({
    id: roundId,
    phaseId: 'phase-1',
    name: `Round ${state.rounds.length + 1}`,
    number: state.rounds.length + 1,
    revision: 1,
    status,
    packetId: null,
    scheduledGameIds,
    scheduledStart: null,
    releasedAt: status === 'released' ? '2026-09-09T12:00:00.000Z' : null,
    startedAt: null,
    closedAt: status === 'closed' ? '2026-09-09T13:00:00.000Z' : null,
  });
  for (const [leftTeamId, rightTeamId] of pairings) {
    const scheduledGameId = `scheduled-${state.scheduledGames.length + 1}`;
    const gameId = `game-${state.games.length + 1}`;
    scheduledGameIds.push(scheduledGameId);
    state.scheduledGames.push({
      id: scheduledGameId,
      roundId,
      roomId: null,
      packetId: null,
      leftTeamId,
      rightTeamId,
      bye: false,
      status: status === 'closed' ? 'accepted' : 'released',
      assignmentRevision: 1,
    });
    state.games.push({
      id: gameId,
      scheduledGameId,
      roundId,
      packetId: null,
      status: 'accepted',
      scores: [
        {
          teamId: leftTeamId,
          score: 100,
          superpowers: 0,
          powers: 0,
          gets: 0,
          negs: 0,
          bonuses: 0,
          bonusPoints: 0,
          bouncebacks: 0,
        },
        {
          teamId: rightTeamId,
          score: 90,
          superpowers: 0,
          powers: 0,
          gets: 0,
          negs: 0,
          bonuses: 0,
          bonusPoints: 0,
          bouncebacks: 0,
        },
      ],
      playerStats: [],
      source: 'manual',
      acceptedAt: '2026-09-09T13:00:00.000Z',
    });
  }
}

describe('advancement readiness safety', () => {
  test('blocks a six-round Swiss phase after only three closed rounds', () => {
    const state = readinessState('swiss', 6, 6);
    for (let round = 0; round < 3; round += 1) {
      addClosedRound(state, [
        [`team-${(round % 3) + 1}`, `team-${(round % 3) + 4}`],
        [`team-${((round + 1) % 3) + 1}`, `team-${((round + 1) % 3) + 4}`],
        [`team-${((round + 2) % 3) + 1}`, `team-${((round + 2) % 3) + 4}`],
      ]);
    }
    state.phases[0]!.status = 'complete';
    expect(advancementCommitBlocker(state, 'phase-1')).toMatch(/requires 6 rounds/i);
  });

  test('allows a Swiss phase at its configured final round', () => {
    const state = readinessState('swiss', 6, 6);
    for (let round = 0; round < 6; round += 1) {
      addClosedRound(state, [[`team-${(round % 3) + 1}`, `team-${((round + 1) % 3) + 4}`]]);
    }
    expect(advancementCommitBlocker(state, 'phase-1')).toBeNull();
  });

  test('blocks round-robin advancement before every required pairing is played', () => {
    const state = readinessState('round-robin', null, 4);
    addClosedRound(state, [
      ['team-1', 'team-2'],
      ['team-3', 'team-4'],
    ]);
    addClosedRound(state, [
      ['team-1', 'team-3'],
      ['team-2', 'team-4'],
    ]);
    expect(advancementCommitBlocker(state, 'phase-1')).toContain('Finish Preliminaries');
  });

  test('allows round-robin advancement at valid exhaustion', () => {
    const state = readinessState('round-robin', null, 4);
    addClosedRound(state, [
      ['team-1', 'team-2'],
      ['team-3', 'team-4'],
    ]);
    addClosedRound(state, [
      ['team-1', 'team-3'],
      ['team-2', 'team-4'],
    ]);
    addClosedRound(state, [
      ['team-1', 'team-4'],
      ['team-2', 'team-3'],
    ]);
    expect(advancementCommitBlocker(state, 'phase-1')).toBeNull();
  });

  test.each([true, false])('allows only a complete single-elimination bracket (complete=%s)', (complete) => {
    const state = readinessState('single-elimination', null, 2);
    state.tournament = { formatId: 'format-1' } as DirectorState['tournament'];
    state.formats[0]!.bracket = {
      phaseId: 'phase-1',
      teamCount: 2,
      bracketSize: 2,
      roundCount: 1,
      seeding: [
        { seed: 1, teamId: 'team-1' },
        { seed: 2, teamId: 'team-2' },
      ],
      nodes: [
        {
          key: 'A',
          roundIndex: 0,
          sequence: 0,
          label: 'Final',
          kind: 'elimination',
          slotA: { kind: 'seed', seed: 1 },
          slotB: { kind: 'seed', seed: 2 },
        },
      ],
      byes: [],
      roundNumbers: [1],
      roundIds: { A: 'round-1' },
    };
    addClosedRound(state, [['team-1', 'team-2']]);
    state.scheduledGames[0]!.bracketKey = 'A';
    if (!complete) {
      state.games[0]!.scores[0]!.score = 100;
      state.games[0]!.scores[1]!.score = 100;
    }
    const blocker = advancementCommitBlocker(state, 'phase-1');
    if (complete) expect(blocker).toBeNull();
    else expect(blocker).toEqual(expect.any(String));
  });

  test('keeps unresolved scheduled games blocked even under a falsely closed round', () => {
    const state = readinessState('swiss', 1, 2);
    addClosedRound(state, [['team-1', 'team-2']], 'released');
    state.rounds[0]!.status = 'closed';
    expect(advancementCommitBlocker(state, 'phase-1')).toMatch(/unresolved|Finish Preliminaries/i);
  });

  test('keeps missing phase structure and pool membership blocked', () => {
    const missingRound = readinessState('swiss', 1, 2);
    missingRound.phases[0]!.roundIds = ['missing-round'];
    expect(advancementCommitBlocker(missingRound, 'phase-1')).toContain('Finish Preliminaries');

    const missingPool = readinessState('pools', 1, 2);
    missingPool.phases[0]!.poolIds = ['missing-pool'];
    addClosedRound(missingPool, [['team-1', 'team-2']]);
    expect(advancementCommitBlocker(missingPool, 'phase-1')).toContain('missing');
  });
});
