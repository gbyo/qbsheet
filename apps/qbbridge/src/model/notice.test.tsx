/**
 * The shell notice is local to QBBridge: routine confirmations expire, but failures stay until
 * the operator dismisses or replaces them.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { yftFixtureText } from '../tests/fixture';
import { noticeAutoDismissMs, useBridge } from './useBridge';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('Bridge notices', () => {
  test('a valid-load success notice disappears after the transient interval', () => {
    vi.useFakeTimers();
    const rendered = renderHook(() => useBridge());

    act(() => {
      rendered.result.current.loadFileContents('/tournaments/spring.yft', yftFixtureText());
    });

    expect(rendered.result.current.notice).toMatchObject({
      kind: 'good',
      message: expect.stringContaining('Loaded '),
    });

    act(() => vi.advanceTimersByTime(noticeAutoDismissMs - 1));
    expect(rendered.result.current.notice).not.toBeNull();

    act(() => vi.advanceTimersByTime(1));
    expect(rendered.result.current.notice).toBeNull();
    rendered.unmount();
  });

  test('a failed load notice persists until it is explicitly dismissed', () => {
    vi.useFakeTimers();
    const rendered = renderHook(() => useBridge());

    act(() => {
      rendered.result.current.loadFileContents(null, '{ not a YellowFruit file');
    });
    expect(rendered.result.current.notice?.kind).toBe('bad');

    act(() => vi.advanceTimersByTime(noticeAutoDismissMs * 2));
    expect(rendered.result.current.notice?.kind).toBe('bad');

    act(() => rendered.result.current.dismissNotice());
    expect(rendered.result.current.notice).toBeNull();
    rendered.unmount();
  });

  test('replacing a success notice resets its timer and unmount clears it', () => {
    vi.useFakeTimers();
    const rendered = renderHook(() => useBridge());

    act(() => {
      rendered.result.current.loadFileContents(null, yftFixtureText());
    });
    act(() => vi.advanceTimersByTime(noticeAutoDismissMs - 1));

    act(() => {
      rendered.result.current.loadFileContents(null, yftFixtureText());
    });
    act(() => vi.advanceTimersByTime(1));
    expect(rendered.result.current.notice).not.toBeNull();

    rendered.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
