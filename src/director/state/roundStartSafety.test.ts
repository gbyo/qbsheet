import { describe, expect, test } from 'vitest';
import { emptyDirectorState, type DirectorState } from '../domain';
import { usbRoundDeliveryBlocker } from './roundStartSafety';

function usbRoundState(): DirectorState {
  const state = emptyDirectorState();
  state.rounds.push({
    id: 'round-1',
    name: 'Round 1',
    revision: 2,
    deliveryMode: 'usb',
  } as DirectorState['rounds'][number]);
  state.scheduledGames.push({
    id: 'scheduled-1',
    roundId: 'round-1',
    assignmentRevision: 3,
    bye: false,
    status: 'scheduled',
  } as DirectorState['scheduledGames'][number]);
  state.transfers.locations.push({
    id: 'usb',
    kind: 'removable-drive',
    label: 'Scorer USB',
    path: '/Volumes/Scorer USB',
    connected: true,
    readOnly: false,
    watching: false,
    initialized: true,
    addedAt: '2026-09-09T12:00:00.000Z',
    lastSeenAt: '2026-09-09T12:00:00.000Z',
  });
  return state;
}

describe('USB round-start safety', () => {
  test('requires a written assignment at the current round and assignment revisions', () => {
    const state = usbRoundState();
    expect(usbRoundDeliveryBlocker(state, 'round-1')).toMatch(/not been prepared/i);

    state.transfers.assignments.push({
      id: 'stale-assignment',
      scheduledGameId: 'scheduled-1',
      roundRevision: 1,
      assignmentRevision: 3,
      artifactDigest: 'old',
      transportKind: 'removable-drive',
      destinationLabel: 'Scorer USB',
      createdAt: '2026-09-09T12:00:00.000Z',
      status: 'written',
    });
    expect(usbRoundDeliveryBlocker(state, 'round-1')).toMatch(/not been prepared/i);

    state.transfers.assignments.push({
      id: 'current-assignment',
      scheduledGameId: 'scheduled-1',
      roundRevision: 2,
      assignmentRevision: 3,
      artifactDigest: 'current',
      transportKind: 'removable-drive',
      destinationLabel: 'Scorer USB',
      createdAt: '2026-09-09T12:00:00.000Z',
      status: 'written',
    });
    expect(usbRoundDeliveryBlocker(state, 'round-1')).toBeNull();
  });
});
