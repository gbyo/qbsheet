/**
 * Everything this application knows about talking to tournament control.
 *
 * # Why it is one object with a base URL
 *
 * The scorer used to live inside the server that served it, so a bare `fetch('/api/v1/...')` was
 * enough and those calls could sit wherever they were convenient. Neither is true any more: the
 * page is static, it is served from somewhere else entirely, and the server's address is something
 * a scorekeeper types in. Scattered relative fetches would have to become scattered absolute ones,
 * and then every component that scores a tossup would be holding an address.
 *
 * So there is one client, it is constructed with a base URL, and it is the only file in the
 * repository that knows the protocol exists. Nothing under `src/scorer` or `src/scoring` imports
 * it, and nothing there is allowed to.
 *
 * # Nothing here throws
 *
 * Every operation resolves to a result object. The network disappearing mid-tournament is the
 * expected case, not the exceptional one, and a rejected promise somewhere in a poll is how a
 * scoresheet ends up unmounted by an error boundary. A failure is a value.
 *
 * # Credentials
 *
 * The room token and the session token are passed as headers on the requests that need them and are
 * never put in a URL, never logged, never rendered, and never written into anything that leaves the
 * device. The caller holds them; this file only forwards them.
 */
import { IScorekeeperFormat } from '../../scoring/ScorekeeperFormat';
import { IRoomProcedure } from '../../scoring/RoomProcedure';
import { ITeamRoster } from '../../game/Roster';
import { HelpRequestCategory } from '../../app/HelpRequests';
import {
  IQbtcpDiscovery,
  IQbtcpRoutes,
  legacyRoutes,
  readDiscovery,
  routesFor,
  qbtcpRoutes,
} from '../../qbtcp/QbtcpRoutes';

export const apiPrefix = '/api/v1';
export const sessionTokenHeader = 'x-yf-session-token';
export const roomTokenHeader = 'x-yf-room-token';
export const deviceIdHeader = 'x-yf-device-id';
export const operatorNameHeader = 'x-yf-operator-name';

/** How long to wait on a request before treating tournament control as unreachable. */
export const requestTimeoutMs = 8000;

export type ApiResult<T> =
  | { ok: true; value: T }
  /**
   * `error` is always safe to show. `detail` is set only when the server itself explained the
   * refusal, so a caller can show that explanation without ever showing our status-code fallback.
   */
  | { ok: false; error: string; status?: number; detail?: string };

export interface IRoomIdentity {
  roomId: string;
  token: string;
  deviceId?: string;
  operatorName?: string;
}

export interface ISessionCredentials {
  sessionId: string;
  token: string;
}

export interface IServerIdentity {
  tournamentKey?: string;
  name: string;
  scoringFormat: IScorekeeperFormat | null;
  roomProcedure?: IRoomProcedure;
  timedRounds: boolean;
  roundCount: number;
  teamCount: number;
}

export interface IRoomListEntry {
  id: string;
  name: string;
  description?: string;
}

export interface IJoinResult {
  roomId: string;
  roomName: string;
  roomDescription?: string;
  accessToken: string;
}

export interface IAssignedMatchup {
  scheduledMatchId: string;
  roundNumber: number;
  roundName: string;
  packetName?: string;
  /**
   * Which issue of this round's pairings the assignment came from.
   *
   * Optional on the wire because a server built before game packages existed does not send it. An
   * absent revision is read as 1 — the first issue — which is correct for every tournament that has
   * never rebracketed and is the only assumption available for one that has.
   */
  roundRevision?: number;
  leftTeam: ITeamRoster;
  rightTeam: ITeamRoster;
  status: string;
}

export interface ISessionResumeInfo {
  sessionId: string;
  token: string;
  status: string;
  finalReceived: boolean;
  rejectionReason?: string;
}

export interface IAssignmentResponse {
  roomId: string;
  roomName: string;
  tournamentName: string;
  tournamentKey?: string;
  current: IAssignedMatchup | null;
  session: ISessionResumeInfo | null;
  blockedReason?: string;
  blockedMessage?: string;
  scoringFormat: IScorekeeperFormat | null;
  roomProcedure?: IRoomProcedure;
  timedRounds: boolean;
  /** Instructions for the manual backup, when the tournament configured any. Free text. */
  resultHandoffInstruction?: string;
}

export interface ISessionCreated {
  sessionId: string;
  token: string;
}

export interface ISessionRecovery {
  sessionId: string;
  roundNumber: number;
  leftTeam: string;
  rightTeam: string;
  finalReceived: boolean;
  /** The most recent payload this session sent, or null if it never sent one. */
  latestQbj: object | null;
}

/**
 * Is this a well-formed base URL for a tournament server?
 *
 * Refused deliberately: anything that is not http or https, and anything carrying a query or a
 * fragment. A scorekeeper types this from a projector or a printed card and the failure mode of
 * accepting a near-miss is a room that spends the round talking to nothing.
 */
export function normalizeBaseUrl(input: string): { ok: true; value: string } | { ok: false; error: string } {
  const trimmed = input.trim();
  if (trimmed === '') return { ok: false, error: 'Enter the address tournament control gave you.' };
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, error: 'That is not an address this browser can use.' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'The address has to start with http:// or https://.' };
  }
  if (url.search !== '' || url.hash !== '') {
    return { ok: false, error: 'Enter the address only, with nothing after it.' };
  }
  // Keep any path prefix — a server behind a reverse proxy may not be at the root — but drop the
  // trailing slash so joining is unambiguous.
  const path = url.pathname.replace(/\/+$/, '');
  return { ok: true, value: `${url.protocol}//${url.host}${path}` };
}

interface IRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** Loopback needs no annotation: it is already potentially trustworthy to a browser. */
function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

/**
 * Tell the browser, before it resolves anything, that this request is going to the local network.
 *
 * Two current Chrome behaviours meet here, and getting either wrong means a room that cannot
 * connect at all.
 *
 * Mixed content: a page served over HTTPS — which a GitHub Pages site always is — may not normally
 * make plain HTTP subresource requests, and a tournament server on a laptop is plain HTTP. Chrome
 * exempts local-network requests from that check, but only when it can tell the destination is
 * local *before* DNS: a private IP literal, a `.local` name, or this annotation. A tournament whose
 * server is reachable by an ordinary hostname is exactly the case the annotation exists for.
 *
 * Local Network Access: from Chrome 142 these requests are additionally gated behind a permission
 * the user is prompted for, which is why every connection attempt in this application begins with
 * somebody pressing a button. There is nothing for the server to send; the permission is entirely
 * between the browser and the person using it.
 *
 * Annotating only plain-HTTP targets is deliberate. An HTTPS server has no mixed-content problem to
 * solve, and claiming a public HTTPS address is local would break a request that would otherwise
 * have worked.
 *
 * @see https://developer.chrome.com/blog/local-network-access
 */
export function localNetworkFetchInit(baseUrl: string): { targetAddressSpace?: 'local' } {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:') return {};
    if (isLoopback(url.hostname)) return {};
    return { targetAddressSpace: 'local' };
  } catch {
    return {};
  }
}

export default class FruityServerClient {
  /**
   * Which protocol surface this client is using.
   *
   * Starts on the legacy table, because a server that has never heard of QBTCP must keep working
   * without a round trip to find out. `discover` upgrades it. Nothing else in the class reads a
   * path directly.
   */
  private routes: IQbtcpRoutes = legacyRoutes;

  private discovery: IQbtcpDiscovery | null = null;

  constructor(
    readonly baseUrl: string,
    private fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  /** What protocol this client settled on. For the connection detail; never a brand. */
  get protocol(): string {
    return this.routes.protocol;
  }

  /** Whether the assignment body will be a QBJ document rather than the legacy shape. */
  get assignmentIsQbj(): boolean {
    return this.routes.assignmentIsQbj;
  }

  get capabilities(): string[] {
    return this.discovery?.capabilities ?? [];
  }

  /**
   * Ask the server what it speaks, and adopt the matching routes.
   *
   * Unauthenticated and cheap, and it never fails in a way that stops a room: a server that does not
   * answer, answers with something else, or announces a version this client does not know simply
   * leaves the legacy table in place. Degrading to the older protocol is safe; guessing at a newer
   * one is not.
   */
  async discover(): Promise<IQbtcpDiscovery | null> {
    const result = await this.request<unknown>(qbtcpRoutes.discovery);
    this.discovery = result.ok ? readDiscovery(result.value) : null;
    this.routes = routesFor(this.discovery);
    return this.discovery;
  }

  private async request<T>(path: string, init: IRequestOptions = {}): Promise<ApiResult<T>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        ...localNetworkFetchInit(this.baseUrl),
        signal: controller.signal,
        // Credentials travel as explicit headers. Sending cookies cross-origin would make the
        // server's CORS configuration a much larger promise than it needs to be.
        credentials: 'omit',
        mode: 'cors',
      } as RequestInit);
      const text = await response.text();
      let payload: unknown = null;
      if (text !== '') {
        try {
          payload = JSON.parse(text);
        } catch {
          return { ok: false, status: response.status, error: 'Tournament control sent an answer this page could not read.' };
        }
      }
      if (!response.ok) {
        const detail =
          typeof payload === 'object' && payload !== null && 'error' in payload && typeof payload.error === 'string'
            ? payload.error
            : undefined;
        return {
          ok: false,
          status: response.status,
          error: detail ?? `Tournament control refused the request (${response.status}).`,
          detail,
        };
      }
      return { ok: true, value: payload as T };
    } catch {
      // An abort and a network failure land in the same place, and mean the same thing to a room.
      return { ok: false, error: 'Could not reach tournament control.' };
    } finally {
      clearTimeout(timeout);
    }
  }

  private roomHeaders(identity: IRoomIdentity, json = false): Record<string, string> {
    const headers: Record<string, string> = { [roomTokenHeader]: identity.token };
    if (json) headers['Content-Type'] = 'application/json';
    if (identity.deviceId) headers[deviceIdHeader] = identity.deviceId;
    if (identity.operatorName) headers[operatorNameHeader] = identity.operatorName;
    return headers;
  }

  /** Is anything there, and is it speaking this protocol? */
  verify(): Promise<ApiResult<{ status: string }>> {
    return this.request(this.routes.status);
  }

  /** What tournament is open, and can its rules be scored here? */
  identify(): Promise<ApiResult<IServerIdentity>> {
    return this.request(this.routes.tournament);
  }

  listRooms(): Promise<ApiResult<{ rooms: IRoomListEntry[]; roomScoringMode: string }>> {
    return this.request(this.routes.rooms);
  }

  /** Exchange the human pairing code for this room's token. */
  join(code: string, roomId?: string): Promise<ApiResult<IJoinResult>> {
    return this.request(this.routes.pair, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(roomId ? { code, roomId } : { code }),
    });
  }

  /** What this room should be playing right now, and any session it already has open. */
  assignment(identity: IRoomIdentity): Promise<ApiResult<IAssignmentResponse>> {
    return this.request(this.routes.assignment(identity.roomId), {
      headers: this.roomHeaders(identity),
    });
  }

  startAssignedMatch(identity: IRoomIdentity, scheduledMatchId: string): Promise<ApiResult<ISessionCreated>> {
    return this.request(this.routes.openSession(identity.roomId), {
      method: 'POST',
      headers: this.roomHeaders(identity, true),
      body: JSON.stringify({ scheduledMatchId, scorer: 'first-party' }),
    });
  }

  updatePresence(identity: IRoomIdentity, update: { ready?: boolean }): Promise<ApiResult<unknown>> {
    return this.request(this.routes.presence(identity.roomId), {
      method: 'POST',
      headers: this.roomHeaders(identity, true),
      body: JSON.stringify(update),
    });
  }

  requestHelp(
    identity: IRoomIdentity,
    category: HelpRequestCategory,
    message: string,
  ): Promise<ApiResult<unknown>> {
    return this.request(this.routes.help(identity.roomId), {
      method: 'POST',
      headers: this.roomHeaders(identity, true),
      body: JSON.stringify({ category, message }),
    });
  }

  addRosterPlayer(
    identity: IRoomIdentity,
    credentials: ISessionCredentials,
    teamName: string,
    playerName: string,
  ): Promise<ApiResult<unknown>> {
    return this.request(this.routes.addPlayer(identity.roomId), {
      method: 'POST',
      headers: { ...this.roomHeaders(identity, true), [sessionTokenHeader]: credentials.token },
      body: JSON.stringify({ sessionId: credentials.sessionId, teamName, playerName }),
    });
  }

  /**
   * Replace the live snapshot for this game.
   *
   * Safe to call repeatedly: control keeps one snapshot per session, so a retry is not a duplicate
   * and a coalesced update is not a lost one.
   */
  putSnapshot(credentials: ISessionCredentials, qbj: object): Promise<ApiResult<unknown>> {
    return this.request(this.routes.progress(credentials.sessionId), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', [sessionTokenHeader]: credentials.token },
      body: JSON.stringify(qbj),
    });
  }

  /** Submit the final. Idempotent server-side, so a retry after a network failure is not a second game. */
  postFinal(credentials: ISessionCredentials, qbj: object): Promise<ApiResult<unknown>> {
    return this.request(this.routes.result(credentials.sessionId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [sessionTokenHeader]: credentials.token },
      body: JSON.stringify(qbj),
    });
  }

  /** This session's own latest snapshot, for a device that has lost its local copy. */
  recover(credentials: ISessionCredentials): Promise<ApiResult<ISessionRecovery>> {
    return this.request(this.routes.recovery(credentials.sessionId), {
      headers: { [sessionTokenHeader]: credentials.token },
    });
  }
}
