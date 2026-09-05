/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { DirectorNavigationTarget } from '../src/director/app/navigationTarget';
import { useNavigationHighlight } from '../src/director/app/useNavigationHighlight';

const target: DirectorNavigationTarget = {
  section: 'rooms',
  entityType: 'room',
  entityId: 'room-1',
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  const destination = document.createElement('div');
  destination.dataset.directorNavigationId = 'room-1';
  destination.tabIndex = -1;
  destination.scrollIntoView = vi.fn();
  document.body.append(destination);
});

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('an older timer does not clear a repeated navigation highlight', () => {
  const hook = renderHook(
    ({ navigationTarget }: { navigationTarget: DirectorNavigationTarget | null }) =>
      useNavigationHighlight(navigationTarget, 'rooms', 'room', 'room-1'),
    { initialProps: { navigationTarget: target as DirectorNavigationTarget | null } },
  );

  expect(hook.result.current).toBe(true);

  // The one-shot navigation target is normally cleared immediately after focus lands.
  hook.rerender({ navigationTarget: null });
  act(() => vi.advanceTimersByTime(800));

  // Navigate to the same destination again before the first 1.6 s treatment has expired.
  hook.rerender({ navigationTarget: { ...target } });
  expect(hook.result.current).toBe(true);

  // The first treatment expires now. It must not clear the newer one halfway through its lifetime.
  act(() => vi.advanceTimersByTime(800));
  expect(hook.result.current).toBe(true);

  act(() => vi.advanceTimersByTime(800));
  expect(hook.result.current).toBe(false);
});
