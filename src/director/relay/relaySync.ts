/**
 * Director relay synchronization engine (#773).
 *
 * # What this owns
 *
 * The long-lived Director ↔ tournament-relay loop: publish an allowlisted mirror projection,
 * replay missed durable events behind a durable cursor, reconcile coalescible session state,
 * and feed relay results through the normal transport-independent Results pipeline. It is
 * deliberately UI-free: the native Director process (not a React view) owns the connection,
 * and this module is the pure protocol core that loop calls. Persistence of the cursor and
 * the credential stay with their existing owners (`RelayConfig` pointer + OS keychain).
 *
 * # Ordering contract (crash-safe)
 *
 * For critical items (final results, help):
 *
 * 1. receive item;
 * 2. validate protocol/body;
 * 3. ingest through existing Director logic (`assessIncomingDocument`/`stageIncomingDocument`);
 * 4. persist local state/receipt;
 * 5. commit the updated local relay cursor;
 * 6. acknowledge to the relay (`POST manage/acks`).
 *
 * A crash between steps replays safely: the relay retains unacknowledged finals/help
 * indefinitely, `POST manage/acks` is idempotent, and `advanceRelayCursor` below only moves
 * forward. Steps 4–5 are the caller's durable commit; this module never advances the cursor
 * past an item the caller has not confirmed ingested.
 *
 * # What this never does
 *
 * - No second "cloud results" inbox: relay QBJ becomes an `IncomingDocument` with
 *   `sourceKind: 'qbtcp'` so LAN + relay duplicates converge on the existing fingerprint
 *   path (`mixedTransport.test.ts` proves the convergence).
 * - No whole-`DirectorState` mirroring: `buildRelayMirrorDocument` projects an explicit
 *   allowlist (rooms, sessions, pairing hashes — never plaintext codes or credentials).
 * - No stale overwrite: `reconcileRelaySessions` is newest-wins on `updated_sequence`
 *   with ties favoring local Director truth, and a full resync replaces coalescible state
 *   only — it never drops unacknowledged finals.
 */

import { digestText } from '../transfers/canonical';
import type { IncomingDocument } from '../transfers/ingest';

// ---------------------------------------------------------------------------
// Mirror projection (Director → relay)
// ---------------------------------------------------------------------------

/** One room as the relay is allowed to see it. Plaintext pairing codes never appear. */
export interface RelayMirrorRoomInput {
  roomId: string;
  name?: string | null;
  /** SHA-256 hex of the pairing code, when the room currently has one. */
  pairingCodeHash?: string | null;
  pairingExpiresAt?: string | null;
  assignmentQbj?: unknown;
  matchId?: string | null;
  roundRevision?: number | null;
  assignmentRevision?: number | null;
}

/** One session as the relay is allowed to see it. */
export interface RelayMirrorSessionInput {
  sessionId: string;
  roomId: string;
  matchId: string;
  status: 'open' | 'final-received' | 'abandoned';
  activeWriterDeviceId?: string | null;
}

export interface RelayMirrorBuildInput {
  directorEpoch: number;
  revision: number;
  tournamentName?: string | null;
  rooms: RelayMirrorRoomInput[];
  sessions: RelayMirrorSessionInput[];
}

export type RelayMirrorBuildResult =
  { ok: true; document: Record<string, unknown> } | { ok: false; error: string };

const MAX_MIRRORED_ROOMS = 512;
const MAX_MIRRORED_SESSIONS = 2048;
const MAX_MIRRORED_ASSIGNMENT_BYTES = 262_144;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

function validRevision(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function utf8Length(text: string): number {
  return typeof TextEncoder === 'undefined' ? text.length : new TextEncoder().encode(text).length;
}

function isJsonTree(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null) return true;
  const kind = typeof value;
  if (kind === 'string' || kind === 'number' || kind === 'boolean') return true;
  if (Array.isArray(value)) return value.every((entry) => isJsonTree(entry, depth + 1));
  if (kind === 'object') {
    return Object.values(value as Record<string, unknown>).every((entry) => isJsonTree(entry, depth + 1));
  }
  return false;
}

/**
 * Project exactly the QBTCP relay duties onto a `PUT manage/mirror` body.
 *
 * Unknown input fields have nowhere to go: the builder picks named properties off the
 * typed inputs, so a future private/local `DirectorState` field fails closed rather than
 * leaking into the relay the next time someone spreads an object.
 */
export function buildRelayMirrorDocument(input: RelayMirrorBuildInput): RelayMirrorBuildResult {
  if (!Number.isInteger(input.directorEpoch) || input.directorEpoch < 0) {
    return { ok: false, error: '`directorEpoch` must be a non-negative integer.' };
  }
  if (!Number.isInteger(input.revision) || input.revision <= 0) {
    return { ok: false, error: '`revision` must be a positive integer.' };
  }
  if (input.rooms.length > MAX_MIRRORED_ROOMS) {
    return { ok: false, error: `The relay accepts at most ${MAX_MIRRORED_ROOMS} rooms per mirror.` };
  }
  if (input.sessions.length > MAX_MIRRORED_SESSIONS) {
    return { ok: false, error: `The relay accepts at most ${MAX_MIRRORED_SESSIONS} sessions per mirror.` };
  }
  const rooms: Record<string, unknown>[] = [];
  for (const entry of input.rooms) {
    const roomId = cleanText(entry.roomId, 200);
    if (!roomId) return { ok: false, error: 'Each mirrored room needs a room id.' };
    let pairingCodeHash: string | null = null;
    if (entry.pairingCodeHash !== undefined && entry.pairingCodeHash !== null) {
      if (typeof entry.pairingCodeHash !== 'string' || !SHA256_HEX.test(entry.pairingCodeHash)) {
        return { ok: false, error: 'A pairing code hash must be sha256 hex.' };
      }
      pairingCodeHash = entry.pairingCodeHash;
    }
    let pairingExpiresAt: string | null = null;
    if (entry.pairingExpiresAt !== undefined && entry.pairingExpiresAt !== null) {
      if (typeof entry.pairingExpiresAt !== 'string' || Number.isNaN(Date.parse(entry.pairingExpiresAt))) {
        return { ok: false, error: 'A pairing expiry must be a timestamp.' };
      }
      pairingExpiresAt = entry.pairingExpiresAt;
    }
    let assignmentQbj: unknown = null;
    if (entry.assignmentQbj !== undefined && entry.assignmentQbj !== null) {
      if (
        typeof entry.assignmentQbj !== 'object' ||
        Array.isArray(entry.assignmentQbj) ||
        !isJsonTree(entry.assignmentQbj)
      ) {
        return { ok: false, error: 'A mirrored assignment must be a valid JSON object.' };
      }
      if (utf8Length(JSON.stringify(entry.assignmentQbj)) > MAX_MIRRORED_ASSIGNMENT_BYTES) {
        return { ok: false, error: 'A mirrored assignment is too large.' };
      }
      assignmentQbj = entry.assignmentQbj;
    }
    rooms.push({
      room_id: roomId,
      ...(entry.name ? { name: cleanText(entry.name, 200) ?? undefined } : {}),
      ...(pairingCodeHash ? { pairing_code_hash: pairingCodeHash } : {}),
      ...(pairingExpiresAt ? { pairing_expires_at: pairingExpiresAt } : {}),
      ...(assignmentQbj ? { assignment_qbj: assignmentQbj } : {}),
      ...(entry.matchId ? { match_id: cleanText(entry.matchId, 200) ?? undefined } : {}),
      ...(validRevision(entry.roundRevision) ? { round_revision: entry.roundRevision } : {}),
      ...(validRevision(entry.assignmentRevision) ? { assignment_revision: entry.assignmentRevision } : {}),
    });
  }
  const roomIds = new Set(rooms.map((entry) => entry.room_id as string));
  const sessions: Record<string, unknown>[] = [];
  for (const entry of input.sessions) {
    const sessionId = cleanText(entry.sessionId, 200);
    const roomId = cleanText(entry.roomId, 200);
    const matchId = cleanText(entry.matchId, 200);
    if (!sessionId || !roomId || !matchId) {
      return { ok: false, error: 'Each mirrored session needs session, room, and match ids.' };
    }
    if (!roomIds.has(roomId)) {
      return { ok: false, error: 'A mirrored session names an unknown room.' };
    }
    if (entry.status !== 'open' && entry.status !== 'final-received' && entry.status !== 'abandoned') {
      return { ok: false, error: 'A mirrored session status must be open, final-received, or abandoned.' };
    }
    sessions.push({
      session_id: sessionId,
      room_id: roomId,
      match_id: matchId,
      status: entry.status,
      ...(entry.activeWriterDeviceId ? { active_writer_device_id: entry.activeWriterDeviceId } : {}),
    });
  }
  const tournamentName =
    input.tournamentName !== undefined && input.tournamentName !== null
      ? (cleanText(input.tournamentName, 200) ?? null)
      : null;
  return {
    ok: true,
    document: {
      director_epoch: input.directorEpoch,
      revision: input.revision,
      ...(tournamentName ? { tournament: { name: tournamentName } } : {}),
      rooms,
      sessions,
    },
  };
}

// ---------------------------------------------------------------------------
// Relay → Director replay (events, results, help, sessions)
// ---------------------------------------------------------------------------

export interface RelaySyncConnection {
  baseUrl: string;
  tournamentId: string;
  managementToken: string;
  fetchImpl?: typeof fetch;
}

function manageBase(connection: RelaySyncConnection): string {
  return `${connection.baseUrl.replace(/\/$/, '')}/qbtcp/v1/manage/tournaments/${connection.tournamentId}`;
}

function authHeaders(connection: RelaySyncConnection): Record<string, string> {
  return { authorization: `Bearer ${connection.managementToken}` };
}

async function readJsonSafe(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Durable cursor: the newest relay revision fully ingested locally. Never moves backward. */
export interface RelaySyncCursor {
  lastIngestedRelayRevision: number;
}

/** Advance only after the corresponding local write has completed durably. */
export function advanceRelayCursor(cursor: RelaySyncCursor, maxIngestedRevision: number): RelaySyncCursor {
  if (!Number.isInteger(maxIngestedRevision) || maxIngestedRevision < 0) return cursor;
  if (maxIngestedRevision <= cursor.lastIngestedRelayRevision) return cursor;
  return { lastIngestedRelayRevision: maxIngestedRevision };
}

export type RelayEventKind = 'assignment' | 'session' | 'result' | 'help';

export interface RelayEvent {
  revision: number;
  kind: RelayEventKind;
  entityId: string;
  body: unknown;
  createdAt: string | null;
}

export interface RelayEventsPage {
  currentRevision: number;
  events: RelayEvent[];
  resyncRequired: boolean;
}

function readRelayEvent(value: unknown): RelayEvent | null {
  if (!isRecord(value)) return null;
  const { revision, kind, entity_id: entityId, body, created_at: createdAt } = value;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision <= 0) return null;
  if (kind !== 'assignment' && kind !== 'session' && kind !== 'result' && kind !== 'help') return null;
  if (typeof entityId !== 'string' || !entityId) return null;
  return { revision, kind, entityId, body, createdAt: typeof createdAt === 'string' ? createdAt : null };
}

export class RelaySyncError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly retryable: boolean;
  constructor(message: string, options: { code?: string; status?: number | null; retryable?: boolean } = {}) {
    super(message);
    this.name = 'RelaySyncError';
    this.code = options.code ?? 'relay-sync-failed';
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
  }
}

/**
 * A transport failure is retryable when Director must keep its cursor and its game state
 * untouched and try again later: Cloudflare quota refusal (HTTP 1027 surfaces as 403/503
 * with a quota-shaped body), rate limits, 5xx, and network loss. Credential and version
 * failures are not retryable — they need a director action, not a retry.
 */
export function classifyRelayTransportFailure(status: number | null, code?: string | null): boolean {
  if (status === null) return true;
  if (status === 429 || status >= 500) return true;
  if (status === 403 && code && /quota|1027|limit|exhausted/i.test(code)) return true;
  return false;
}

function throwForStatus(status: number, code: string | null, fallback: string): never {
  throw new RelaySyncError(fallback, {
    code: code ?? `http-${status}`,
    status,
    retryable: classifyRelayTransportFailure(status, code),
  });
}

/** Replay missed durable events after `after`. Bounded: `limit` is clamped to 1–128. */
export async function fetchRelayEventsPage(
  connection: RelaySyncConnection,
  after: number,
  options: { limit?: number; kinds?: RelayEventKind[] } = {},
): Promise<RelayEventsPage> {
  if (!Number.isInteger(after) || after < 0) {
    throw new RelaySyncError('`after` must be a non-negative integer.', { code: 'invalid-cursor' });
  }
  const limit = Math.min(128, Math.max(1, Math.floor(options.limit ?? 64)));
  const url = new URL(`${manageBase(connection)}/events`);
  url.searchParams.set('after', String(after));
  url.searchParams.set('limit', String(limit));
  if (options.kinds?.length) url.searchParams.set('kinds', options.kinds.join(','));
  let response: Response;
  try {
    response = await (connection.fetchImpl ?? fetch)(url.toString(), { headers: authHeaders(connection) });
  } catch {
    throw new RelaySyncError('The relay could not be reached. Scoring continues locally.', {
      code: 'relay-unreachable',
      retryable: true,
    });
  }
  const body = await readJsonSafe(response);
  if (!response.ok) {
    const code = isRecord(body) && typeof body.error === 'string' ? body.error : null;
    throwForStatus(response.status, code, `The relay replay request failed (${response.status}).`);
  }
  if (!isRecord(body))
    throw new RelaySyncError('The relay replay response was not valid.', { code: 'invalid-body' });
  const currentRevision =
    typeof body.currentRevision === 'number' && Number.isInteger(body.currentRevision)
      ? body.currentRevision
      : null;
  if (currentRevision === null)
    throw new RelaySyncError('The relay replay response was not valid.', { code: 'invalid-body' });
  if (!Array.isArray(body.events))
    throw new RelaySyncError('The relay replay response was not valid.', { code: 'invalid-body' });
  const events: RelayEvent[] = [];
  for (const [index, value] of body.events.entries()) {
    const event = readRelayEvent(value);
    if (event === null) {
      throw new RelaySyncError(`Relay replay event ${index + 1} was not valid.`, {
        code: 'invalid-event',
      });
    }
    const previousRevision = events.at(-1)?.revision ?? after;
    if (event.revision <= previousRevision || event.revision > currentRevision) {
      throw new RelaySyncError(`Relay replay event ${index + 1} had an invalid revision sequence.`, {
        code: 'invalid-event',
      });
    }
    events.push(event);
  }
  return { currentRevision, events, resyncRequired: body.resyncRequired === true };
}

export interface RelaySyncResult {
  resultId: string;
  sessionId: string;
  roomId: string;
  matchId: string | null;
  fingerprint: string;
  retryKey: string | null;
  qbj: unknown;
  receivedAt: string;
}

function readRelaySyncResult(value: unknown): RelaySyncResult | null {
  if (!isRecord(value)) return null;
  if (typeof value.result_id !== 'string' || !value.result_id) return null;
  if (typeof value.session_id !== 'string' || !value.session_id) return null;
  if (typeof value.room_id !== 'string' || !value.room_id) return null;
  if (typeof value.fingerprint !== 'string' || !value.fingerprint) return null;
  if (typeof value.received_at !== 'string' || !value.received_at) return null;
  return {
    resultId: value.result_id,
    sessionId: value.session_id,
    roomId: value.room_id,
    matchId: typeof value.match_id === 'string' ? value.match_id : null,
    fingerprint: value.fingerprint,
    retryKey: typeof value.retry_key === 'string' ? value.retry_key : null,
    qbj: value.qbj ?? null,
    receivedAt: value.received_at,
  };
}

/** Durable results: the source of truth behind the `result` notification events. */
export async function fetchUnackedRelayResults(connection: RelaySyncConnection): Promise<RelaySyncResult[]> {
  const url = new URL(`${manageBase(connection)}/results`);
  url.searchParams.set('state', 'unacked');
  url.searchParams.set('limit', '128');
  let response: Response;
  try {
    response = await (connection.fetchImpl ?? fetch)(url.toString(), { headers: authHeaders(connection) });
  } catch {
    throw new RelaySyncError('The relay could not be reached. Scoring continues locally.', {
      code: 'relay-unreachable',
      retryable: true,
    });
  }
  const body = await readJsonSafe(response);
  if (!response.ok) {
    const code = isRecord(body) && typeof body.error === 'string' ? body.error : null;
    throwForStatus(response.status, code, `The relay results request failed (${response.status}).`);
  }
  if (!isRecord(body) || !Array.isArray(body.results)) {
    throw new RelaySyncError('The relay results response was not valid.', { code: 'invalid-body' });
  }
  const results: RelaySyncResult[] = [];
  for (const value of body.results) {
    const result = readRelaySyncResult(value);
    if (!result) {
      throw new RelaySyncError('The relay results response contained an invalid result.', {
        code: 'invalid-result',
      });
    }
    results.push(result);
  }
  return results;
}

export interface RelaySyncHelp {
  id: string;
  roomId: string;
  sessionId: string | null;
  deviceId: string;
  category: string;
  message: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  operatorName?: string;
  currentMatchup?: Record<string, unknown>;
}

function readRelaySyncHelp(value: unknown): RelaySyncHelp | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || !value.id) return null;
  if (typeof value.room_id !== 'string' || !value.room_id) return null;
  if (typeof value.device_id !== 'string' || !value.device_id) return null;
  if (typeof value.category !== 'string' || typeof value.message !== 'string') return null;
  if (
    typeof value.status !== 'string' ||
    typeof value.created_at !== 'string' ||
    typeof value.updated_at !== 'string'
  )
    return null;
  return {
    id: value.id,
    roomId: value.room_id,
    sessionId: typeof value.session_id === 'string' ? value.session_id : null,
    deviceId: value.device_id,
    category: value.category,
    message: value.message,
    status: value.status,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
    ...(typeof value.operator_name === 'string' ? { operatorName: value.operator_name } : {}),
    ...(isRecord(value.current_matchup) ? { currentMatchup: value.current_matchup } : {}),
  };
}

/** Open help requests: replayable until acknowledged/resolved. */
export async function fetchOpenRelayHelp(connection: RelaySyncConnection): Promise<RelaySyncHelp[]> {
  const url = new URL(`${manageBase(connection)}/help`);
  url.searchParams.set('state', 'open');
  let response: Response;
  try {
    response = await (connection.fetchImpl ?? fetch)(url.toString(), { headers: authHeaders(connection) });
  } catch {
    throw new RelaySyncError('The relay could not be reached. Scoring continues locally.', {
      code: 'relay-unreachable',
      retryable: true,
    });
  }
  const body = await readJsonSafe(response);
  if (!response.ok) {
    const code = isRecord(body) && typeof body.error === 'string' ? body.error : null;
    throwForStatus(response.status, code, `The relay help request failed (${response.status}).`);
  }
  if (!isRecord(body) || !Array.isArray(body.help)) {
    throw new RelaySyncError('The relay help response was not valid.', { code: 'invalid-body' });
  }
  const help: RelaySyncHelp[] = [];
  for (const value of body.help) {
    const request = readRelaySyncHelp(value);
    if (!request) {
      throw new RelaySyncError('The relay help response contained an invalid request.', {
        code: 'invalid-help',
      });
    }
    help.push(request);
  }
  return help;
}

export interface RelaySessionSnapshot {
  sessionId: string;
  roomId: string;
  matchId: string;
  status: string;
  updatedSequence: number;
  deviceId?: string;
  updatedAt: string;
  progressSequence?: number;
  progressUpdatedAt?: string;
  progress?: unknown;
}

/** Current coalesced session state, so Director converges without replaying history. */
export async function fetchRelaySessionSnapshot(
  connection: RelaySyncConnection,
): Promise<{ revision: number; sessions: RelaySessionSnapshot[] }> {
  const url = new URL(`${manageBase(connection)}/sessions`);
  let response: Response;
  try {
    response = await (connection.fetchImpl ?? fetch)(url.toString(), { headers: authHeaders(connection) });
  } catch {
    throw new RelaySyncError('The relay could not be reached. Scoring continues locally.', {
      code: 'relay-unreachable',
      retryable: true,
    });
  }
  const body = await readJsonSafe(response);
  if (!response.ok) {
    const code = isRecord(body) && typeof body.error === 'string' ? body.error : null;
    throwForStatus(response.status, code, `The relay sessions request failed (${response.status}).`);
  }
  if (!isRecord(body) || typeof body.revision !== 'number' || !Array.isArray(body.sessions)) {
    throw new RelaySyncError('The relay sessions response was not valid.', { code: 'invalid-body' });
  }
  const sessions: RelaySessionSnapshot[] = [];
  for (const entry of body.sessions) {
    if (!isRecord(entry)) {
      throw new RelaySyncError('The relay sessions response contained an invalid session.', {
        code: 'invalid-session',
      });
    }
    if (
      typeof entry.session_id !== 'string' ||
      !entry.session_id ||
      typeof entry.room_id !== 'string' ||
      !entry.room_id ||
      typeof entry.match_id !== 'string' ||
      !entry.match_id
    )
      throw new RelaySyncError('The relay sessions response contained an invalid session.', {
        code: 'invalid-session',
      });
    if (
      (entry.status !== 'open' && entry.status !== 'final-received' && entry.status !== 'abandoned') ||
      typeof entry.updated_sequence !== 'number' ||
      !Number.isInteger(entry.updated_sequence) ||
      entry.updated_sequence < 0 ||
      typeof entry.updated_at !== 'string'
    )
      throw new RelaySyncError('The relay sessions response contained an invalid session.', {
        code: 'invalid-session',
      });
    sessions.push({
      sessionId: entry.session_id,
      roomId: entry.room_id,
      matchId: entry.match_id,
      status: entry.status,
      updatedSequence: entry.updated_sequence,
      updatedAt: entry.updated_at,
      ...(typeof entry.writer_device === 'string' ? { deviceId: entry.writer_device } : {}),
      ...(typeof entry.progress_sequence === 'number' && Number.isInteger(entry.progress_sequence)
        ? { progressSequence: entry.progress_sequence }
        : {}),
      ...(typeof entry.progress_updated_at === 'string'
        ? { progressUpdatedAt: entry.progress_updated_at }
        : {}),
      ...(entry.progress !== undefined ? { progress: entry.progress } : {}),
    });
  }
  return { revision: body.revision, sessions };
}

/**
 * Acknowledge durable items after local ingest. Idempotent: unknown ids are ignored by the
 * relay, so a crash between cursor commit and ack retries safely. Call only with ids the
 * caller has durably ingested — never speculatively.
 */
export function buildRelayAckBody(
  ingestedResultIds: string[],
  ingestedHelpIds: string[],
): { results: string[]; help: string[] } {
  const dedupe = (ids: string[]) =>
    [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))].slice(0, 512);
  return { results: dedupe(ingestedResultIds), help: dedupe(ingestedHelpIds) };
}

export async function acknowledgeRelayItems(
  connection: RelaySyncConnection,
  acked: { results: string[]; help: string[] },
): Promise<void> {
  const body = buildRelayAckBody(acked.results, acked.help);
  if (body.results.length === 0 && body.help.length === 0) return;
  let response: Response;
  try {
    response = await (connection.fetchImpl ?? fetch)(`${manageBase(connection)}/acks`, {
      method: 'POST',
      headers: { ...authHeaders(connection), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new RelaySyncError('The relay acknowledgment could not be delivered. It will retry.', {
      code: 'relay-unreachable',
      retryable: true,
    });
  }
  if (!response.ok) {
    const payload = await readJsonSafe(response);
    const code = isRecord(payload) && typeof payload.error === 'string' ? payload.error : null;
    throwForStatus(response.status, code, `The relay acknowledgment failed (${response.status}).`);
  }
}

/** Publish the allowlisted mirror. A 409 means a stale Director — never force it through. */
export async function publishRelayMirror(
  connection: RelaySyncConnection,
  document: Record<string, unknown>,
): Promise<{ relayRevision: number }> {
  let response: Response;
  try {
    response = await (connection.fetchImpl ?? fetch)(`${manageBase(connection)}/mirror`, {
      method: 'PUT',
      headers: { ...authHeaders(connection), 'content-type': 'application/json' },
      body: JSON.stringify(document),
    });
  } catch {
    throw new RelaySyncError('The relay could not be reached. Local QBTCP keeps serving.', {
      code: 'relay-unreachable',
      retryable: true,
    });
  }
  const body = await readJsonSafe(response);
  if (!response.ok) {
    const code = isRecord(body) && typeof body.error === 'string' ? body.error : null;
    throwForStatus(response.status, code, `The relay mirror publication failed (${response.status}).`);
  }
  const relayRevision =
    isRecord(body) && typeof body.relay_revision === 'number' ? body.relay_revision : null;
  return { relayRevision: relayRevision ?? 0 };
}

// ---------------------------------------------------------------------------
// Reconciliation (relay → Director local truth)
// ---------------------------------------------------------------------------

export interface LocalSessionView {
  sessionId: string;
  updatedSequence: number;
  status: string;
}

/**
 * Converge relay session state onto local Director truth without replaying history.
 *
 * Newest-wins on `updated_sequence`; ties favor the local Director, which remains the
 * authoritative tournament control. A mirrored `open` never resurrects a locally terminal
 * session the relay has not yet caught up with — that direction is the relay lagging, not
 * Director being wrong.
 */
export function reconcileRelaySessions(
  local: Map<string, LocalSessionView> | LocalSessionView[],
  incoming: RelaySessionSnapshot[],
): { apply: RelaySessionSnapshot[]; ignoreStale: number } {
  const localById = new Map<string, LocalSessionView>();
  if (Array.isArray(local)) {
    for (const entry of local) localById.set(entry.sessionId, entry);
  } else {
    for (const [key, entry] of local) localById.set(key, entry);
  }
  const apply: RelaySessionSnapshot[] = [];
  let ignoreStale = 0;
  for (const snapshot of incoming) {
    const known = localById.get(snapshot.sessionId);
    if (!known) {
      apply.push(snapshot);
      continue;
    }
    if (snapshot.updatedSequence < known.updatedSequence) {
      ignoreStale += 1;
      continue;
    }
    if (snapshot.updatedSequence === known.updatedSequence) {
      ignoreStale += 1;
      continue;
    }
    const locallyTerminal = known.status === 'final-received' || known.status === 'abandoned';
    if (locallyTerminal && snapshot.status === 'open') {
      ignoreStale += 1;
      continue;
    }
    apply.push(snapshot);
  }
  return { apply, ignoreStale };
}

/**
 * Whether a resync response is safe to apply: coalescible session/progress state may be
 * replaced, but the caller must still fetch unacknowledged results/help first. A full
 * snapshot is never an excuse to lose an unacknowledged final.
 */
export function resyncKeepsUnackedFinals(options: {
  resyncRequired: boolean;
  unackedResultsFetched: boolean;
}): boolean {
  if (!options.resyncRequired) return true;
  return options.unackedResultsFetched;
}

/** Concise reconnect summary for the Operations surface. Quiet by construction. */
export function summarizeRelayReconnect(ingested: { results: number; help: number }): string | null {
  const { results, help } = ingested;
  if (results === 0 && help === 0) return null;
  const resultPart = results === 1 ? '1 result' : `${results} results`;
  const helpPart = help === 1 ? '1 help request' : `${help} help requests`;
  if (results > 0 && help > 0)
    return `Reconnected · received ${resultPart} and ${helpPart} while this Director was offline.`;
  if (results > 0) return `Reconnected · received ${resultPart} while this Director was offline.`;
  return `Reconnected · received ${helpPart} while this Director was offline.`;
}

// ---------------------------------------------------------------------------
// Result ingestion mapping (relay → canonical pipeline)
// ---------------------------------------------------------------------------

/**
 * Map one relay-retained result onto the canonical ingest input.
 *
 * The document keeps the raw QBJ and the relay's own result id for correlation, but
 * semantic identity stays the QBJ fingerprint: `assessIncomingDocument` downstream is what
 * makes a LAN final and a relay final converge to one submission. The digest binds the
 * relay result id so a re-fetch of the same retained row is digest-stable.
 */
export function relayResultToIncomingDocument(
  result: RelaySyncResult,
  tournamentId: string,
): IncomingDocument {
  const qbjText = JSON.stringify(result.qbj ?? null);
  return {
    sourceKind: 'qbtcp',
    sourceLabel: 'QBTCP relay',
    fileName: `relay-${result.roomId}-${result.resultId}.qbj`,
    byteLength: qbjText.length,
    digest: digestText(`relay:${tournamentId}:${result.resultId}:${result.fingerprint}`),
    qbj: result.qbj,
    transportResultId: result.resultId,
    sessionId: result.sessionId,
    transportTournamentId: tournamentId,
    transportMatchId: result.matchId ?? undefined,
  };
}
