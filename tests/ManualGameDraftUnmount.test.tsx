/** @vitest-environment jsdom */

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { emptyInput } from '../src/app/ManualGameDraft';
import { useManualGameDraft } from '../src/app/useManualGameDraft';

afterEach(() => {
  window.localStorage.clear();
  vi.useRealTimers();
});

describe('manual game draft persistence', () => {
  test('persists the latest committed draft when the editor unmounts before the deferred save', () => {
    vi.useFakeTimers();
    const storageKey = 'qbsheet.test.manual-draft-unmount';
    const initial = emptyInput();
    const hook = renderHook(() => useManualGameDraft(storageKey, initial));

    act(() => {
      hook.result.current.setInput({
        ...initial,
        gameLabel: 'Round 7',
        left: { ...initial.left, name: 'Aiken' },
      });
    });

    // The normal zero-delay save has not run yet. Navigating away now used to cancel it in cleanup.
    expect(window.localStorage.getItem(storageKey)).toBeNull();
    hook.unmount();

    expect(JSON.parse(window.localStorage.getItem(storageKey) ?? 'null')).toMatchObject({
      gameLabel: 'Round 7',
      left: { name: 'Aiken' },
    });
  });
});
