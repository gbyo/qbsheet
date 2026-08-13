import { describe, expect, test } from 'vitest';
import { screenAfterLoad } from '../src/app/App';
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
    expect(screenAfterLoad(connection, [])).toEqual({ kind: 'connect', fresh: false });
  });

  test('an unfinished game keeps the deliberate Resume workflow', () => {
    expect(screenAfterLoad(connection, [record()])).toEqual({ kind: 'home' });
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

    expect(screenAfterLoad(connection, [accepted])).toEqual({ kind: 'connect', fresh: false });
  });

  test('an unpaired device retains the ordinary welcome screen', () => {
    expect(screenAfterLoad(null, [])).toEqual({ kind: 'home' });
  });
});
