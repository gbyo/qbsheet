import { describe, expect, test } from 'vitest';
import {
  elapsedRoomClock,
  expireRoomClock,
  formatClock,
  idleRoomClock,
  loadRoomClock,
  normalizeRoomClock,
  pauseRoomClock,
  remainingRoomClock,
  resetRoomClock,
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

  test('malformed running state recovers to a safe idle clock', () => {
    expect(normalizeRoomClock({ version: 2, durationMs: 60_000, status: 'running', accumulatedMs: 0 }, 60_000)).toEqual(
      idleRoomClock(60_000),
    );
  });

  test.each([
    [{ version: 2, durationMs: 60_000, status: 'idle', accumulatedMs: 60_000 }, 'expired'],
    [{ version: 2, durationMs: 60_000, status: 'expired', accumulatedMs: 0 }, 'expired'],
    [{ version: 2, durationMs: 60_000, status: 'paused', accumulatedMs: 60_000, runningSince: 10 }, 'expired'],
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
    expect(resetRoomClock({ version: 2, durationMs: 60_000, status: 'expired', accumulatedMs: 60_000 })).toEqual(
      idleRoomClock(60_000),
    );
  });
});
