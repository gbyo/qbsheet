import '@testing-library/jest-dom/vitest';
import { webcrypto } from 'node:crypto';
import { beforeEach } from 'vitest';

// jsdom supplies no WebCrypto. Pairing-code generation and hashing both use the real one, which
// is the point of the tests that cover them.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

/**
 * `localStorage`, which this jsdom does not provide.
 *
 * The same shim the root suite installs (`tests/localStorage.ts`), for the same reason: the whole
 * of QBBridge's persistence lives here, so an environment without one would pass the restart
 * tests by never having saved anything.
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

// Install the same object even when a Node version or jsdom happens to expose its own storage.
// The application uses globalThis.localStorage, and tests need to be able to spy on that exact
// object; otherwise Node 22 and Node 26 exercise different storage surfaces.
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  writable: true,
  value: new MemoryStorage(),
});

beforeEach(() => {
  globalThis.localStorage.clear();
});
