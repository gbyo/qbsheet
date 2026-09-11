/**
 * The relay calls QBBridge makes.
 *
 * `apps/qbtcp-relay-backend-cloudflare` is the relay. QBBridge deploys nothing, forks nothing, and
 * speaks the surface that is already there:
 *
 * ```
 * POST /qbtcp/v1/manage/claim
 * PUT  /qbtcp/v1/manage/tournaments/{id}/mirror
 * GET  /qbtcp/v1/manage/tournaments/{id}/results?state=unacked
 * POST /qbtcp/v1/manage/tournaments/{id}/acks
 * GET  /qbtcp/v1/manage/tournaments/{id}/scorer-readiness
 * ```
 *
 * # Why acknowledgment is here, and what it is not
 *
 * `GET manage/results?state=unacked` answers with the oldest 128 unacknowledged results and
 * carries no cursor or offset. A build that never acknowledged anything would, at result 129,
 * have a result it could never reach by polling. That is a silent data-loss ceiling, and it is
 * the reason this call exists.
 *
 * The rule is narrow: **a result is acknowledged only after its bytes are on the operator's
 * disk**, never because it arrived and never because it was displayed. `unacked` therefore means
 * "not yet saved locally", which is a queue that drains and cannot fill up under normal use.
 *
 * The relay keeps an acknowledged result for seven days (`ACK_RETENTION_MS`) and still serves it
 * under `state=all`, so the second copy the tournament wanted is still there for the weekend; what
 * changes is only that a saved result stops occupying the unacknowledged window.
 *
 * This is still not a synchronization engine. There is no event cursor, no replay, no
 * reconciliation, or result review. A failed ACK is intentionally retried on a later poll after
 * the local save already succeeded; it is transport housekeeping, not YellowFruit acceptance.
 */

import { buildRelayMirrorDocument } from '../../../../src/director/relay/relaySync';
import { scoresheetOrigin } from '../../../../src/director/relay/relayConfig';
import { relayRequest, type RelayResponse } from './native';

/**
 * The alphabet a relay tournament id may use.
 *
 * Digits and lowercase consonants, 24 characters — the relay's own `isTournamentId`. It is
 * narrow because the id becomes a Durable Object name that a stranger could construct, and a
 * fixed alphabet and length is the cheapest bound on how many objects a deployment can be made
 * to create. The vowels are absent, which also means an id cannot spell anything.
 */
const tournamentIdAlphabet = '0123456789bcdfghjklmnpqrstvwxyz';

/**
 * Mint a tournament id for a fresh relay.
 *
 * The operator chooses this value — the relay accepts whatever the claim names, as long as it
 * fits the rule — and nobody can be expected to type 24 characters from a restricted alphabet
 * correctly on a tournament morning. It identifies one tournament's Durable Object on the
 * deployment and is not a secret: it appears in every pairing link.
 */
export function generateTournamentId(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  // 31 characters into 256 values leaves a slight bias toward the first nine. That matters for a
  // secret and not for a name whose only job is to be distinct and well-formed.
  return [...bytes].map((byte) => tournamentIdAlphabet[byte % tournamentIdAlphabet.length]).join('');
}

/**
 * Mint a relay setup token.
 *
 * 32 random bytes as base64url: long enough that guessing is not a threat, and in an alphabet
 * that survives a copy through a terminal, a password manager and a text field without a
 * character being mangled or a line being wrapped.
 *
 * This is a secret, briefly. The operator pastes it into Cloudflare's deployment form and then
 * into the claim, after which the relay has exchanged it for a management credential and it is
 * worthless. QBBridge never stores it: it lives in one component's state until the window is closed.
 */
export function generateSetupToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export class RelayError extends Error {
  readonly status: number | null;
  readonly code: string | null;
  constructor(message: string, status: number | null = null, code: string | null = null) {
    super(message);
    this.name = 'RelayError';
    this.status = status;
    this.code = code;
  }
}

export interface RelayConnection {
  /** The relay origin, normalized, with no trailing slash. */
  baseUrl: string;
  tournamentId: string;
  managementToken: string;
  /** Stored only as local metadata; the relay derives authorization from the bearer hash. */
  controllerRole?: 'primary' | 'backup';
  controllerId?: string;
  controllerLabel?: string;
}

function manageBase(baseUrl: string, tournamentId: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/qbtcp/v1/manage/tournaments/${tournamentId}`;
}

function parseBody(response: RelayResponse): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(response.body);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function fail(response: RelayResponse, fallback: string): RelayError {
  const body = parseBody(response);
  const message = typeof body.message === 'string' ? body.message : fallback;
  const code = typeof body.code === 'string' ? body.code : null;
  return new RelayError(message, response.status, code);
}

export interface ClaimResult {
  tournamentId: string;
  managementToken: string;
}

export interface BackupProvisionResult {
  tournamentId: string;
  managementToken: string;
  controllerId: string;
  label: string;
}

export interface RelayHealth {
  tournamentId: string;
  directorEpoch: number;
  revision: number;
  activeController: 'primary' | 'backup';
  authenticatedAs: 'primary' | 'backup';
  controllerActive: boolean;
  backupProvisioned: boolean;
  backupControllerId: string | null;
  backupControllerLabel: string | null;
  /** Relay protocol version, when the health payload carries it. */
  protocolVersion: number | null;
  /** Relay lifecycle (`live` while scoring), when carried. */
  lifecycle: string | null;
  /** Row counts per table, when carried. Never player data. */
  storage: Record<string, number> | null;
  /** Protocol counters, when carried. The quota instrument panel. */
  counters: Record<string, number> | null;
  /** Headroom estimates derived from counters, when carried. */
  budget: Record<string, unknown> | null;
}

export interface DirectorSessionPresence {
  deviceId: string;
  updatedAt: string;
  expiresAt: string;
}

export interface DirectorSessionResult {
  resultId: string;
  matchId: string | null;
  receivedAt: string;
  acked: boolean;
}

export interface DirectorSession {
  sessionId: string;
  roomId: string;
  matchId: string;
  status: 'open' | 'final-received' | 'abandoned';
  writerDevice: string | null;
  updatedAt: string;
  progressSequence: number | null;
  progressUpdatedAt: string | null;
  results: DirectorSessionResult[];
  presence: DirectorSessionPresence[];
}

export interface DirectorHelp {
  id: string;
  roomId: string;
  category: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScorerReadinessResult {
  origin: typeof scoresheetOrigin;
  canPair: boolean;
  state: 'ready' | 'blocked';
  message: string;
}

/**
 * Ask the relay whether the fixed browser Scorer origin is in its credentialed allowlist.
 *
 * This is intentionally a management-authenticated endpoint rather than an extra native header
 * escape hatch. The request has no browser `Origin`; the relay compares its own configuration with
 * the same fixed origin its pairing links launch, and returns only the result and corrective copy.
 */
export async function relayCheckScorerReadiness(connection: RelayConnection): Promise<ScorerReadinessResult> {
  const response = await relayRequest({
    method: 'GET',
    url: `${manageBase(connection.baseUrl, connection.tournamentId)}/scorer-readiness`,
    bearer: connection.managementToken,
  });
  if (response.status !== 200) {
    throw fail(response, 'The relay could not verify whether qbsheet.com can pair.');
  }
  const body = parseBody(response);
  if (
    body.origin !== scoresheetOrigin ||
    typeof body.canPair !== 'boolean' ||
    typeof body.message !== 'string'
  ) {
    throw new RelayError('The relay answered with an invalid Scorer readiness response.', response.status);
  }
  const state: ScorerReadinessResult['state'] = body.canPair ? 'ready' : 'blocked';
  if (body.state !== state) {
    throw new RelayError('The relay answered with an invalid Scorer readiness response.', response.status);
  }
  return {
    origin: scoresheetOrigin,
    canPair: body.canPair,
    state,
    message: body.message,
  };
}

/**
 * Claim a freshly deployed relay.
 *
 * The setup token is single-use on the relay's side: a second claim answers 403. The management
 * credential comes back exactly once, in this response, and is kept locally from then on.
 */
export async function relayClaim(options: {
  baseUrl: string;
  tournamentId: string;
  setupToken: string;
}): Promise<ClaimResult> {
  const response = await relayRequest({
    method: 'POST',
    url: `${options.baseUrl.replace(/\/+$/, '')}/qbtcp/v1/manage/claim`,
    body: { setupToken: options.setupToken, tournamentId: options.tournamentId },
  });
  if (response.status !== 200) throw fail(response, 'The relay refused that setup token.');
  const body = parseBody(response);
  if (typeof body.managementToken !== 'string' || typeof body.tournamentId !== 'string') {
    throw new RelayError('The relay answered a claim without a management credential.', 200);
  }
  return { tournamentId: body.tournamentId, managementToken: body.managementToken };
}

/** Provision a second, independently revocable relay controller. The token is returned once. */
export async function relayProvisionBackup(
  connection: RelayConnection,
  label: string,
  replace = false,
): Promise<BackupProvisionResult> {
  const response = await relayRequest({
    method: 'POST',
    url: `${manageBase(connection.baseUrl, connection.tournamentId)}/backup/provision`,
    bearer: connection.managementToken,
    body: { label, replace },
  });
  if (response.status !== 200) throw fail(response, 'The relay could not provision backup control access.');
  const body = parseBody(response);
  if (
    typeof body.tournamentId !== 'string' ||
    typeof body.backupToken !== 'string' ||
    typeof body.controllerId !== 'string' ||
    typeof body.label !== 'string'
  ) {
    throw new RelayError('The relay answered without a backup controller credential.', response.status);
  }
  return {
    tournamentId: body.tournamentId,
    managementToken: body.backupToken,
    controllerId: body.controllerId,
    label: body.label,
  };
}

/** Rotate the provisioned backup credential without changing active publication authority. */
export async function relayRotateBackup(
  connection: RelayConnection,
  label?: string,
): Promise<BackupProvisionResult> {
  const response = await relayRequest({
    method: 'POST',
    url: `${manageBase(connection.baseUrl, connection.tournamentId)}/backup/rotate`,
    bearer: connection.managementToken,
    body: label === undefined ? {} : { label },
  });
  if (response.status !== 200) throw fail(response, 'The relay could not rotate backup control access.');
  const body = parseBody(response);
  if (
    typeof body.tournamentId !== 'string' ||
    typeof body.backupToken !== 'string' ||
    typeof body.controllerId !== 'string' ||
    typeof body.label !== 'string'
  ) {
    throw new RelayError('The relay answered without a rotated backup credential.', response.status);
  }
  return {
    tournamentId: body.tournamentId,
    managementToken: body.backupToken,
    controllerId: body.controllerId,
    label: body.label,
  };
}

export async function relayRevokeBackup(connection: RelayConnection): Promise<void> {
  const response = await relayRequest({
    method: 'POST',
    url: `${manageBase(connection.baseUrl, connection.tournamentId)}/backup/revoke`,
    bearer: connection.managementToken,
    body: {},
  });
  if (response.status !== 200) throw fail(response, 'The relay could not revoke backup control access.');
}

/** Read current epoch/revision and controller state without exposing any credential. */
export async function relayHealth(connection: RelayConnection): Promise<RelayHealth> {
  const response = await relayRequest({
    method: 'GET',
    url: `${manageBase(connection.baseUrl, connection.tournamentId)}/health`,
    bearer: connection.managementToken,
  });
  if (response.status !== 200) throw fail(response, 'The relay health check failed.');
  const body = parseBody(response);
  const mirror =
    body.mirror && typeof body.mirror === 'object' ? (body.mirror as Record<string, unknown>) : {};
  const controller =
    body.controller && typeof body.controller === 'object'
      ? (body.controller as Record<string, unknown>)
      : {};
  if (
    typeof body.tournamentId !== 'string' ||
    typeof mirror.director_epoch !== 'number' ||
    typeof mirror.revision !== 'number' ||
    (controller.authenticated_as !== 'primary' && controller.authenticated_as !== 'backup') ||
    (controller.active_controller !== 'primary' && controller.active_controller !== 'backup') ||
    typeof controller.active !== 'boolean' ||
    typeof controller.backup_provisioned !== 'boolean'
  ) {
    throw new RelayError('The relay answered with invalid controller health.', response.status);
  }
  return {
    tournamentId: body.tournamentId,
    directorEpoch: mirror.director_epoch,
    revision: mirror.revision,
    authenticatedAs: controller.authenticated_as,
    activeController: controller.active_controller,
    controllerActive: controller.active,
    backupProvisioned: controller.backup_provisioned,
    backupControllerId:
      typeof controller.backup_controller_id === 'string' ? controller.backup_controller_id : null,
    backupControllerLabel:
      typeof controller.backup_controller_label === 'string' ? controller.backup_controller_label : null,
    protocolVersion: typeof body.protocolVersion === 'number' ? body.protocolVersion : null,
    lifecycle: typeof body.lifecycle === 'string' ? body.lifecycle : null,
    storage: numberRecord(body.storage),
    counters: numberRecord(body.counters),
    budget:
      body.budget && typeof body.budget === 'object' && !Array.isArray(body.budget)
        ? (body.budget as Record<string, unknown>)
        : null,
  };
}

function numberRecord(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'number' && Number.isFinite(entry)) out[key] = entry;
  }
  return out;
}

/**
 * The relay's coalesced session state: one entry per scorer session with writer presence.
 * Operator names and help messages are dropped at this boundary — the dashboard needs
 * presence and status, never who typed what.
 */
export async function relayFetchDirectorSessions(
  connection: RelayConnection,
): Promise<DirectorSession[]> {
  const response = await relayRequest({
    method: 'GET',
    url: `${manageBase(connection.baseUrl, connection.tournamentId)}/sessions`,
    bearer: connection.managementToken,
  });
  if (response.status !== 200) throw fail(response, 'The relay did not answer with sessions.');
  const body = parseBody(response);
  return parseDirectorSessions(body.sessions, response.status);
}

/**
 * Parse the sessions view. Operator names and help messages never cross this boundary:
 * presence keeps device ids and timestamps, nothing attributable.
 */
export function parseDirectorSessions(sessions: unknown, status: number | null): DirectorSession[] {
  if (!Array.isArray(sessions)) {
    throw new RelayError('The relay answered with invalid sessions.', status);
  }
  const parsed: DirectorSession[] = [];
  for (const row of sessions) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const entry = row as Record<string, unknown>;
    if (
      typeof entry.session_id !== 'string' ||
      typeof entry.room_id !== 'string' ||
      typeof entry.match_id !== 'string'
    )
      continue;
    const status = entry.status;
    if (status !== 'open' && status !== 'final-received' && status !== 'abandoned') continue;
    parsed.push({
      sessionId: entry.session_id,
      roomId: entry.room_id,
      matchId: entry.match_id,
      status,
      writerDevice: typeof entry.writer_device === 'string' ? entry.writer_device : null,
      updatedAt: typeof entry.updated_at === 'string' ? entry.updated_at : '',
      progressSequence:
        typeof entry.progress_sequence === 'number' ? entry.progress_sequence : null,
      progressUpdatedAt:
        typeof entry.progress_updated_at === 'string' ? entry.progress_updated_at : null,
      results: Array.isArray(entry.results)
        ? (entry.results as Record<string, unknown>[])
            .filter(
              (result): result is Record<string, unknown> =>
                !!result &&
                typeof result === 'object' &&
                typeof result.result_id === 'string',
            )
            .map((result) => ({
              resultId: result.result_id as string,
              matchId: typeof result.match_id === 'string' ? result.match_id : null,
              receivedAt: typeof result.received_at === 'string' ? result.received_at : '',
              acked: typeof result.director_ack_at === 'string',
            }))
        : [],
      presence: Array.isArray(entry.presence)
        ? (entry.presence as Record<string, unknown>[])
            .filter(
              (item): item is Record<string, unknown> =>
                !!item &&
                typeof item === 'object' &&
                typeof item.device_id === 'string',
            )
            .map((item) => ({
              deviceId: item.device_id as string,
              updatedAt: typeof item.updated_at === 'string' ? item.updated_at : '',
              expiresAt: typeof item.expires_at === 'string' ? item.expires_at : '',
            }))
        : [],
    });
  }
  return parsed;
}

/**
 * Open help requests across rooms. Only the category and age cross this boundary: messages
 * and operator names stay in the help flow, out of the dashboard.
 */
export async function relayFetchOpenHelp(connection: RelayConnection): Promise<DirectorHelp[]> {
  const response = await relayRequest({
    method: 'GET',
    url: `${manageBase(connection.baseUrl, connection.tournamentId)}/help?state=open`,
    bearer: connection.managementToken,
  });
  if (response.status !== 200) throw fail(response, 'The relay did not answer with help.');
  const body = parseBody(response);
  return parseOpenHelp(body.help, response.status);
}

/**
 * Parse the open-help view. Categories and ages cross; messages and operator names stay
 * in the help flow.
 */
export function parseOpenHelp(help: unknown, status: number | null): DirectorHelp[] {
  if (!Array.isArray(help)) {
    throw new RelayError('The relay answered with invalid help.', status);
  }
  const open: DirectorHelp[] = [];
  for (const row of help) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const entry = row as Record<string, unknown>;
    if (
      typeof entry.id !== 'string' ||
      typeof entry.room_id !== 'string' ||
      typeof entry.category !== 'string'
    )
      continue;
    open.push({
      id: entry.id,
      roomId: entry.room_id,
      category: entry.category,
      createdAt: typeof entry.created_at === 'string' ? entry.created_at : '',
      updatedAt: typeof entry.updated_at === 'string' ? entry.updated_at : '',
    });
  }
  return open;
}

export async function relayTakeover(
  connection: RelayConnection,
  takeoverId: string,
): Promise<{ directorEpoch: number; revision: number; idempotent: boolean }> {
  const response = await relayRequest({
    method: 'POST',
    url: `${manageBase(connection.baseUrl, connection.tournamentId)}/takeover`,
    bearer: connection.managementToken,
    body: { takeover_id: takeoverId },
  });
  if (response.status !== 200) throw fail(response, 'The relay refused backup takeover.');
  const body = parseBody(response);
  if (
    typeof body.director_epoch !== 'number' ||
    body.active_controller !== 'backup' ||
    typeof body.revision !== 'number'
  ) {
    throw new RelayError('The relay answered with invalid takeover state.', response.status);
  }
  return {
    directorEpoch: body.director_epoch,
    revision: body.revision,
    idempotent: body.idempotent === true,
  };
}

export async function relayTransfer(
  connection: RelayConnection,
  controller: 'primary' | 'backup',
): Promise<{ directorEpoch: number; revision: number; activeController: 'primary' | 'backup' }> {
  const response = await relayRequest({
    method: 'POST',
    url: `${manageBase(connection.baseUrl, connection.tournamentId)}/transfer`,
    bearer: connection.managementToken,
    body: { controller },
  });
  if (response.status !== 200) throw fail(response, 'The relay refused controller transfer.');
  const body = parseBody(response);
  if (
    typeof body.director_epoch !== 'number' ||
    typeof body.revision !== 'number' ||
    (body.active_controller !== 'primary' && body.active_controller !== 'backup')
  ) {
    throw new RelayError('The relay answered with invalid transfer state.', response.status);
  }
  return {
    directorEpoch: body.director_epoch,
    revision: body.revision,
    activeController: body.active_controller,
  };
}

export interface MirrorRoomInput {
  roomId: string;
  name: string;
  pairingCodeHash: string;
  /** Null clears the room's assignment: the room stays, its game does not. */
  assignmentQbj: unknown | null;
  matchId: string | null;
  assignmentRevision: number;
}

/**
 * Publish the current rooms.
 *
 * Three things about `PUT manage/mirror` decide what a publish is allowed to leave out, and all
 * three were read out of the relay rather than assumed:
 *
 * 1. A room that is **not in the payload is left exactly as it was**. The relay upserts; it never
 *    deletes. A room left out because it is unused this round therefore keeps serving last
 *    round's assignment, which is the worst kind of wrong: a scorekeeper opens a real, correctly
 *    formatted game that nobody is playing. So every configured room appears in every publish.
 * 2. Every listed room's columns are *replaced*, including with nulls. That is what makes (1)
 *    fixable — a room sent without an assignment has its assignment cleared — and it is also why
 *    every publish restates each room's pairing hash, since a room republished without one would
 *    stop accepting the code printed on its QR.
 * 3. `sessions` is applied the same way: listed sessions are upserted, unlisted ones are left
 *    alone. QBBridge models no sessions, so it sends an empty list, which touches none. Room
 *    tokens live in their own table and a mirror does not revoke them, so a device's room token
 *    from round 1 remains valid in round 8.
 */
export async function relayPublishMirror(
  connection: RelayConnection,
  input: { directorEpoch: number; revision: number; tournamentName: string; rooms: MirrorRoomInput[] },
): Promise<void> {
  const built = buildRelayMirrorDocument({
    directorEpoch: input.directorEpoch,
    revision: input.revision,
    tournamentName: input.tournamentName,
    rooms: input.rooms.map((room) => ({
      roomId: room.roomId,
      name: room.name,
      // Always restated: the relay replaces this column, and a room without it stops pairing.
      pairingCodeHash: room.pairingCodeHash,
      // Null for a room with no game this round. The builder omits the key, and the relay reads
      // an omitted key as an explicit null, which is what clears the stale assignment.
      assignmentQbj: room.assignmentQbj,
      matchId: room.matchId,
      assignmentRevision: room.assignmentRevision,
    })),
    sessions: [],
  });
  if (!built.ok) throw new RelayError(built.error);

  const response = await relayRequest({
    method: 'PUT',
    url: `${manageBase(connection.baseUrl, connection.tournamentId)}/mirror`,
    bearer: connection.managementToken,
    body: built.document,
  });
  if (response.status === 409) {
    const body = parseBody(response);
    const current = typeof body.currentRevision === 'number' ? body.currentRevision : null;
    throw new RelayError(
      current === null
        ? 'The relay already holds a newer publication than this one. Nothing was sent to the rooms.'
        : `The relay already holds revision ${current}. Nothing was sent to the rooms.`,
      409,
      'conflict',
    );
  }
  if (response.status !== 200) throw fail(response, 'The relay refused that publication.');
}

/** One completed game the relay is holding. `qbj` is the scorer's document, untouched. */
export interface RelayResult {
  resultId: string;
  roomId: string;
  matchId: string | null;
  fingerprint: string;
  receivedAt: string;
  qbj: unknown;
}

/**
 * The relay's page of unacknowledged results: everything received and not yet saved locally.
 *
 * Bounded by the relay at `relayUnackedWindow`, with no cursor behind it, which is why a saved
 * result is acknowledged and leaves this page. Deduplication is still local and by `result_id`,
 * because a result stays here across every poll until its save succeeds.
 */
export async function relayFetchResults(connection: RelayConnection): Promise<RelayResult[]> {
  const response = await relayRequest({
    method: 'GET',
    url: `${manageBase(connection.baseUrl, connection.tournamentId)}/results?state=unacked&limit=${relayUnackedWindow}`,
    bearer: connection.managementToken,
  });
  if (response.status !== 200) throw fail(response, 'The relay did not answer with results.');
  const body = parseBody(response);
  const rows = Array.isArray(body.results) ? body.results : [];
  const results: RelayResult[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const entry = row as Record<string, unknown>;
    if (typeof entry.result_id !== 'string' || entry.qbj === undefined || entry.qbj === null) continue;
    results.push({
      resultId: entry.result_id,
      roomId: typeof entry.room_id === 'string' ? entry.room_id : '',
      matchId: typeof entry.match_id === 'string' ? entry.match_id : null,
      fingerprint: typeof entry.fingerprint === 'string' ? entry.fingerprint : '',
      receivedAt: typeof entry.received_at === 'string' ? entry.received_at : '',
      // Kept exactly as it arrived. Nothing downstream rewrites it.
      qbj: entry.qbj,
    });
  }
  return results;
}

/**
 * The most unacknowledged results the relay will return in one page.
 *
 * `clampPage(limit, 1, 128)` in `getDirectorResults`, over
 * `WHERE director_ack_at IS NULL ORDER BY received_at ASC LIMIT ?` with no offset. There is no
 * page after this one, so a result beyond the window is unreachable until something ahead of it
 * is acknowledged.
 */
export const relayUnackedWindow = 128;

/**
 * Acknowledge results whose bytes are on disk.
 *
 * Called after a successful local save and at no other time. Idempotent on the relay's side
 * (`COALESCE(director_ack_at, ?)`), and unknown ids are ignored, so a retry is harmless.
 *
 * A failure here is deliberately not fatal to the save: the file is already written, and a result
 * that stays unacknowledged is merely one that will be offered again on the next poll, where the
 * local record recognises it and reports it as already saved.
 */
export async function relayAcknowledgeResults(
  connection: RelayConnection,
  resultIds: readonly string[],
): Promise<void> {
  if (resultIds.length === 0) return;
  const response = await relayRequest({
    method: 'POST',
    url: `${manageBase(connection.baseUrl, connection.tournamentId)}/acks`,
    bearer: connection.managementToken,
    body: { results: [...resultIds] },
  });
  if (response.status !== 200) throw fail(response, 'The relay did not record that acknowledgment.');
}
