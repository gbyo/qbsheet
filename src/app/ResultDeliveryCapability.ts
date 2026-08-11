/**
 * The private capability needed to retry one completed result.
 *
 * This is intentionally separate from `IStoredGameRecord`. A game record is portable operational
 * data: it can be rendered, downloaded, and inspected by diagnostics. The values here are browser
 * capabilities and must never cross that boundary. There is no room token in this store because a
 * completed result only needs the session endpoint and its session capability to be resent.
 */
import { completedGameRetentionMs } from '../game/GameStore';

export const resultDeliveryCapabilityStorageKey = 'qbsheet.result-delivery.v1';
export const resultDeliveryCapabilityVersion = 1;

export interface IResultDeliveryCapability {
  baseUrl: string;
  sessionId: string;
  sessionToken: string;
}
interface IStoredResultDeliveryCapability extends IResultDeliveryCapability {
  expiresAt: string;
}

interface ICapabilityDocument {
  version: number;
  entries: Record<string, IStoredResultDeliveryCapability>;
}

export interface IResultDeliveryCapabilityStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): IResultDeliveryCapabilityStorage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function validCapability(value: unknown): value is IResultDeliveryCapability {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<IResultDeliveryCapability>;
  return (
    typeof candidate.baseUrl === 'string' &&
    candidate.baseUrl !== '' &&
    typeof candidate.sessionId === 'string' &&
    candidate.sessionId !== '' &&
    typeof candidate.sessionToken === 'string' &&
    candidate.sessionToken !== ''
  );
}

function validStoredCapability(value: unknown): value is IStoredResultDeliveryCapability {
  return validCapability(value) && typeof (value as Partial<IStoredResultDeliveryCapability>).expiresAt === 'string';
}

function discardDocument(storage: IResultDeliveryCapabilityStorage): void {
  try {
    storage.removeItem(resultDeliveryCapabilityStorageKey);
  } catch {
    // A malformed private document must never make the completed-result read path fail.
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readDocument(storage: IResultDeliveryCapabilityStorage | null): ICapabilityDocument | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(resultDeliveryCapabilityStorageKey);
    if (!raw) return { version: resultDeliveryCapabilityVersion, entries: {} };
    const parsed = JSON.parse(raw) as unknown;
    if (
      !isObjectRecord(parsed) ||
      parsed.version !== resultDeliveryCapabilityVersion ||
      !isObjectRecord(parsed.entries)
    ) {
      discardDocument(storage);
      return null;
    }
    const entries: Record<string, IStoredResultDeliveryCapability> = {};
    for (const [recordId, entry] of Object.entries(parsed.entries)) {
      if (!validStoredCapability(entry)) continue;
      const expiresAt = new Date(entry.expiresAt).getTime();
      if (!Number.isFinite(expiresAt)) continue;
      entries[recordId] = { ...entry, expiresAt: new Date(expiresAt).toISOString() };
    }
    return { version: resultDeliveryCapabilityVersion, entries };
  } catch {
    discardDocument(storage);
    return null;
  }
}

function writeDocument(storage: IResultDeliveryCapabilityStorage | null, document: ICapabilityDocument): boolean {
  if (!storage) return false;
  try {
    storage.setItem(resultDeliveryCapabilityStorageKey, JSON.stringify(document));
    return true;
  } catch {
    // A completed result remains safe and downloadable when this private write is refused. It only
    // means a retry after reload cannot be promised.
    return false;
  }
}

function isExpired(entry: IStoredResultDeliveryCapability, now: Date): boolean {
  return new Date(entry.expiresAt).getTime() <= now.getTime();
}

/**
 * Device-only storage for completed-result delivery capabilities.
 *
 * The entries are bounded by the same retention window as completed records. `prune` also accepts
 * the record ids still present in IndexedDB so a direct record deletion cannot leave a credential
 * behind until the clock reaches expiry.
 */
export class ResultDeliveryCapabilityStore {
  constructor(
    private storage: IResultDeliveryCapabilityStorage | null = browserStorage(),
    private now: () => Date = () => new Date(),
  ) {}

  has(recordId: string): boolean {
    const document = readDocument(this.storage);
    const entry = document?.entries[recordId];
    return entry !== undefined && !isExpired(entry, this.now());
  }

  get(recordId: string): IResultDeliveryCapability | null {
    const document = readDocument(this.storage);
    const entry = document?.entries[recordId];
    if (!entry || isExpired(entry, this.now())) {
      if (entry) this.remove(recordId);
      return null;
    }
    return { baseUrl: entry.baseUrl, sessionId: entry.sessionId, sessionToken: entry.sessionToken };
  }

  remember(recordId: string, capability: IResultDeliveryCapability, completedAt: string): boolean {
    if (!validCapability(capability)) return false;
    const completed = new Date(completedAt).getTime();
    if (!Number.isFinite(completed)) return false;
    const document = readDocument(this.storage) ?? { version: resultDeliveryCapabilityVersion, entries: {} };
    this.removeExpired(document);
    document.entries[recordId] = {
      ...capability,
      expiresAt: new Date(completed + completedGameRetentionMs).toISOString(),
    };
    return writeDocument(this.storage, document);
  }

  remove(recordId: string): void {
    const document = readDocument(this.storage);
    if (!document || !(recordId in document.entries)) return;
    delete document.entries[recordId];
    if (Object.keys(document.entries).length === 0) {
      try {
        this.storage?.removeItem(resultDeliveryCapabilityStorageKey);
      } catch {
        // Storage is already unavailable; there is no safer place to move the entry.
      }
      return;
    }
    void writeDocument(this.storage, document);
  }

  prune(retainedRecordIds?: ReadonlySet<string>): void {
    const document = readDocument(this.storage);
    if (!document) return;
    const before = JSON.stringify(document.entries);
    this.removeExpired(document);
    if (retainedRecordIds) {
      for (const recordId of Object.keys(document.entries)) {
        if (!retainedRecordIds.has(recordId)) delete document.entries[recordId];
      }
    }
    if (JSON.stringify(document.entries) === before) return;
    if (Object.keys(document.entries).length === 0) {
      try {
        this.storage?.removeItem(resultDeliveryCapabilityStorageKey);
      } catch {
        // Nothing further can be done when browser storage refuses a cleanup.
      }
      return;
    }
    void writeDocument(this.storage, document);
  }

  private removeExpired(document: ICapabilityDocument): void {
    const now = this.now();
    for (const [recordId, entry] of Object.entries(document.entries)) {
      if (isExpired(entry, now)) delete document.entries[recordId];
    }
  }
}
