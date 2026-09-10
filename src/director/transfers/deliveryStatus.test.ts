/**
 * Per-game delivery derivation for #702.
 *
 * One mixed round proves the core invariant: QBTCP, file, manual, stale,
 * disconnected, and backup rooms each derive their own intent/readiness
 * from canonical evidence, never from a round-wide mode. Explicit per-game
 * intent wins over session evidence and the round default without touching
 * siblings, and history survives intent changes.
 */
import { describe, expect, test } from 'vitest';
import type {
  AssignmentTransfer,
  DirectorState,
  QbtcpRoomSession,
  ResultSubmission,
  ScheduledGame,
} from '../domain';
import {
  deriveAssignmentReadiness,
  deriveCurrentRoundDelivery,
  deriveGameDeliveryIntent,
  deriveGameResultStatus,
  gameNeedsFiles,
  sanitizeDeliveryIntent,
} from './deliveryStatus';
import { scheduledGame, team, tournamentState } from '../../../tests/directorFixtures';

const AT = '2026-09-12T12:00:00.000Z';

function room(id: string, name: string): DirectorState['rooms'][number] {
  return { id, name, available: true, status: 'live' } as DirectorState['rooms'][number];
}

function session(roomId: string, state: QbtcpRoomSession['state']): QbtcpRoomSession {
  return {
    roomId,
    sessionId: `session-${roomId}`,
    deviceId: `device-${roomId}`,
    state,
    lastSeenAt: AT,
    progress: null,
    helpRequestId: null,
  };
}

function fileTransfer(gameId: string, revision: number, label = 'SanDisk Ultra'): AssignmentTransfer {
  return {
    id: `transfer-${gameId}-${revision}`,
    scheduledGameId: gameId,
    roundRevision: 1,
    assignmentRevision: revision,
    artifactDigest: `digest-${gameId}-${revision}`,
    transportKind: 'removable-drive',
    destinationLabel: label,
    createdAt: AT,
    status: 'written',
  };
}

/** A mixed current round: QBTCP, QBTCP+backup, file, manual, disconnected, stale. */
function mixedState(): DirectorState {
  const state = tournamentState();
  // The round default is QBTCP: rooms without explicit intent or session
  // evidence follow it, while configured rooms keep their own routes.
  state.rounds[0]!.deliveryMode = 'qbtcp';
  state.teams.push(
    team('team-a', 'Aiken'),
    team('team-b', 'Dorman'),
    team('team-c', 'Eastside'),
    team('team-d', 'Mauldin'),
  );
  state.rooms.push(
    room('room-101', 'Room 101'),
    room('room-102', 'Room 102'),
    room('room-103', 'Room 103'),
    room('room-104', 'Room 104'),
    room('room-105', 'Room 105'),
    room('room-106', 'Room 106'),
  );
  const games: ScheduledGame[] = [
    scheduledGame('game-101', 'team-a', 'team-b', {
      roundId: 'round-1',
      roomId: 'room-101',
      status: 'released',
    }),
    scheduledGame('game-102', 'team-c', 'team-d', {
      roundId: 'round-1',
      roomId: 'room-102',
      status: 'released',
    }),
    scheduledGame('game-103', 'team-a', 'team-c', {
      roundId: 'round-1',
      roomId: 'room-103',
      status: 'released',
      deliveryIntent: { primary: 'file', fallbacks: [] },
    }),
    scheduledGame('game-104', 'team-b', 'team-d', {
      roundId: 'round-1',
      roomId: 'room-104',
      status: 'released',
      deliveryIntent: { primary: 'manual', fallbacks: [] },
    }),
    scheduledGame('game-105', 'team-a', 'team-d', {
      roundId: 'round-1',
      roomId: 'room-105',
      status: 'released',
    }),
    scheduledGame('game-106', 'team-b', 'team-c', {
      roundId: 'round-1',
      roomId: 'room-106',
      status: 'released',
      assignmentRevision: 2,
      deliveryIntent: { primary: 'file', fallbacks: [] },
    }),
  ];
  state.scheduledGames.push(...games);
  state.qbtcpSessions.push(
    session('room-101', 'live'),
    session('room-102', 'live'),
    session('room-105', 'abandoned'),
  );
  state.transfers.assignments.push(fileTransfer('game-102', 1), fileTransfer('game-106', 1));
  return state;
}

function submission(id: string, gameRecordId: string, status: ResultSubmission['status']): ResultSubmission {
  return {
    id,
    gameId: gameRecordId,
    receivedAt: AT,
    fingerprint: `fp-${id}`,
    status,
    rawSubmission: {},
  };
}

describe('per-game delivery intent (#702)', () => {
  test('sanitizer drops corrupt intent instead of inventing routing', () => {
    expect(sanitizeDeliveryIntent(undefined)).toBeUndefined();
    expect(sanitizeDeliveryIntent({ primary: 'usb' })).toBeUndefined();
    expect(sanitizeDeliveryIntent({ primary: 'qbtcp', fallbacks: ['qbtcp', 'file', 'pigeon'] })).toEqual({
      primary: 'qbtcp',
      fallbacks: ['file'],
    });
    expect(sanitizeDeliveryIntent({ fallbacks: ['file'] })).toEqual({ fallbacks: ['file'] });
  });

  test('explicit intent wins over session evidence and the round default', () => {
    const state = mixedState();
    state.rounds[0]!.deliveryMode = 'usb';
    const game = state.scheduledGames.find((entry) => entry.id === 'game-101')!;
    game.deliveryIntent = { primary: 'manual', fallbacks: [] };
    expect(deriveGameDeliveryIntent(state, game)).toEqual({
      primary: 'manual',
      fallbacks: [],
      source: 'explicit',
    });
  });

  test('a live session routes its room to QBTCP without touching siblings', () => {
    const state = mixedState();
    const live = deriveGameDeliveryIntent(
      state,
      state.scheduledGames.find((entry) => entry.id === 'game-101')!,
    );
    expect(live).toEqual({ primary: 'qbtcp', fallbacks: [], source: 'session' });
    const manual = deriveGameDeliveryIntent(
      state,
      state.scheduledGames.find((entry) => entry.id === 'game-104')!,
    );
    expect(manual.primary).toBe('manual');
  });

  test('the round default only covers games with no intent or session evidence', () => {
    const state = mixedState();
    state.rounds[0]!.deliveryMode = 'usb';
    const derived = deriveGameDeliveryIntent(
      state,
      state.scheduledGames.find((entry) => entry.id === 'game-105')!,
    );
    expect(derived).toEqual({ primary: 'file', fallbacks: [], source: 'round-default' });
  });

  test('legacy documents without any mode fall back to manual, not to a guess', () => {
    const state = mixedState();
    delete state.rounds[0]!.deliveryMode;
    const derived = deriveGameDeliveryIntent(
      state,
      state.scheduledGames.find((entry) => entry.id === 'game-105')!,
    );
    expect(derived).toEqual({ primary: 'manual', fallbacks: [], source: 'manual' });
  });
});

describe('assignment readiness (#702)', () => {
  test('mixed rooms derive independent readiness', () => {
    const state = mixedState();
    const readiness = new Map(
      state.scheduledGames.map((game) => [game.id, deriveAssignmentReadiness(state, game).state]),
    );
    expect(readiness.get('game-101')).toBe('qbtcp-connected');
    expect(readiness.get('game-102')).toBe('qbtcp-connected');
    expect(readiness.get('game-103')).toBe('file-needed');
    expect(readiness.get('game-104')).toBe('manual');
    expect(readiness.get('game-105')).toBe('problem');
    expect(readiness.get('game-106')).toBe('needs-reprepare');
  });

  test('a file backup for a QBTCP room is reported as backup, never conflict', () => {
    const state = mixedState();
    const readiness = deriveAssignmentReadiness(
      state,
      state.scheduledGames.find((entry) => entry.id === 'game-102')!,
    );
    expect(readiness.state).toBe('qbtcp-connected');
    expect(readiness.backupCurrent).toBe(true);
    expect(readiness.backupStale).toBe(false);
  });

  test('a stale prepared file names both revisions', () => {
    const state = mixedState();
    const readiness = deriveAssignmentReadiness(
      state,
      state.scheduledGames.find((entry) => entry.id === 'game-106')!,
    );
    expect(readiness.state).toBe('needs-reprepare');
    expect(readiness.message).toContain('revision 1');
    expect(readiness.message).toContain('revision 2');
  });

  test('gameNeedsFiles selects exactly the actionable file games', () => {
    const state = mixedState();
    const needing = state.scheduledGames.filter((game) => gameNeedsFiles(state, game)).map((game) => game.id);
    expect(needing.sort()).toEqual(['game-103', 'game-106']);
  });
});

describe('result status (#702)', () => {
  test('no submissions means waiting', () => {
    const state = mixedState();
    expect(
      deriveGameResultStatus(
        state,
        state.scheduledGames.find((entry) => entry.id === 'game-101')!,
      ).state,
    ).toBe('waiting');
  });

  test('a QBTCP-tied submission reads received via QBTCP', () => {
    const state = mixedState();
    state.games.push({
      id: 'record-101',
      scheduledGameId: 'game-101',
      roundId: 'round-1',
      packetId: null,
      status: 'submitted',
      scores: [],
      playerStats: [],
      source: 'qbtcp',
    });
    state.submissions.push({
      ...submission('sub-1', 'record-101', 'received'),
      sessionId: 'session-room-101',
    });
    const result = deriveGameResultStatus(
      state,
      state.scheduledGames.find((entry) => entry.id === 'game-101')!,
    );
    expect(result.state).toBe('received');
    expect(result.sourceLabel).toBe('via QBTCP');
    expect(result.submissionId).toBe('sub-1');
  });

  test('a conflicting second transport surfaces conflict, never a silent preference', () => {
    const state = mixedState();
    state.games.push({
      id: 'record-102',
      scheduledGameId: 'game-102',
      roundId: 'round-1',
      packetId: null,
      status: 'submitted',
      scores: [],
      playerStats: [],
      source: 'qbtcp',
    });
    state.submissions.push(
      { ...submission('sub-2a', 'record-102', 'received'), sessionId: 'session-room-102' },
      { ...submission('sub-2b', 'record-102', 'review'), conflictWith: 'sub-2a' },
    );
    const result = deriveGameResultStatus(
      state,
      state.scheduledGames.find((entry) => entry.id === 'game-102')!,
    );
    expect(result.state).toBe('conflict');
  });
});

describe('current-round delivery rows (#702)', () => {
  test('gaps sort first and counts separate files, problems, and reviews', () => {
    const state = mixedState();
    const delivery = deriveCurrentRoundDelivery(state);
    expect(delivery.round?.id).toBe('round-1');
    expect(delivery.rows).toHaveLength(6);
    // Problems and stale files outrank healthy rooms.
    expect(delivery.rows[0]!.assignment.state).toBe('problem');
    expect(delivery.needingFiles.map((row) => row.scheduledGameId).sort()).toEqual(['game-103', 'game-106']);
    expect(delivery.qbtcpProblem.map((row) => row.scheduledGameId)).toEqual(['game-105']);
    const row101 = delivery.rows.find((row) => row.scheduledGameId === 'game-101')!;
    expect(row101.roomName).toBe('Room 101');
    expect(row101.matchup).toBe('Aiken vs Dorman');
  });
});
