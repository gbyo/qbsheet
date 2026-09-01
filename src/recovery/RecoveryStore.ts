import { retainRecoveryCheckpoints, IRecoveryCheckpointLimits } from './RecoveryCheckpoints';
import {
  IRecoveryCheckpoint,
  IRecoveryDirectoryHandle,
  IRecoveryFilenameMapping,
  IRecoverySettings,
  recoverySettingsId,
} from './RecoveryTypes';

/** A separate database keeps recovery migrations independent from the game-record schema. */
export const recoveryDatabaseName = 'qbsheet-recovery';
export const recoveryDatabaseVersion = 1;
export const recoverySettingsStoreName = 'settings';
export const recoveryFilenameMappingsStoreName = 'filename-mappings';
export const recoveryCheckpointsStoreName = 'checkpoints';

export interface IRecoveryStore {
  /** True only when records survive closing and reopening the browser. */
  readonly durable: boolean;
  readonly storageDegraded: boolean;
  readonly storageError?: string;
  getSettings(): Promise<IRecoverySettings | null>;
  putSettings(settings: IRecoverySettings): Promise<boolean>;
  /** Clears QBSheet's remembered configuration; it never touches user files in the folder. */
  clearExternalConfiguration(): Promise<boolean>;
  getFilenameMapping(gameKey: string): Promise<IRecoveryFilenameMapping | null>;
  listFilenameMappings(): Promise<IRecoveryFilenameMapping[]>;
  putFilenameMapping(mapping: IRecoveryFilenameMapping): Promise<boolean>;
  listCheckpoints(gameKey: string): Promise<IRecoveryCheckpoint[]>;
  /** Optional enumeration for Recovery Mode; older store adapters may only support per-game reads. */
  listAllCheckpoints?(): Promise<IRecoveryCheckpoint[]>;
  /** Put and prune in sequence so rapid checkpoint calls cannot race each other. */
  saveCheckpoint(checkpoint: IRecoveryCheckpoint, limits?: IRecoveryCheckpointLimits): Promise<boolean>;
  deleteCheckpoint(id: string): Promise<boolean>;
}

/** The honest fallback used when IndexedDB is missing, blocked, or broken. */
export class MemoryRecoveryStore implements IRecoveryStore {
  readonly durable = false;
  readonly storageDegraded = false;
  private settings: IRecoverySettings | null = null;
  private mappings = new Map<string, IRecoveryFilenameMapping>();
  private checkpoints = new Map<string, IRecoveryCheckpoint>();
  private tail: Promise<void> = Promise.resolve();

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async getSettings(): Promise<IRecoverySettings | null> {
    return this.settings;
  }

  async putSettings(settings: IRecoverySettings): Promise<boolean> {
    return this.enqueue(async () => {
      this.settings = settings;
      return false;
    });
  }

  async clearExternalConfiguration(): Promise<boolean> {
    return this.enqueue(async () => {
      this.settings = null;
      this.mappings.clear();
      return false;
    });
  }

  async getFilenameMapping(gameKey: string): Promise<IRecoveryFilenameMapping | null> {
    return this.mappings.get(gameKey) ?? null;
  }

  async listFilenameMappings(): Promise<IRecoveryFilenameMapping[]> {
    return [...this.mappings.values()];
  }

  async putFilenameMapping(mapping: IRecoveryFilenameMapping): Promise<boolean> {
    return this.enqueue(async () => {
      this.mappings.set(mapping.gameKey, mapping);
      return false;
    });
  }

  async listCheckpoints(gameKey: string): Promise<IRecoveryCheckpoint[]> {
    return [...this.checkpoints.values()].filter((checkpoint) => checkpoint.gameKey === gameKey);
  }

  async listAllCheckpoints(): Promise<IRecoveryCheckpoint[]> {
    return [...this.checkpoints.values()];
  }

  async saveCheckpoint(
    checkpoint: IRecoveryCheckpoint,
    limits?: IRecoveryCheckpointLimits,
  ): Promise<boolean> {
    return this.enqueue(async () => {
      this.checkpoints.set(checkpoint.id, checkpoint);
      const current = [...this.checkpoints.values()].filter(
        (candidate) => candidate.gameKey === checkpoint.gameKey,
      );
      const retained = new Set(retainRecoveryCheckpoints(current, limits).map((candidate) => candidate.id));
      for (const candidate of current) {
        if (!retained.has(candidate.id)) this.checkpoints.delete(candidate.id);
      }
      return false;
    });
  }

  async deleteCheckpoint(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      this.checkpoints.delete(id);
      return false;
    });
  }
}

export interface IRecoveryStoreEnvironment {
  /** `null` explicitly disables IndexedDB; omission uses the global browser factory. */
  indexedDB?: IDBFactory | null;
  databaseName?: string;
}

type RecoveryStoreName =
  | typeof recoverySettingsStoreName
  | typeof recoveryFilenameMappingsStoreName
  | typeof recoveryCheckpointsStoreName;

function globalIndexedDb(): IDBFactory | null {
  try {
    return typeof indexedDB === 'undefined' ? null : indexedDB;
  } catch {
    return null;
  }
}

function openRecoveryDatabase(factory: IDBFactory | null, databaseName: string): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (!factory) {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(databaseName, recoveryDatabaseVersion);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      try {
        const database = request.result;
        if (!database.objectStoreNames.contains(recoverySettingsStoreName)) {
          database.createObjectStore(recoverySettingsStoreName, { keyPath: 'id' });
        }
        if (!database.objectStoreNames.contains(recoveryFilenameMappingsStoreName)) {
          database.createObjectStore(recoveryFilenameMappingsStoreName, { keyPath: 'id' });
        }
        if (!database.objectStoreNames.contains(recoveryCheckpointsStoreName)) {
          const checkpoints = database.createObjectStore(recoveryCheckpointsStoreName, { keyPath: 'id' });
          checkpoints.createIndex('gameKey', 'gameKey', { unique: false });
        }
      } catch {
        // The request's error/abort handlers below turn an upgrade failure into the fallback.
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

type TransactionResult<T> = { ok: true; result: T } | { ok: false };

class NativeRecoveryStore implements IRecoveryStore {
  readonly durable = true;
  private degraded = false;
  private error: string | undefined;
  private tail: Promise<void> = Promise.resolve();

  constructor(private database: IDBDatabase) {
    database.onversionchange = () => {
      this.degraded = true;
      this.error = 'The local recovery database changed and is being reopened.';
      try {
        database.close();
      } catch {
        // Best effort; the browser has already told us this connection is no longer usable.
      }
    };
  }

  get storageDegraded(): boolean {
    return this.degraded;
  }

  get storageError(): string | undefined {
    return this.error;
  }

  private markFailure(message: string): void {
    this.degraded = true;
    this.error = message;
  }

  private markHealthy(): void {
    this.degraded = false;
    this.error = undefined;
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private transaction<T>(
    mode: IDBTransactionMode,
    stores: RecoveryStoreName[],
    work: (transaction: IDBTransaction) => IDBRequest<T>,
  ): Promise<TransactionResult<T>> {
    return new Promise((resolve) => {
      let settled = false;
      let requestResult!: T;
      let requestFailed = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        this.markFailure('The local recovery database could not complete a transaction.');
        resolve({ ok: false });
      };
      try {
        const transaction = this.database.transaction(stores, mode);
        transaction.onerror = fail;
        transaction.onabort = fail;
        transaction.oncomplete = () => {
          if (requestFailed) {
            fail();
            return;
          }
          if (settled) return;
          settled = true;
          this.markHealthy();
          resolve({ ok: true, result: requestResult });
        };
        const request = work(transaction);
        request.onsuccess = () => {
          requestResult = request.result;
        };
        request.onerror = () => {
          requestFailed = true;
        };
      } catch {
        fail();
      }
    });
  }

  private async getInternal<T>(storeName: RecoveryStoreName, key: IDBValidKey): Promise<T | null> {
    const result = await this.transaction<T | undefined>('readonly', [storeName], (transaction) =>
      transaction.objectStore(storeName).get(key),
    );
    return result.ok ? (result.result ?? null) : null;
  }

  private async listInternal<T>(
    storeName: RecoveryStoreName,
  ): Promise<{ ok: true; values: T[] } | { ok: false }> {
    const result = await this.transaction<T[]>('readonly', [storeName], (transaction) =>
      transaction.objectStore(storeName).getAll(),
    );
    return result.ok ? { ok: true, values: result.result } : { ok: false };
  }

  private async putInternal<T>(storeName: RecoveryStoreName, value: T): Promise<boolean> {
    return (
      await this.transaction<IDBValidKey>('readwrite', [storeName], (transaction) =>
        transaction.objectStore(storeName).put(value),
      )
    ).ok;
  }

  private async deleteInternal(storeName: RecoveryStoreName, key: IDBValidKey): Promise<boolean> {
    return (
      await this.transaction<undefined>('readwrite', [storeName], (transaction) =>
        transaction.objectStore(storeName).delete(key),
      )
    ).ok;
  }

  async getSettings(): Promise<IRecoverySettings | null> {
    const settings = await this.getInternal<IRecoverySettings>(recoverySettingsStoreName, recoverySettingsId);
    return settings?.id === recoverySettingsId ? settings : null;
  }

  async putSettings(settings: IRecoverySettings): Promise<boolean> {
    return this.enqueue(() => this.putInternal(recoverySettingsStoreName, settings));
  }

  async clearExternalConfiguration(): Promise<boolean> {
    return this.enqueue(async () => {
      const mappings = await this.listInternal<IRecoveryFilenameMapping>(recoveryFilenameMappingsStoreName);
      if (!mappings.ok) return false;
      const settingsDeleted = await this.deleteInternal(recoverySettingsStoreName, recoverySettingsId);
      if (!settingsDeleted) return false;
      for (const mapping of mappings.values) {
        if (!(await this.deleteInternal(recoveryFilenameMappingsStoreName, mapping.id))) return false;
      }
      return true;
    });
  }

  async getFilenameMapping(gameKey: string): Promise<IRecoveryFilenameMapping | null> {
    return this.getInternal<IRecoveryFilenameMapping>(recoveryFilenameMappingsStoreName, gameKey);
  }

  async listFilenameMappings(): Promise<IRecoveryFilenameMapping[]> {
    const result = await this.listInternal<IRecoveryFilenameMapping>(recoveryFilenameMappingsStoreName);
    return result.ok ? result.values : [];
  }

  async putFilenameMapping(mapping: IRecoveryFilenameMapping): Promise<boolean> {
    return this.enqueue(() => this.putInternal(recoveryFilenameMappingsStoreName, mapping));
  }

  async listCheckpoints(gameKey: string): Promise<IRecoveryCheckpoint[]> {
    const result = await this.listInternal<IRecoveryCheckpoint>(recoveryCheckpointsStoreName);
    return result.ok ? result.values.filter((checkpoint) => checkpoint.gameKey === gameKey) : [];
  }

  async listAllCheckpoints(): Promise<IRecoveryCheckpoint[]> {
    const result = await this.listInternal<IRecoveryCheckpoint>(recoveryCheckpointsStoreName);
    return result.ok ? result.values : [];
  }

  async saveCheckpoint(
    checkpoint: IRecoveryCheckpoint,
    limits?: IRecoveryCheckpointLimits,
  ): Promise<boolean> {
    return this.enqueue(() => this.saveCheckpointAtomic(checkpoint, limits));
  }

  /** Put and prune in one IndexedDB transaction so a failed prune rolls back rather than losing evidence. */
  private saveCheckpointAtomic(
    checkpoint: IRecoveryCheckpoint,
    limits?: IRecoveryCheckpointLimits,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        this.markFailure('The local recovery database could not save a checkpoint.');
        resolve(false);
      };
      try {
        const transaction = this.database.transaction([recoveryCheckpointsStoreName], 'readwrite');
        transaction.onerror = fail;
        transaction.onabort = fail;
        transaction.oncomplete = () => {
          if (settled) return;
          settled = true;
          this.markHealthy();
          resolve(true);
        };
        const store = transaction.objectStore(recoveryCheckpointsStoreName);
        const request = store.getAll();
        request.onerror = fail;
        request.onsuccess = () => {
          try {
            const all = Array.isArray(request.result) ? (request.result as IRecoveryCheckpoint[]) : [];
            const existing = all.filter((candidate) => candidate.id !== checkpoint.id);
            const forGame = [
              ...existing.filter((candidate) => candidate.gameKey === checkpoint.gameKey),
              checkpoint,
            ];
            const retained = new Set(
              retainRecoveryCheckpoints(forGame, limits).map((candidate) => candidate.id),
            );
            store.put(checkpoint);
            for (const candidate of forGame) {
              if (!retained.has(candidate.id)) store.delete(candidate.id);
            }
          } catch {
            fail();
          }
        };
      } catch {
        fail();
      }
    });
  }

  async deleteCheckpoint(id: string): Promise<boolean> {
    return this.enqueue(() => this.deleteInternal(recoveryCheckpointsStoreName, id));
  }
}

/** Open native recovery persistence, falling back without throwing through application startup. */
export async function openRecoveryStore(
  environment: IRecoveryStoreEnvironment = {},
): Promise<IRecoveryStore> {
  const factory = environment.indexedDB === undefined ? globalIndexedDb() : environment.indexedDB;
  const database = await openRecoveryDatabase(factory, environment.databaseName ?? recoveryDatabaseName);
  return database ? new NativeRecoveryStore(database) : new MemoryRecoveryStore();
}

/** Construct an exact settings record without ever accepting a serialized path or credential. */
export function recoverySettings(
  directoryHandle: IRecoveryDirectoryHandle,
  configuredAt: Date = new Date(),
): IRecoverySettings {
  return {
    id: recoverySettingsId,
    directoryHandle,
    configuredAt: configuredAt.toISOString(),
  };
}
