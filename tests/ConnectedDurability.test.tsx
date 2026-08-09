/** @vitest-environment jsdom */

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { connectionVersion, readConnection, writeConnection } from '../src/app/ConnectedSession';
import useConnectedRuntime, { assignmentPollIntervalMs } from '../src/app/useConnectedRuntime';
import FruityServerClient, { IAssignmentResponse } from '../src/integrations/fruity/FruityServerClient';
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
    const assignment: IAssignmentResponse = {
      roomId: 'room-1',
      roomName: 'Room 1',
      tournamentName: 'Tournament',
      current: null,
      session: null,
      scoringFormat: null,
      timedRounds: false,
    };
    const client = {
      assignment: vi.fn(async () => ({ ok: true as const, value: assignment })),
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
});
