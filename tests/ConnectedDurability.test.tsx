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
   * The sequence has to survive a reload, and it cannot lean on the clock to do it.
   *
   * QBTCP requires the number to increase within a session and has servers discard a lower one
   * *silently*, with a `200`. So a device that corrects its clock backward — an NTP sync, a manual
   * change, a machine that booted without a network — would resume numbering below where it left
   * off and spend the rest of the game filing snapshots that are accepted and thrown away. Nothing
   * in that sequence of events produces an error for anybody to notice, which is the whole reason
   * the high-water mark is stored rather than derived.
   */
  test('the progress sequence keeps rising across a reload that moved the clock backward', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-11T15:00:00.000Z'));

    const sequences: number[] = [];
    const persisted: number[] = [];
    const client = {
      ensureDiscovered: vi.fn(async () => null),
      assignment: vi.fn(async () => ({ ok: true as const, value: assignmentWithNothingToPlay })),
      putSnapshot: vi.fn(async (_credentials: unknown, _qbj: object, sequence: number) => {
        sequences.push(sequence);
        return { ok: true as const, value: {} };
      }),
    } as unknown as FruityServerClient;

    const room = (progressSequence?: number) =>
      renderHook(() =>
        useConnectedRuntime({
          client,
          identity: { roomId: 'room-1', token: 'room-token' },
          credentials: { sessionId: 'session-1', token: 'session-token' },
          enabled: true,
          progressSequence,
          onProgressSequence: (sequence) => persisted.push(sequence),
        }),
      );

    const before = room();
    act(() => before.result.current.reportProgress({ tossups_read: 1 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(progressIntervalMs);
    });
    expect(sequences).toHaveLength(1);
    before.unmount();

    // The tab reloads and the device's clock has been put back an hour in the meantime.
    vi.setSystemTime(new Date('2026-04-11T14:00:00.000Z'));
    const after = room(persisted[persisted.length - 1]);
    act(() => after.result.current.reportProgress({ tossups_read: 2 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(progressIntervalMs);
    });

    expect(sequences).toHaveLength(2);
    expect(sequences[1]).toBeGreaterThan(sequences[0]);
    // And what was stored is what was sent, so the next reload starts from the truth as well.
    expect(persisted).toEqual(sequences);
    after.unmount();
  });

  test('the sequence still rises within one session when the clock does not move at all', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-11T15:00:00.000Z'));
    const sequences: number[] = [];
    const client = {
      ensureDiscovered: vi.fn(async () => null),
      assignment: vi.fn(async () => ({ ok: true as const, value: assignmentWithNothingToPlay })),
      putSnapshot: vi.fn(async (_credentials: unknown, _qbj: object, sequence: number) => {
        sequences.push(sequence);
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

    for (const tossups of [1, 2, 3]) {
      act(() => hook.result.current.reportProgress({ tossups_read: tossups }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(progressIntervalMs);
      });
    }

    expect(sequences).toHaveLength(3);
    expect(sequences).toEqual([...sequences].sort((first, second) => first - second));
    expect(new Set(sequences).size).toBe(3);
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
