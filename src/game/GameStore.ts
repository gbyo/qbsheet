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
import { isManualGame } from './GameDefinition';
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

/**
 * Hand-entered games are useful to a coach well after a tournament result has been reconciled.
 * Keep them for a month by default; they have no server-side copy that a recent-games cleanup can
 * rediscover, and their local record is the convenient history users asked for when they created it.
 */
export const manualGameRetentionMs = 30 * 24 * 60 * 60 * 1000;

/** The retention policy shared by pruning and the Recent Games explanation. */
export function retentionMsFor(packageValue: IGamePackage): number {
  return isManualGame(packageValue) ? manualGameRetentionMs : completedGameRetentionMs;
}

/** What is known about the copy tournament control was supposed to receive. */
export type ServerDeliveryState =
  /** This game has no tournament control. A file game is complete when its QBJ is handed over. */
  | 'none'
  /** Connected, and the final has not been accepted yet. A person may retry it explicitly. */
  | 'pending'
  /** Control acknowledged the result. Does not remove the obligation to hand over the backup. */
  | 'sent'
  /** Control refused it, and said why. The game stays exactly as it is. */
  | 'rejected';

/** The last normalized outcome recorded by the result-delivery boundary. */
export type ServerDeliveryLedgerOutcome = 'accepted' | 'pending' | 'rejected' | 'unsupported';

/**
 * Small, bounded operational facts about delivery.
 *
 * This is deliberately a summary rather than an event log. The connection timeline is the place
 * for deeper troubleshooting; a finished game only needs enough durable context to explain its
 * current state and make a useful manual retry possible after a reload.
 */
export interface IServerDeliveryLedger {
  /** Real requests made to the result endpoint. A capability refusal does not increment this. */
  attemptCount: number;
  /** ISO 8601. The first real request this device made for the result. */
  firstAttemptedAt?: string;
  /** ISO 8601. The most recent real request this device made for the result. */
  lastAttemptedAt?: string;
  /** ISO 8601. When control accepted the result, including a duplicate receipt. */
  acceptedAt?: string;
  /** Which attempt received the accepted receipt, when there was one. */
  acceptedOnAttempt?: number;
  /** True when the accepted receipt said control already had this exact result. */
  acceptedAsDuplicate?: boolean;
  /** The match identifier returned by control, when it supplied one. */
  matchId?: string;
  /** The result fingerprint returned by control, when it supplied one. */
  fingerprint?: string;
  /** The last safe-to-display explanation for a pending or rejected outcome. */
  lastFailureDetail?: string;
  /** Whether a later explicit attempt is meaningful with the capability still held. */
  retryable?: boolean;
  /** The latest normalized result, including a client-side unsupported-capability refusal. */
  outcome?: ServerDeliveryLedgerOutcome;
}

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
  /** Optional bounded delivery facts. Records from before this field was added remain valid. */
  serverDeliveryLedger?: IServerDeliveryLedger;
  /** ISO 8601. When this device last wrote the QBJ to the downloads folder. */
  qbjDownloadedAt?: string;
  /** ISO 8601. When somebody said they had handed the file over. Our workflow state, not proof. */
  handoffAcknowledgedAt?: string;
}

export interface IGameStore {
  /** Whether the record store is durable. False means the room must be warned. */
  readonly durable: boolean;
  /** Whether a durable record store is currently unavailable. */
  readonly storageDegraded: boolean;
  /** A safe-to-display explanation for a current storage failure, when available. */
  readonly storageError?: string;
  /** Notify the app when the underlying record store changes health. */
  subscribeToStorageStatus?(listener: () => void): () => void;
  list(): Promise<IStoredGameRecord[]>;
  get(id: string): Promise<IStoredGameRecord | null>;
  findByIdentity(identity: string): Promise<IStoredGameRecord[]>;
  /** The game in progress, if there is one. */
  active(): Promise<IStoredGameRecord | null>;
  create(input: ICreateGameInput): Promise<IStoredGameRecord>;
  update(id: string, change: Partial<IStoredGameRecord>): Promise<IStoredGameRecord | null>;
  /**
   * Record the event history for a game, and optionally the rosters it is scored against.
   *
   * `setup` is passed only by a correction that changed a team or player name. It has to travel with
   * the events because the two are one fact: a history whose buzzes name "Samir" and a journal whose
   * roster still says "Sam" describes a player who is on no roster, and the reload after the write is
   * exactly when that would be discovered.
   *
   * @returns whether the synchronous journal accepted the write. That, not the IndexedDB result, is
   * what the scoresheet may claim about the room's data being safe.
   */
  saveEvents(id: string, events: ScoreEvent[], setup?: IGameSetup): boolean;
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
  /**
   * A device-local identity to file this record under, instead of the package's.
   *
   * For games that have no assignment behind them. `gamePackageIdentity` answers "which scheduled
   * game is this", which is exactly right for a file or a connected assignment and has no answer at
   * all for a practice somebody typed in: two practices between the same two teams are two games,
   * and the package cannot tell them apart. The fields that would — a scheduled match id, a
   * tournament key — mean something outside this device and must not be invented to solve a local
   * filing problem. See `newManualRecordIdentity`.
   *
   * Local only. It is the record id and the journal key; it is never written into the package, and
   * therefore never into a QBJ.
   */
  recordIdentity?: string;
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
 *
 * And not owed at all by a game nobody is waiting for; see `gameRequiresHandoff`.
 */
export function needsHandoff(record: IStoredGameRecord): boolean {
  if (isActive(record)) return false;
  // Accepted by tournament control, with nothing else asked for. The copy on this device stays,
  // and `Download QBJ again` stays with it; neither is an outstanding task.
  if (isDelivered(record)) return false;
  if (!gameRequiresHandoff(record)) return false;
  if (record.qbjDownloadedAt === undefined) return true;
  return record.connected || Boolean(record.package.handoffInstruction)
    ? record.handoffAcknowledgedAt === undefined
    : false;
}

/**
 * Whether this game's result has to reach anybody other than the person who scored it.
 *
 * A file game's answer is yes, and stays yes: a tournament handed the room an assignment and the
 * downloaded QBJ is the only path the result has back. That is why the completion screen will not
 * let a file game leave until the file has been written, and nothing here weakens it.
 *
 * A game somebody created on this device to score a practice has no such path, because there is
 * nobody at the other end of it. Demanding a download before the screen will close is asking a
 * coach to file paperwork with themselves, and the predictable result is the same one every
 * unnecessary confirmation produces: it gets clicked through, including on the day it mattered.
 * The result is saved, it is in Recent Games, and the QBJ stays one press away for as long as the
 * record does — it is simply not owed to anyone.
 *
 * Provenance, not UI state: a manual game that arrived with an explicit handoff instruction, or one
 * scored connected, is back to the ordinary rule.
 */
export function gameRequiresHandoff(record: IStoredGameRecord): boolean {
  if (record.connected) return true;
  if (record.package.handoffInstruction) return true;
  return !isManualGame(record.package);
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

  get storageDegraded(): boolean {
    return this.records.storageDegraded === true;
  }

  get storageError(): string | undefined {
    return this.records.storageError;
  }

  subscribeToStorageStatus(listener: () => void): () => void {
    return this.records.subscribeToStatus?.(listener) ?? (() => undefined);
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
      // Register the write before exposing the migrated object. A caller may update it immediately
      // after `list()` resolves, and that write must be ordered after this one rather than racing it.
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

  /** The tail of the durable-write queue for each record. */
  private pendingWrites = new Map<string, Promise<void>>();

  /**
   * Put one durable mutation after every earlier mutation of the same record.
   *
   * Migration write-back is deliberately not awaited by `list()`, but it still has to be ordered with
   * an update that begins immediately afterwards. Keeping the queue here makes that ordering explicit
   * without making the welcome screen wait for IndexedDB.
   */
  private enqueueWrite<T>(id: string, write: () => Promise<T>): Promise<T> {
    const previous = this.pendingWrites.get(id) ?? Promise.resolve();
    const result = previous.then(write);
    const pending = result.then(
      () => undefined,
      () => undefined,
    );
    this.pendingWrites.set(id, pending);
    void pending.then(() => {
      if (this.pendingWrites.get(id) === pending) this.pendingWrites.delete(id);
    });
    return result;
  }

  /** Persist a migrated record without delaying the read that discovered it. */
  private writeBack(record: IStoredGameRecord): void {
    void this.enqueueWrite(record.id, () => this.records.put(record));
  }

  async findByIdentity(identity: string): Promise<IStoredGameRecord[]> {
    return (await this.list()).filter((record) => record.identity === identity);
  }

  async active(): Promise<IStoredGameRecord | null> {
    return (await this.list()).find(isActive) ?? null;
  }

  async create(input: ICreateGameInput): Promise<IStoredGameRecord> {
    const now = input.now ?? new Date();
    const identity = input.recordIdentity ?? gamePackageIdentity(input.package);
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
    const written = await this.records.put(record);
    // The in-memory fallback is intentionally allowed to keep the current tab useful, but an
    // IndexedDB-backed store that refuses this first write must not let the scorer start with a
    // record that cannot be rediscovered after a reload.
    if (!written && this.records.durable) {
      throw new Error('The game could not be committed to the local database.');
    }
    return record;
  }

  async update(id: string, change: Partial<IStoredGameRecord>): Promise<IStoredGameRecord | null> {
    return this.enqueueWrite(id, async () => {
      const stored = await this.records.get(id);
      if (!stored) return null;
      // The value in IndexedDB may still be from the previous schema even when no caller listed it
      // first. Migrate that shape before applying the requested change or assigning the target version.
      const read = readStoredRecord(stored, this.readerOptions);
      if (read.record === null) return null;
      const existing = read.record;
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
    });
  }

  saveEvents(id: string, events: ScoreEvent[], setup?: IGameSetup): boolean {
    // Written synchronously first. The durable mirror follows and is allowed to be slower; it is
    // never allowed to be the thing the room is told about.
    const cached = this.journalKeys.get(id);
    if (!cached) return false;
    const nextSetup = setup ?? cached.setup;
    const written = saveGame(cached.gameKey, nextSetup, events);
    // The cache is what a later `saveEvents` journals against, so a corrected roster has to land in
    // it as well. Only once the journal accepted the write: a refused write leaves this device
    // holding the game it had, and the cache must describe that game rather than the intended one.
    if (written && setup !== undefined) this.journalKeys.set(id, { gameKey: cached.gameKey, setup });
    void this.enqueueWrite(id, async () => {
      const stored = await this.records.get(id);
      if (!stored) return false;
      const read = readStoredRecord(stored, this.readerOptions);
      if (read.record === null) return false;
      return this.records.put({
        ...read.record,
        events,
        setup: nextSetup,
        updatedAt: new Date().toISOString(),
      });
    });
    return written;
  }

  async remove(id: string): Promise<void> {
    await this.enqueueWrite(id, async () => {
      const existing = await this.records.get(id);
      if (existing) clearGame(existing.gameKey);
      this.journalKeys.delete(id);
      await this.records.delete(id);
    });
  }

  async prune(now: Date = new Date()): Promise<number> {
    const all = await this.list();
    let removed = 0;
    for (const record of all) {
      if (isActive(record)) continue;
      const completed = new Date(record.completedAt!).getTime();
      if (!Number.isFinite(completed)) continue;
      if (now.getTime() - completed <= retentionMsFor(record.package)) continue;
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
