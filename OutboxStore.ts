/**
 * The outbox as the room application uses it: load, enqueue, deliver, mark, prune.
 *
 * The ordering rule this file exists to enforce is that a completed game is written to this device
 * *before* the first upload attempt, and is not removed because an upload appeared to succeed —
 * only because tournament control accepted it and the retention policy let it go. Everything else
 * here is in service of that: the in-memory list is a cache of the store rather than the other way
 * round, and every mutation writes through.
 *
 * Persistence failure is a first-class outcome, not an exception. A Chromebook with storage
 * disabled still has to be able to finish the game in front of it; what it must not do is tell the
 * scorekeeper the result is safe. So a failed write returns `persisted: false` and the entry stays
 * in memory, where the UI turns it into an immediate "download the QBJ now" rather than a
 * reassuring message.
 */
import { ISessionCredentials } from './api';
import { IOutboxDriver, IOutboxRecord } from './OutboxStorage';
import {
  IRoomResultOutboxEntry,
  OutboxDeliveryState,
  classifyDeliveryFailure,
  fingerprintPayload,
  isDueForRetry,
  parseOutboxRecord,
  selectPrunableEntries,
  sortForDisplay,
  toOutboxRecord,
} from './ResultOutbox';

/** The localStorage key the single-result predecessor used. Read once, then retired. */
export const legacyPendingFinalKey = 'yellowfruit-room-pending-final';

/** The minimal storage surface the legacy migration needs. */
export interface ILegacyStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
}

/** What a completed game looks like before it has an id or timestamps. */
export interface IOutboxDraft {
  tournamentKey?: string;
  roomId?: string;
  scheduledMatchId?: string;
  roundNumber?: number;
  roundName?: string;
  leftTeam: string;
  rightTeam: string;
  qbj: object;
  deliveryState: OutboxDeliveryState;
  sessionCredentials?: ISessionCredentials;
}

/** The outcome of trying to put a completed game into the outbox. */
export interface IEnqueueResult {
  entry: IRoomResultOutboxEntry;
  /**
   * True only when the result genuinely survives a reload of this page.
   *
   * The room app must not say "saved on this Chromebook" unless this is true.
   */
  persisted: boolean;
  /** Why persistence failed, when it did. */
  error?: string;
  /** True when this was recognized as a result the outbox already had. */
  deduplicated: boolean;
  /** True when this replaced a result tournament control had sent back to be corrected. */
  supersededCorrection?: boolean;
}

export interface IOutboxLoadResult {
  entries: IRoomResultOutboxEntry[];
  /** Records that could not be read. Left in the store, counted, and otherwise ignored. */
  skipped: number;
  /** How many legacy single-result records were carried across. */
  migrated: number;
  /** False when this browser has no durable store at all. */
  durable: boolean;
  /** Set when the store itself could not be read. */
  error?: string;
}

/** What one delivery attempt returned. Mirrors the room API's result shape. */
export type DeliveryAttemptResult =
  | { ok: true; newSubmission: boolean }
  | { ok: false; status?: number; error: string };

export type OutboxDeliverFn = (entry: IRoomResultOutboxEntry) => Promise<DeliveryAttemptResult>;

export interface IFlushSummary {
  attempted: number;
  delivered: number;
  /** Entries whose refusal was classified as permanent during this flush. */
  blocked: number;
  /** Entries that will be tried again. */
  retrying: number;
}

interface IOutboxOptions {
  now?: () => Date;
  newId?: () => string;
  legacyStorage?: ILegacyStorage | null;
}

function defaultId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
      return `result-${crypto.randomUUID()}`;
  } catch {
    // Fall through to the timestamped form below.
  }
  return `result-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

function defaultLegacyStorage(): ILegacyStorage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Retire the predecessor's key once its record is safely somewhere else. */
function forgetLegacyRecord(storage: ILegacyStorage) {
  try {
    storage.removeItem(legacyPendingFinalKey);
  } catch {
    // The migration itself succeeded. A stale key is re-detected and re-cleared next load.
  }
}

/** The two team names in a QBJ Match, in the order the payload lists them. */
export function teamNamesFromQbj(qbj: unknown): [string, string] | null {
  const matchTeams = (qbj as { match_teams?: unknown })?.match_teams;
  if (!Array.isArray(matchTeams) || matchTeams.length < 2) return null;
  const names = matchTeams.slice(0, 2).map((matchTeam) => (matchTeam as any)?.team?.name);
  if (names.some((name) => typeof name !== 'string' || name === '')) return null;
  return [names[0], names[1]] as [string, string];
}

export default class RoomResultOutbox {
  private driver: IOutboxDriver;

  private cache: IRoomResultOutboxEntry[] = [];

  private loaded = false;

  private now: () => Date;

  private newId: () => string;

  private legacyStorage: ILegacyStorage | null;

  /**
   * Ids whose most recent write to the store actually landed.
   *
   * A per-entry fact, not a per-driver one, and the distinction is the whole point. `driver.durable`
   * says "writes to this store survive a reload", which IndexedDB answers yes to even for a write
   * that just failed on quota. Reporting that as `persisted: true` would tell a scorekeeper their
   * game is safe on the Chromebook when it exists only in this page's memory — exactly the promise
   * this outbox exists to keep. So durability is tracked per id, and a result is only ever called
   * persisted when a write for that id has been observed to succeed.
   */
  private persistedIds = new Set<string>();

  constructor(driver: IOutboxDriver, options: IOutboxOptions = {}) {
    this.driver = driver;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? defaultId;
    this.legacyStorage = options.legacyStorage === undefined ? defaultLegacyStorage() : options.legacyStorage;
  }

  /** True when a write to this outbox survives a reload. */
  get durable(): boolean {
    return this.driver.durable;
  }

  /** Does this specific result survive a reload right now? */
  isPersisted(id: string): boolean {
    return this.driver.durable && this.persistedIds.has(id);
  }

  /**
   * Write one entry and record whether it landed.
   *
   * The single place `persistedIds` is maintained, so there is no path that can mark an entry
   * durable without a write having succeeded for it.
   */
  private async writeThrough(entry: IRoomResultOutboxEntry): Promise<{ persisted: boolean; error?: string }> {
    try {
      await this.driver.write(toOutboxRecord(entry));
      this.persistedIds.add(entry.id);
      return { persisted: this.driver.durable };
    } catch (error: unknown) {
      this.persistedIds.delete(entry.id);
      return { persisted: false, error: messageOf(error) };
    }
  }

  /** Everything currently held, newest first. Reads the in-memory cache; call `load` first. */
  list(): IRoomResultOutboxEntry[] {
    return sortForDisplay(this.cache);
  }

  find(id: string): IRoomResultOutboxEntry | undefined {
    return this.cache.find((entry) => entry.id === id);
  }

  /** Results that still need something to happen before the tournament has them. */
  unresolved(): IRoomResultOutboxEntry[] {
    return this.list().filter((entry) => entry.deliveryState !== 'accepted');
  }

  /**
   * Read the store, migrating the legacy single-result record if one is present.
   *
   * Called once on mount and safe to call again. A store that cannot be read at all produces an
   * empty list and an error rather than throwing, because the alternative is a room browser that
   * shows a stack trace instead of a scoresheet.
   */
  async load(): Promise<IOutboxLoadResult> {
    let records: IOutboxRecord[] = [];
    let readError: string | undefined;
    try {
      records = await this.driver.readAll();
    } catch (error: unknown) {
      readError = messageOf(error);
    }

    const entries: IRoomResultOutboxEntry[] = [];
    let skipped = 0;
    for (const record of records) {
      const parsed = parseOutboxRecord(record);
      if (parsed) entries.push(parsed);
      else skipped += 1;
    }
    this.cache = entries;
    this.loaded = true;
    // Anything that came back out of the store is, by definition, in the store.
    this.persistedIds = new Set(entries.map((entry) => entry.id));

    const migrated = readError === undefined ? await this.migrateLegacyPendingFinal() : 0;

    return {
      entries: this.list(),
      skipped,
      migrated,
      durable: this.driver.durable,
      error: readError,
    };
  }

  /**
   * Carry the single-result predecessor's record across.
   *
   * Order matters and is the whole point: write the new entry, prove it is readable, and only then
   * remove the old record. A migration that clears the old key first and then fails to write has
   * destroyed a completed game, which is the one outcome this code exists to prevent.
   */
  private async migrateLegacyPendingFinal(): Promise<number> {
    const storage = this.legacyStorage;
    if (!storage) return 0;

    let raw: string | null = null;
    try {
      raw = storage.getItem(legacyPendingFinalKey);
    } catch {
      return 0;
    }
    if (!raw) return 0;

    let legacy: { credentials?: ISessionCredentials; qbj?: object; queuedAt?: string; attempts?: number } | null = null;
    try {
      legacy = JSON.parse(raw);
    } catch {
      legacy = null;
    }
    const credentials = legacy?.credentials;
    const qbj = legacy?.qbj;
    if (
      !legacy ||
      typeof credentials?.sessionId !== 'string' ||
      typeof credentials?.token !== 'string' ||
      typeof qbj !== 'object' ||
      qbj === null
    ) {
      // Unreadable rather than absent. Leave it exactly where it is: it is the only copy of
      // whatever it was, and a human with the browser's storage inspector can still get at it.
      return 0;
    }

    const fingerprint = fingerprintPayload(qbj);
    const alreadyHere = this.cache.some(
      (entry) =>
        entry.sessionCredentials?.sessionId === credentials.sessionId && entry.finalFingerprint === fingerprint,
    );
    if (alreadyHere) {
      // A previous run migrated it and then failed to clear the key. Finish the job.
      forgetLegacyRecord(storage);
      return 0;
    }

    const names = teamNamesFromQbj(qbj);
    const queuedAt =
      typeof legacy.queuedAt === 'string' && Number.isFinite(new Date(legacy.queuedAt).getTime())
        ? legacy.queuedAt
        : this.now().toISOString();
    const entry: IRoomResultOutboxEntry = {
      id: this.newId(),
      leftTeam: names?.[0] ?? '',
      rightTeam: names?.[1] ?? '',
      qbj,
      createdAt: queuedAt,
      updatedAt: this.now().toISOString(),
      deliveryState: 'queued',
      attempts: typeof legacy.attempts === 'number' && legacy.attempts >= 0 ? Math.floor(legacy.attempts) : 0,
      sessionCredentials: { sessionId: credentials.sessionId, token: credentials.token },
      finalFingerprint: fingerprint,
    };

    try {
      await this.driver.write(toOutboxRecord(entry));
      const written = await this.driver.readAll();
      const proven = written.some((record) => parseOutboxRecord(record)?.id === entry.id);
      if (!proven) return 0;
    } catch {
      // The old record stays. The next load will try again.
      return 0;
    }

    this.cache.push(entry);
    forgetLegacyRecord(storage);
    return 1;
  }

  /**
   * The entry this draft is a correction of, if any.
   *
   * A result tournament control sent back is the same *game*, so a correction has to replace it
   * rather than sit beside it. Matching is by scheduled game where there is one and by session
   * otherwise — never by payload, because the entire point of a correction is that the payload
   * changed. Without this, a corrected result either never sends (the payload happened to be
   * identical, so it deduped onto an entry `deliverOne` refuses to touch) or sends as a second
   * entry while the rejected one stays unresolved on the device forever.
   */
  private findCorrectableEntry(draft: IOutboxDraft): IRoomResultOutboxEntry | undefined {
    if (draft.deliveryState !== 'queued') return undefined;
    return this.cache.find((entry) => {
      if (entry.deliveryState !== 'needs-correction') return false;
      if (draft.scheduledMatchId !== undefined) return entry.scheduledMatchId === draft.scheduledMatchId;
      if (draft.sessionCredentials !== undefined) {
        return entry.sessionCredentials?.sessionId === draft.sessionCredentials.sessionId;
      }
      return false;
    });
  }

  /**
   * Put a completed game into the outbox, persisting it before anyone tries to upload it.
   *
   * Three cases, in order. A correction supersedes the entry it corrects. A result the outbox
   * already holds — same session, same payload — is recognized rather than duplicated, which is what
   * makes a lost HTTP response safe. Anything else is new.
   *
   * `persisted` is a claim about this specific result surviving a reload, and it is never inferred
   * from the store's general durability: a dedupe onto an entry whose own write failed reports
   * false and retries the write, rather than telling the scorekeeper the game is safe because
   * IndexedDB exists.
   */
  async enqueue(draft: IOutboxDraft): Promise<IEnqueueResult> {
    if (!this.loaded) await this.load();

    const fingerprint = fingerprintPayload(draft.qbj);

    const correctable = this.findCorrectableEntry(draft);
    if (correctable) {
      const superseded = await this.update(correctable.id, {
        qbj: draft.qbj,
        finalFingerprint: fingerprint,
        // Back to the front of the queue: a correction is a fresh submission of the same game, so
        // it must not inherit the rejected attempt's backoff or its blocked flag.
        deliveryState: 'queued',
        attempts: 0,
        lastAttemptAt: undefined,
        retryBlocked: undefined,
        lastError: undefined,
        roundNumber: draft.roundNumber ?? correctable.roundNumber,
        roundName: draft.roundName ?? correctable.roundName,
        sessionCredentials: draft.sessionCredentials ?? correctable.sessionCredentials,
      });
      const entry = superseded ?? correctable;
      return {
        entry,
        persisted: this.isPersisted(entry.id),
        error: this.isPersisted(entry.id) ? undefined : 'This browser could not save the corrected result locally.',
        deduplicated: false,
        supersededCorrection: true,
      };
    }

    const existing = this.cache.find(
      (entry) =>
        entry.finalFingerprint === fingerprint &&
        entry.sessionCredentials?.sessionId === draft.sessionCredentials?.sessionId,
    );
    if (existing) {
      // Already known, but "known" may only mean in memory. Try the write again before making any
      // claim about it.
      if (this.isPersisted(existing.id)) {
        return { entry: existing, persisted: true, deduplicated: true };
      }
      const retried = await this.writeThrough(existing);
      return { entry: existing, persisted: retried.persisted, error: retried.error, deduplicated: true };
    }

    const timestamp = this.now().toISOString();
    const entry: IRoomResultOutboxEntry = {
      id: this.newId(),
      tournamentKey: draft.tournamentKey,
      roomId: draft.roomId,
      scheduledMatchId: draft.scheduledMatchId,
      roundNumber: draft.roundNumber,
      roundName: draft.roundName,
      leftTeam: draft.leftTeam,
      rightTeam: draft.rightTeam,
      qbj: draft.qbj,
      createdAt: timestamp,
      updatedAt: timestamp,
      deliveryState: draft.deliveryState,
      attempts: 0,
      sessionCredentials: draft.sessionCredentials,
      finalFingerprint: fingerprint,
    };

    // In memory first, so the result exists for the UI and for the download even if the store
    // refuses it. The store is the durability claim, not the existence of the result.
    this.cache.push(entry);

    const written = await this.writeThrough(entry);
    return { entry, persisted: written.persisted, error: written.error, deduplicated: false };
  }

  /** Write one entry through to the store, keeping the cache and the store in step. */
  private async persist(entry: IRoomResultOutboxEntry): Promise<boolean> {
    const index = this.cache.findIndex((candidate) => candidate.id === entry.id);
    if (index >= 0) this.cache[index] = entry;
    else this.cache.push(entry);
    return (await this.writeThrough(entry)).persisted;
  }

  private async update(id: string, change: Partial<IRoomResultOutboxEntry>): Promise<IRoomResultOutboxEntry | null> {
    const current = this.cache.find((entry) => entry.id === id);
    if (!current) return null;
    const next: IRoomResultOutboxEntry = { ...current, ...change, updatedAt: this.now().toISOString() };
    await this.persist(next);
    return next;
  }

  /**
   * The server has this result and tournament control is looking at it.
   *
   * The local copy stays. A result under review is precisely the one that might come back needing
   * correction, and the device is the only place the scorekeeper can get it from.
   */
  markSubmitted(id: string): Promise<IRoomResultOutboxEntry | null> {
    return this.update(id, { deliveryState: 'submitted', retryBlocked: undefined, lastError: undefined });
  }

  /** Tournament control accepted it. Now — and only now — it becomes prunable. */
  markAccepted(id: string): Promise<IRoomResultOutboxEntry | null> {
    return this.update(id, { deliveryState: 'accepted', retryBlocked: undefined, lastError: undefined });
  }

  /** Tournament control sent it back. The local copy is what the room corrects from. */
  markNeedsCorrection(id: string, reason?: string): Promise<IRoomResultOutboxEntry | null> {
    return this.update(id, { deliveryState: 'needs-correction', lastError: reason });
  }

  /**
   * The scorekeeper says they have handed this result over another way.
   *
   * The case this exists for: a room's server was replaced, so its session no longer exists and the
   * result is permanently `retryBlocked`. The director recovers it by importing the downloaded QBJ,
   * which creates no session — so nothing will ever come back through the assignment poll to mark
   * this entry accepted. Without an acknowledgement the entry stays unresolved forever, and a room
   * with an unresolved result is a room that will not start its next game.
   *
   * Deliberately not `accepted`: this browser has no standing to say the tournament recorded
   * anything. It records only that the scorekeeper got the file to tournament control, which is
   * exactly the fact being asserted. The result and its download stay.
   */
  markHandedOver(id: string): Promise<IRoomResultOutboxEntry | null> {
    const entry = this.cache.find((candidate) => candidate.id === id);
    // An accepted result needs no acknowledgement, and one still being retried is not stranded.
    if (!entry || entry.deliveryState === 'accepted') return Promise.resolve(entry ?? null);
    return this.update(id, { handedOver: true });
  }

  /** Remove one entry explicitly. Only ever called for an accepted result. */
  async remove(id: string): Promise<void> {
    const entry = this.cache.find((candidate) => candidate.id === id);
    if (entry && entry.deliveryState !== 'accepted') return;
    this.cache = this.cache.filter((candidate) => candidate.id !== id);
    this.persistedIds.delete(id);
    try {
      await this.driver.remove(id);
    } catch {
      // The cache no longer shows it; a later load will simply see it again and re-prune.
    }
  }

  /**
   * Apply the retention policy.
   *
   * Only accepted results are candidates, and the policy is a pure function so what it selects can
   * be read and tested without a store. Nothing unresolved is reachable from here.
   */
  async prune(): Promise<number> {
    const prunable = selectPrunableEntries(this.cache);
    for (const entry of prunable) {
      // eslint-disable-next-line no-await-in-loop
      await this.remove(entry.id);
    }
    return prunable.length;
  }

  /**
   * One delivery attempt for one entry, applied to the store.
   *
   * The attempt is counted and timestamped *before* the request goes out, so a response that never
   * arrives still advances the backoff rather than producing an unbounded retry storm. A refusal
   * classified as permanent stops automatic retry for this entry and nothing else: the result
   * stays, other entries carry on, and the scorekeeper is offered the download.
   */
  private async attemptDelivery(
    entry: IRoomResultOutboxEntry,
    deliver: OutboxDeliverFn,
  ): Promise<'delivered' | 'blocked' | 'retrying'> {
    const attempted = await this.update(entry.id, {
      attempts: entry.attempts + 1,
      lastAttemptAt: this.now().toISOString(),
    });
    if (!attempted) return 'retrying';

    let result: DeliveryAttemptResult;
    try {
      result = await deliver(attempted);
    } catch (error: unknown) {
      result = { ok: false, error: messageOf(error) };
    }

    if (result.ok) {
      await this.update(entry.id, { deliveryState: 'submitted', retryBlocked: undefined, lastError: undefined });
      return 'delivered';
    }

    const classification = classifyDeliveryFailure(result.status, result.error);
    if (classification.kind === 'permanent') {
      await this.update(entry.id, { retryBlocked: true, lastError: classification.message });
      return 'blocked';
    }
    await this.update(entry.id, { lastError: classification.message });
    return 'retrying';
  }

  /**
   * Deliver one specific result right now, ignoring the backoff.
   *
   * This is the first attempt made immediately after a game is finished, where the scorekeeper is
   * standing there waiting to be told whether it landed. The backoff governs the automatic retries
   * that follow, not the attempt they are retrying.
   */
  async deliverOne(id: string, deliver: OutboxDeliverFn): Promise<IRoomResultOutboxEntry | null> {
    const entry = this.cache.find((candidate) => candidate.id === id);
    if (!entry) return null;
    if (entry.deliveryState !== 'queued' || !entry.sessionCredentials) return entry;
    await this.attemptDelivery(entry, deliver);
    return this.cache.find((candidate) => candidate.id === id) ?? null;
  }

  /** Try to deliver everything the backoff says is due. */
  async flush(deliver: OutboxDeliverFn): Promise<IFlushSummary> {
    if (!this.loaded) await this.load();
    const summary: IFlushSummary = { attempted: 0, delivered: 0, blocked: 0, retrying: 0 };
    const nowMs = this.now().getTime();
    const due = this.cache.filter((entry) => isDueForRetry(entry, nowMs));

    for (const entry of due) {
      summary.attempted += 1;
      // Sequential on purpose: two results from one room going out at once would race the server's
      // per-assignment duplicate check for no benefit on a LAN.
      // eslint-disable-next-line no-await-in-loop
      const outcome = await this.attemptDelivery(entry, deliver);
      if (outcome === 'delivered') summary.delivered += 1;
      else if (outcome === 'blocked') summary.blocked += 1;
      else summary.retrying += 1;
    }

    return summary;
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error !== '') return error;
  return 'This browser could not save the result locally.';
}
