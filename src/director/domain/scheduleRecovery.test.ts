import { describe, expect, test } from 'vitest';
import { planTeamRestore } from './scheduleRecovery';
import { scheduledGame, team, tournamentState } from '../../../tests/directorFixtures';

function stateWithCancelledGames() {
  const state = tournamentState();
  state.teams.push(team('team-a', 'Alpha'), team('team-b', 'Beta'));
  state.teams[0]!.status = 'dropped';
  state.rounds[0]!.status = 'planned';
  state.rounds[0]!.scheduledGameIds = ['drop-game', 'manual-game', 'closed-game'];
  state.scheduledGames.push(
    scheduledGame('drop-game', 'team-a', 'team-b', {
      status: 'cancelled',
      cancellation: {
        reasonKind: 'team-dropped',
        teamId: 'team-a',
        reason: 'No-show',
        at: '2026-09-05T12:00:00.000Z',
      },
    }),
    scheduledGame('manual-game', 'team-a', 'team-b', {
      status: 'cancelled',
      cancellation: {
        reasonKind: 'manual',
        reason: 'Packet damaged',
        at: '2026-09-05T12:00:00.000Z',
      },
    }),
    scheduledGame('closed-game', 'team-a', 'team-b', {
      roundId: 'closed-round',
      status: 'cancelled',
      cancellation: {
        reasonKind: 'team-dropped',
        teamId: 'team-a',
        reason: 'No-show',
        at: '2026-09-05T12:00:00.000Z',
      },
    }),
  );
  state.rounds.push({
    ...state.rounds[0]!,
    id: 'closed-round',
    name: 'Closed round',
    status: 'closed',
    scheduledGameIds: ['closed-game'],
  });
  return state;
}

describe('planTeamRestore', () => {
  test('selects only attributable future cancellations and is idempotent after repair', () => {
    const state = stateWithCancelledGames();
    const plan = planTeamRestore(state, 'team-a');
    expect(plan.dropCancelledGameIds).toEqual(['drop-game', 'closed-game']);
    expect(plan.safeGameIds).toEqual(['drop-game']);
    expect(plan.review).toEqual([
      { scheduledGameId: 'closed-game', roundId: 'closed-round', reason: 'The round is already closed.' },
    ]);

    state.scheduledGames[0]!.status = 'scheduled';
    delete state.scheduledGames[0]!.cancellation;
    expect(planTeamRestore(state, 'team-a').dropCancelledGameIds).toEqual(['closed-game']);
    expect(state.scheduledGames[1]!.status).toBe('cancelled');
  });

  test('requires review when a released game has scorer work even though its row is cancelled', () => {
    const state = stateWithCancelledGames();
    state.rounds[0]!.status = 'released';
    state.scheduledGames[0]!.roomId = 'room-1';
    state.qbtcpSessions.push({
      roomId: 'room-1',
      sessionId: 'session-1',
      matchId: 'drop-game',
      deviceId: 'device-1',
      state: 'live',
      lastSeenAt: '2026-09-05T12:00:00.000Z',
      helpRequestId: null,
      progress: null,
    });
    expect(planTeamRestore(state, 'team-a').review[0]?.reason).toBe(
      'The scorer still has unresolved QBTCP work.',
    );
  });
});
