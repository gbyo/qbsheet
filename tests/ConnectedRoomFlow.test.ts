import { describe, expect, test } from 'vitest';
import { resumeRecordForConnection, screenAfterLoad } from '../src/app/App';
import { connectionVersion, IConnectedSession } from '../src/app/ConnectedSession';
import { gameRecordVersion, IStoredGameRecord } from '../src/game/GameStore';
import { validPackage } from './packages';

const connection: IConnectedSession = {
  version: connectionVersion,
  baseUrl: 'http://control.test',
  roomId: 'room-204',
  roomName: 'Room 204',
  roomToken: 'room-token',
  deviceId: 'device-1',
  gameRecordId: 'game-1',
  updatedAt: '2026-08-11T14:00:00.000Z',
};

function record(overrides: Partial<IStoredGameRecord> = {}): IStoredGameRecord {
  return {
    version: gameRecordVersion,
    id: 'game-1',
    identity: 'game-identity',
    attempt: 1,
    gameKey: 'session-1',
    package: validPackage(),
    setup: { left: { name: 'A', players: [] }, right: { name: 'B', players: [] } },
    events: [],
    connected: true,
    createdAt: '2026-08-11T14:00:00.000Z',
    updatedAt: '2026-08-11T14:00:00.000Z',
    serverDelivery: 'pending',
    ...overrides,
  };
}

describe('durable startup routing for a paired room', () => {
  test('an idle paired device opens its existing room', () => {
    expect(screenAfterLoad(connection, [])).toEqual({ kind: 'room' });
  });

  test('an unfinished game keeps the deliberate Resume workflow', () => {
    expect(screenAfterLoad(connection, [record()])).toEqual({ kind: 'room' });
  });

  test('a linked completed result with an outstanding handoff reopens completion', () => {
    const pending = record({
      completedAt: '2026-08-11T14:30:00.000Z',
      finalQbj: { tossups_read: 20 },
      finalScore: { left: 100, right: 90 },
      serverDeliveryLedger: { attemptCount: 1, retryable: true, outcome: 'pending' },
    });

    expect(screenAfterLoad(connection, [pending])).toEqual({ kind: 'completed', recordId: pending.id });
  });

  test('an accepted linked result no longer prevents room-first launch', () => {
    const accepted = record({
      completedAt: '2026-08-11T14:30:00.000Z',
      finalQbj: { tossups_read: 20 },
      finalScore: { left: 100, right: 90 },
      serverDelivery: 'sent',
      serverDeliveryLedger: { attemptCount: 1, retryable: false, outcome: 'accepted' },
    });

    expect(screenAfterLoad(connection, [accepted])).toEqual({ kind: 'room' });
  });

  test('ambiguous connected unfinished games stay visible on Home instead of opening the room', () => {
    const ambiguousConnection = { ...connection, gameRecordId: undefined, sessionId: undefined };
    const first = record({ id: 'game-1a', gameKey: 'session-1a' });
    const second = record({ id: 'game-1b', gameKey: 'session-1b' });

    expect(screenAfterLoad(ambiguousConnection, [first, second])).toEqual({ kind: 'home' });
  });

  test('an unreadable record named by the connection goes to Home', () => {
    expect(
      screenAfterLoad(connection, [], [{ id: 'game-1', readability: 'too-new', storedVersion: 99 }]),
    ).toEqual({
      kind: 'home',
    });
  });

  test('an unpaired device retains the ordinary welcome screen', () => {
    expect(screenAfterLoad(null, [])).toEqual({ kind: 'home' });
  });
});

describe('safe connected-game resumption', () => {
  test('prefers the exact game record over a newer room fallback', () => {
    const newer = record({ id: 'game-2', gameKey: 'session-2', updatedAt: '2026-08-11T15:00:00.000Z' });
    const exact = record();

    expect(resumeRecordForConnection(connection, [newer, exact])).toBe(exact);
  });

  test('uses the legacy session key before considering room fallback', () => {
    const legacyConnection = { ...connection, gameRecordId: undefined, sessionId: 'session-1' };
    const newer = record({ id: 'game-2', gameKey: 'session-2', updatedAt: '2026-08-11T15:00:00.000Z' });
    const legacy = record({ id: 'legacy-game', gameKey: 'session-1' });

    expect(resumeRecordForConnection(legacyConnection, [newer, legacy])).toBe(legacy);
  });

  test('does not choose between multiple room and tournament fallbacks', () => {
    const fallbackConnection = { ...connection, gameRecordId: undefined, sessionId: undefined };
    const first = record({ id: 'game-1a', gameKey: 'session-1a' });
    const second = record({ id: 'game-1b', gameKey: 'session-1b' });

    expect(resumeRecordForConnection(fallbackConnection, [first, second])).toBeNull();
  });
});
