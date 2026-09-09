/** @vitest-environment jsdom */

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { emptyInput } from '../src/app/ManualGameDraft';
import { useManualGameDraft } from '../src/app/useManualGameDraft';

afterEach(() => {
  window.localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function wouldWarn(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

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
    expect(wouldWarn()).toBe(true);
    hook.unmount();

    expect(JSON.parse(window.localStorage.getItem(storageKey) ?? 'null')).toMatchObject({
      gameLabel: 'Round 7',
      left: { name: 'Aiken' },
    });
    expect(wouldWarn()).toBe(false);
  });

  test('removes the leave warning after a successful autosave', () => {
    vi.useFakeTimers();
    const initial = emptyInput();
    const hook = renderHook(() => useManualGameDraft('qbsheet.test.manual-draft-saved', initial));

    act(() => {
      hook.result.current.setInput({ ...initial, gameLabel: 'Round 8' });
    });
    expect(wouldWarn()).toBe(true);

    act(() => {
      vi.runAllTimers();
    });

    expect(hook.result.current.draftSaveState).toBe('saved');
    expect(wouldWarn()).toBe(false);
  });

  test('keeps warning on save failure and clears it after a later successful save', () => {
    vi.useFakeTimers();
    const initial = emptyInput();
    const setItem = vi.spyOn(Object.getPrototypeOf(window.localStorage), 'setItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    const hook = renderHook(() => useManualGameDraft('qbsheet.test.manual-draft-retry', initial));

    act(() => {
      hook.result.current.setInput({ ...initial, gameLabel: 'Round 9' });
    });
    act(() => {
      vi.runAllTimers();
    });

    expect(hook.result.current.draftSaveState).toBe('failed');
    expect(wouldWarn()).toBe(true);

    setItem.mockRestore();
    act(() => {
      hook.result.current.setInput({ ...initial, gameLabel: 'Round 10' });
    });
    act(() => {
      vi.runAllTimers();
    });

    expect(hook.result.current.draftSaveState).toBe('saved');
    expect(wouldWarn()).toBe(false);
  });
});
