import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { useDurableRecordFlag } from './useDurableRecordFlag';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useDurableRecordFlag', () => {
  test('degradation applies immediately without a render-phase state update', () => {
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    const { result, rerender } = renderHook(
      ({ durable, degraded }: { durable: boolean; degraded: boolean }) =>
        useDurableRecordFlag(durable, degraded),
      { initialProps: { durable: true, degraded: false } },
    );
    expect(result.current[0]).toBe(true);

    // The store stops being durable: the very next render already stops presenting safety.
    rerender({ durable: false, degraded: false });
    expect(result.current[0]).toBe(false);

    expect(
      errors.filter((args) =>
        (args as unknown[]).some(
          (part) => typeof part === 'string' && part.includes('Cannot update a component'),
        ),
      ),
    ).toHaveLength(0);
    spy.mockRestore();
  });

  test('recovery re-presents safety only through the live props; saves still gate it', () => {
    const { result, rerender } = renderHook(
      ({ durable, degraded }: { durable: boolean; degraded: boolean }) =>
        useDurableRecordFlag(durable, degraded),
      { initialProps: { durable: true, degraded: false } },
    );
    rerender({ durable: false, degraded: false });
    expect(result.current[0]).toBe(false);

    // Props recover: presentation follows the live props, with no second render needed.
    rerender({ durable: true, degraded: false });
    expect(result.current[0]).toBe(true);

    // A failed save still drops the safe presentation even with healthy props.
    act(() => {
      result.current[1](false);
    });
    expect(result.current[0]).toBe(false);
  });

  test('storage degradation applies the same way', () => {
    const { result, rerender } = renderHook(
      ({ durable, degraded }: { durable: boolean; degraded: boolean }) =>
        useDurableRecordFlag(durable, degraded),
      { initialProps: { durable: true, degraded: false } },
    );
    rerender({ durable: true, degraded: true });
    expect(result.current[0]).toBe(false);
    rerender({ durable: true, degraded: false });
    expect(result.current[0]).toBe(true);
  });

  test('a stale degraded prop cannot overwrite a successful save', () => {
    const { result, rerender } = renderHook(
      ({ durable, degraded }: { durable: boolean; degraded: boolean }) =>
        useDurableRecordFlag(durable, degraded),
      { initialProps: { durable: false, degraded: false } },
    );
    expect(result.current[0]).toBe(false);
    // A write that reported success against the store's own view wins.
    act(() => {
      result.current[1](true);
    });
    // Props still say non-durable: derivation stays conservative until they catch up.
    expect(result.current[0]).toBe(false);
    rerender({ durable: true, degraded: false });
    expect(result.current[0]).toBe(true);
  });
});
