import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { NativeServerStatus } from '../src/director/platform/native';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('native server status activation', () => {
  test('reactivation waits for a fresh snapshot instead of reusing the previous one', async () => {
    const native = await import('../src/director/platform/native');
    const first = deferred<NativeServerStatus>();
    const second = deferred<NativeServerStatus>();
    const read = vi
      .spyOn(native, 'readNativeServerStatus')
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const { useNativeServerStatus } = await import('../src/director/server/useNativeServerStatus');

    const { result, rerender, unmount } = renderHook(({ active }) => useNativeServerStatus({ active }), {
      initialProps: { active: true },
    });

    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    expect(result.current.loading).toBe(true);

    rerender({ active: false });
    expect(result.current.loading).toBe(false);
    expect(result.current.status).toEqual({ running: false });

    await act(async () => {
      first.resolve({
        running: true,
        pairingCode: 'OLD123',
        pairingInvitations: [
          {
            roomId: 'old-room',
            roomName: 'Old room',
            pairingCode: 'OLD123',
            issuedAt: '2026-09-09T12:00:00.000Z',
            expiresAt: '2026-09-09T12:05:00.000Z',
            expiresInSeconds: 300,
          },
        ],
      });
      await first.promise;
    });
    expect(result.current.status).toEqual({ running: false });

    rerender({ active: true });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(result.current.loading).toBe(true);
    expect(result.current.status).toEqual({ running: false });

    await act(async () => {
      second.resolve({
        running: true,
        pairingCode: 'NEW456',
        pairingInvitations: [
          {
            roomId: 'new-room',
            roomName: 'New room',
            pairingCode: 'NEW456',
            issuedAt: '2999-09-09T12:00:00.000Z',
            expiresAt: '2999-09-09T12:05:00.000Z',
            expiresInSeconds: 300,
          },
        ],
      });
      await second.promise;
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.status).toEqual(
      expect.objectContaining({
        running: true,
        pairingCode: 'NEW456',
        expiredPairingRoomIds: [],
      }),
    );

    unmount();
    read.mockRestore();
  });
});
