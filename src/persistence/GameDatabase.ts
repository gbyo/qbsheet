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
  list(): Promise<T[]>;
  get(id: string): Promise<T | null>;
  put(record: T): Promise<boolean>;
  delete(id: string): Promise<boolean>;
}

/** Used when IndexedDB is unavailable, and by tests that want no persistence at all. */
export class MemoryRecordStore<T extends { id: string }> implements IRecordStore<T> {
  readonly durable = false;

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
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

class IndexedDbRecordStore<T extends { id: string }> implements IRecordStore<T> {
  readonly durable = true;

  constructor(
    private database: IDBDatabase,
    private storeName: string,
  ) {}

  private run<R>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest): Promise<R | null> {
    return new Promise((resolve) => {
      let request: IDBRequest;
      try {
        const transaction = this.database.transaction(this.storeName, mode);
        transaction.onerror = () => resolve(null);
        transaction.onabort = () => resolve(null);
        request = work(transaction.objectStore(this.storeName));
      } catch {
        resolve(null);
        return;
      }
      request.onsuccess = () => resolve(request.result as R);
      request.onerror = () => resolve(null);
    });
  }

  async list(): Promise<T[]> {
    const all = await this.run<T[]>('readonly', (store) => store.getAll());
    return all ?? [];
  }

  async get(id: string): Promise<T | null> {
    return (await this.run<T>('readonly', (store) => store.get(id))) ?? null;
  }

  async put(record: T): Promise<boolean> {
    // `put` resolves to the key, so anything non-null is a write that happened.
    return (await this.run<IDBValidKey>('readwrite', (store) => store.put(record))) !== null;
  }

  async delete(id: string): Promise<boolean> {
    // A successful delete resolves undefined, which is indistinguishable from the failure sentinel
    // through `run`, so ask separately whether the record survived.
    await this.run<undefined>('readwrite', (store) => store.delete(id));
    return (await this.get(id)) === null;
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
  if (storeName === gameStoreName && (await store.list()).length === 0) {
    const legacy = await openDatabaseNamed(legacyDatabaseName);
    if (legacy) {
      const legacyStore = new IndexedDbRecordStore<T>(legacy, gameStoreName);
      const records = await legacyStore.list();
      for (const record of records) await store.put(record);
      legacy.close();
    }
  }
  return store;
}
