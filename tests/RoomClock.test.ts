import { describe, expect, test } from 'vitest';
import {
  elapsedRoomClock,
  exportRoomClocks,
  expireRoomClock,
  formatClock,
  idleRoomClock,
  loadRoomClock,
  normalizeRoomClock,
  pauseRoomClock,
  remainingRoomClock,
  resetRoomClock,
  restoreRoomClocks,
  roomClockSegment,
  resumeRoomClock,
  saveRoomClock,
  startRoomClock,
} from '../src/scorer/RoomClock';

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
  };
}

describe('timestamp-based room clock', () => {
  test('uses a fresh identity for each half and overtime segment', () => {
    expect(roomClockSegment(true, 0, false, false)).toBe('half-1');
    expect(roomClockSegment(true, 1, true, false)).toBe('half-1');
    expect(roomClockSegment(true, 1, false, false)).toBe('half-2');
    expect(roomClockSegment(true, 1, false, true)).toBe('overtime');
  });

  test('elapsed time comes from timestamps, not tick count', () => {
    const started = startRoomClock(idleRoomClock(60_000), 1_000);

    expect(elapsedRoomClock(started, 31_000)).toBe(30_000);
    expect(remainingRoomClock(started, 31_000)).toBe(30_000);
    expect(formatClock(30_001)).toBe('00:31');
  });

  test('a backward clock correction cannot subtract accumulated play time', () => {
    const paused = pauseRoomClock(startRoomClock(idleRoomClock(60_000), 1_000), 'manual', 21_000);
    const resumed = resumeRoomClock(paused, 100_000);

    expect(elapsedRoomClock(resumed, 90_000)).toBe(20_000);
    expect(pauseRoomClock(resumed, 'manual', 90_000)).toMatchObject({
      status: 'paused',
      accumulatedMs: 20_000,
    });
  });

  test('pause and resume preserve the accumulated duration', () => {
    const running = startRoomClock(idleRoomClock(60_000), 1_000);
    const paused = pauseRoomClock(running, 'timeout', 21_000);
    const resumed = resumeRoomClock(paused, 100_000);

    expect(paused).toMatchObject({ status: 'paused', accumulatedMs: 20_000, pauseReason: 'timeout' });
    expect(elapsedRoomClock(resumed, 110_000)).toBe(30_000);
  });

  test('expiry is explicit and does not mutate the game procedure', () => {
    const running = startRoomClock(idleRoomClock(10_000), 1_000);
    const expired = expireRoomClock(running, 11_000);

    expect(expired).toMatchObject({ status: 'expired', accumulatedMs: 10_000 });
    expect(remainingRoomClock(expired, 100_000)).toBe(0);
  });

  test('clock state survives local recovery and rejects a mismatched duration', () => {
    const durable = storage();
    const running = startRoomClock(idleRoomClock(60_000), 1_000);

    expect(saveRoomClock('game-1', running, durable, 'half-1')).toBe(true);
    expect(loadRoomClock('game-1', 60_000, durable, 'half-1')).toEqual(running);
    expect(loadRoomClock('game-1', 60_000, durable, 'half-2')).toEqual(idleRoomClock(60_000));
    expect(loadRoomClock('game-1', 90_000, durable, 'half-1')).toEqual(idleRoomClock(90_000));
  });

  test('portable clock export snapshots every segment and restores paused', () => {
    const durable = storage();
    const running = startRoomClock(idleRoomClock(60_000), 1_000);
    const paused = pauseRoomClock(startRoomClock(idleRoomClock(60_000), 1_000), 'checkpoint', 6_000);
    saveRoomClock('game-1', running, durable, 'half-1');
    saveRoomClock('game-1', paused, durable, 'half-2');

    const exported = exportRoomClocks('game-1', 31_000, durable);
    expect(exported['half-1']).toMatchObject({ status: 'paused', accumulatedMs: 30_000 });
    expect(exported['half-1']).not.toHaveProperty('runningSince');
    expect(exported['half-2']).toMatchObject({ status: 'paused', accumulatedMs: 5_000 });

    restoreRoomClocks('new-game', exported, durable);
    expect(loadRoomClock('new-game', 60_000, durable, 'half-1')).toEqual(exported['half-1']);
    expect(loadRoomClock('new-game', 60_000, durable, 'half-2')).toEqual(exported['half-2']);
  });

  test('does not export a dotted game key as a segment of its prefix', () => {
    const durable = storage();
    const first = pauseRoomClock(startRoomClock(idleRoomClock(60_000), 1_000), 'manual', 6_000);
    const second = pauseRoomClock(startRoomClock(idleRoomClock(60_000), 1_000), 'manual', 11_000);

    saveRoomClock('g1', first, durable, 'half-1');
    saveRoomClock('g1.retry', second, durable, 'half-1');

    expect(exportRoomClocks('g1', 12_000, durable)).toEqual({ 'half-1': first });
    expect(exportRoomClocks('g1.retry', 12_000, durable)).toEqual({ 'half-1': second });

    // The old v2 key grammar could not tell this key from a `retry.half-1` segment of g1. It stays
    // readable by its exact game-and-segment key, but the new v3 export namespace never enumerates
    // it under the wrong game.
    const legacyOnly = storage();
    legacyOnly.setItem('yellowfruit.room.clock.v2.g1.retry.half-1', JSON.stringify(second));
    expect(loadRoomClock('g1.retry', 60_000, legacyOnly, 'half-1')).toEqual(second);
    expect(exportRoomClocks('g1', 12_000, legacyOnly)).toEqual({});
  });

  test('malformed running state recovers to a safe idle clock', () => {
    expect(
      normalizeRoomClock({ version: 2, durationMs: 60_000, status: 'running', accumulatedMs: 0 }, 60_000),
    ).toEqual(idleRoomClock(60_000));
  });

  test.each([
    [{ version: 2, durationMs: 60_000, status: 'idle', accumulatedMs: 60_000 }, 'expired'],
    [{ version: 2, durationMs: 60_000, status: 'expired', accumulatedMs: 0 }, 'expired'],
    [
      { version: 2, durationMs: 60_000, status: 'paused', accumulatedMs: 60_000, runningSince: 10 },
      'expired',
    ],
  ])('canonicalizes invalid terminal state %#', (raw, status) => {
    expect(normalizeRoomClock(raw, 60_000)).toMatchObject({ status, accumulatedMs: 60_000 });
    expect(normalizeRoomClock(raw, 60_000)).not.toHaveProperty('runningSince');
  });

  test('preserves only valid paused and running state fields', () => {
    expect(
      normalizeRoomClock(
        { version: 2, durationMs: 60_000, status: 'paused', accumulatedMs: 5_000, runningSince: 10 },
        60_000,
      ),
    ).toEqual({ version: 2, durationMs: 60_000, status: 'paused', accumulatedMs: 5_000 });
    expect(
      normalizeRoomClock(
        { version: 2, durationMs: 60_000, status: 'running', accumulatedMs: 5_000, runningSince: 10 },
        60_000,
      ),
    ).toEqual({ version: 2, durationMs: 60_000, status: 'running', accumulatedMs: 5_000, runningSince: 10 });
  });

  test('reset returns an expired segment to a fresh idle clock', () => {
    expect(
      resetRoomClock({ version: 2, durationMs: 60_000, status: 'expired', accumulatedMs: 60_000 }),
    ).toEqual(idleRoomClock(60_000));
  });
});
