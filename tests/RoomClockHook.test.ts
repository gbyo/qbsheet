/** @vitest-environment jsdom */

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { loadRoomClock, saveRoomClock } from '../src/scorer/RoomClock';
import useRoomClock from '../src/scorer/useRoomClock';

beforeEach(() => {
  vi.restoreAllMocks();
  const values = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, String(value)),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    },
  });
});

describe('useRoomClock persistence identity', () => {
  test('loads a new game before saving it, even when duration is unchanged', () => {
    window.localStorage.clear();
    const hook = renderHook(({ gameKey }: { gameKey: string }) => useRoomClock(gameKey, 1, 'half-1'), {
      initialProps: { gameKey: 'game-a' },
    });

    act(() => hook.result.current.start());
    expect(loadRoomClock('game-a', 60_000, window.localStorage, 'half-1').status).toBe('running');

    hook.rerender({ gameKey: 'game-b' });
    expect(hook.result.current.state).toEqual({
      version: 2,
      durationMs: 60_000,
      status: 'idle',
      accumulatedMs: 0,
    });
    expect(loadRoomClock('game-b', 60_000, window.localStorage, 'half-1').status).toBe('idle');

    act(() => hook.result.current.start());
    expect(loadRoomClock('game-a', 60_000, window.localStorage, 'half-1').status).toBe('running');
    expect(loadRoomClock('game-b', 60_000, window.localStorage, 'half-1').status).toBe('running');
    hook.unmount();
  });

  test('loads a new duration and segment without inheriting the previous state', () => {
    window.localStorage.clear();
    const hook = renderHook(
      ({ gameKey, minutes, segment }: { gameKey: string; minutes: number; segment: string }) =>
        useRoomClock(gameKey, minutes, segment),
      { initialProps: { gameKey: 'game-a', minutes: 1, segment: 'half-1' } },
    );
    act(() => hook.result.current.start());

    hook.rerender({ gameKey: 'game-a', minutes: 2, segment: 'half-2' });
    expect(hook.result.current.state).toEqual({
      version: 2,
      durationMs: 120_000,
      status: 'idle',
      accumulatedMs: 0,
    });
    expect(loadRoomClock('game-a', 120_000, window.localStorage, 'half-2').status).toBe('idle');
    expect(loadRoomClock('game-a', 60_000, window.localStorage, 'half-1').status).toBe('running');
    hook.unmount();
  });

  test('refreshes the display timestamp when switching to a stored running clock', () => {
    window.localStorage.clear();
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000);
    saveRoomClock(
      'game-b',
      {
        version: 2,
        durationMs: 60_000,
        status: 'running',
        accumulatedMs: 0,
        runningSince: 1_000,
      },
      window.localStorage,
      'half-1',
    );

    now.mockReturnValue(5_000);
    const hook = renderHook(({ gameKey }: { gameKey: string }) => useRoomClock(gameKey, 1, 'half-1'), {
      initialProps: { gameKey: 'game-a' },
    });

    now.mockReturnValue(31_000);
    hook.rerender({ gameKey: 'game-b' });

    expect(hook.result.current.remainingMs).toBe(30_000);
    expect(hook.result.current.display).toBe('00:30');
    hook.unmount();
  });
});
