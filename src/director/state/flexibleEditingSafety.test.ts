import { describe, expect, test } from 'vitest';
import { emptyDirectorState, type DirectorState } from '../domain';
import { roundRemovalBlocker, roundRemovalImpact } from './flexibleEditing';

function roundState(status: DirectorState['rounds'][number]['status']): DirectorState {
  const state = emptyDirectorState();
  state.rounds.push({
    id: 'round-1',
    name: 'Round 1',
    status,
    scheduledGameIds: ['scheduled-1'],
  } as DirectorState['rounds'][number]);
  state.scheduledGames.push({
    id: 'scheduled-1',
    roundId: 'round-1',
  } as DirectorState['scheduledGames'][number]);
  return state;
}

function roundStateWithDelivery(
  status: DirectorState['rounds'][number]['status'],
  deliveryMode: 'usb' | 'qbtcp',
): DirectorState {
  const state = roundState(status);
  state.rounds[0]!.deliveryMode = deliveryMode;
  return state;
}

describe('flexible round removal safety', () => {
  test('allows ordinary removal of an unplayed planned round', () => {
    expect(roundRemovalBlocker(roundState('planned'), 'round-1')).toBeNull();
  });

  test.each(['usb', 'qbtcp'] as const)(
    'blocks a prepared %s round before any result exists',
    (deliveryMode) => {
      const state = roundStateWithDelivery('prepared', deliveryMode);
      expect(roundRemovalImpact(state, 'round-1')).toMatchObject({
        prepared: true,
        writtenAssignments: 0,
        activeQbtcpSessions: 0,
      });
      expect(roundRemovalBlocker(state, 'round-1')).toMatch(
        /exposed scorer work|prepared scorer assignments/,
      );
      expect(roundRemovalBlocker(state, 'round-1')).toContain('Advanced recovery');
    },
  );

  test('blocks planned cleanup after a USB assignment was written', () => {
    const state = roundStateWithDelivery('planned', 'usb');
    state.transfers.assignments.push({
      id: 'assignment-1',
      scheduledGameId: 'scheduled-1',
      roundRevision: 1,
      assignmentRevision: 1,
      artifactDigest: 'digest',
      transportKind: 'removable-drive',
      destinationLabel: 'Scorer USB',
      createdAt: '2026-09-09T12:00:00.000Z',
      status: 'written',
    });
    expect(roundRemovalImpact(state, 'round-1')?.writtenAssignments).toBe(1);
    expect(roundRemovalBlocker(state, 'round-1')).toContain('written assignment');
  });

  test('blocks planned cleanup with an unresolved QBTCP assignment session', () => {
    const state = roundStateWithDelivery('planned', 'qbtcp');
    state.qbtcpSessions.push({
      roomId: 'room-1',
      sessionId: 'session-1',
      matchId: 'scheduled-1',
      deviceId: 'device-1',
      state: 'assigned',
      lastSeenAt: '2026-09-09T12:00:00.000Z',
      progress: null,
      helpRequestId: null,
    });
    expect(roundRemovalImpact(state, 'round-1')?.activeQbtcpSessions).toBe(1);
    expect(roundRemovalBlocker(state, 'round-1')).toContain('QBTCP session');
  });

  test('blocks removal of a released round even before a result is accepted', () => {
    expect(roundRemovalBlocker(roundState('released'), 'round-1')).toContain('competitive history');
  });

  test('blocks a corrupted/planned round that already contains an accepted result', () => {
    const state = roundState('planned');
    state.games.push({
      id: 'game-1',
      roundId: 'round-1',
      scheduledGameId: 'scheduled-1',
      status: 'accepted',
    } as DirectorState['games'][number]);
    expect(roundRemovalImpact(state, 'round-1')?.acceptedResults).toBe(1);
    expect(roundRemovalBlocker(state, 'round-1')).toContain('1 accepted/forfeit result');
  });

  test.each(['closed'] as const)('blocks a %s round even without a result', (status) => {
    expect(roundRemovalBlocker(roundState(status), 'round-1')).toContain('competitive history');
  });

  test.each([
    ['received', 'submission'],
    ['review', 'submission'],
  ] as const)('blocks a planned round with a %s %s', (status, label) => {
    const state = roundState('planned');
    state.games.push({
      id: 'game-1',
      roundId: 'round-1',
      scheduledGameId: 'scheduled-1',
      status: 'rejected',
    } as DirectorState['games'][number]);
    state.submissions.push({
      id: 'submission-1',
      gameId: 'game-1',
      status,
    } as DirectorState['submissions'][number]);
    expect(roundRemovalBlocker(state, 'round-1')).toContain(label);
  });

  test('blocks a planned round with a protest', () => {
    const state = roundState('planned');
    state.games.push({
      id: 'game-1',
      roundId: 'round-1',
      scheduledGameId: 'scheduled-1',
      status: 'rejected',
    } as DirectorState['games'][number]);
    state.protests.push({ id: 'protest-1', gameId: 'game-1' } as DirectorState['protests'][number]);
    expect(roundRemovalBlocker(state, 'round-1')).toContain('protest');
  });

  test('blocks a late assignment artifact so it cannot be mistaken for unexposed planning', () => {
    const state = roundState('planned');
    state.transfers.artifacts.push({
      id: 'artifact-1',
      sourceKind: 'drop',
      sourceLabel: 'Scorer return',
      fileName: 'round-1.qbj',
      byteLength: 1,
      digest: 'digest',
      detectedAt: '2026-09-09T12:00:00.000Z',
      classification: 'assignment',
      warnings: ['stale assignment'],
      status: 'detected',
      scheduledGameId: 'scheduled-1',
    });
    expect(roundRemovalImpact(state, 'round-1')?.assignmentArtifacts).toBe(1);
    expect(roundRemovalBlocker(state, 'round-1')).toContain('late or stale results');
  });
});
