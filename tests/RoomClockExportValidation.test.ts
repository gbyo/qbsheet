import { describe, expect, test } from 'vitest';
import { exportRoomClocks, roomClockVersion } from '../src/scorer/RoomClock';

class MemoryStorage {
  private values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

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

describe('room clock export validation', () => {
  test('malformed persisted segments are omitted instead of exported as idle clocks', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      'yellowfruit.room.clock.v3.game.half-1',
      JSON.stringify({
        version: roomClockVersion,
        durationMs: 600_000,
        status: 'running',
        accumulatedMs: 12_000,
      }),
    );
    storage.setItem(
      'yellowfruit.room.clock.v3.game.half-2',
      JSON.stringify({
        version: roomClockVersion,
        durationMs: 600_000,
        status: 'paused',
        accumulatedMs: 42_000,
        pauseReason: 'checkpoint',
      }),
    );

    expect(exportRoomClocks('game', 100_000, storage)).toEqual({
      'half-2': {
        version: roomClockVersion,
        durationMs: 600_000,
        status: 'paused',
        accumulatedMs: 42_000,
        pauseReason: 'checkpoint',
      },
    });
  });
});
