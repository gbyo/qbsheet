/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ResultDeliveryService } from '../src/app/ResultDelivery';
import useAutomaticResultDelivery, {
  automaticResultRetryAt,
  automaticResultRetryDelayMs,
} from '../src/app/useAutomaticResultDelivery';
import { gameRecordVersion, IStoredGameRecord } from '../src/game/GameStore';
import { validPackage } from './packages';

const start = new Date('2026-08-11T14:00:00.000Z');

function pendingRecord(
  id: string,
  completedAt: string,
  attemptedAt = start.toISOString(),
): IStoredGameRecord {
  return {
    version: gameRecordVersion,
    id,
    identity: `identity-${id}`,
    attempt: 1,
    gameKey: `session-${id}`,
    package: validPackage(),
    setup: { left: { name: 'A', players: [] }, right: { name: 'B', players: [] } },
    events: [],
    connected: true,
    createdAt: completedAt,
    updatedAt: attemptedAt,
    completedAt,
    finalQbj: { tossups_read: 20 },
    finalScore: { left: 100, right: 90 },
    serverDelivery: 'pending',
    serverDeliveryLedger: {
      attemptCount: 1,
      lastAttemptedAt: attemptedAt,
      retryable: true,
      outcome: 'pending',
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(start);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('automatic result retry schedule', () => {
  test('uses the specified backoff and caps at five minutes', () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(automaticResultRetryDelayMs)).toEqual([
      5_000, 15_000, 30_000, 60_000, 120_000, 300_000, 300_000,
    ]);
    expect(automaticResultRetryAt(pendingRecord('one', start.toISOString()))).toBe(start.getTime() + 5_000);
  });

  test('retries immediately when a clock correction leaves the last attempt in the future', async () => {
    const retry = vi.fn(async () => null);
    const service = {
      canAutoRetry: () => true,
      retry,
    } as unknown as ResultDeliveryService;
    const onAttemptFinished = vi.fn(async () => undefined);
    const futureAttempt = new Date(start.getTime() + 6 * 60 * 60_000).toISOString();

    renderHook(() =>
      useAutomaticResultDelivery({
        records: [pendingRecord('clock-corrected', start.toISOString(), futureAttempt)],
        service,
        onAttemptFinished,
      }),
    );

    await act(async () => vi.advanceTimersByTimeAsync(0));

    expect(retry).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledWith('clock-corrected');
    expect(onAttemptFinished).toHaveBeenCalledOnce();
  });

  test('waits for the persisted due time before retrying', async () => {
    const retry = vi.fn(async () => null);
    const service = {
      canAutoRetry: () => true,
      retry,
    } as unknown as ResultDeliveryService;
    const onAttemptFinished = vi.fn(async () => undefined);
    renderHook(() =>
      useAutomaticResultDelivery({
        records: [pendingRecord('one', start.toISOString())],
        service,
        onAttemptFinished,
      }),
    );

    await act(async () => vi.advanceTimersByTimeAsync(4_999));
    expect(retry).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));

    expect(retry).toHaveBeenCalledWith('one');
    expect(onAttemptFinished).toHaveBeenCalledOnce();
  });

  test('wake events re-evaluate but never bypass the due time', async () => {
    const retry = vi.fn(async () => null);
    const service = { canAutoRetry: () => true, retry } as unknown as ResultDeliveryService;
    renderHook(() =>
      useAutomaticResultDelivery({
        records: [pendingRecord('one', start.toISOString())],
        service,
        onAttemptFinished: () => undefined,
      }),
    );

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    act(() => window.dispatchEvent(new Event('online')));
    act(() => window.dispatchEvent(new Event('focus')));
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(retry).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTimeAsync(4_000));
    expect(retry).toHaveBeenCalledOnce();
  });

  test('tries only the oldest due completion at a time', async () => {
    const retry = vi.fn(async () => null);
    const service = { canAutoRetry: () => true, retry } as unknown as ResultDeliveryService;
    const attemptedLongAgo = new Date(start.getTime() - 60_000).toISOString();
    renderHook(() =>
      useAutomaticResultDelivery({
        records: [
          pendingRecord('newer', '2026-08-11T13:30:00.000Z', attemptedLongAgo),
          pendingRecord('older', '2026-08-11T13:00:00.000Z', attemptedLongAgo),
        ],
        service,
        onAttemptFinished: () => undefined,
      }),
    );

    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledWith('older');
  });
});
