import { emptyDirectorState, type DirectorState } from '../domain';
import { normalizeDirectorState } from './stateMigrations';

const databaseName = 'qbsheet-director';
const databaseVersion = 1;
const stateStoreName = 'tournament-state';
const stateKey = 'current';
const localStorageKey = 'qbsheet.director.state.v1';

export interface DirectorRepository {
  readonly kind: 'tauri-sqlite' | 'indexeddb' | 'memory';
  load(): Promise<DirectorState>;
  save(state: DirectorState): Promise<void>;
  checkpoint(state: DirectorState, reason: string): Promise<void>;
}

export class DirectorPersistenceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DirectorPersistenceError';
  }
}

interface TauriInternals {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: TauriInternals;
  }
}

function tauri(): TauriInternals | null {
  if (typeof window === 'undefined') return null;
  return window.__TAURI_INTERNALS__ ?? null;
}

export class TauriDirectorRepository implements DirectorRepository {
  readonly kind = 'tauri-sqlite' as const;

  constructor(private readonly bridge: TauriInternals) {}

  async load(): Promise<DirectorState> {
    return normalizeDirectorState(await this.bridge.invoke('director_load_state'));
  }

  async save(state: DirectorState): Promise<void> {
    await this.bridge.invoke('director_save_state', { state });
  }

  async checkpoint(state: DirectorState, reason: string): Promise<void> {
    await this.bridge.invoke('director_checkpoint', { state, reason });
  }
}

export class IndexedDbDirectorRepository implements DirectorRepository {
  readonly kind = 'indexeddb' as const;
  private databasePromise: Promise<IDBDatabase | null> | null = null;

  async load(): Promise<DirectorState> {
    const database = await this.database();
    if (!database) return this.loadLocalStorage();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(stateStoreName, 'readonly');
      const request = transaction.objectStore(stateStoreName).get(stateKey);
      request.onsuccess = () => {
        try {
          resolve(normalizeDirectorState(request.result));
        } catch (reason: unknown) {
          reject(reason);
        }
      };
      request.onerror = () =>
        reject(
          new DirectorPersistenceError('Director browser storage could not be read.', {
            cause: request.error,
          }),
        );
      transaction.onabort = () =>
        reject(
          new DirectorPersistenceError('Director browser storage read was aborted.', {
            cause: transaction.error,
          }),
        );
    });
  }

  async save(state: DirectorState): Promise<void> {
    let persisted: string;
    try {
      persisted = JSON.stringify(state);
    } catch (reason: unknown) {
      throw new DirectorPersistenceError('Director state could not be serialized for browser storage.', {
        cause: reason,
      });
    }
    const database = await this.database();
    if (!database) {
      this.saveLocalStorage(persisted);
      return;
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(stateStoreName, 'readwrite');
        transaction.objectStore(stateStoreName).put(state, stateKey);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error('Director storage failed.'));
        transaction.onabort = () => reject(transaction.error ?? new Error('Director storage was aborted.'));
      });
    } catch (reason: unknown) {
      // A browser can expose IndexedDB but reject writes (private mode, quota, or a disabled origin).
      // A localStorage fallback is acceptable only when it actually succeeds; never report a save as
      // complete after swallowing both failures.
      try {
        this.saveLocalStorage(persisted);
      } catch (fallbackReason: unknown) {
        throw new DirectorPersistenceError('Director browser storage could not be saved.', {
          cause: fallbackReason ?? reason,
        });
      }
    }
  }

  async checkpoint(state: DirectorState, _reason: string): Promise<void> {
    await this.save(state);
  }

  private database(): Promise<IDBDatabase | null> {
    if (!this.databasePromise) this.databasePromise = openDatabase();
    return this.databasePromise;
  }

  private loadLocalStorage(): DirectorState {
    if (typeof localStorage === 'undefined') {
      throw new DirectorPersistenceError('Director browser storage is unavailable in this browser.');
    }
    try {
      const value = localStorage.getItem(localStorageKey);
      return normalizeDirectorState(value === null ? null : JSON.parse(value));
    } catch (reason: unknown) {
      if (reason instanceof Error && reason.name === 'DirectorStateVersionError') throw reason;
      throw new DirectorPersistenceError('Director browser storage could not be read.', { cause: reason });
    }
  }

  private saveLocalStorage(value: string): void {
    if (typeof localStorage === 'undefined') {
      throw new DirectorPersistenceError('Director browser storage is unavailable in this browser.');
    }
    try {
      localStorage.setItem(localStorageKey, value);
    } catch (reason: unknown) {
      throw new DirectorPersistenceError('Director browser storage quota or permissions prevented saving.', {
        cause: reason,
      });
    }
  }
}

export class MemoryDirectorRepository implements DirectorRepository {
  readonly kind = 'memory' as const;
  private state = emptyDirectorState();

  async load(): Promise<DirectorState> {
    return structuredClone(this.state);
  }

  async save(state: DirectorState): Promise<void> {
    this.state = structuredClone(state);
  }

  async checkpoint(state: DirectorState, _reason: string): Promise<void> {
    await this.save(state);
  }
}

export function createDirectorRepository(): DirectorRepository {
  const bridge = tauri();
  if (bridge) return new TauriDirectorRepository(bridge);
  if (typeof indexedDB !== 'undefined' || typeof localStorage !== 'undefined')
    return new IndexedDbDirectorRepository();
  return new MemoryDirectorRepository();
}

function openDatabase(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(databaseName, databaseVersion);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(stateStoreName))
        request.result.createObjectStore(stateStoreName);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}
