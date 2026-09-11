/**
 * The three relay calls QBBridge makes.
 *
 * `apps/qbtcp-relay-backend-cloudflare` is the relay. QBBridge deploys nothing, forks nothing, and
 * speaks the surface that is already there:
 *
 * ```
 * POST /qbtcp/v1/manage/claim
 * PUT  /qbtcp/v1/manage/tournaments/{id}/mirror
 * GET  /qbtcp/v1/manage/tournaments/{id}/results?state=unacked
 * ```
 *
 * There is no fourth call. In particular there is no `POST manage/acks`: leaving the day's finals
 * unacknowledged is deliberate, because the relay keeps an unacknowledged final forever and that
 * is a free second copy of every result. See `docs/QBTCP_INTERNET.md`.
 *
 * This is not a synchronization engine. There is no event cursor, no replay, no reconciliation and
 * no retry coordinator: a call either worked or it is reported as having failed.
 */

import { buildRelayMirrorDocument } from '../../../../src/director/relay/relaySync';
import { relayRequest, type RelayResponse } from './native';

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

export interface MirrorRoomInput {
  roomId: string;
  name: string;
  pairingCodeHash: string;
  assignmentQbj: unknown;
  matchId: string;
  assignmentRevision: number;
}

/**
 * Publish the current rooms.
 *
 * Two things about `PUT manage/mirror` are worth stating because they decide what a publish is
 * allowed to leave out, and both were read out of the relay rather than assumed:
 *
 * 1. Rooms are upserted and never deleted, but every listed room's columns are *replaced*. A room
 *    republished without its pairing hash would lose the hash and stop accepting the code on its
 *    QR. So every publish restates each room's hash.
 * 2. `sessions` is applied the same way — listed sessions are upserted, unlisted ones are left
 *    alone. QBBridge models no sessions, so it sends an empty list, which touches none. Room
 *    tokens live in their own table and a mirror does not revoke them, so a device paired in
 *    round 1 is still paired in round 8.
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
      pairingCodeHash: room.pairingCodeHash,
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
 * Every completed result the relay still holds unacknowledged.
 *
 * QBBridge never acknowledges, so this is the whole day's finals, every poll. Deduplication is
 * local and by `result_id`; the repeated rows are the point, not a problem — they are the relay's
 * standing backup copy.
 */
export async function relayFetchResults(connection: RelayConnection): Promise<RelayResult[]> {
  const response = await relayRequest({
    method: 'GET',
    url: `${manageBase(connection.baseUrl, connection.tournamentId)}/results?state=unacked&limit=128`,
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
