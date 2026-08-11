/**
 * Every game this device has scored, and the one it is scoring now.
 *
 * # Two stores, on purpose
 *
 * The event history is written to `localStorage` synchronously by the scorer itself, on every
 * accepted operation, through `GameSession`. That path is not negotiable and is not made
 * asynchronous: `saveGame` returns a boolean in the same turn as the click, which is what lets the
 * scoresheet say "saved just now" as a fact and what lets it shout when the browser refused. An
 * IndexedDB write cannot do that, and a scorekeeper who is told a game is safe when the write is
 * still in flight has been lied to.
 *
 * Everything else — the frozen game package, the completion state, the finished QBJ, whether the
 * result reached tournament control, whether the backup has been handed over — lives in IndexedDB,
 * which is where a season of results can sit without running into a five-megabyte cap.
 *
 * So on load, the journal wins for events and the record wins for everything else. The journal is by
 * construction at least as new, because it is written first.
 *
 * # Nothing is deleted because it worked
 *
 * A game does not leave this store because the server accepted it, or because the QBJ was
 * downloaded, or because somebody clicked the acknowledgement. Those are three independent claims
 * about three independent copies, and a room that discovers on Sunday that one of them was wrong
 * needs the fourth copy — this one — to still be here. Retention is by age, generously.
 */
import { ScoreEvent } from '../scoring/ScoreEvents';
import { IGameSetup } from '../scoring/deriveGame';
import { IGamePackage, gamePackageIdentity } from './GamePackage';
import { IRecordStore, MemoryRecordStore } from '../persistence/GameDatabase';
import { clearGame, loadGame, saveGame } from '../scorer/GameSession';
import {
  IUnreadableRecord,
  UpgradeStep,
  gameRecordVersion,
  readStoredRecord,
  upgradeSteps,
} from './GameRecordUpgrade';

// Re-exported from where it has always been imported from. The constant moved next to the migration
// steps it is only meaningful alongside; see `GameRecordUpgrade`.
export { gameRecordVersion };

/**
 * How long a finished game is kept.
 *
 * A week, because the failure this guards against is discovered on Monday: a QBJ that never reached
 * the folder, a result somebody has questions about, a director reconciling a scoresheet. The cost
 * of keeping it is a few kilobytes; the cost of not keeping it is a game nobody can reconstruct.
 */
export const completedGameRetentionMs = 7 * 24 * 60 * 60 * 1000;

/** What is known about the copy tournament control was supposed to receive. */
export type ServerDeliveryState =
  /** This game has no tournament control. A file game is complete when its QBJ is handed over. */
  | 'none'
  /** Connected, and the final has not been accepted yet. Retried in the background. */
  | 'pending'
  /** Control acknowledged the result. Does not remove the obligation to hand over the backup. */
  | 'sent'
  /** Control refused it, and said why. The game stays exactly as it is. */
  | 'rejected';

export interface IStoredGameRecord {
  version: number;
  /** Storage key. Identity plus the attempt, so a deliberate re-score is a separate record. */
  id: string;
  /** What game this is, independent of how many times it has been opened. */
  identity: string;
  /** 1 for the ordinary case; higher only when a scorekeeper deliberately started a game again. */
  attempt: number;
  /** What the scorer files its events under. Also the `localStorage` journal key. */
  gameKey: string;
  package: IGamePackage;
  /**
   * The rosters as this game is being scored against.
   *
   * Frozen when the game starts and never rebuilt from the package afterwards, because
   * substitutions are recorded against these names: rebuilding would move players around underneath
   * an event history that already refers to them.
   */
  setup: IGameSetup;
  events: ScoreEvent[];
  /** True when this game came from tournament control rather than from a file. */
  connected: boolean;
  /** ISO 8601 */
  createdAt: string;
  /** ISO 8601 */
  updatedAt: string;
  /** ISO 8601. Set once the scorekeeper has submitted the final. */
  completedAt?: string;
  /** The portable QBJ, exactly as it would be downloaded. No recovery layer, no credentials. */
  finalQbj?: object;
  /** For the recent list, so it does not have to re-derive a finished game to show a score. */
  finalScore?: { left: number; right: number };
  serverDelivery: ServerDeliveryState;
  /** Whatever control said, when it said something. Shown verbatim. */
  serverDeliveryDetail?: string;
  /** ISO 8601. When this device last wrote the QBJ to the downloads folder. */
  qbjDownloadedAt?: string;
  /** ISO 8601. When somebody said they had handed the file over. Our workflow state, not proof. */
  handoffAcknowledgedAt?: string;
}

export interface IGameStore {
  /** Whether the record store is durable. False means the room must be warned. */
  readonly durable: boolean;
  list(): Promise<IStoredGameRecord[]>;
  get(id: string): Promise<IStoredGameRecord | null>;
  findByIdentity(identity: string): Promise<IStoredGameRecord[]>;
  /** The game in progress, if there is one. */
  active(): Promise<IStoredGameRecord | null>;
  create(input: ICreateGameInput): Promise<IStoredGameRecord>;
  update(id: string, change: Partial<IStoredGameRecord>): Promise<IStoredGameRecord | null>;
  /**
   * Record the event history for a game.
   *
   * @returns whether the synchronous journal accepted the write. That, not the IndexedDB result, is
   * what the scoresheet may claim about the room's data being safe.
   */
  saveEvents(id: string, events: ScoreEvent[]): boolean;
  remove(id: string): Promise<void>;
  /** Drop finished games past the retention window. Never touches an unfinished one. */
  prune(now?: Date): Promise<number>;
}

export interface ICreateGameInput {
  package: IGamePackage;
  setup: IGameSetup;
  connected: boolean;
  /** Supplied by the connected path so the scorer's key matches the server's session. */
  gameKey?: string;
  attempt?: number;
  now?: Date;
}

/** A record for a game that is still being scored. */
export function isActive(record: IStoredGameRecord): boolean {
  return record.completedAt === undefined;
}

/**
 * Whether somebody has to carry this result somewhere.
 *
 * The distinction is between a result that has reached the tournament and one that has not. A
 * result tournament control accepted has arrived; asking the scorekeeper to download it, upload it
 * by hand, and then confirm they did is asking for a second delivery of something already
 * delivered, eleven times a day. QBTCP requires the download to stay *available* — it does not
 * require a second handoff after every success — and a workflow that demands one anyway teaches
 * rooms to click the confirmation without doing the upload, which is the state that makes the
 * acknowledgement worthless when it matters.
 *
 * So the obligation is owed when delivery did not happen or cannot be trusted to have happened:
 *
 *   - a game with no tournament control behind it, which only ever had the file;
 *   - a submission that is pending or was refused;
 *   - any game whose tournament attached its own handoff instruction, because that instruction is
 *     the tournament saying explicitly that it wants the file too.
 */
export function needsHandoff(record: IStoredGameRecord): boolean {
  if (isActive(record)) return false;
  // Accepted by tournament control, with nothing else asked for. The copy on this device stays,
  // and `Download QBJ again` stays with it; neither is an outstanding task.
  if (isDelivered(record)) return false;
  if (record.qbjDownloadedAt === undefined) return true;
  return record.connected || Boolean(record.package.handoffInstruction)
    ? record.handoffAcknowledgedAt === undefined
    : false;
}

/**
 * Tournament control has this result and asked for nothing else.
 *
 * Exported because the completion screen decides what to say from the same fact that decides
 * whether anything is owed, and two copies of the rule is two chances for the screen to promise
 * something the store disagrees with.
 */
export function isDelivered(record: IStoredGameRecord): boolean {
  return record.serverDelivery === 'sent' && !record.package.handoffInstruction;
}

function recordId(identity: string, attempt: number): string {
  return attempt <= 1 ? identity : `${identity}#${attempt}`;
}

/**
 * The scorer's storage key for a game.
 *
 * Distinct from the record id because the journal is keyed by whatever identity the *game* has —
 * for a connected game that is the server's session id, so a browser that reloads mid-round finds
 * the same history the server would recover.
 */
function defaultGameKey(identity: string, attempt: number): string {
  return recordId(identity, attempt).replace(/[^\w.:#-]+/g, '_');
}

/**
 * The record shape a store reads and writes.
 *
 * Injectable, and not only for tidiness: the whole point of a version number is what happens when it
 * changes, and that is not observable in a test unless the version a store believes in can be moved.
 * Without this seam the migration path could only ever be exercised on the Saturday it was deployed.
 * Application code passes nothing and gets the shipping schema.
 */
export interface IRecordSchema {
  version: number;
  steps: Readonly<Record<number, UpgradeStep>>;
}

export const shippingSchema: IRecordSchema = { version: gameRecordVersion, steps: upgradeSteps };

export class GameStore implements IGameStore {
  constructor(
    private records: IRecordStore<IStoredGameRecord>,
    private schema: IRecordSchema = shippingSchema,
  ) {}

  get durable(): boolean {
    return this.records.durable;
  }

  /**
   * The schema, in the vocabulary the reader uses.
   *
   * Spelled out rather than passed straight through: the store's `version` is the version it *writes*
   * and the reader's `target` is the version it migrates *to*. They are the same number, and relying
   * on that by passing one object where the other was expected is a silent no-op — `target` falls back
   * to its default, every record reads as current, and nothing is ever migrated. Which is exactly what
   * happened the first time this was written.
   */
  private get readerOptions(): { target: number; steps: Readonly<Record<number, UpgradeStep>> } {
    return { target: this.schema.version, steps: this.schema.steps };
  }

  /**
   * Every game this build can read, newest first.
   *
   * Records written by an older build are migrated on the way through and written back, so the
   * migration is paid once rather than on every load. Records this build cannot read are not returned
   * and are not touched: see `GameRecordUpgrade` for why deleting them was the old behaviour and why
   * it was wrong.
   */
  async list(): Promise<IStoredGameRecord[]> {
    const all = await this.records.list();
    const readable: IStoredGameRecord[] = [];
    const unreadable: IUnreadableRecord[] = [];
    for (const stored of all) {
      const read = readStoredRecord(stored, this.readerOptions);
      if (read.record === null) {
        if (typeof (stored as { id?: unknown })?.id === 'string') {
          unreadable.push({
            id: stored.id,
            readability: read.readability as IUnreadableRecord['readability'],
            storedVersion: read.storedVersion,
          });
        }
        continue;
      }
      if (read.readability === 'upgraded') this.writeBack(read.record);
      readable.push(this.withJournal(read.record));
    }
    this.unreadableRecords = unreadable;
    return readable.sort((first, second) => second.updatedAt.localeCompare(first.updatedAt));
  }

  async get(id: string): Promise<IStoredGameRecord | null> {
    const read = readStoredRecord(await this.records.get(id), this.readerOptions);
    if (read.record === null) return null;
    if (read.readability === 'upgraded') this.writeBack(read.record);
    return this.withJournal(read.record);
  }

  /**
   * What this build found in storage and could not read, as of the last `list()`.
   *
   * Reported rather than silently skipped so the front door can say that a game is on this device
   * which this version of QBSheet will not open — which is a recoverable situation with an obvious
   * fix, and is indistinguishable from data loss if nobody mentions it.
   */
  get unreadable(): IUnreadableRecord[] {
    return this.unreadableRecords;
  }

  private unreadableRecords: IUnreadableRecord[] = [];

  /**
   * Persist a migrated record.
   *
   * Not awaited. A migration that does not stick costs a few microseconds on the next load; a welcome
   * screen that waits on a write before it can offer the unfinished game costs a room time it does not
   * have. The read has already succeeded either way.
   */
  private writeBack(record: IStoredGameRecord): void {
    void this.records.put(record);
  }

  async findByIdentity(identity: string): Promise<IStoredGameRecord[]> {
    return (await this.list()).filter((record) => record.identity === identity);
  }

  async active(): Promise<IStoredGameRecord | null> {
    return (await this.list()).find(isActive) ?? null;
  }

  async create(input: ICreateGameInput): Promise<IStoredGameRecord> {
    const now = input.now ?? new Date();
    const identity = gamePackageIdentity(input.package);
    const attempt = input.attempt ?? 1;
    const id = recordId(identity, attempt);
    const record: IStoredGameRecord = {
      version: this.schema.version,
      id,
      identity,
      attempt,
      gameKey: input.gameKey ?? defaultGameKey(identity, attempt),
      package: input.package,
      setup: input.setup,
      events: [],
      connected: input.connected,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      serverDelivery: input.connected ? 'pending' : 'none',
    };
    await this.records.put(record);
    return record;
  }

  async update(id: string, change: Partial<IStoredGameRecord>): Promise<IStoredGameRecord | null> {
    const existing = await this.records.get(id);
    if (!existing) return null;
    const next: IStoredGameRecord = {
      ...existing,
      ...change,
      id: existing.id,
      version: this.schema.version,
      updatedAt: (change.updatedAt ?? new Date().toISOString()) as string,
    };
    const written = await this.records.put(next);
    // A memory fallback is intentionally usable, but it must remain visible as non-durable through
    // `durable`. A real IndexedDB failure, on the other hand, is a failed update rather than a
    // success that only exists in the caller's React state.
    if (!written && this.records.durable) return null;
    return next;
  }

  saveEvents(id: string, events: ScoreEvent[]): boolean {
    // Written synchronously first. The durable mirror follows and is allowed to be slower; it is
    // never allowed to be the thing the room is told about.
    const cached = this.journalKeys.get(id);
    if (!cached) return false;
    const written = saveGame(cached.gameKey, cached.setup, events);
    void this.records.get(id).then((existing) => {
      if (!existing) return;
      void this.records.put({ ...existing, events, updatedAt: new Date().toISOString() });
    });
    return written;
  }

  async remove(id: string): Promise<void> {
    const existing = await this.records.get(id);
    if (existing) clearGame(existing.gameKey);
    this.journalKeys.delete(id);
    await this.records.delete(id);
  }

  async prune(now: Date = new Date()): Promise<number> {
    const all = await this.list();
    let removed = 0;
    for (const record of all) {
      if (isActive(record)) continue;
      const completed = new Date(record.completedAt!).getTime();
      if (!Number.isFinite(completed)) continue;
      if (now.getTime() - completed <= completedGameRetentionMs) continue;
      await this.remove(record.id);
      removed += 1;
    }
    return removed;
  }

  /**
   * Where `saveEvents` writes, per record.
   *
   * Populated by `withJournal`, which every read goes through, so a record read at any point in the
   * session can have its events journalled synchronously afterwards without another await.
   */
  private journalKeys = new Map<string, { gameKey: string; setup: IGameSetup }>();

  private withJournal(record: IStoredGameRecord): IStoredGameRecord {
    this.journalKeys.set(record.id, { gameKey: record.gameKey, setup: record.setup });
    if (record.completedAt !== undefined) return record;
    const journalled = loadGame(record.gameKey);
    if (!journalled) return record;
    return { ...record, setup: journalled.setup, events: journalled.events };
  }
}

/** A store backed by nothing, for tests and for a browser that gave us no database. */
export function memoryGameStore(): GameStore {
  return new GameStore(new MemoryRecordStore<IStoredGameRecord>());
}
