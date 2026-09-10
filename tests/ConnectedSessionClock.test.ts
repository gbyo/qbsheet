import { describe, expect, test } from 'vitest';
import { readConnection, writeConnection } from '../src/app/ConnectedSession';

class TestStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe('connected session clock handling', () => {
  test('keeps a valid pairing when the device clock moves backward', () => {
    const storage = new TestStorage();
    const clockBeforeCorrection = new Date('2026-09-06T16:00:00.000Z');
    const clockAfterCorrection = new Date('2026-09-06T14:00:00.000Z');

    expect(
      writeConnection(
        {
          baseUrl: 'http://192.168.1.20:8787',
          roomId: 'room-1',
          roomName: 'Room 1',
          roomToken: 'room-token',
          deviceId: 'device-1',
          tournamentKey: 'tournament-1',
        },
        clockBeforeCorrection,
        storage,
      ),
    ).toBe(true);

    expect(readConnection(clockAfterCorrection, storage)).toMatchObject({
      roomId: 'room-1',
      roomToken: 'room-token',
      deviceId: 'device-1',
      tournamentKey: 'tournament-1',
    });
  });

  test('round-trips endpoint-specific LAN room and session credentials', () => {
    const storage = new TestStorage();
    writeConnection(
      {
        baseUrl: 'https://relay.example/tournament',
        roomId: 'room-1',
        roomName: 'Room 1',
        roomToken: 'relay-room-token',
        deviceId: 'device-1',
        sessionId: 'relay-session',
        sessionToken: 'relay-session-token',
        lanBaseUrl: 'http://192.168.1.20:8787',
        lanRoomToken: 'lan-room-token',
        lanSessionId: 'lan-session',
        lanSessionToken: 'lan-session-token',
      },
      new Date('2026-09-06T16:00:00.000Z'),
      storage,
    );

    expect(readConnection(new Date(), storage)).toMatchObject({
      roomToken: 'relay-room-token',
      sessionToken: 'relay-session-token',
      lanRoomToken: 'lan-room-token',
      lanSessionId: 'lan-session',
      lanSessionToken: 'lan-session-token',
    });
  });
});
