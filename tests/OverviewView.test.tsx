import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { defaultRules, emptyDirectorState, type DirectorState } from '../src/director/domain';
import { OverviewView } from '../src/director/overview/OverviewView';
import type { DirectorController } from '../src/director/state/useDirectorController';

const controller = {
  prepareRound: vi.fn(() => true),
  releaseRound: vi.fn(() => true),
  closeRound: vi.fn(() => true),
  startRound: vi.fn(async () => ({ ok: true, summary: 'Round 1 started.' })),
  finishRound: vi.fn(() => ({ finished: true, summary: 'Round 1 finished.' })),
  error: null,
  saving: false,
  repositoryKind: 'indexeddb',
} as unknown as DirectorController;

function renderOverview(state: DirectorState, onAnnounce = vi.fn()) {
  const onNavigate = vi.fn();
  render(
    <OverviewView
      state={state}
      controller={controller}
      onNavigate={onNavigate}
      onAnnounce={onAnnounce}
      nativeServerReady={false}
      nativeServerAvailable={false}
    />,
  );
  return { onNavigate, onAnnounce };
}

function tournamentState(): DirectorState {
  const state = emptyDirectorState();
  state.tournament = {
    id: 'tournament-overview',
    name: 'Saturday Event',
    date: '2026-09-05',
    venue: 'Main hall',
    organizer: 'Director',
    status: 'running',
    timeZone: 'America/New_York',
    rules: structuredClone(defaultRules),
    formatId: null,
    currentPhaseId: null,
    currentPacketId: null,
    currentRoundId: null,
    createdAt: '2026-09-05T10:00:00.000Z',
    updatedAt: '2026-09-05T10:00:00.000Z',
  };
  return state;
}

function confirmedTeam(id: string, displayName: string): DirectorState['teams'][number] {
  return {
    id,
    organizationId: null,
    displayName,
    teamLetter: '',
    seed: null,
    status: 'confirmed',
    createdAt: '2026-09-05T10:00:00.000Z',
    updatedAt: '2026-09-05T10:00:00.000Z',
  };
}

describe('OverviewView attention-first layout', () => {
  test('no tournament shows first-step guidance, not subsystem cards', () => {
    const { onNavigate } = renderOverview(emptyDirectorState());

    expect(screen.getByText('Build the tournament plan')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add teams' }));
    expect(onNavigate).toHaveBeenCalledWith('teams');

    expect(screen.getByText('Needs attention')).toBeTruthy();
    expect(screen.getByText('Create or open a tournament first.')).toBeTruthy();

    expect(screen.queryByText('Saved locally')).toBeNull();
    expect(screen.queryByText('Rooms now')).toBeNull();
    expect(screen.queryByText('Recent activity')).toBeNull();
    expect(screen.queryByText('Audit history')).toBeNull();
  });

  test('attention list surfaces blockers, review, protests, and help requests', () => {
    const state = tournamentState();
    state.rooms = [
      {
        id: 'room-203',
        name: 'Room 203',
        status: 'available',
        moderatorId: null,
        scorekeeperId: null,
        equipmentId: null,
        available: true,
      },
    ];
    state.submissions = [
      {
        id: 'submission-1',
        gameId: 'game-1',
        receivedAt: '2026-09-05T11:00:00.000Z',
        fingerprint: 'fingerprint-1',
        status: 'review',
        rawSubmission: null,
      },
    ];
    state.protests = [
      {
        id: 'protest-1',
        gameId: 'game-1',
        category: 'tossup',
        description: 'Answer ruling challenged.',
        status: 'open',
        createdAt: '2026-09-05T11:01:00.000Z',
        updatedAt: '2026-09-05T11:01:00.000Z',
      },
    ];
    state.qbtcpSessions = [
      {
        roomId: 'room-203',
        sessionId: 'session-1',
        matchId: 'match-1',
        deviceId: 'device-1',
        operatorName: 'Scorekeeper',
        state: 'live',
        resumable: true,
        resultReceived: false,
        progressSequence: 3,
        lastSeenAt: '2026-09-05T11:02:00.000Z',
        progress: null,
        helpRequestId: 'help-1',
      },
    ];
    const { onNavigate } = renderOverview(state);

    expect(screen.getByText('Add at least two confirmed teams.')).toBeTruthy();
    expect(screen.getByText('1 result needs a decision.')).toBeTruthy();
    expect(screen.getByText('1 open protest.')).toBeTruthy();
    expect(screen.getByText('Room 203 requested help.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '1 result needs a decision.' }));
    expect(onNavigate).toHaveBeenCalledWith('results');
    fireEvent.click(screen.getByRole('button', { name: 'Room 203 requested help.' }));
    expect(onNavigate).toHaveBeenCalledWith('rooms');
  });

  test('round banner reports progress with standings as secondary content', () => {
    const state = tournamentState();
    state.teams = [confirmedTeam('team-1', 'Wren A'), confirmedTeam('team-2', 'Dorman')];
    state.tournament!.currentRoundId = 'round-1';
    state.rounds = [
      {
        id: 'round-1',
        phaseId: 'phase-1',
        name: 'Round 1',
        number: 1,
        revision: 1,
        status: 'released',
        packetId: null,
        scheduledGameIds: ['game-1', 'game-2', 'game-3', 'game-4', 'game-5'],
        scheduledStart: null,
        releasedAt: null,
        startedAt: null,
        closedAt: null,
        dayOrder: 0,
      },
    ];
    state.scheduledGames = ['game-1', 'game-2', 'game-3', 'game-4'].map((id) => ({
      id,
      roundId: 'round-1',
      poolId: null,
      roomId: null,
      packetId: null,
      leftTeamId: 'team-1',
      rightTeamId: 'team-2',
      bye: false,
      status: 'accepted' as const,
      assignmentRevision: 1,
    }));
    state.scheduledGames.push({
      id: 'game-5',
      roundId: 'round-1',
      poolId: null,
      roomId: null,
      packetId: null,
      leftTeamId: 'team-1',
      rightTeamId: 'team-2',
      bye: false,
      status: 'live',
      assignmentRevision: 1,
    });
    const { onNavigate } = renderOverview(state);

    expect(screen.getByText('Round 1')).toBeTruthy();
    expect(screen.getByText(/4 of 5 results accepted/)).toBeTruthy();
    expect(screen.getByText(/1 still playing/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open control' }));
    expect(onNavigate).toHaveBeenCalledWith('tournament');

    expect(screen.getByText('Current leaders')).toBeTruthy();
    expect(screen.getByText('View standings')).toBeTruthy();
    expect(screen.getByText('Diagnostics')).toBeTruthy();
  });

  test('planned round offers a one-action start', async () => {
    const state = tournamentState();
    state.tournament!.currentRoundId = 'round-1';
    state.rounds = [
      {
        id: 'round-1',
        phaseId: 'phase-1',
        name: 'Round 1',
        number: 1,
        revision: 1,
        status: 'planned',
        packetId: null,
        scheduledGameIds: [],
        scheduledStart: null,
        releasedAt: null,
        startedAt: null,
        closedAt: null,
        dayOrder: 0,
      },
    ];
    const { onAnnounce } = renderOverview(state);

    fireEvent.click(screen.getByRole('button', { name: 'Start Round 1' }));
    await waitFor(() => expect(onAnnounce).toHaveBeenCalledWith('Round 1 started.'));
  });

  test('complete released round offers a one-action finish', () => {
    const state = tournamentState();
    state.teams = [confirmedTeam('team-1', 'Wren A'), confirmedTeam('team-2', 'Dorman')];
    state.tournament!.currentRoundId = 'round-1';
    state.rounds = [
      {
        id: 'round-1',
        phaseId: 'phase-1',
        name: 'Round 1',
        number: 1,
        revision: 1,
        status: 'released',
        packetId: null,
        scheduledGameIds: ['game-1'],
        scheduledStart: null,
        releasedAt: null,
        startedAt: null,
        closedAt: null,
        dayOrder: 0,
      },
    ];
    state.scheduledGames = [
      {
        id: 'game-1',
        roundId: 'round-1',
        poolId: null,
        roomId: null,
        packetId: null,
        leftTeamId: 'team-1',
        rightTeamId: 'team-2',
        bye: false,
        status: 'accepted',
        assignmentRevision: 1,
      },
    ];
    const { onAnnounce } = renderOverview(state);

    fireEvent.click(screen.getByRole('button', { name: 'Finish Round 1' }));
    expect(onAnnounce).toHaveBeenCalledWith('Round 1 finished.');
  });
});
