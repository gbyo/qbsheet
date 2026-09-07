/** @vitest-environment jsdom */

import { describe, expect, test } from 'vitest';
import { crashCountStorageKey, readCrashCount } from '../src/app/RenderErrorBoundary';

function storageWith(value: string) {
  return {
    getItem: (key: string) => (key === crashCountStorageKey ? value : null),
    setItem: () => undefined,
  };
}

describe('render crash count parsing', () => {
  test('accepts only the complete positive integer written by QBSheet', () => {
    expect(readCrashCount(storageWith('2'))).toBe(2);
    expect(readCrashCount(storageWith('2junk'))).toBe(0);
    expect(readCrashCount(storageWith('2.5'))).toBe(0);
    expect(readCrashCount(storageWith(' 2'))).toBe(0);
    expect(readCrashCount(storageWith('9007199254740992'))).toBe(0);
  });
});
