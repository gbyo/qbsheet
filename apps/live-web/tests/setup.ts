import '@testing-library/jest-dom/vitest';

/**
 * Give the jsdom window a `localStorage`.
 *
 * Node 26 defines a global `localStorage` accessor that is `undefined` unless the process was
 * started with `--localstorage-file`. Because the test environment shares one global object, that
 * accessor wins over the one jsdom would have installed, and `window.localStorage` comes out
 * undefined — the same collision the scorer's suite hits with `BroadcastChannel` (see
 * `tests/broadcastChannel.ts` at the repository root).
 *
 * A real browser has real storage, so faking it here is not weakening the tests: it restores the
 * platform behaviour the code is written against, and the staleness tests genuinely exercise
 * serialization, quota-free writes, and reads back across a remount.
 */
if (typeof window !== 'undefined' && !window.localStorage) {
  const entries = new Map<string, string>();
  const shim: Storage = {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key: string) => entries.get(key) ?? null,
    key: (index: number) => [...entries.keys()][index] ?? null,
    removeItem: (key: string) => void entries.delete(key),
    setItem: (key: string, value: string) => void entries.set(key, String(value)),
  };
  Object.defineProperty(window, 'localStorage', { value: shim, configurable: true });
}
