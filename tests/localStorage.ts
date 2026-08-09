/**
 * `window.localStorage`, which this jsdom does not provide.
 *
 * The scorer's journal — the write that makes a scored question safe in the same turn as the click
 * — goes to `localStorage`, so a test environment without one would exercise a browser that cannot
 * save and quietly pass tests about recovery for the wrong reason. This is the Storage interface,
 * backed by a Map, with the two behaviours the code under test actually depends on: `setItem` can
 * be made to throw, and reads see what writes put there.
 *
 * Installed only when the environment has none, so a jsdom that grows one later takes over.
 */
class MemoryStorage implements Storage {
  private entries = new Map<string, string>();

  get length(): number {
    return this.entries.size;
  }

  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.entries.set(key, String(value));
  }

  removeItem(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}

if (typeof window !== 'undefined' && !window.localStorage) {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    writable: true,
    value: new MemoryStorage(),
  });
}

export {};
