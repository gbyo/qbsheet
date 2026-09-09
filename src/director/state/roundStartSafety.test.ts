import { describe, expect, test } from 'vitest';
import { emptyDirectorState, type DirectorState } from '../domain';
import { generatedRoundCommitObserved, usbRoundDeliveryBlocker } from './roundStartSafety';

function usbRoundState(): DirectorState {
  const state = emptyDirectorState();
  state.rounds.push({
    id: 'round-1',
    name: 'Round 1',
    status: 'planned',
    deliveryMode: 'usb',
    revision: 3,
    scheduledGameIds: ['game-1'],
  } as DirectorState['rounds'][number]);
  state.teams.push(
    { id: 'team-a', displayName: 'Alpha' } as DirectorState['teams'][number],
    { id: 'team-b', displayName: 'Beta' } as DirectorState['teams'][number],
  );
  state.scheduledGames.push({
    id: 'game-1',
    roundId: 'round-1',
    leftTeamId: 'team-a',
    rightTeamId: 'team-b',
    roomId: null,
    bye: false,
    status: 'scheduled',
    assignmentRevision: 7,
  } as DirectorState['scheduledGames'][number]);
  state.transfers.locations.push({ id: 'location-1' } as DirectorState['transfers']['locations'][number]);
  return state;
}

function recordAssignment(
  state: DirectorState,
  roundRevision = 3,
  assignmentRevision = 7,
  status: DirectorState['transfers']['assignments'][number]['status'] = 'written',
): void {
  state.transfers.assignments.push({
    id: 'assignment-1',
    scheduledGameId: 'game-1',
    roundRevision,
    assignmentRevision,
    artifactDigest: 'digest',
    transportKind: 'removable-drive',
    destinationLabel: 'Scorer USB',
    createdAt: '2026-09-09T12:00:00.000Z',
    status,
  });
}

describe('USB round delivery readiness', () => {
  test('blocks USB release when the current assignment has not been prepared', () => {
    expect(usbRoundDeliveryBlocker(usbRoundState(), 'round-1')).toMatch(/has not been prepared/i);
  });

  test('allows USB release after the current assignment revision was written', () => {
    const state = usbRoundState();
    recordAssignment(state);
    expect(usbRoundDeliveryBlocker(state, 'round-1')).toBeNull();
  });

  test.each([
    ['stale round', 2, 7],
    ['stale assignment', 3, 6],
  ] as const)('rejects a %s transfer record', (_label, roundRevision, assignmentRevision) => {
    const state = usbRoundState();
    recordAssignment(state, roundRevision, assignmentRevision);
    expect(usbRoundDeliveryBlocker(state, 'round-1')).toMatch(/current round\/assignment revision/i);
  });

  test('does not count a failed prepare as ready', () => {
    const state = usbRoundState();
    recordAssignment(state, 3, 7, 'failed');
    expect(usbRoundDeliveryBlocker(state, 'round-1')).not.toBeNull();
  });

  test('does not impose USB preparation on a manual round', () => {
    const state = usbRoundState();
    state.rounds[0]!.deliveryMode = 'manual';
    expect(usbRoundDeliveryBlocker(state, 'round-1')).toBeNull();
  });
});

describe('schedule generation commit observation', () => {
  test('recognizes a newly committed round', () => {
    const before = emptyDirectorState();
    const after = structuredClone(before);
    after.rounds.push({ id: 'round-1' } as DirectorState['rounds'][number]);
    expect(generatedRoundCommitObserved(before, after)).toBe(true);
  });

  test('does not report a commit when the round set is unchanged', () => {
    const state = emptyDirectorState();
    state.rounds.push({ id: 'round-1' } as DirectorState['rounds'][number]);
    expect(generatedRoundCommitObserved(state, structuredClone(state))).toBe(false);
  });
});
