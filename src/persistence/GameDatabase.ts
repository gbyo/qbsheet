/**
 * The durable store, and what happens when the browser will not give us one.
 *
 * IndexedDB is the right home for finished games: it holds the QBJ payloads, it is not capped at a
 * few megabytes the way `localStorage` is, and a season of results in it costs nothing. It is also
 * asynchronous, which is exactly wrong for the one write that must never be lost — see
 * `GameStore` for how the in-progress event history is journalled synchronously alongside it.
 *
 * # Failure is a state, not an exception
 *
 * A locked-down Chromebook profile, private browsing, a corrupted database, a quota that is already
 * full: all of them are things that happen in a hallway at 8:40 on a Saturday. None of them may
 * throw out of a call the scoresheet makes. So every operation resolves, the store reports whether
 * it is actually durable, and a store that is not says so loudly rather than quietly pretending
 * (see `LocalSaveWarning`). The in-memory fallback keeps the application working for the game in
 * front of the room; it does not keep it safe, and it does not claim to.
 */

export const databaseName = 'qbsheet';
/** The old database is read once so a deployed rename cannot strand an in-progress game. */
const legacyDatabaseName = 'standalone-scorekeeper';
export const databaseVersion = 1;
export const gameStoreName = 'games';

export interface IRecordStore<T extends { id: string }> {
  /** Whether writes to this store survive the tab closing. */
  readonly durable: boolean;
  /** Whether a previously opened durable store is currently unavailable. */
  readonly storageDegraded?: boolean;
  /** A safe-to-display explanation for the current storage failure, when there is one. */
  readonly storageError?: string;
  /** Notify a host when storage health changes. */
  subscribeToStatus?(listener: () => void): () => void;
  list(): Promise<T[]>;
  get(id: string): Promise<T | null>;
  put(record: T): Promise<boolean>;
  delete(id: string): Promise<boolean>;
}

/** Used when IndexedDB is unavailable, and by tests that want no persistence at all. */
export class MemoryRecordStore<T extends { id: string }> implements IRecordStore<T> {
  readonly durable = false;
  readonly storageDegraded = false;

  private records = new Map<string, T>();

  async list(): Promise<T[]> {
    return [...this.records.values()];
  }

  async get(id: string): Promise<T | null> {
    return this.records.get(id) ?? null;
  }

  async put(record: T): Promise<boolean> {
    this.records.set(record.id, record);
    // Deliberately false: the record is here, but "saved" is a promise about surviving a reload and
    // this store cannot make it.
    return false;
  }

  async delete(id: string): Promise<boolean> {
    this.records.delete(id);
    return false;
  }
}

function openDatabaseNamed(name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(name, databaseVersion);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(gameStoreName)) {
        database.createObjectStore(gameStoreName, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

class IndexedDbRecordStore<T extends { id: string }> implements IRecordStore<T> {
  readonly durable = true;

  private database: IDBDatabase | null;
  private degraded = false;
  private error: string | undefined;
  private reopening: Promise<boolean> | null = null;
  private readonly statusListeners = new Set<() => void>();

  constructor(
    database: IDBDatabase,
    private storeName: string,
    private databaseNameForReopen: string = databaseName,
  ) {
    this.database = database;
    this.attachDatabase(database);
  }

  get storageDegraded(): boolean {
    return this.degraded;
  }

  get storageError(): string | undefined {
    return this.error;
  }

  subscribeToStatus(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private notifyStatus(): void {
    for (const listener of this.statusListeners) listener();
  }

  private attachDatabase(database: IDBDatabase): void {
    this.database = database;
    database.onversionchange = () => {
      this.markDegraded('The local game database changed and is being reopened.');
    };
  }

  private markHealthy(): void {
    if (!this.degraded && this.error === undefined) return;
    this.degraded = false;
    this.error = undefined;
    this.notifyStatus();
  }

  private markDegraded(message: string): void {
    const changed = !this.degraded || this.error !== message;
    this.degraded = true;
    this.error = message;
    const database = this.database;
    this.database = null;
    try {
      database?.close();
    } catch {
      // Closing an already-broken connection is best effort.
    }
    if (changed) this.notifyStatus();
    void this.reopen();
  }

  private async reopen(): Promise<boolean> {
    if (this.reopening) return this.reopening;
    this.reopening = (async () => {
      const opened = await openDatabaseNamed(this.databaseNameForReopen);
      if (!opened) return false;
      this.attachDatabase(opened);
      return true;
    })().finally(() => {
      this.reopening = null;
    });
    return this.reopening;
  }

  private async ready(): Promise<boolean> {
    // A reopened connection is not declared healthy until a transaction commits. This keeps a
    // failed `list()` distinguishable from a successful empty list even when reopening is quick.
    if (this.database) return true;
    return this.reopen();
  }

  private async run<R>(
    mode: IDBTransactionMode,
    work: (store: IDBObjectStore) => IDBRequest,
  ): Promise<{ ok: true; result: R } | { ok: false }> {
    if (!(await this.ready())) return { ok: false };
    return new Promise((resolve) => {
      let request: IDBRequest;
      let requestResult!: R;
      let requestFailed = false;
      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        this.markDegraded('The local game database could not complete a transaction.');
        resolve({ ok: false });
      };
      try {
        const database = this.database;
        if (!database) {
          fail();
          return;
        }
        const transaction = database.transaction(this.storeName, mode);
        transaction.onerror = fail;
        transaction.onabort = fail;
        transaction.oncomplete = () => {
          if (requestFailed) fail();
          else if (!settled) {
            settled = true;
            this.markHealthy();
            resolve({ ok: true, result: requestResult });
          }
        };
        request = work(transaction.objectStore(this.storeName));
      } catch {
        fail();
        return;
      }
      request.onsuccess = () => {
        requestResult = request.result as R;
      };
      request.onerror = () => {
        requestFailed = true;
      };
    });
  }

  async list(): Promise<T[]> {
    const result = await this.run<T[]>('readonly', (store) => store.getAll());
    return result.ok ? result.result : [];
  }

  async get(id: string): Promise<T | null> {
    const result = await this.run<T | null>('readonly', (store) => store.get(id));
    return result.ok ? result.result ?? null : null;
  }

  async put(record: T): Promise<boolean> {
    return (await this.run<IDBValidKey>('readwrite', (store) => store.put(record))).ok;
  }

  async delete(id: string): Promise<boolean> {
    const removed = await this.run<undefined>('readwrite', (store) => store.delete(id));
    if (!removed.ok) return false;
    const remaining = await this.run<T | null>('readonly', (store) => store.get(id));
    return remaining.ok && remaining.result === undefined;
  }
}

/**
 * Open the durable store, or the honest substitute for it.
 *
 * Never rejects. A caller that gets a store with `durable === false` has a working application and a
 * scorekeeper who needs to be told to download a QBJ backup now rather than at the end.
 */
export async function openRecordStore<T extends { id: string }>(
  storeName: string = gameStoreName,
): Promise<IRecordStore<T>> {
  const database = await openDatabaseNamed(databaseName);
  if (!database) return new MemoryRecordStore<T>();
  const store = new IndexedDbRecordStore<T>(database, storeName);

  // The product was renamed after the first public build. Copy the old game records into the new
  // database before the app starts looking for an unfinished game, and never delete the old copy:
  // it is a recoverable fallback if a browser interrupts this one-time migration.
  if (storeName === gameStoreName && !store.storageDegraded) {
    const current = await store.list();
    if (!store.storageDegraded && current.length === 0) {
      const legacy = await openDatabaseNamed(legacyDatabaseName);
      if (legacy) {
        const legacyStore = new IndexedDbRecordStore<T>(legacy, gameStoreName, legacyDatabaseName);
        const records = await legacyStore.list();
        if (!legacyStore.storageDegraded) {
          for (const record of records) await store.put(record);
        }
        legacy.close();
      }
    }
  }
  return store;
}
