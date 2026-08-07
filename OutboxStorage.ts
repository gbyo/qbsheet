/**
 * Where the room's completed results actually live on the Chromebook.
 *
 * The outbox needs a store that survives a reload, holds more than one result at a time, and does
 * not fall over when a browser is in private mode or out of quota. IndexedDB is the only thing in a
 * browser that does the first two properly, so it is the real driver — but the code above it must
 * never depend on IndexedDB existing, because the case that matters most (a locked-down Chromebook
 * with storage disabled) is exactly the case where it doesn't.
 *
 * So this file is deliberately just two implementations of one four-method interface: a real
 * IndexedDB one, and an in-memory one used when IndexedDB is unavailable and by tests. A caller
 * that got the in-memory driver is told so, because "saved on this Chromebook" is a promise the
 * room app must not make when it isn't true.
 */

/**
 * One stored record, as the driver sees it.
 *
 * Only the key matters here. What is in the rest of the record is the outbox's business, and the
 * driver deliberately has no opinion about it — that is what lets the record schema change without
 * this file knowing.
 */
export interface IOutboxRecord {
  id: string;
}

/**
 * The whole storage surface the outbox needs.
 *
 * Deliberately tiny and asynchronous. IndexedDB is asynchronous, and pretending otherwise would
 * have meant either a synchronous facade that lies about durability or a second code path for
 * tests.
 */
export interface IOutboxDriver {
  /** True when a write to this driver genuinely survives a reload. */
  readonly durable: boolean;
  /** Every stored record. Unreadable individual records are the store's problem, not the caller's. */
  readAll(): Promise<IOutboxRecord[]>;
  /** Insert or replace one record by id. Rejects if the write did not land. */
  write(record: IOutboxRecord): Promise<void>;
  remove(id: string): Promise<void>;
  /** Remove everything. Used by tests and by an explicit operator reset, never automatically. */
  clear(): Promise<void>;
}

/** Database and object-store names. Changing either of these orphans existing results, so don't. */
export const outboxDatabaseName = 'yellowfruit-room';
export const outboxStoreName = 'results';

/**
 * IndexedDB's own schema version.
 *
 * Distinct from the outbox's record schema version: this one only governs the shape of the object
 * store, and the record version governs the shape of what goes in it. Conflating them would force a
 * database upgrade every time a field is added to a result.
 */
const indexedDbVersion = 1;

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('The browser refused the storage request.'));
  });
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(outboxDatabaseName, indexedDbVersion);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(outboxStoreName)) {
        database.createObjectStore(outboxStoreName, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('The browser refused to open local storage.'));
    // Private browsing can leave the open request permanently blocked rather than failing it.
    request.onblocked = () => reject(new Error('Local storage for saved results is blocked in this browser.'));
  });
}

/** A driver backed by real IndexedDB. Every method opens the database lazily and reuses it. */
export function createIndexedDbDriver(factory: IDBFactory): IOutboxDriver {
  let databasePromise: Promise<IDBDatabase> | null = null;

  const database = (): Promise<IDBDatabase> => {
    if (!databasePromise) {
      databasePromise = openDatabase(factory).catch((error: unknown) => {
        // Never cache a failed open: a browser that recovers storage part-way through a tournament
        // should start working again without a reload.
        databasePromise = null;
        throw error;
      });
    }
    return databasePromise;
  };

  const transact = async <T>(
    mode: 'readonly' | 'readwrite',
    run: (store: IDBObjectStore) => Promise<T>,
  ): Promise<T> => {
    const connection = await database();
    const transaction = connection.transaction(outboxStoreName, mode);
    const store = transaction.objectStore(outboxStoreName);
    const value = await run(store);
    // A readwrite transaction is not durable until it commits, and its request can succeed while
    // the transaction still aborts on quota. Wait for the commit before telling anyone it is saved.
    if (mode === 'readwrite') {
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error ?? new Error('The saved-result write was rolled back.'));
        transaction.onerror = () => reject(transaction.error ?? new Error('The saved-result write failed.'));
      });
    }
    return value;
  };

  return {
    durable: true,
    readAll: () =>
      transact('readonly', async (store) => {
        const rows = await promisifyRequest(store.getAll());
        return (Array.isArray(rows) ? rows : []).filter(
          (row): row is IOutboxRecord =>
            typeof row === 'object' && row !== null && typeof (row as IOutboxRecord).id === 'string',
        );
      }),
    write: (record) =>
      transact('readwrite', async (store) => {
        await promisifyRequest(store.put(record));
      }),
    remove: (id) =>
      transact('readwrite', async (store) => {
        await promisifyRequest(store.delete(id));
      }),
    clear: () =>
      transact('readwrite', async (store) => {
        await promisifyRequest(store.clear());
      }),
  };
}

/**
 * A driver that keeps records for the life of the page and no longer.
 *
 * Used by tests, and as the last-resort fallback when the browser has no usable IndexedDB. As a
 * fallback it reports `durable: false`, so the room app offers the QBJ download immediately instead
 * of claiming the result is safe on the device. Tests that are exercising the store's own semantics
 * rather than the fallback pass `durable: true` and treat a fresh outbox over the same driver as a
 * reload.
 */
export function createMemoryDriver(durable = false): IOutboxDriver {
  const records = new Map<string, IOutboxRecord>();
  return {
    durable,
    readAll: async () => Array.from(records.values()).map((record) => ({ ...record })),
    write: async (record) => {
      records.set(record.id, { ...record });
    },
    remove: async (id) => {
      records.delete(id);
    },
    clear: async () => {
      records.clear();
    },
  };
}

/** The window-ish object to look for IndexedDB on. Injectable so tests never touch a real one. */
export interface IStorageScope {
  indexedDB?: IDBFactory;
}

/** The best driver this browser can give us. */
export function resolveOutboxDriver(
  scope: IStorageScope | undefined = typeof window === 'undefined' ? undefined : window,
): IOutboxDriver {
  try {
    const factory = scope?.indexedDB;
    if (factory) return createIndexedDbDriver(factory);
  } catch {
    // Accessing indexedDB itself throws in some locked-down configurations.
  }
  return createMemoryDriver();
}
