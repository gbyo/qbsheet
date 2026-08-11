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
 * So there is one client, it is constructed with a base URL, and it — with the two adapters it owns
 * — is the only part of the repository that knows the protocol exists. Nothing under `src/scorer`
 * or `src/scoring` imports it, and nothing there is allowed to.
 *
 * # Two protocols, one question, asked once
 *
 * A client starts on the legacy surface, because a server that has never heard of QBTCP must keep
 * working without a round trip to find out. `discover` asks, and whatever it learns is settled for
 * the life of the client: the adapter is replaced, and no caller above ever branches on the answer
 * again. Every method below returns the normalized vocabulary in `ServerTypes`, not a wire shape.
 *
 * Discovery is not optional in the live flow. A client that never asks is a client permanently on
 * the deprecated surface, which is how a canonical route table ends up shipped and unused.
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
import { HelpRequestCategory } from '../../app/HelpRequests';
import { IQbtcpDiscovery, readDiscovery, qbtcpRoutes, supports } from '../../qbtcp/QbtcpRoutes';
import { IServerAdapter, IRequestOptions, LegacyAdapter, QbtcpAdapter } from './ProtocolAdapters';
import {
  ApiResult,
  INormalizedAssignment,
  IOpenedSession,
  IResultReceipt,
  IRoomIdentity,
  IRoomListEntry,
  IJoinResult,
  IServerIdentity,
  ISessionCredentials,
  ISessionRecovery,
} from './ServerTypes';

export {
  deviceIdHeader,
  operatorNameHeader,
  qbjMediaType,
  roomTokenHeader,
  sessionTokenHeader,
} from './ServerTypes';
export type {
  ApiResult,
  AssignmentState,
  IAssignedMatchup,
  IAssignmentResponse,
  IJoinResult,
  INormalizedAssignment,
  IOpenedSession,
  IResultReceipt,
  IResumableSession,
  IRoomIdentity,
  IRoomListEntry,
  IServerIdentity,
  ISessionCredentials,
  ISessionRecovery,
  ISessionResumeInfo,
  IWriterConflict,
} from './ServerTypes';
export { readWriterConflict } from './ProtocolAdapters';

/** How long to wait on a request before treating tournament control as unreachable. */
export const requestTimeoutMs = 8000;

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
   * Which surface this client is having its conversation on.
   *
   * Starts legacy, because that is the assumption that keeps an old server working, and is replaced
   * exactly once by `discover`. Nothing else in the class reads a path or a wire shape directly.
   */
  private adapter: IServerAdapter;

  private discovery: IQbtcpDiscovery | null = null;

  /**
   * The last progress sequence this client sent.
   *
   * Seeded from the clock rather than from zero, and that is load-bearing. QBTCP has servers prefer
   * the higher sequence and silently discard a lower one, so a counter that restarted at zero after
   * a reload would have every snapshot for the rest of the game accepted with a `200` and thrown
   * away. Wall-clock milliseconds only ever go up across reloads of the same device.
   */
  private lastSequence = 0;

  constructor(
    readonly baseUrl: string,
    private fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {
    this.adapter = new LegacyAdapter(this.requestFn);
  }

  /** What protocol this client settled on. For the connection detail; never a brand. */
  get protocol(): string {
    return this.adapter.routes.protocol;
  }

  /** Whether the assignment body will be a QBJ document rather than the legacy shape. */
  get assignmentIsQbj(): boolean {
    return this.adapter.routes.assignmentIsQbj;
  }

  get capabilities(): string[] {
    return this.discovery?.capabilities ?? [];
  }

  /** Whether discovery found a QBTCP server. False means this client is on the deprecated surface. */
  get isQbtcp(): boolean {
    return this.discovery !== null && this.adapter.routes.assignmentIsQbj;
  }

  supports(capability: string): boolean {
    return supports(this.discovery, capability);
  }

  /**
   * Ask the server what it speaks, and adopt the matching surface.
   *
   * Unauthenticated and cheap, and it never fails in a way that stops a room: a server that does not
   * answer, answers with something else, or announces a version this client does not know simply
   * leaves the legacy adapter in place. Degrading to the older protocol is safe; guessing at a newer
   * one is not.
   */
  async discover(): Promise<IQbtcpDiscovery | null> {
    const result = await this.request<unknown>(qbtcpRoutes.discovery);
    this.discovery = result.ok ? readDiscovery(result.value) : null;
    this.adapter =
      this.discovery && this.discovery.version === 1
        ? new QbtcpAdapter(this.requestFn, this.discovery)
        : new LegacyAdapter(this.requestFn);
    // Settled only when something answered. A `404` is an answer — it is how a pre-QBTCP server
    // says so — but nothing answering is not, and latching on it would pin a room to the deprecated
    // surface for the whole game because its Wi-Fi happened to be out at the moment it started.
    this.discoveryAttempted = result.ok || result.status !== undefined;
    return this.discovery;
  }

  private discoveryAttempted = false;

  private discovering: Promise<IQbtcpDiscovery | null> | null = null;

  /**
   * Discover, unless this client already has.
   *
   * Every operation below waits on this, and that is the rule rather than a convenience. A client
   * is constructed fresh in several places — the setup screen, the scoring screen, the readiness
   * check — and any one of them that made its first call without asking would be pinned to the
   * deprecated surface for the life of that client. The only symptom would be a tournament where
   * the new server happened to still serve the old paths, which is to say: no symptom, until the
   * aliases are withdrawn. Making it structural is the only version of this that stays true.
   *
   * Concurrent callers share one probe, so a screen that polls and sends at the same moment does
   * not ask twice.
   */
  ensureDiscovered(): Promise<IQbtcpDiscovery | null> {
    if (this.discoveryAttempted) return Promise.resolve(this.discovery);
    this.discovering ??= this.discover().finally(() => {
      this.discovering = null;
    });
    return this.discovering;
  }

  /** The adapter, once it is the right one. */
  private async ready(): Promise<IServerAdapter> {
    await this.ensureDiscovered();
    return this.adapter;
  }

  private requestFn = <T>(path: string, init: IRequestOptions = {}): Promise<ApiResult<T>> =>
    this.request<T>(path, init);

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
          payload,
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

  /** Is anything there, and is it speaking this protocol? */
  async verify(): Promise<ApiResult<unknown>> {
    return (await this.ready()).verify();
  }

  /** What tournament is open, and can its rules be scored here? */
  async identify(): Promise<ApiResult<IServerIdentity>> {
    return (await this.ready()).identify();
  }

  /** The optional room picker. An empty list means no listing was offered, not that there are none. */
  async listRooms(): Promise<ApiResult<IRoomListEntry[]>> {
    return (await this.ready()).listRooms();
  }

  /** Exchange the human pairing code for this room's token. */
  async join(code: string, roomId?: string): Promise<ApiResult<IJoinResult>> {
    return (await this.ready()).join(code, roomId);
  }

  /** What this room should be playing right now, and any session it already has open. */
  async assignment(identity: IRoomIdentity): Promise<ApiResult<INormalizedAssignment>> {
    return (await this.ready()).assignment(identity);
  }

  /**
   * Open a session against the assigned game, or rejoin the one that is already open.
   *
   * Not two operations, because on both surfaces the server returns the existing session rather
   * than creating a second one. That is what makes resume-after-reload the same call as start.
   */
  async openSession(identity: IRoomIdentity, matchId: string): Promise<ApiResult<IOpenedSession>> {
    return (await this.ready()).openSession(identity, matchId);
  }

  /** Claim the write lock from another device. A person starts this; it is never automatic. */
  async takeWriter(
    identity: IRoomIdentity,
    credentials: ISessionCredentials,
  ): Promise<ApiResult<IOpenedSession>> {
    return (await this.ready()).takeWriter(identity, credentials);
  }

  async updatePresence(identity: IRoomIdentity, update: { ready?: boolean }): Promise<ApiResult<unknown>> {
    return (await this.ready()).updatePresence(identity, update);
  }

  async requestHelp(
    identity: IRoomIdentity,
    category: HelpRequestCategory,
    message: string,
  ): Promise<ApiResult<unknown>> {
    return (await this.ready()).requestHelp(identity, category, message);
  }

  async addRosterPlayer(
    identity: IRoomIdentity,
    credentials: ISessionCredentials,
    teamName: string,
    playerName: string,
  ): Promise<ApiResult<unknown>> {
    return (await this.ready()).addRosterPlayer(identity, credentials, teamName, playerName);
  }

  /**
   * Replace the live snapshot for this game.
   *
   * Safe to call repeatedly: control keeps one snapshot per session, so a retry is not a duplicate
   * and a coalesced update is not a lost one. The sequence this attaches is what lets a server
   * prefer the newer of two snapshots that arrived out of order.
   *
   * The sequence is taken after discovery rather than before, so that two snapshots cannot be
   * numbered in one order and sent in another.
   */
  async putSnapshot(credentials: ISessionCredentials, qbj: object): Promise<ApiResult<unknown>> {
    const adapter = await this.ready();
    this.lastSequence = Math.max(this.lastSequence + 1, Date.now());
    return adapter.putProgress(credentials, qbj, this.lastSequence);
  }

  /** Submit the final. Idempotent server-side, so a retry after a network failure is not a second game. */
  async postFinal(credentials: ISessionCredentials, qbj: object): Promise<ApiResult<IResultReceipt>> {
    return (await this.ready()).postResult(credentials, qbj);
  }

  /** This session's own latest snapshot, for a device that has lost its local copy. */
  async recover(credentials: ISessionCredentials): Promise<ApiResult<ISessionRecovery>> {
    return (await this.ready()).recover(credentials);
  }
}
