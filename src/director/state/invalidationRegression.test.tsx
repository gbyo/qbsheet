import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import {
  advancementBasisStatus,
  advancementBasisToken,
  deriveTeamStandings,
  acceptedGameRecords,
  type DirectorState,
} from '../domain';
import { MemoryDirectorRepository } from '../persistence';
import { acceptedGame, scheduledGame, score, team, tournamentState } from '../../../tests/directorFixtures';
import { useDirectorController } from './useDirectorController';

async function controllerFor(state: DirectorState) {
  const repository = new MemoryDirectorRepository();
  await repository.save(state);
  const hook = renderHook(() => useDirectorController(repository));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return { hook, repository };
}

function forfeitState(): DirectorState {
  const at = '2026-09-05T12:00:00.000Z';
  const state = tournamentState();
  state.teams.push(team('team-a', 'Alpha'), team('team-b', 'Beta'));
  state.rounds[0]!.scheduledGameIds = ['scheduled-1'];
  state.scheduledGames.push(scheduledGame('scheduled-1', 'team-a', 'team-b', { status: 'accepted' }));
  state.games.push({
    id: 'forfeit-game',
    scheduledGameId: 'scheduled-1',
    roundId: 'round-1',
    packetId: null,
    status: 'forfeit',
    forfeitedTeamId: 'team-a',
    scores: [score('team-a', 0), score('team-b', 0)],
    playerStats: [],
    source: 'manual',
    detailedStats: 'unknown',
    acceptedAt: at,
  });
  state.submissions.push({
    id: 'forfeit-submission',
    gameId: 'forfeit-game',
    receivedAt: at,
    fingerprint: 'forfeit-fingerprint',
    status: 'accepted',
    rawSubmission: { source: 'manual', outcome: 'forfeit', forfeitedTeamId: 'team-a' },
    acceptedBy: 'Director',
    acceptedAt: at,
  });
  return state;
}

/** Stamp a verifying advancement commit so later mutations must retire it explicitly. */
function stampCommit(state: DirectorState): DirectorState {
  state.phases.push({
    id: 'playoffs',
    name: 'Playoffs',
    roundIds: [],
  } as unknown as DirectorState['phases'][number]);
  const phase = state.phases.find((entry) => entry.id === 'phase-1')!;
  state.audit.push({
    id: 'advancement-audit',
    at: '2026-09-05T12:01:00.000Z',
    actor: 'Director',
    type: 'advancement-committed',
    entityId: 'playoffs',
    summary: 'Committed advancement.',
    details: {
      sourcePhaseId: 'phase-1',
      basisToken: advancementBasisToken(state, phase),
      qualifierTeamIds: ['team-a'],
    },
  });
  expect(advancementBasisStatus(state, 'phase-1')).toBe('current');
  return state;
}

function reversedTiebreakers(state: DirectorState) {
  return [...state.tournament!.rules.tiebreakers].reverse();
}

describe('dependency invalidation (#673)', () => {
  test('a tiebreaker edit before advancement recomputes standings without retiring any basis', async () => {
    const state = tournamentState();
    state.teams.push(team('team-a', 'Ninety Six'), team('team-b', 'Greenwood'));
    state.scheduledGames.push(scheduledGame('scheduled-1', 'team-a', 'team-b'));
    state.games.push(acceptedGame('game-1', 'scheduled-1', [score('team-a', 300), score('team-b', 210)]));
    const { hook } = await controllerFor(state);

    act(() => {
      expect(hook.result.current.updateTiebreakers(reversedTiebreakers(hook.result.current.state))).toBe(
        true,
      );
    });
    await waitFor(() => expect(hook.result.current.saving).toBe(false));

    const next = hook.result.current.state;
    expect(deriveTeamStandings(next, acceptedGameRecords(next))[0]?.teamId).toBe('team-a');
    expect(next.audit.some((entry) => entry.type === 'advancement-stale')).toBe(false);
  });

  test('a tiebreaker edit after advancement retires the dependent basis, not the scorer definitions', async () => {
    const { hook } = await controllerFor(stampCommit(forfeitState()));

    act(() => {
      expect(hook.result.current.updateTiebreakers(reversedTiebreakers(hook.result.current.state))).toBe(
        true,
      );
    });
    await waitFor(() => expect(hook.result.current.saving).toBe(false));

    const next = hook.result.current.state;
    expect(advancementBasisStatus(next, 'phase-1')).toBe('stale');
    expect(next.audit.find((entry) => entry.type === 'advancement-stale')?.details).toMatchObject({
      sourcePhaseId: 'phase-1',
      cause: 'tiebreaker-change',
    });
  });

  test('restoring a team retires the dependent basis instead of silently changing the field', async () => {
    const state = forfeitState();
    state.teams.find((entry) => entry.id === 'team-b')!.status = 'dropped';
    const { hook } = await controllerFor(stampCommit(state));
    expect(advancementBasisStatus(hook.result.current.state, 'phase-1')).toBe('current');

    act(() => {
      expect(hook.result.current.restoreTeam('team-b')).toBe(true);
    });
    await waitFor(() => expect(hook.result.current.saving).toBe(false));

    const next = hook.result.current.state;
    expect(next.teams.find((entry) => entry.id === 'team-b')?.status).toBe('confirmed');
    expect(advancementBasisStatus(next, 'phase-1')).toBe('stale');
    expect(next.audit.find((entry) => entry.type === 'advancement-stale')?.details).toMatchObject({
      sourcePhaseId: 'phase-1',
      cause: 'team-restored',
    });
  });

  test('checkpoint restore rotates newer authority and audits the reconciliation', async () => {
    const at = '2026-09-05T12:00:00.000Z';
    const state = forfeitState();
    state.qbtcpSessions.push({
      roomId: 'room-1',
      sessionId: 'session-old',
      deviceId: 'device-1',
      state: 'assigned',
      lastSeenAt: at,
      progress: null,
      helpRequestId: null,
    });
    const { hook } = await controllerFor(state);

    await act(async () => {
      await hook.result.current.checkpoint('Before the afternoon games');
    });
    const point = hook.result.current.checkpoints.at(-1);
    expect(point?.id).toBeTruthy();

    const newer = structuredClone(hook.result.current.state);
    newer.qbtcpSessions.push({
      roomId: 'room-2',
      sessionId: 'session-new',
      matchId: 'scheduled-1',
      deviceId: 'device-2',
      state: 'assigned',
      lastSeenAt: at,
      progress: null,
      helpRequestId: null,
    });
    newer.scheduledGames.push(scheduledGame('scheduled-2', 'team-a', 'team-b', { status: 'accepted' }));
    newer.games.push(acceptedGame('game-new', 'scheduled-2', [score('team-a', 100), score('team-b', 90)]));
    newer.transfers = {
      version: 1,
      locations: [],
      assignments: [
        {
          id: 'assign-new',
          scheduledGameId: 'scheduled-1',
          roundRevision: 1,
          assignmentRevision: 1,
          artifactDigest: 'digest-new',
          transportKind: 'removable-drive',
          destinationLabel: 'USB stick',
          createdAt: at,
          status: 'written',
        },
      ],
      artifacts: [],
      events: [],
    };
    await act(async () => {
      expect(await hook.result.current.editTournamentSnapshot(newer, 'Inject newer authority')).toBe(true);
    });

    await act(async () => {
      expect(await hook.result.current.restoreCheckpoint(point!.id)).toBe(true);
    });

    const next = hook.result.current.state;
    // The checkpoint-era session cannot look current against the restored document.
    expect(next.qbtcpSessions.find((session) => session.sessionId === 'session-old')).toMatchObject({
      state: 'abandoned',
      resumable: false,
    });
    // Newer authority is gone from the document but named in the audit trail.
    expect(next.games.some((game) => game.id === 'game-new')).toBe(false);
    expect(next.qbtcpSessions.some((session) => session.sessionId === 'session-new')).toBe(false);
    const restored = next.audit.find((entry) => entry.type === 'checkpoint-restored');
    expect(restored?.details).toMatchObject({
      checkpointId: point!.id,
      abandonedSessionIds: ['session-old'],
      invalidatedSessionIds: ['session-new'],
      supersededResultIds: ['game-new'],
      invalidatedAssignmentIds: ['assign-new'],
    });
  });
});
