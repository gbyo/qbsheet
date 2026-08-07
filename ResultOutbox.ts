/**
 * Every completed game this Chromebook has produced, kept until tournament control has it.
 *
 * The predecessor to this file held exactly one pending result in localStorage, which was fine for
 * the failure it was written for — one upload, one dropped packet — and wrong for the day the
 * server goes away for twenty minutes. A room finishes round 4, is handed round 5, finishes that
 * too, and now has two completed games and one storage slot. The second one silently replaced the
 * first, and nobody found out until the standings were short a game.
 *
 * So the outbox holds many results, each with its own delivery state, and nothing is ever removed
 * because something newer arrived. Removal happens for exactly one reason: tournament control has
 * accepted the result and the retention policy has decided the local copy is no longer earning its
 * space. An unresolved result is never pruned, at any age, for any reason.
 *
 * Two things are deliberately kept out of the store. Session credentials for a game are needed to
 * deliver it and are stored with it, but they are stripped from anything that leaves the device
 * (see QbjBackup). And the store never decides tournament state: the server remains authoritative
 * about whether a result was accepted, and `accepted` here only ever mirrors what the server said.
 */
import { ISessionCredentials } from './api';

/**
 * Record schema version.
 *
 * Bumped when the shape of a stored entry changes in a way an older bundle could misread. A record
 * from a *newer* version than this bundle understands is left alone rather than migrated
 * downwards — a Chromebook that has been rolled back mid-tournament must not destroy results a
 * newer bundle wrote.
 */
export const outboxSchemaVersion = 1;

/** Where a result is on its way to tournament control. */
export type OutboxDeliveryState =
  /** Saved on this device; not sent yet, or waiting for the next attempt. */
  | 'queued'
  /** The server has it and it is with tournament control. */
  | 'submitted'
  /** Tournament control accepted it. The local copy is now only a safety copy. */
  | 'accepted'
  /** Tournament control sent it back to be corrected. */
  | 'needs-correction'
  /** Scored outside any server assignment. Non-authoritative until a human imports it. */
  | 'manual-backup';

/** One completed game held on this device. */
export interface IRoomResultOutboxEntry {
  id: string;
  /** The tournament this belongs to, so a result cannot be delivered into a different one. */
  tournamentKey?: string;
  roomId?: string;
  scheduledMatchId?: string;

  roundNumber?: number;
  roundName?: string;
  leftTeam: string;
  rightTeam: string;

  /** The QBJ Match exactly as it will be uploaded and exactly as it will be downloaded. */
  qbj: object;

  /** ISO 8601 */
  createdAt: string;
  /** ISO 8601 */
  updatedAt: string;

  deliveryState: OutboxDeliveryState;

  /** How many delivery attempts have been made. Drives the backoff, never the correctness. */
  attempts: number;

  /**
   * Credentials for the session this result belongs to.
   *
   * Absent for a manual-backup entry, which by definition has no server session. Never included in
   * a downloaded QBJ.
   */
  sessionCredentials?: ISessionCredentials;

  /** Stable digest of the payload, used to recognize a retry of the same result. */
  finalFingerprint?: string;

  /**
   * True once a refusal has been classified as permanent.
   *
   * Automatic retry stops, the result stays on the device, and the scorekeeper is offered the QBJ
   * download instead. Nothing about the result itself is discarded.
   */
  retryBlocked?: boolean;

  /** The last thing the server or the network said, for the scorekeeper and for diagnosis. */
  lastError?: string;

  /** ISO 8601 of the last delivery attempt, so backoff survives a reload. */
  lastAttemptAt?: string;
}

/** A stored record is the entry plus the schema version it was written under. */
interface IStoredOutboxRecord extends IRoomResultOutboxEntry {
  schemaVersion: number;
}

/** Delivery states that still need something to happen. These are never auto-pruned. */
const unresolvedStates: OutboxDeliveryState[] = ['queued', 'submitted', 'needs-correction', 'manual-backup'];

export function isUnresolvedDeliveryState(state: OutboxDeliveryState): boolean {
  return unresolvedStates.includes(state);
}

/**
 * How many accepted results to keep on the device.
 *
 * A fixed limit rather than a setting: nobody running a tournament wants to tune this, and the only
 * thing it protects against is a Chromebook's storage filling up over a long day. Unresolved
 * results are not subject to it.
 */
export const acceptedRetentionLimit = 20;

/** Longest gap between automatic retries. A room should not wait more than a minute to try again. */
export const maxRetryDelayMs = 60_000;

/** Shortest gap. Matches the room's own poll interval, so retries never outpace the poll. */
export const baseRetryDelayMs = 5_000;

/**
 * How long to wait before the next automatic attempt.
 *
 * Doubling, capped. There is no attempt ceiling on purpose: a room whose server has been off for
 * half an hour must still be trying when it comes back, and "we gave up after ten tries" is exactly
 * the behavior that loses a game. What stops retrying is a *classification* — a permanent refusal —
 * not a counter.
 */
export function retryDelayMs(attempts: number): number {
  const safeAttempts = Number.isInteger(attempts) && attempts > 0 ? attempts : 0;
  return Math.min(maxRetryDelayMs, baseRetryDelayMs * 2 ** Math.min(safeAttempts, 10));
}

/** Is this entry due for another automatic attempt? */
export function isDueForRetry(entry: IRoomResultOutboxEntry, nowMs: number): boolean {
  if (entry.retryBlocked) return false;
  if (entry.deliveryState !== 'queued') return false;
  if (!entry.sessionCredentials) return false;
  if (!entry.lastAttemptAt) return true;
  const last = new Date(entry.lastAttemptAt).getTime();
  if (!Number.isFinite(last)) return true;
  return nowMs - last >= retryDelayMs(entry.attempts);
}

/**
 * What a failed delivery attempt meant.
 *
 * `retry` means the network or the server was temporarily unable to take it. `permanent` means it
 * is never going to work: keep the result, stop retrying, and tell the scorekeeper.
 */
export interface IDeliveryFailureClassification {
  kind: 'retry' | 'permanent';
  message: string;
}

/**
 * Decide what an HTTP failure means for a queued result.
 *
 * The split is by *what would change if we tried again*. No status at all means the request never
 * reached anything, which a working network fixes. A 5xx means the server is there and struggling,
 * which time fixes. A 404 means the session no longer exists, a 403 means these credentials are not
 * valid for the open tournament, and a 409 means the tournament has already resolved this game —
 * none of which get better by asking again, so the result is kept locally and handed to a human.
 */
export function classifyDeliveryFailure(status: number | undefined, message: string): IDeliveryFailureClassification {
  if (status === undefined) {
    return { kind: 'retry', message: message || 'Could not reach the YellowFruit computer.' };
  }
  if (status === 404 || status === 403 || status === 409 || status === 410) {
    return { kind: 'permanent', message };
  }
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return { kind: 'retry', message };
  }
  // Any other 4xx is the server refusing this specific payload. Retrying the identical bytes is
  // not going to change its mind.
  return { kind: 'permanent', message };
}

/**
 * A stable digest of a result payload.
 *
 * Only ever compared against another digest produced here, to recognize "this is the same result we
 * already have" after a reload or a lost response. It is not a security control and is deliberately
 * not a browser-crypto call, which would make every enqueue asynchronous for no benefit.
 */
export function fingerprintPayload(value: unknown): string {
  const text = canonicalJson(value);
  // Two independently seeded FNV-1a passes. Enough to make an accidental collision between two
  // scoresheets from the same room implausible, which is all this is asked to do.
  // eslint-disable-next-line no-bitwise -- XOR and unsigned shift are the hash, not a cleverness.
  const mix = (accumulator: number, code: number, prime: number) => Math.imul(accumulator ^ code, prime) >>> 0;
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    a = mix(a, code, 0x01000193);
    b = mix(b, code + index, 0x85ebca6b);
  }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
}

/** Byte-order-free string comparison, so key ordering does not depend on the browser's locale. */
function compareKeys(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Key-order-independent JSON, so a re-serialized payload hashes the same. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => compareKeys(left, right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
  return `{${entries.join(',')}}`;
}

/**
 * Read one stored record back into an entry.
 *
 * Returns null for anything unusable. A malformed record is not an error the room app should have
 * to handle: it is skipped, left in the store rather than deleted, and scorekeeping carries on. The
 * one thing it must never do is throw, because that would take the whole saved-results list — and
 * with it every *good* result — down with it.
 */
export function parseOutboxRecord(source: unknown): IRoomResultOutboxEntry | null {
  if (typeof source !== 'object' || source === null) return null;
  const record = source as Partial<IStoredOutboxRecord>;
  if (typeof record.id !== 'string' || record.id === '') return null;
  if (typeof record.schemaVersion !== 'number' || !Number.isInteger(record.schemaVersion)) return null;
  // A record from a future bundle is left intact and simply not shown. Guessing at a shape we do
  // not know would be a good way to corrupt a result a newer bundle can still deliver.
  if (record.schemaVersion > outboxSchemaVersion) return null;
  if (typeof record.leftTeam !== 'string' || typeof record.rightTeam !== 'string') return null;
  if (typeof record.qbj !== 'object' || record.qbj === null) return null;
  if (typeof record.createdAt !== 'string' || !Number.isFinite(new Date(record.createdAt).getTime())) return null;
  const state = record.deliveryState;
  if (
    state !== 'queued' &&
    state !== 'submitted' &&
    state !== 'accepted' &&
    state !== 'needs-correction' &&
    state !== 'manual-backup'
  ) {
    return null;
  }

  const credentials =
    typeof record.sessionCredentials === 'object' &&
    record.sessionCredentials !== null &&
    typeof record.sessionCredentials.sessionId === 'string' &&
    typeof record.sessionCredentials.token === 'string'
      ? { sessionId: record.sessionCredentials.sessionId, token: record.sessionCredentials.token }
      : undefined;

  return {
    id: record.id,
    tournamentKey: typeof record.tournamentKey === 'string' ? record.tournamentKey : undefined,
    roomId: typeof record.roomId === 'string' ? record.roomId : undefined,
    scheduledMatchId: typeof record.scheduledMatchId === 'string' ? record.scheduledMatchId : undefined,
    roundNumber:
      typeof record.roundNumber === 'number' && Number.isFinite(record.roundNumber) ? record.roundNumber : undefined,
    roundName: typeof record.roundName === 'string' ? record.roundName : undefined,
    leftTeam: record.leftTeam,
    rightTeam: record.rightTeam,
    qbj: record.qbj as object,
    createdAt: record.createdAt,
    updatedAt:
      typeof record.updatedAt === 'string' && Number.isFinite(new Date(record.updatedAt).getTime())
        ? record.updatedAt
        : record.createdAt,
    deliveryState: state,
    attempts: typeof record.attempts === 'number' && record.attempts >= 0 ? Math.floor(record.attempts) : 0,
    sessionCredentials: credentials,
    finalFingerprint: typeof record.finalFingerprint === 'string' ? record.finalFingerprint : undefined,
    retryBlocked: record.retryBlocked === true ? true : undefined,
    lastError: typeof record.lastError === 'string' && record.lastError !== '' ? record.lastError : undefined,
    lastAttemptAt: typeof record.lastAttemptAt === 'string' ? record.lastAttemptAt : undefined,
  };
}

export function toOutboxRecord(entry: IRoomResultOutboxEntry): IStoredOutboxRecord {
  return { ...entry, schemaVersion: outboxSchemaVersion };
}

/**
 * Which accepted entries the retention policy would remove.
 *
 * Deterministic: newest accepted results are kept, ties broken by id, and nothing unresolved is
 * ever a candidate. Written as a pure function over the list so the rule can be tested without a
 * store, and so it is obvious by reading it that an unresolved result cannot be selected.
 */
export function selectPrunableEntries(
  entries: IRoomResultOutboxEntry[],
  limit: number = acceptedRetentionLimit,
): IRoomResultOutboxEntry[] {
  const accepted = entries
    .filter((entry) => entry.deliveryState === 'accepted')
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
  return accepted.slice(Math.max(0, limit));
}

/** The order the Saved results list shows: newest first, stable on ties. */
export function sortForDisplay(entries: IRoomResultOutboxEntry[]): IRoomResultOutboxEntry[] {
  return entries
    .slice()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
}

/** The scorekeeper-facing name for a delivery state. Never a status code, never a state string. */
export function describeDeliveryState(entry: IRoomResultOutboxEntry): string {
  switch (entry.deliveryState) {
    case 'accepted':
      return 'Accepted by YellowFruit';
    case 'submitted':
      return 'Submitted to YellowFruit';
    case 'needs-correction':
      return 'Needs correction';
    case 'manual-backup':
      return 'Emergency copy — not yet in the tournament';
    case 'queued':
    default:
      return entry.retryBlocked ? 'Not sent — download and hand in' : 'Waiting to send';
  }
}
