/** @vitest-environment jsdom */

import { act, renderHook } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import useScreenWakeLock from '../src/scorer/useScreenWakeLock';

function visibleDocument() {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
}

describe('screen wake lock acquisition', () => {
  test('serializes delayed requests and releases a lock resolved after cleanup', async () => {
    visibleDocument();
    let resolveRequest: (sentinel: { release: () => Promise<void> }) => void = () => undefined;
    const release = vi.fn(() => Promise.resolve());
    const request = vi.fn(
      () =>
        new Promise<{ release: () => Promise<void> }>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request } });

    const hook = renderHook(() => useScreenWakeLock(true));
    expect(request).toHaveBeenCalledTimes(1);
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(request).toHaveBeenCalledTimes(1);

    hook.unmount();
    await act(async () => {
      resolveRequest({ release });
      await Promise.resolve();
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  test('reacquires when the browser revokes a visible wake lock', async () => {
    visibleDocument();
    const first = Object.assign(new EventTarget(), {
      release: vi.fn(() => Promise.resolve()),
    });
    const second = Object.assign(new EventTarget(), {
      release: vi.fn(() => Promise.resolve()),
    });
    const request = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request } });

    const hook = renderHook(() => useScreenWakeLock(true));
    await act(async () => {
      await Promise.resolve();
    });
    expect(request).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.dispatchEvent(new Event('release'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(request).toHaveBeenCalledTimes(2);
    hook.unmount();
  });
});
