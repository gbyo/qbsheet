import { emptyDirectorState, type DirectorState, type TournamentStatus } from '../domain';
import { normalizeDirectorState } from './stateMigrations';

const databaseName = 'qbsheet-director';
const databaseVersion = 2;
const stateStoreName = 'tournament-state';
const stateKey = 'current';
const documentsStoreName = 'tournament-documents';
const metadataStoreName = 'app-metadata';
const currentMetadataKey = 'current-tournament-id';
const localStorageKey = 'qbsheet.director.state.v1';
const localLibraryKey = 'qbsheet.director.library.v1';

export interface TournamentCatalogEntry {
  id: string;
  name: string;
  date: string;
  status: TournamentStatus;
  createdAt: string;
  updatedAt: string;
}

export interface DirectorRepository {
  readonly kind: 'tauri-sqlite' | 'indexeddb' | 'memory';
  load(): Promise<DirectorState>;
  save(state: DirectorState): Promise<void>;
  checkpoint(state: DirectorState, reason: string): Promise<void>;
  /** Optional so narrow test repositories remain valid while native/browser stores grow a catalog. */
  listTournaments?(): Promise<TournamentCatalogEntry[]>;
  openTournament?(id: string): Promise<DirectorState>;
  readTournament?(id: string): Promise<DirectorState>;
  saveDocument?(state: DirectorState, activate?: boolean): Promise<void>;
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

  async listTournaments(): Promise<TournamentCatalogEntry[]> {
    return normalizeCatalogEntries(await this.bridge.invoke('director_list_tournaments'));
  }

  async openTournament(id: string): Promise<DirectorState> {
    return normalizeDirectorState(await this.bridge.invoke('director_open_tournament', { tournamentId: id }));
  }

  async readTournament(id: string): Promise<DirectorState> {
    return normalizeDirectorState(await this.bridge.invoke('director_read_tournament', { tournamentId: id }));
  }

  async saveDocument(state: DirectorState, activate = true): Promise<void> {
    await this.bridge.invoke('director_save_document', { state, activate });
  }
}

interface BrowserDocumentRecord {
  id: string;
  state: DirectorState;
}

export class IndexedDbDirectorRepository implements DirectorRepository {
  readonly kind = 'indexeddb' as const;
  private databasePromise: Promise<IDBDatabase | null> | null = null;
  private migrationPromise: Promise<void> | null = null;

  async load(): Promise<DirectorState> {
    const database = await this.database();
    if (!database) return this.loadLocalStorage();
    try {
      await this.ensureMigrated(database);
      const currentId = await this.readCurrentId(database);
      const records = await this.readAllRecords(database);
      const record = (currentId ? records.find((entry) => entry.id === currentId) : undefined) ?? records[0];
      return normalizeDirectorState(record?.state ?? null);
    } catch (reason: unknown) {
      if (reason instanceof Error && reason.name === 'DirectorStateVersionError') throw reason;
      try {
        return this.loadLocalStorage();
      } catch {
        throw reason instanceof DirectorPersistenceError
          ? reason
          : new DirectorPersistenceError('Director browser storage could not be read.', { cause: reason });
      }
    }
  }

  async save(state: DirectorState): Promise<void> {
    if (!state.tournament) {
      const database = await this.database();
      if (!database) this.saveLocalStorage(state);
      return;
    }
    await this.saveDocument(state, true);
  }

  async checkpoint(state: DirectorState, _reason: string): Promise<void> {
    await this.save(state);
  }

  async listTournaments(): Promise<TournamentCatalogEntry[]> {
    const database = await this.database();
    if (!database) return this.listLocalTournaments();
    try {
      await this.ensureMigrated(database);
      return (await this.readAllRecords(database))
        .map((record) => catalogEntry(record.state))
        .sort(sortCatalogEntries);
    } catch (reason: unknown) {
      try {
        return this.listLocalTournaments();
      } catch {
        throw reason instanceof DirectorPersistenceError
          ? reason
          : new DirectorPersistenceError('Director browser catalog could not be read.', { cause: reason });
      }
    }
  }

  async openTournament(id: string): Promise<DirectorState> {
    const database = await this.database();
    if (!database) {
      const state = this.readLocalTournament(id);
      this.writeLocalCurrentId(id);
      return state;
    }
    await this.ensureMigrated(database);
    const record = (await this.readAllRecords(database)).find((entry) => entry.id === id);
    if (!record) throw new DirectorPersistenceError(`Tournament “${id}” is not in the local catalog.`);
    await this.writeCurrentId(database, id);
    return normalizeDirectorState(record.state);
  }

  async readTournament(id: string): Promise<DirectorState> {
    const database = await this.database();
    if (!database) return this.readLocalTournament(id);
    await this.ensureMigrated(database);
    const record = (await this.readAllRecords(database)).find((entry) => entry.id === id);
    if (!record) throw new DirectorPersistenceError(`Tournament “${id}” is not in the local catalog.`);
    return normalizeDirectorState(record.state);
  }

  async saveDocument(state: DirectorState, activate = true): Promise<void> {
    if (!state.tournament) {
      this.saveLocalStorage(state);
      return;
    }
    const serialized = this.serializeState(state);
    const database = await this.database();
    if (!database) {
      this.saveLocalDocument(state, activate);
      return;
    }
    try {
      await this.ensureMigrated(database);
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(
          activate ? [documentsStoreName, metadataStoreName] : [documentsStoreName],
          'readwrite',
        );
        transaction.objectStore(documentsStoreName).put({
          id: state.tournament!.id,
          state: JSON.parse(serialized) as DirectorState,
        } satisfies BrowserDocumentRecord);
        if (activate) {
          transaction.objectStore(metadataStoreName).put({
            key: currentMetadataKey,
            value: state.tournament!.id,
          });
        }
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error('Director storage failed.'));
        transaction.onabort = () => reject(transaction.error ?? new Error('Director storage was aborted.'));
      });
    } catch (reason: unknown) {
      try {
        this.saveLocalDocument(state, activate);
      } catch (fallbackReason: unknown) {
        throw new DirectorPersistenceError('Director browser storage could not be saved.', {
          cause: fallbackReason ?? reason,
        });
      }
    }
  }

  private database(): Promise<IDBDatabase | null> {
    if (!this.databasePromise) this.databasePromise = openDatabase();
    return this.databasePromise;
  }

  private async ensureMigrated(database: IDBDatabase): Promise<void> {
    if (!this.migrationPromise) {
      this.migrationPromise = (async () => {
        const records = await this.readAllRecords(database);
        if (records.length > 0) return;
        // A browser that temporarily lacked IndexedDB may already have accumulated a catalog in
        // the localStorage fallback. Move every document, not only its selected entry, so making
        // IndexedDB available again cannot silently discard inactive tournaments.
        const localLibrary = this.readLocalLibrary();
        const localDocuments = Object.values(localLibrary.documents);
        if (localDocuments.length > 0) {
          let activated = false;
          for (const raw of localDocuments) {
            const state = normalizeDirectorState(raw);
            if (!state.tournament) continue;
            const shouldActivate: boolean =
              state.tournament.id === localLibrary.currentId || (!localLibrary.currentId && !activated);
            await this.writeRecord(database, state, shouldActivate);
            activated ||= shouldActivate;
          }
          if (activated) return;
        }
        let legacy: unknown = await this.readLegacyCurrent(database);
        if (legacy === undefined || legacy === null) legacy = this.readLegacyLocalStorageValue();
        if (legacy === undefined || legacy === null) return;
        const state = normalizeDirectorState(legacy);
        if (!state.tournament) return;
        await this.writeRecord(database, state, true);
      })().catch((reason) => {
        this.migrationPromise = null;
        throw reason;
      });
    }
    await this.migrationPromise;
  }

  private async readAllRecords(database: IDBDatabase): Promise<BrowserDocumentRecord[]> {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(documentsStoreName, 'readonly');
      const request = transaction.objectStore(documentsStoreName).getAll();
      request.onsuccess = () => resolve((request.result ?? []) as BrowserDocumentRecord[]);
      request.onerror = () => reject(request.error ?? new Error('Director catalog read failed.'));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('Director catalog read was aborted.'));
    });
  }

  private async readCurrentId(database: IDBDatabase): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(metadataStoreName, 'readonly');
      const request = transaction.objectStore(metadataStoreName).get(currentMetadataKey);
      request.onsuccess = () =>
        resolve(typeof request.result?.value === 'string' ? request.result.value : null);
      request.onerror = () => reject(request.error ?? new Error('Director metadata read failed.'));
    });
  }

  private async writeCurrentId(database: IDBDatabase, id: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(metadataStoreName, 'readwrite');
      transaction.objectStore(metadataStoreName).put({ key: currentMetadataKey, value: id });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Director metadata write failed.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Director metadata was aborted.'));
    });
  }

  private async readLegacyCurrent(database: IDBDatabase): Promise<unknown> {
    if (!database.objectStoreNames.contains(stateStoreName)) return null;
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(stateStoreName, 'readonly');
      const request = transaction.objectStore(stateStoreName).get(stateKey);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Legacy Director storage read failed.'));
    });
  }

  private async writeRecord(database: IDBDatabase, state: DirectorState, activate: boolean): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(
        activate ? [documentsStoreName, metadataStoreName] : [documentsStoreName],
        'readwrite',
      );
      transaction.objectStore(documentsStoreName).put({ id: state.tournament!.id, state });
      if (activate) {
        transaction
          .objectStore(metadataStoreName)
          .put({ key: currentMetadataKey, value: state.tournament!.id });
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Director catalog write failed.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Director catalog was aborted.'));
    });
  }

  private serializeState(state: DirectorState): string {
    try {
      return JSON.stringify(state);
    } catch (reason: unknown) {
      throw new DirectorPersistenceError('Director state could not be serialized for browser storage.', {
        cause: reason,
      });
    }
  }

  private loadLocalStorage(): DirectorState {
    return normalizeDirectorState(this.readLocalCurrentValue());
  }

  private readLocalCurrentValue(): unknown {
    if (typeof localStorage === 'undefined') {
      throw new DirectorPersistenceError('Director browser storage is unavailable in this browser.');
    }
    try {
      const library = this.readLocalLibrary();
      if (library.currentId && library.documents[library.currentId])
        return library.documents[library.currentId];
      const legacy = localStorage.getItem(localStorageKey);
      return legacy === null ? null : JSON.parse(legacy);
    } catch (reason: unknown) {
      if (reason instanceof Error && reason.name === 'DirectorStateVersionError') throw reason;
      throw new DirectorPersistenceError('Director browser storage could not be read.', { cause: reason });
    }
  }

  private readLegacyLocalStorageValue(): unknown {
    try {
      if (typeof localStorage === 'undefined') return null;
      const raw = localStorage.getItem(localStorageKey);
      return raw === null ? null : JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private readLocalLibrary(): { currentId: string | null; documents: Record<string, unknown> } {
    if (typeof localStorage === 'undefined') return { currentId: null, documents: {} };
    const raw = localStorage.getItem(localLibraryKey);
    if (!raw) return { currentId: null, documents: {} };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { currentId: null, documents: {} };
    const value = parsed as Record<string, unknown>;
    const documents = value.documents;
    return {
      currentId: typeof value.currentId === 'string' ? value.currentId : null,
      documents: documents && typeof documents === 'object' ? (documents as Record<string, unknown>) : {},
    };
  }

  private saveLocalStorage(state: DirectorState): void {
    if (typeof localStorage === 'undefined') {
      throw new DirectorPersistenceError('Director browser storage is unavailable in this browser.');
    }
    try {
      localStorage.setItem(localStorageKey, JSON.stringify(state));
    } catch (reason: unknown) {
      throw new DirectorPersistenceError('Director browser storage quota or permissions prevented saving.', {
        cause: reason,
      });
    }
  }

  private saveLocalDocument(state: DirectorState, activate: boolean): void {
    if (typeof localStorage === 'undefined') {
      throw new DirectorPersistenceError('Director browser storage is unavailable in this browser.');
    }
    try {
      const library = this.readLocalLibrary();
      library.documents[state.tournament!.id] = structuredClone(state);
      if (activate) library.currentId = state.tournament!.id;
      localStorage.setItem(localLibraryKey, JSON.stringify(library));
    } catch (reason: unknown) {
      throw new DirectorPersistenceError('Director browser storage quota or permissions prevented saving.', {
        cause: reason,
      });
    }
  }

  private listLocalTournaments(): TournamentCatalogEntry[] {
    const library = this.readLocalLibrary();
    const entries = Object.values(library.documents).map((value) =>
      catalogEntry(normalizeDirectorState(value)),
    );
    if (entries.length === 0) {
      const legacy = this.readLegacyLocalStorageValue();
      if (legacy !== null && legacy !== undefined) {
        const state = normalizeDirectorState(legacy);
        if (state.tournament) entries.push(catalogEntry(state));
      }
    }
    return entries.sort(sortCatalogEntries);
  }

  private readLocalTournament(id: string): DirectorState {
    const library = this.readLocalLibrary();
    const raw = library.documents[id];
    if (raw === undefined)
      throw new DirectorPersistenceError(`Tournament “${id}” is not in the local catalog.`);
    return normalizeDirectorState(raw);
  }

  private writeLocalCurrentId(id: string): void {
    const library = this.readLocalLibrary();
    library.currentId = id;
    localStorage.setItem(localLibraryKey, JSON.stringify(library));
  }
}

export class MemoryDirectorRepository implements DirectorRepository {
  readonly kind = 'memory' as const;
  private state = emptyDirectorState();
  private documents = new Map<string, DirectorState>();

  async load(): Promise<DirectorState> {
    return structuredClone(this.state);
  }

  async save(state: DirectorState): Promise<void> {
    await this.saveDocument(state, true);
  }

  async checkpoint(state: DirectorState, _reason: string): Promise<void> {
    await this.save(state);
  }

  async listTournaments(): Promise<TournamentCatalogEntry[]> {
    return [...this.documents.values()].map(catalogEntry).sort(sortCatalogEntries);
  }

  async openTournament(id: string): Promise<DirectorState> {
    const state = this.documents.get(id);
    if (!state) throw new DirectorPersistenceError(`Tournament “${id}” is not in the local catalog.`);
    this.state = structuredClone(state);
    return structuredClone(this.state);
  }

  async readTournament(id: string): Promise<DirectorState> {
    const state = this.documents.get(id);
    if (!state) throw new DirectorPersistenceError(`Tournament “${id}” is not in the local catalog.`);
    return structuredClone(state);
  }

  async saveDocument(state: DirectorState, activate = true): Promise<void> {
    if (!state.tournament) {
      this.state = structuredClone(state);
      return;
    }
    const copy = structuredClone(state);
    this.documents.set(copy.tournament!.id, copy);
    if (activate) {
      this.state = structuredClone(copy);
    }
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
      const database = request.result;
      if (!database.objectStoreNames.contains(stateStoreName)) database.createObjectStore(stateStoreName);
      if (!database.objectStoreNames.contains(documentsStoreName)) {
        database.createObjectStore(documentsStoreName, { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains(metadataStoreName)) {
        database.createObjectStore(metadataStoreName, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

function catalogEntry(state: DirectorState): TournamentCatalogEntry {
  const tournament = state.tournament;
  if (!tournament) throw new DirectorPersistenceError('A catalog document is missing its tournament.');
  return {
    id: tournament.id,
    name: tournament.name,
    date: tournament.date,
    status: tournament.status,
    createdAt: tournament.createdAt,
    updatedAt: tournament.updatedAt,
  };
}

function sortCatalogEntries(left: TournamentCatalogEntry, right: TournamentCatalogEntry): number {
  if (left.status === 'archived' && right.status !== 'archived') return 1;
  if (left.status !== 'archived' && right.status === 'archived') return -1;
  return (
    right.updatedAt.localeCompare(left.updatedAt) ||
    left.name.localeCompare(right.name) ||
    left.id.localeCompare(right.id)
  );
}

function normalizeCatalogEntries(value: unknown): TournamentCatalogEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isCatalogEntry)
    .map((entry) => ({ ...entry }))
    .sort(sortCatalogEntries);
}

function isCatalogEntry(value: unknown): value is TournamentCatalogEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.name === 'string' &&
    typeof entry.date === 'string' &&
    (entry.status === 'draft' ||
      entry.status === 'running' ||
      entry.status === 'complete' ||
      entry.status === 'archived') &&
    typeof entry.createdAt === 'string' &&
    typeof entry.updatedAt === 'string'
  );
}
