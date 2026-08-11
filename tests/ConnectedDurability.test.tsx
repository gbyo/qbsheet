/** @vitest-environment jsdom */

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { connectionVersion, readConnection, writeConnection } from '../src/app/ConnectedSession';
import useConnectedRuntime, { assignmentPollIntervalMs } from '../src/app/useConnectedRuntime';
import FruityServerClient, { INormalizedAssignment } from '../src/integrations/fruity/FruityServerClient';
import { progressIntervalMs } from '../src/integrations/fruity/FruityResultDestination';

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

afterEach(() => {
  vi.useRealTimers();
});

/** A poll that answers, and answers with nothing to play, so it never changes what is on screen. */
const assignmentWithNothingToPlay: INormalizedAssignment = {
  state: 'none',
  roomId: 'room-1',
  roomName: 'Room 1',
  tournamentName: 'Tournament',
  definition: null,
  session: null,
};

describe('connected room durability', () => {
  test('keeps stored room and session credentials until explicitly cleared', () => {
    const storage = new TestStorage();
    const storedAt = new Date('2026-01-01T12:00:00.000Z');
    const muchLater = new Date('2036-01-01T12:00:00.000Z');

    expect(
      writeConnection(
        {
          baseUrl: 'http://192.168.1.20:8787',
          roomId: 'room-1',
          roomName: 'Room 1',
          roomToken: 'room-token',
          deviceId: 'device-1',
          sessionId: 'session-1',
          sessionToken: 'session-token',
          tournamentKey: 'tournament-1',
        },
        storedAt,
        storage,
      ),
    ).toBe(true);

    expect(readConnection(muchLater, storage)).toMatchObject({
      version: connectionVersion,
      roomId: 'room-1',
      roomToken: 'room-token',
      sessionId: 'session-1',
      sessionToken: 'session-token',
    });
  });

  test('re-offers the latest snapshot on periodic successful server polls', async () => {
    vi.useFakeTimers();
    const snapshots: object[] = [];
    const client = {
      ensureDiscovered: vi.fn(async () => null),
      assignment: vi.fn(async () => ({ ok: true as const, value: assignmentWithNothingToPlay })),
      putSnapshot: vi.fn(async (_credentials: unknown, qbj: object) => {
        snapshots.push(qbj);
        return { ok: true as const, value: {} };
      }),
    } as unknown as FruityServerClient;

    const hook = renderHook(() =>
      useConnectedRuntime({
        client,
        identity: { roomId: 'room-1', token: 'room-token' },
        credentials: { sessionId: 'session-1', token: 'session-token' },
        enabled: true,
      }),
    );

    const latest = { match: 'current-state' };
    act(() => hook.result.current.reportProgress(latest));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(progressIntervalMs);
    });
    expect(snapshots).toEqual([latest]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(assignmentPollIntervalMs);
    });
    expect(snapshots).toEqual([latest, latest]);

    hook.unmount();
  });

  /**
   * A blocked write is not a pending one.
   *
   * `pending` is a promise that something is still trying, and the completion screen makes it in
   * those words. A room another device took the writer lock from has nothing trying on its behalf,
   * so a scorekeeper told to wait would wait for the rest of the tournament. The distinction is
   * decided where the facts are — at the moment of the write — because a caller reading a rendered
   * copy of it is wrong in exactly the case that produces this state: a snapshot refused in the
   * instant somebody was pressing Submit.
   */
  test('a final blocked by a writer conflict is refused, not left pending', async () => {
    vi.useFakeTimers();
    const postFinal = vi.fn(async () => ({ ok: true as const, value: { accepted: true, duplicate: false } }));
    const client = {
      ensureDiscovered: vi.fn(async () => null),
      assignment: vi.fn(async () => ({ ok: true as const, value: assignmentWithNothingToPlay })),
      putSnapshot: vi.fn(async () => ({
        ok: false as const,
        status: 409,
        error: 'Another device is scoring this game.',
        payload: { can_take_over: true },
      })),
      postFinal,
    } as unknown as FruityServerClient;

    const hook = renderHook(() =>
      useConnectedRuntime({
        client,
        identity: { roomId: 'room-1', token: 'room-token' },
        credentials: { sessionId: 'session-1', token: 'session-token' },
        enabled: true,
      }),
    );

    act(() => hook.result.current.reportProgress({ tossups_read: 1 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(progressIntervalMs);
    });
    expect(hook.result.current.automaticDelivery).toBe(false);

    const delivered = await hook.result.current.submitFinal({ tossups_read: 20 });

    expect(delivered.delivery).toBe('rejected');
    expect(delivered.detail).toBeTruthy();
    // And nothing was filed over the device that holds the lock.
    expect(postFinal).not.toHaveBeenCalled();

    hook.unmount();
  });

  test('a final nobody could deliver is pending, because retrying it is worth something', async () => {
    const client = {
      ensureDiscovered: vi.fn(async () => null),
      assignment: vi.fn(async () => ({ ok: true as const, value: assignmentWithNothingToPlay })),
      postFinal: vi.fn(async () => ({ ok: false as const, error: 'Could not reach tournament control.' })),
    } as unknown as FruityServerClient;

    const hook = renderHook(() =>
      useConnectedRuntime({
        client,
        identity: { roomId: 'room-1', token: 'room-token' },
        credentials: { sessionId: 'session-1', token: 'session-token' },
        enabled: true,
      }),
    );

    const delivered = await hook.result.current.submitFinal({ tossups_read: 20 });

    expect(delivered.delivery).toBe('pending');

    hook.unmount();
  });
});
