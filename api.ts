/**
 * HTTP client for the room application.
 *
 * Every call is written on the assumption that the network can disappear mid-tournament. Nothing
 * here throws in a way that could take the scorekeeping UI down: callers get a result object and
 * decide what to show. A failed upload never discards local state.
 */
import {
  ICreateSessionRequest,
  ICreateHelpRequest,
  IHelpRequest,
  IRoomAssignmentResponse,
  IRoomJoinListResponse,
  IRoomJoinRequest,
  IRoomJoinResponse,
  IRoomPresence,
  IRoomPresenceUpdateRequest,
  IRoomRound,
  IRoomTeam,
  ISessionCreatedResponse,
  ISessionStateResponse,
  apiPrefix,
  roomTokenHeader,
  sessionTokenHeader,
} from '../main/server/ServerTypes';
import { IModaqGameFormat } from '../renderer/Services/YellowFruitScoringRulesToModaq';
import type { IScorekeeperFormat } from '../renderer/Services/ScorekeeperFormat';

export type ApiResult<T> =
  | { ok: true; value: T }
  /**
   * `error` is always safe to show. `detail` is set only when YellowFruit itself explained the
   * refusal, so a caller can show the explanation without ever showing our own status-code
   * fallback text to a scorekeeper.
   */
  | { ok: false; error: string; status?: number; detail?: string };

/** Tournament information the room needs before it can start a game */
export interface ITournamentInfo {
  /** Stable identity of the open tournament, independent of its display name. */
  tournamentKey?: string;
  name: string;
  gameFormat: IModaqGameFormat | null;
  gameFormatErrors: string[];
  gameFormatWarnings: string[];
  /** The scoring rules as structural data. See `ITournamentSnapshot.scoringFormat`. */
  scoringFormat: IScorekeeperFormat | null;
  /** Timed rounds can end before every regulation tossup is read */
  timedRounds: boolean;
  roundCount: number;
  teamCount: number;
}

/** Credentials the room holds for the game it's currently scoring */
export interface ISessionCredentials {
  sessionId: string;
  token: string;
}

/** Which room this page is, read from its permanent URL */
export interface IRoomIdentity {
  roomId: string;
  token: string;
  deviceId?: string;
  operatorName?: string;
}

const rememberedIdentityStorageKey = 'yellowfruit.room.identity.v1';
const rememberedDeviceIdStorageKey = 'yellowfruit.room.device-id.v1';

interface IStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): IStorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Work out which room this page is from its own URL.
 *
 * The permanent room URL is `/room/<roomId>?token=<token>`, which is what the QR code encodes and
 * what the Chromebook stays on all day. A page opened without one falls back to the manual
 * team-picking workflow, which is still how a tournament that hasn't configured rooms works.
 */
export function readRoomIdentity(location: { pathname: string; search: string }): IRoomIdentity | null {
  const match = /^\/room\/([^/]+)\/?$/.exec(location.pathname);
  if (!match) return null;
  const token = new URLSearchParams(location.search).get('token');
  if (!token) return null;
  return { roomId: decodeURIComponent(match[1]), token };
}

/** Read a previously paired identity without treating it as proof until the server accepts it. */
export function getRememberedRoomIdentity(storage: IStorageLike | null = browserStorage()): IRoomIdentity | null {
  if (!storage) return null;
  try {
    const parsed = JSON.parse(storage.getItem(rememberedIdentityStorageKey) ?? 'null') as Record<string, unknown>;
    const roomId = typeof parsed?.roomId === 'string' ? parsed.roomId : '';
    let token = '';
    if (typeof parsed?.accessToken === 'string') token = parsed.accessToken;
    else if (typeof parsed?.token === 'string') token = parsed.token;
    if (!roomId || !token) return null;
    return {
      roomId,
      token,
      deviceId: typeof parsed.deviceId === 'string' ? parsed.deviceId : undefined,
      operatorName: typeof parsed.operatorName === 'string' ? parsed.operatorName : undefined,
    };
  } catch {
    return null;
  }
}

/** Persist the room token only in browser storage; it is never rendered as text. */
export function rememberRoomIdentity(identity: IRoomIdentity, storage: IStorageLike | null = browserStorage()): void {
  if (!storage || !identity.roomId || !identity.token) return;
  try {
    storage.setItem(
      rememberedIdentityStorageKey,
      JSON.stringify({
        roomId: identity.roomId,
        accessToken: identity.token,
        deviceId: identity.deviceId,
        operatorName: identity.operatorName,
      }),
    );
  } catch {
    // Private browsing/storage-disabled devices can still use the current page session.
  }
}

export function clearRememberedRoomIdentity(storage: IStorageLike | null = browserStorage()): void {
  try {
    storage?.removeItem(rememberedIdentityStorageKey);
  } catch {
    // Ignore storage failures; clearing the in-memory UI remains useful.
  }
}

/** Stable per-browser label for presence. It is descriptive only and carries no authority. */
export function getOrCreateDeviceId(storage: IStorageLike | null = browserStorage()): string {
  if (storage) {
    try {
      const existing = storage.getItem(rememberedDeviceIdStorageKey);
      if (existing) return existing;
      const bytes = new Uint8Array(12);
      crypto.getRandomValues(bytes);
      const created = `device-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
      storage.setItem(rememberedDeviceIdStorageKey, created);
      return created;
    } catch {
      // Fall through to a per-page label if storage is unavailable.
    }
  }
  return 'device-session';
}

/** Resolve direct QR credentials first, then a remembered identity for the same room path. */
export function resolveRoomIdentity(
  location: { pathname: string; search: string },
  storage: IStorageLike | null = browserStorage(),
): IRoomIdentity | null {
  const direct = readRoomIdentity(location);
  if (direct) {
    const identity = { ...direct, deviceId: getOrCreateDeviceId(storage) };
    rememberRoomIdentity(identity, storage);
    return identity;
  }
  const roomMatch = /^\/room\/([^/]+)\/?$/.exec(location.pathname);
  if (!roomMatch) return null;
  const remembered = getRememberedRoomIdentity(storage);
  if (!remembered || remembered.roomId !== decodeURIComponent(roomMatch[1])) return null;
  return { ...remembered, deviceId: remembered.deviceId ?? getOrCreateDeviceId(storage) };
}

/** Adopt a QR identity and remove the long token from the visible address bar. */
export function adoptRoomIdentity(
  location: { pathname: string; search: string },
  history: {
    replaceState: (data: unknown, unused: string, url?: string | URL | null) => void;
  } | null = typeof window !== 'undefined' ? window.history : null,
  storage: IStorageLike | null = browserStorage(),
): IRoomIdentity | null {
  const direct = readRoomIdentity(location);
  const identity = resolveRoomIdentity(location, storage);
  if (direct && identity && history) {
    const hash = 'hash' in location && typeof location.hash === 'string' ? location.hash : '';
    history.replaceState(null, '', `${location.pathname}${hash}`);
  }
  return identity;
}

/** How long to wait on a request before treating the server as unreachable */
const requestTimeoutMs = 8000;

/** The subset of fetch options the room app actually uses */
interface IRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

async function request<T>(path: string, init: IRequestOptions = {}): Promise<ApiResult<T>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(path, { ...init, signal: controller.signal });
    const text = await response.text();
    let payload: unknown = null;
    if (text !== '') {
      try {
        payload = JSON.parse(text);
      } catch {
        return {
          ok: false,
          status: response.status,
          error: 'The server sent a response the room app could not read.',
        };
      }
    }
    if (!response.ok) {
      const errorPayload =
        typeof payload === 'object' && payload !== null && 'error' in payload && typeof payload.error === 'string'
          ? payload.error
          : undefined;
      return {
        ok: false,
        status: response.status,
        error: errorPayload ?? `The server refused the request (${response.status}).`,
        detail: errorPayload,
      };
    }
    return { ok: true, value: payload as T };
  } catch {
    // Aborts and network failures both land here. Either way, YellowFruit is unreachable.
    return { ok: false, error: 'Could not reach the YellowFruit computer.' };
  } finally {
    clearTimeout(timeout);
  }
}

function jsonHeaders(credentials?: ISessionCredentials): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (credentials) headers[sessionTokenHeader] = credentials.token;
  return headers;
}

function roomHeaders(identity: IRoomIdentity, contentType = false): Record<string, string> {
  const headers: Record<string, string> = { [roomTokenHeader]: identity.token };
  if (contentType) headers['Content-Type'] = 'application/json';
  if (identity.deviceId) headers['x-yf-device-id'] = identity.deviceId;
  if (identity.operatorName) headers['x-yf-operator-name'] = identity.operatorName;
  return headers;
}

/** Is the YellowFruit server reachable right now? */
export function getStatus(): Promise<ApiResult<{ status: string }>> {
  return request(`${apiPrefix}/status`);
}

export function getTournament(): Promise<ApiResult<ITournamentInfo>> {
  return request(`${apiPrefix}/tournament`);
}

export function getRounds(): Promise<ApiResult<{ rounds: IRoomRound[] }>> {
  return request(`${apiPrefix}/rounds`);
}

export function getTeams(): Promise<ApiResult<{ teams: IRoomTeam[] }>> {
  return request(`${apiPrefix}/teams`);
}

export function getJoinRooms(): Promise<ApiResult<IRoomJoinListResponse>> {
  return request(`${apiPrefix}/join/rooms`);
}

export function joinRoom(body: IRoomJoinRequest): Promise<ApiResult<IRoomJoinResponse>> {
  return request(`${apiPrefix}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * What this room should be playing right now.
 *
 * Polled continuously, so a change tournament control makes reaches the room without anyone
 * reloading anything. Also the recovery path: the response carries any open session's token, so a
 * page that has just been refreshed can resume the game it was already scoring in one round trip.
 */
export function getRoomAssignment(identity: IRoomIdentity): Promise<ApiResult<IRoomAssignmentResponse>> {
  return request(`${apiPrefix}/rooms/${encodeURIComponent(identity.roomId)}/assignment`, {
    headers: roomHeaders(identity),
  });
}

/**
 * Start the game this room is assigned.
 *
 * The teams and the round are decided by the server from the assignment; this only says which
 * assignment the page believes it is starting, so a stale page is refused rather than obeyed.
 */
export function startAssignedMatch(
  identity: IRoomIdentity,
  scheduledMatchId: string,
  scorer: 'first-party' | 'legacy' = 'legacy',
): Promise<ApiResult<ISessionCreatedResponse>> {
  return request(`${apiPrefix}/rooms/${encodeURIComponent(identity.roomId)}/sessions`, {
    method: 'POST',
    headers: roomHeaders(identity, true),
    body: JSON.stringify({ scheduledMatchId, scorer }),
  });
}

/** Ask the authoritative renderer to append one player to a team in this room's playing session. */
export function addRoomPlayer(
  identity: IRoomIdentity,
  credentials: ISessionCredentials,
  teamName: string,
  playerName: string,
): Promise<ApiResult<{ requested: true }>> {
  return request(`${apiPrefix}/rooms/${encodeURIComponent(identity.roomId)}/players`, {
    method: 'POST',
    headers: { ...roomHeaders(identity, true), [sessionTokenHeader]: credentials.token },
    body: JSON.stringify({ sessionId: credentials.sessionId, teamName, playerName }),
  });
}

export function getRoomPresence(identity: IRoomIdentity): Promise<ApiResult<{ presence: IRoomPresence }>> {
  return request(`${apiPrefix}/rooms/${encodeURIComponent(identity.roomId)}/presence`, {
    headers: roomHeaders(identity),
  });
}

export function updateRoomPresence(
  identity: IRoomIdentity,
  update: IRoomPresenceUpdateRequest,
): Promise<ApiResult<{ presence: IRoomPresence }>> {
  return request(`${apiPrefix}/rooms/${encodeURIComponent(identity.roomId)}/presence`, {
    method: 'POST',
    headers: roomHeaders(identity, true),
    body: JSON.stringify(update),
  });
}

export function getRoomHelp(identity: IRoomIdentity): Promise<ApiResult<{ request: IHelpRequest | null }>> {
  return request(`${apiPrefix}/rooms/${encodeURIComponent(identity.roomId)}/help`, {
    headers: roomHeaders(identity),
  });
}

export function createRoomHelp(
  identity: IRoomIdentity,
  requestBody: ICreateHelpRequest,
): Promise<ApiResult<{ request: IHelpRequest }>> {
  return request(`${apiPrefix}/rooms/${encodeURIComponent(identity.roomId)}/help`, {
    method: 'POST',
    headers: roomHeaders(identity, true),
    body: JSON.stringify(requestBody),
  });
}

export function cancelRoomHelp(identity: IRoomIdentity, helpId: string): Promise<ApiResult<{ request: IHelpRequest }>> {
  return request(`${apiPrefix}/rooms/${encodeURIComponent(identity.roomId)}/help/${encodeURIComponent(helpId)}`, {
    method: 'DELETE',
    headers: roomHeaders(identity),
  });
}

export function createSession(body: ICreateSessionRequest): Promise<ApiResult<ISessionCreatedResponse>> {
  return request(`${apiPrefix}/sessions`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
}

export function getSession(credentials: ISessionCredentials): Promise<ApiResult<ISessionStateResponse>> {
  return request(`${apiPrefix}/sessions/${encodeURIComponent(credentials.sessionId)}`, {
    headers: { [sessionTokenHeader]: credentials.token },
  });
}

/**
 * Replace the live snapshot for this game. Safe to call repeatedly: the server keeps one snapshot
 * per session, so a retry is not a duplicate.
 */
export function putSnapshot(credentials: ISessionCredentials, qbj: object): Promise<ApiResult<ISessionStateResponse>> {
  return request(`${apiPrefix}/sessions/${encodeURIComponent(credentials.sessionId)}/snapshot`, {
    method: 'PUT',
    headers: jsonHeaders(credentials),
    body: JSON.stringify(qbj),
  });
}

/**
 * Submit the final result. Idempotent server-side, so retrying after a network failure will not
 * create a second game in the tournament.
 */
export function postFinal(
  credentials: ISessionCredentials,
  qbj: object,
): Promise<ApiResult<ISessionStateResponse & { newSubmission: boolean }>> {
  return request(`${apiPrefix}/sessions/${encodeURIComponent(credentials.sessionId)}/final`, {
    method: 'POST',
    headers: jsonHeaders(credentials),
    body: JSON.stringify(qbj),
  });
}
