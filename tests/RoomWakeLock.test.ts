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
});
