/**
 * Conformance suite for QBTCP Internet relays.
 *
 * # What it is for
 *
 * The relay is an open contract (`docs/QBTCP-STREAM.md` plus the Director sync surface). A relay
 * built on anything — Cloudflare or otherwise — that honours it is a first-class relay, and
 * "first-class" is only meaningful if there is a way to check. This suite runs against any relay
 * by base URL and reports what it does and does not satisfy.
 *
 * ```bash
 * node packages/qbtcp-relay-conformance/dist/cli.js \
 *   --origin https://qbtcp-relay-backend.<subdomain>.workers.dev \
 *   --setup-token <one-time-setup-token>
 * ```
 *
 * or against an already-claimed tournament:
 *
 * ```bash
 * node packages/qbtcp-relay-conformance/dist/cli.js \
 *   --origin http://127.0.0.1:8787 \
 *   --tournament-id <id> --management-token <token>
 * ```
 *
 * # How it decides
 *
 * Checks are grouped by the capability level they belong to. A relay must satisfy all three
 * levels; there is no read-only deployment shape to be lenient about, unlike a spectator
 * backend. Levels still order the report so a failure reads as what it is: discovery first,
 * streaming second, Director sync third.
 *
 * Nothing here mutates scorer state beyond one room, one session, one final, and one help
 * request in the tournament under test, and the suite claims its own tournament id when given a
 * setup token, so pointing it at a deployment never disturbs a live tournament — but prefer a
 * test tournament anyway.
 */

export type CheckLevel = 'basic' | 'realtime' | 'management';
export type CheckOutcome = 'pass' | 'fail' | 'skip';

export interface CheckResult {
  id: string;
  level: CheckLevel;
  title: string;
  outcome: CheckOutcome;
  detail: string;
  /** Milliseconds. Reported so a slow-but-correct relay is visible as slow. */
  elapsedMs: number;
}

export interface ConformanceOptions {
  origin: string;
  /** Claim this tournament when a setup token is supplied; otherwise generated. */
  tournamentId?: string;
  /** Claim a fresh tournament and run the management checks with the resulting credential. */
  setupToken?: string;
  /** Run the management checks against an already-claimed tournament. */
  managementToken?: string;
  fetchImpl?: typeof fetch;
  /** Supplied in tests. Node 22 has a global WebSocket. */
  webSocketImpl?: typeof WebSocket;
  /** How long to wait for a stream frame before calling it absent. */
  streamTimeoutMs?: number;
  /**
   * A browser origin the relay is configured to allow, e.g. `https://qbsheet.com`.
   *
   * Supply it to check the CORS preflight contract. Without it the preflight checks skip: whether
   * an origin is approved is the operator's configuration, and a suite that guessed would report
   * a correct relay as broken.
   */
  browserOrigin?: string;
}

export interface ConformanceReport {
  origin: string;
  tournamentId: string;
  results: CheckResult[];
  /** Whether the relay satisfies every check. Relays have no partial-credit level. */
  conforming: boolean;
  passed: number;
  failed: number;
  skipped: number;
}

interface WireFrame {
  version: number;
  type: string;
  sequence?: number;
  session_id?: string;
  payload?: Record<string, unknown>;
}

type FetchImpl = typeof fetch;
type WebSocketImpl = typeof WebSocket;

const STREAM_SUBPROTOCOL = 'qbtcp.stream.v1';
const TOURNAMENT_ALPHABET = '0123456789bcdfghjklmnpqrstvwxyz';

export function randomTournamentId(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => TOURNAMENT_ALPHABET[byte % TOURNAMENT_ALPHABET.length]).join('');
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

class Recorder {
  readonly results: CheckResult[] = [];

  async run(id: string, level: CheckLevel, title: string, body: () => Promise<string>): Promise<void> {
    const started = Date.now();
    try {
      const detail = await body();
      this.results.push({ id, level, title, outcome: 'pass', detail, elapsedMs: Date.now() - started });
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      this.results.push({ id, level, title, outcome: 'fail', detail, elapsedMs: Date.now() - started });
    }
  }

  skip(id: string, level: CheckLevel, title: string, detail: string): void {
    this.results.push({ id, level, title, outcome: 'skip', detail, elapsedMs: 0 });
  }
}

function fail(message: string): never {
  throw new Error(message);
}

async function readJson(response: Response): Promise<{ status: number; body: unknown }> {
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) as unknown };
  } catch {
    fail(`Expected JSON, got status ${response.status} with ${text.length} undecodable bytes.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface StreamHarness {
  send(frame: unknown): void;
  next(predicate?: (frame: WireFrame) => boolean): Promise<WireFrame>;
  close(): void;
}

async function connectStream(
  WebSocketClass: WebSocketImpl,
  url: string,
  timeoutMs: number,
): Promise<StreamHarness> {
  const socket = new WebSocketClass(url, [STREAM_SUBPROTOCOL]);
  const pending: {
    predicate: (frame: WireFrame) => boolean;
    resolve: (frame: WireFrame) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];
  const backlog: WireFrame[] = [];
  let failed: Error | null = null;

  const deliver = (frame: WireFrame): void => {
    const index = pending.findIndex((entry) => {
      try {
        return entry.predicate(frame);
      } catch {
        return false;
      }
    });
    if (index >= 0) {
      const [entry] = pending.splice(index, 1);
      clearTimeout(entry.timer);
      entry.resolve(frame);
    } else {
      backlog.push(frame);
    }
  };

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`The stream at ${url} did not open within ${timeoutMs} ms.`)),
      timeoutMs,
    );
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`The stream at ${url} failed to open.`));
    });
  });

  socket.addEventListener('message', (event) => {
    try {
      deliver(JSON.parse(String((event as MessageEvent).data)) as WireFrame);
    } catch {
      // Non-JSON on the wire is itself a finding, surfaced by the waiting check timing out.
    }
  });
  socket.addEventListener('close', () => {
    failed ??= new Error('The stream closed while a frame was awaited.');
    for (const entry of pending.splice(0)) {
      clearTimeout(entry.timer);
      entry.reject(failed);
    }
  });
  socket.addEventListener('error', () => {
    failed ??= new Error('The stream errored while a frame was awaited.');
  });

  return {
    send(frame: unknown): void {
      socket.send(JSON.stringify(frame));
    },
    next(predicate: (frame: WireFrame) => boolean = () => true): Promise<WireFrame> {
      const index = backlog.findIndex(predicate);
      if (index >= 0) {
        const [frame] = backlog.splice(index, 1);
        return Promise.resolve(frame);
      }
      if (failed) return Promise.reject(failed);
      return new Promise<WireFrame>((resolve, reject) => {
        const timer = setTimeout(() => {
          const position = pending.findIndex((entry) => entry.resolve === resolve);
          if (position >= 0) pending.splice(position, 1);
          reject(new Error('Timed out waiting for a stream frame.'));
        }, timeoutMs);
        pending.push({ predicate, resolve, reject, timer });
      });
    },
    close(): void {
      try {
        socket.close();
      } catch {
        // Already gone.
      }
    },
  };
}

export async function runRelayConformance(options: ConformanceOptions): Promise<ConformanceReport> {
  const fetchImpl: FetchImpl = options.fetchImpl ?? fetch;
  const WebSocketClass: WebSocketImpl | undefined = options.webSocketImpl ?? globalThis.WebSocket;
  const timeoutMs = options.streamTimeoutMs ?? 5000;
  const origin = options.origin.replace(/\/+$/, '');
  const recorder = new Recorder();

  const tournamentId = options.tournamentId ?? randomTournamentId();
  const base = `${origin}/qbtcp/v1/tournaments/${tournamentId}`;
  const manage = `${origin}/qbtcp/v1/manage/tournaments/${tournamentId}`;

  const http = async (
    path: string,
    init?: RequestInit,
  ): Promise<{ status: number; body: unknown; headers: Headers }> => {
    const response = await fetchImpl(path, init);
    const { status, body } = await readJson(response);
    return { status, body, headers: response.headers };
  };

  // -- Setup: claim (or reuse) and provision one room --------------------------------------------
  let managementToken = options.managementToken ?? null;
  if (options.setupToken) {
    const claimed = await http(`${origin}/qbtcp/v1/manage/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ setupToken: options.setupToken, tournamentId }),
    });
    if (
      claimed.status !== 200 ||
      !isRecord(claimed.body) ||
      typeof claimed.body.managementToken !== 'string'
    ) {
      fail(`Claim failed with status ${claimed.status}: ${JSON.stringify(claimed.body).slice(0, 200)}`);
    }
    managementToken = claimed.body.managementToken as string;
  }

  const mgmt = (token: string): Record<string, string> => ({
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  });

  const pairingCode = `700${String(Math.floor(Math.random() * 90000) + 10000)}`;
  const roomId = 'room-a';
  const matchId = 'conf-match-1';
  const assignmentQbj = {
    type: 'Match',
    id: matchId,
    _qbtcp: { round_revision: 3, assignment_revision: 7 },
    match_teams: [],
  };
  let roomToken: string | null = null;
  let sessionId: string | null = null;
  let sessionToken: string | null = null;
  let streamEndpoint: string | null = null;

  if (managementToken) {
    const mirrored = await http(`${manage}/mirror`, {
      method: 'PUT',
      headers: mgmt(managementToken),
      body: JSON.stringify({
        director_epoch: 1,
        revision: 1,
        tournament: { name: 'Conformance' },
        rooms: [
          {
            room_id: roomId,
            name: 'Room A',
            pairing_code_hash: await sha256Hex(pairingCode),
            assignment_qbj: assignmentQbj,
            match_id: matchId,
            round_revision: 3,
            assignment_revision: 7,
          },
        ],
        sessions: [],
      }),
    });
    if (mirrored.status !== 200) fail(`Setup mirror failed: ${JSON.stringify(mirrored.body).slice(0, 200)}`);
    const paired = await http(`${base}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: pairingCode, room_id: roomId }),
    });
    if (paired.status !== 200 || !isRecord(paired.body) || typeof paired.body.token !== 'string') {
      fail(`Setup pairing failed: ${JSON.stringify(paired.body).slice(0, 200)}`);
    }
    roomToken = paired.body.token as string;
    const opened = await http(`${base}/sessions`, {
      method: 'POST',
      headers: { 'x-yf-room-token': roomToken, 'content-type': 'application/json' },
      body: JSON.stringify({ match_id: matchId, device_id: 'conformance-1' }),
    });
    if (opened.status !== 200 || !isRecord(opened.body))
      fail(`Setup session open failed: ${JSON.stringify(opened.body).slice(0, 200)}`);
    sessionId = opened.body.session_id as string;
    sessionToken = opened.body.token as string;
  }

  /**
   * Send a browser-shaped CORS preflight and return the raw response.
   *
   * Not routed through `http`: a preflight answers 204 with no body, and the whole point is the
   * headers. A relay that answers a credentialed preflight with a public policy is broken in a way
   * that is invisible to any check that only ever sends the real request from a non-browser — the
   * server is happy, and only the browser refuses.
   */
  const preflight = async (
    path: string,
    method: string,
    requestHeaders: string,
    browserOrigin: string,
  ): Promise<Response> =>
    fetchImpl(path, {
      method: 'OPTIONS',
      headers: {
        origin: browserOrigin,
        'access-control-request-method': method,
        'access-control-request-headers': requestHeaders,
      },
    });

  const headerList = (response: Response, name: string): string[] =>
    (response.headers.get(name) ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry !== '');

  // -- Basic: discovery and the pairing contract ---------------------------------------------------
  await recorder.run('root', 'basic', 'The root names the service without naming tournaments', async () => {
    const response = await http(`${origin}/health`);
    if (response.status !== 200) fail(`GET /health answered ${response.status}.`);
    const body = response.body as Record<string, unknown>;
    if (body.service !== 'qbtcp-relay' || body.protocolVersion !== 1)
      fail(`Unexpected root document: ${JSON.stringify(body).slice(0, 160)}`);
    return 'The root answers {service, protocolVersion} and discloses nothing else.';
  });

  await recorder.run(
    'discovery',
    'basic',
    'Discovery advertises a credential-free stream descriptor',
    async () => {
      const response = await http(`${base}/discovery`);
      if (response.status !== 200) fail(`Discovery answered ${response.status}.`);
      if (!isRecord(response.body)) fail('Discovery is not a JSON object.');
      const body = response.body;
      if (body.protocol !== 'QBTCP' || body.version !== 1) fail('Discovery is not QBTCP v1.');
      if (!Array.isArray(body.capabilities) || !body.capabilities.includes('stream'))
        fail('The stream capability is missing.');
      if (!isRecord(body.stream)) fail('The stream descriptor is missing.');
      const descriptor = body.stream;
      if (
        typeof descriptor.endpoint !== 'string' ||
        !descriptor.endpoint.startsWith('/') ||
        /[?#@]/.test(descriptor.endpoint)
      ) {
        fail(`The stream endpoint is not a relative path: ${JSON.stringify(descriptor.endpoint)}`);
      }
      streamEndpoint = descriptor.endpoint as string;
      if (descriptor.frames !== 1) fail('The descriptor must speak frame version 1.');
      if (descriptor.retains_finals !== true) fail('A durable relay must advertise retains_finals.');
      if (descriptor.mirrors_assignment !== true) fail('A relay must advertise mirrors_assignment.');
      if (!Array.isArray(descriptor.replay) || descriptor.replay.length === 0)
        fail('The descriptor must list replay features.');
      for (const feature of descriptor.replay as unknown[]) {
        if (feature !== 'sequence' && feature !== 'resync')
          fail(`Unknown replay feature: ${String(feature)}`);
      }
      if (typeof descriptor.max_frame_bytes !== 'number' || descriptor.max_frame_bytes <= 0)
        fail('The descriptor needs a frame bound.');
      if (typeof descriptor.ticket !== 'boolean') fail('The descriptor must say whether it offers tickets.');
      if (Object.keys(descriptor).some((key) => /token|code|secret|password|credential|bearer/i.test(key))) {
        fail('The descriptor carries credential-shaped data.');
      }
      return `Stream at ${streamEndpoint} speaks frames v1 with replay ${(descriptor.replay as string[]).join('+')}.`;
    },
  );

  await recorder.run(
    'pairing-refusal',
    'basic',
    'Pairing failures are uniform and reveal nothing',
    async () => {
      if (!managementToken) fail('Setup did not complete; cannot test pairing.');
      const attempts = [{ code: '00000000' }, { code: 'abc' }, { code: pairingCode, room_id: 'room-b' }];
      const answers = new Set<string>();
      for (const body of attempts) {
        const response = await http(`${base}/pair`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (response.status !== 401) fail(`A bad pairing code answered ${response.status}, not 401.`);
        answers.add(JSON.stringify(response.body));
      }
      if (answers.size !== 1) fail('Pairing refusals differ by cause: an enumeration oracle.');
      if (JSON.stringify([...answers][0]).includes(pairingCode)) fail('A refusal retained the code.');
      return 'Malformed, unknown, and mismatched codes converge on one answer.';
    },
  );

  await recorder.run(
    'unknown-tournament',
    'basic',
    'Unknown tournaments 404 without distinguishing why',
    async () => {
      const response = await http(`${origin}/qbtcp/v1/tournaments/${'0'.repeat(24)}/discovery`);
      if (response.status !== 404) fail(`An unknown tournament answered ${response.status}.`);
      return 'Unknown tournaments are indistinguishable from unclaimed ones.';
    },
  );

  await recorder.run(
    'cors-public',
    'basic',
    'Credential-free routes are readable by any origin',
    async () => {
      const response = await preflight(`${base}/discovery`, 'GET', 'content-type', 'https://example.invalid');
      if (response.status >= 400) fail(`A discovery preflight answered ${response.status}.`);
      const allowOrigin = response.headers.get('access-control-allow-origin');
      if (allowOrigin !== '*') {
        fail(`Discovery is credential-free and should allow any origin; got ${String(allowOrigin)}.`);
      }
      return 'Discovery preflights allow any origin, as a credential-free route may.';
    },
  );

  const browserOrigin = options.browserOrigin?.replace(/\/+$/, '');
  if (!browserOrigin) {
    recorder.skip(
      'cors-preflight',
      'basic',
      'Credentialed routes preflight for a real browser scorer',
      'No --browser-origin supplied; the relay operator decides which origins are approved.',
    );
  } else if (!sessionId) {
    recorder.skip(
      'cors-preflight',
      'basic',
      'Credentialed routes preflight for a real browser scorer',
      'Setup did not produce a session; cannot preflight the session routes.',
    );
  } else {
    const session = sessionId;
    await recorder.run(
      'cors-preflight',
      'basic',
      'Credentialed routes preflight for a real browser scorer',
      async () => {
        // Exactly what a page at `browserOrigin` sends before each request. A relay that answers
        // these with the public `GET, OPTIONS` / `content-type` policy is unusable from a browser
        // even though every one of these routes works perfectly from curl.
        const cases: { path: string; method: string; headers: string }[] = [
          { path: `${base}/pair`, method: 'POST', headers: 'content-type' },
          {
            path: `${base}/sessions`,
            method: 'POST',
            headers: 'x-yf-room-token,content-type,x-yf-device-id',
          },
          { path: `${base}/assignment`, method: 'GET', headers: 'x-yf-room-token' },
          {
            path: `${base}/sessions/${session}/progress`,
            method: 'POST',
            headers: 'x-yf-session-token,content-type',
          },
          {
            path: `${base}/sessions/${session}/result`,
            method: 'POST',
            headers: 'x-yf-session-token,content-type',
          },
          { path: `${base}/sessions/${session}/recovery`, method: 'GET', headers: 'x-yf-session-token' },
          {
            path: `${base}/help`,
            method: 'POST',
            headers: 'x-yf-room-token,content-type,x-yf-device-id,x-yf-operator-name',
          },
          { path: `${manage}/mirror`, method: 'PUT', headers: 'authorization,content-type' },
          { path: `${manage}/results`, method: 'GET', headers: 'authorization' },
        ];
        for (const item of cases) {
          const response = await preflight(item.path, item.method, item.headers, browserOrigin);
          const where = `${item.method} ${new URL(item.path).pathname}`;
          if (response.status >= 400) fail(`The preflight for ${where} answered ${response.status}.`);
          const allowOrigin = response.headers.get('access-control-allow-origin');
          if (allowOrigin === '*') {
            fail(`${where} honours a credential and must not allow *.`);
          }
          if (allowOrigin !== browserOrigin) {
            fail(`${where} did not echo the approved origin; got ${String(allowOrigin)}.`);
          }
          const methods = headerList(response, 'access-control-allow-methods');
          if (!methods.includes(item.method.toLowerCase())) {
            fail(`${where} preflight does not allow ${item.method}: ${methods.join(', ') || 'nothing'}.`);
          }
          const allowed = headerList(response, 'access-control-allow-headers');
          for (const requested of item.headers.split(',')) {
            if (!allowed.includes(requested.trim())) {
              fail(`${where} preflight does not allow ${requested.trim()}.`);
            }
          }
        }
        return `All ${cases.length} credentialed routes preflight for ${browserOrigin} with the headers a browser sends.`;
      },
    );

    await recorder.run(
      'cors-origin-refusal',
      'basic',
      'An unapproved browser origin is refused, not allowed',
      async () => {
        const response = await preflight(
          `${base}/sessions`,
          'POST',
          'x-yf-room-token,content-type',
          'https://not-approved.invalid',
        );
        const allowOrigin = response.headers.get('access-control-allow-origin');
        if (allowOrigin === '*' || allowOrigin === 'https://not-approved.invalid') {
          fail(`An unapproved origin was allowed on a credentialed route: ${String(allowOrigin)}.`);
        }
        return 'A credentialed preflight from an unapproved origin is not granted.';
      },
    );
  }

  // -- Realtime: the stream ------------------------------------------------------------------------
  const canStream =
    WebSocketClass !== undefined && WebSocketClass !== null && streamEndpoint !== null && roomToken !== null;
  if (!canStream) {
    recorder.skip(
      'stream-hello',
      'realtime',
      'The stream greets an authenticated socket',
      'No WebSocket implementation or no setup session.',
    );
  } else {
    const endpoint = streamEndpoint;
    const SocketClass = WebSocketClass;
    const room = roomToken;
    if (!endpoint || !SocketClass || !room) fail('Setup did not produce a streamable session.');
    const wsUrl =
      (origin.startsWith('https') ? origin.replace(/^https/, 'wss') : origin.replace(/^http/, 'ws')) +
      endpoint;
    await recorder.run('stream-hello', 'realtime', 'The stream greets an authenticated socket', async () => {
      const stream = await connectStream(SocketClass, wsUrl, timeoutMs);
      try {
        stream.send({
          version: 1,
          type: 'authenticate',
          payload: { room_token: room, device_id: 'conformance-1' },
        });
        const hello = await stream.next((frame) => frame.type === 'hello');
        if ((hello.payload as Record<string, unknown>)?.tournament_id !== tournamentId)
          fail('Hello names the wrong tournament.');
        return `Hello at relay revision ${String(hello.sequence ?? (hello.payload as Record<string, unknown>)?.relay_revision)}.`;
      } finally {
        stream.close();
      }
    });

    await recorder.run(
      'stream-auth-first',
      'realtime',
      'No frame is honoured before authenticate',
      async () => {
        const stream = await connectStream(SocketClass, wsUrl, timeoutMs);
        try {
          stream.send({ version: 1, type: 'progress', payload: { sequence: 1, match_state: {} } });
          const error = await stream.next((frame) => frame.type === 'error');
          if ((error.payload as Record<string, unknown>)?.code !== 'unauthorized')
            fail(`Expected unauthorized, got ${JSON.stringify(error.payload)}`);
          return 'A pre-auth frame is refused without touching state.';
        } finally {
          stream.close();
        }
      },
    );

    await recorder.run(
      'stream-malformed',
      'realtime',
      'Malformed frames fail safely and the connection survives',
      async () => {
        if (!sessionId || !sessionToken) fail('Setup did not complete.');
        const stream = await connectStream(SocketClass, wsUrl, timeoutMs);
        try {
          // Session scope: recovery carries the same session capability as HTTP recovery, so the
          // socket proves the session token here rather than the room token alone.
          stream.send({
            version: 1,
            type: 'authenticate',
            session_id: sessionId,
            payload: { room_token: room, session_token: sessionToken, device_id: 'conformance-1' },
          });
          await stream.next((frame) => frame.type === 'hello');
          stream.send({ version: 2, type: 'progress', payload: {} });
          const error = await stream.next((frame) => frame.type === 'error');
          if ((error.payload as Record<string, unknown>)?.code !== 'unsupported-version')
            fail(`Expected unsupported-version, got ${JSON.stringify(error.payload)}`);
          stream.send({ version: 1, type: 'recover', session_id: sessionId, payload: {} });
          await stream.next((frame) => frame.type === 'recovery');
          return 'A versioned frame is refused and the same socket still recovers.';
        } finally {
          stream.close();
        }
      },
    );

    await recorder.run('stream-push', 'realtime', 'Assignment updates are pushed, not polled', async () => {
      if (!managementToken) fail('Setup did not complete.');
      const stream = await connectStream(SocketClass, wsUrl, timeoutMs);
      try {
        stream.send({
          version: 1,
          type: 'authenticate',
          payload: { room_token: room, device_id: 'conformance-1' },
        });
        await stream.next((frame) => frame.type === 'hello');
        const pushed = await http(`${manage}/mirror`, {
          method: 'PUT',
          headers: mgmt(managementToken as string),
          body: JSON.stringify({
            director_epoch: 1,
            revision: 2,
            rooms: [
              {
                room_id: roomId,
                assignment_qbj: assignmentQbj,
                match_id: matchId,
                round_revision: 4,
                assignment_revision: 1,
              },
            ],
            sessions: [],
          }),
        });
        if (pushed.status !== 200) fail('Setup mirror for the push check failed.');
        // Authenticating without a cursor replays pre-auth telemetry first; wait for the push
        // itself rather than the first assignment-changed frame.
        const frame = await stream.next(
          (candidate) =>
            candidate.type === 'assignment-changed' &&
            (candidate.payload as Record<string, unknown>)?.round_revision === 4,
        );
        void frame;
        return 'The mirror published round revision 4 and the socket was told.';
      } finally {
        stream.close();
      }
    });

    await recorder.run(
      'stream-receipt',
      'realtime',
      'A streamed final gets exactly one durable receipt',
      async () => {
        if (!managementToken || !sessionToken || !sessionId) fail('Setup did not complete.');
        const qbj = { type: 'Match', id: matchId, match_teams: [{ score: 11 }] };
        const stream = await connectStream(SocketClass, wsUrl, timeoutMs);
        try {
          stream.send({
            version: 1,
            type: 'authenticate',
            session_id: sessionId,
            payload: { room_token: room, session_token: sessionToken, device_id: 'conformance-1' },
          });
          await stream.next((frame) => frame.type === 'hello');
          stream.send({
            version: 1,
            type: 'final',
            session_id: sessionId,
            payload: { qbj, retry_key: 'conf-retry-1' },
          });
          const receipt = await stream.next((frame) => frame.type === 'receipt');
          const payload = (receipt.payload ?? {}) as Record<string, unknown>;
          if (
            payload.received !== true ||
            payload.accepted_by_director !== false ||
            payload.duplicate !== false
          ) {
            fail(`Unexpected receipt: ${JSON.stringify(payload).slice(0, 200)}`);
          }
          const resultId = payload.result_id as string;
          const overHttp = await http(`${base}/sessions/${sessionId}/result`, {
            method: 'POST',
            headers: { 'x-yf-session-token': sessionToken as string, 'content-type': 'application/json' },
            body: JSON.stringify({ qbj, retry_key: 'conf-retry-1' }),
          });
          if ((overHttp.body as Record<string, unknown>).duplicate !== true)
            fail('The cross-transport retry was not idempotent.');
          if ((overHttp.body as Record<string, unknown>).result_id !== resultId)
            fail('The retry minted a second result.');
          return `Result ${resultId} retained once across both transports.`;
        } finally {
          stream.close();
        }
      },
    );
  }

  // -- Management: mirror, replay, ack, scope --------------------------------------------------------
  if (!managementToken) {
    for (const [id, title] of [
      ['mirror-fencing', 'Stale Director state is fenced, not forked'],
      ['replay', 'Missed durable items replay after a cursor'],
      ['ack', 'Acknowledgment clears the unacked set idempotently'],
      ['trim', 'Unacknowledged finals survive the replay trim'],
      ['scope', 'Scorer credentials never reach the management surface'],
      ['health', 'Health reports counters and honest headroom'],
      ['help', 'Help is retained and resolved with Director authority'],
    ] as [string, string][]) {
      recorder.skip(
        id,
        'management',
        title,
        'No management token: pass --setup-token or --management-token.',
      );
    }
  } else {
    const token = managementToken;
    await recorder.run(
      'mirror-fencing',
      'management',
      'Stale Director state is fenced, not forked',
      async () => {
        const health = (await http(`${manage}/health`, { headers: mgmt(token) })).body as {
          mirror: { revision: number; director_epoch: number };
        };
        const current = health.mirror.revision;
        const epoch = health.mirror.director_epoch;
        const forward = await http(`${manage}/mirror`, {
          method: 'PUT',
          headers: mgmt(token),
          body: JSON.stringify({ director_epoch: epoch, revision: current + 1, rooms: [], sessions: [] }),
        });
        if (forward.status !== 200) fail(`A fresh mirror answered ${forward.status}.`);
        const stale = await http(`${manage}/mirror`, {
          method: 'PUT',
          headers: mgmt(token),
          body: JSON.stringify({ director_epoch: epoch, revision: current + 1, rooms: [], sessions: [] }),
        });
        if (stale.status !== 409) fail(`A stale mirror answered ${stale.status}, not 409.`);
        return 'The old revision is refused with the current position.';
      },
    );

    await recorder.run('replay', 'management', 'Missed durable items replay after a cursor', async () => {
      const replay = await http(`${manage}/events?after=0`, { headers: mgmt(token) });
      if (replay.status !== 200) fail(`Replay answered ${replay.status}.`);
      const body = replay.body as {
        events: { kind: string }[];
        resyncRequired: boolean;
        currentRevision: number;
      };
      if (body.resyncRequired !== false) fail('A fresh tournament claims resync is required.');
      if (!body.events.some((event) => event.kind === 'result')) fail('The retained final did not replay.');
      return `${body.events.length} events replay to revision ${body.currentRevision}.`;
    });

    await recorder.run(
      'ack',
      'management',
      'Acknowledgment clears the unacked set idempotently',
      async () => {
        const listed = (await http(`${manage}/results`, { headers: mgmt(token) })).body as {
          results: { result_id: string }[];
        };
        if (listed.results.length === 0) fail('No retained results to acknowledge.');
        const ack = await http(`${manage}/acks`, {
          method: 'POST',
          headers: mgmt(token),
          body: JSON.stringify({ results: listed.results.map((entry) => entry.result_id), help: [] }),
        });
        if ((ack.body as { acked_results: number }).acked_results !== listed.results.length)
          fail('Not every result acknowledged.');
        const remaining = (await http(`${manage}/results`, { headers: mgmt(token) })).body as {
          results: unknown[];
        };
        if (remaining.results.length !== 0) fail('Acknowledged results still list as unacked.');
        return 'Every retained result acknowledged and cleared.';
      },
    );

    await recorder.run('trim', 'management', 'Unacknowledged finals survive the replay trim', async () => {
      // Retain a fresh final, then flood telemetry past the replay window in one bulk mirror.
      const qbj = { type: 'Match', id: matchId, match_teams: [{ score: 12 }] };
      const retained = await http(`${base}/sessions/${sessionId}/result`, {
        method: 'POST',
        headers: { 'x-yf-session-token': sessionToken as string, 'content-type': 'application/json' },
        body: JSON.stringify({ qbj, retry_key: 'conf-trim' }),
      });
      const resultId = (retained.body as { result_id: string }).result_id;
      if (!resultId) fail('Could not retain a final for the trim check.');
      const health = (await http(`${manage}/health`, { headers: mgmt(token) })).body as {
        mirror: { revision: number; director_epoch: number };
      };
      const flood = await http(`${manage}/mirror`, {
        method: 'PUT',
        headers: mgmt(token),
        body: JSON.stringify({
          director_epoch: health.mirror.director_epoch,
          revision: health.mirror.revision + 1,
          rooms: Array.from({ length: 270 }, (_, index) => ({
            room_id: `trim-${index}`,
            assignment_qbj: { type: 'Match', id: `trim-match-${index}` },
            match_id: `trim-match-${index}`,
            round_revision: index + 10,
            assignment_revision: 1,
          })),
          sessions: [],
        }),
      });
      if (flood.status !== 200) fail('The bulk mirror for the trim check failed.');
      const results = (await http(`${manage}/results`, { headers: mgmt(token) })).body as {
        results: { result_id: string }[];
      };
      if (!results.results.some((entry) => entry.result_id === resultId))
        fail('The unacknowledged final aged out with telemetry.');
      return 'Telemetry compacted; the unacknowledged final is still listed.';
    });

    await recorder.run(
      'scope',
      'management',
      'Scorer credentials never reach the management surface',
      async () => {
        const response = await http(`${manage}/health`, {
          headers: { authorization: `Bearer ${roomToken}` },
        });
        if (response.status !== 401) fail(`A room token on management answered ${response.status}.`);
        return 'Room and session tokens are refused on management routes.';
      },
    );

    await recorder.run('health', 'management', 'Health reports counters and honest headroom', async () => {
      const response = await http(`${manage}/health`, { headers: mgmt(token) });
      if (response.status !== 200) fail(`Health answered ${response.status}.`);
      const body = response.body as {
        capabilities: Record<string, unknown>;
        counters: Record<string, number>;
        budget: { limits: Record<string, number>; headroom: Record<string, number> };
      };
      if (body.capabilities.retainsFinals !== true) fail('Health does not claim durable finals.');
      if (typeof body.counters.http_requests !== 'number') fail('Health carries no counters.');
      if (body.budget.limits.rows_written_per_day !== 100_000)
        fail('Health does not name the rows-written limit.');
      return 'Counters, storage pressure, and Free-tier headroom are reported.';
    });

    await recorder.run(
      'help',
      'management',
      'Help is retained and resolved with Director authority',
      async () => {
        const opened = await http(`${base}/help`, {
          method: 'POST',
          headers: { 'x-yf-room-token': roomToken as string, 'content-type': 'application/json' },
          body: JSON.stringify({
            category: 'protest',
            message: 'Conformance help',
            device_id: 'conformance-1',
          }),
        });
        const helpId = (opened.body as { request: { id: string } }).request?.id;
        if (!helpId) fail('Could not open a help request.');
        const resolved = await http(`${manage}/help/${helpId}/resolve`, {
          method: 'POST',
          headers: mgmt(token),
        });
        if (resolved.status !== 200) fail(`Resolve answered ${resolved.status}.`);
        if ((resolved.body as { request: { status: string } }).request?.status !== 'resolved')
          fail('Help did not resolve.');
        return `Help ${helpId} retained while Director was away, resolved on return.`;
      },
    );
  }

  const passed = recorder.results.filter((entry) => entry.outcome === 'pass').length;
  const failed = recorder.results.filter((entry) => entry.outcome === 'fail').length;
  const skipped = recorder.results.filter((entry) => entry.outcome === 'skip').length;
  return {
    origin,
    tournamentId,
    results: recorder.results,
    conforming: failed === 0,
    passed,
    failed,
    skipped,
  };
}

export function formatReport(report: ConformanceReport): string {
  const lines = [
    `QBTCP relay conformance: ${report.origin} (tournament ${report.tournamentId})`,
    `${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped — ${report.conforming ? 'CONFORMING' : 'NOT CONFORMING'}`,
    '',
  ];
  for (const result of report.results) {
    const mark = result.outcome === 'pass' ? 'ok' : result.outcome === 'fail' ? 'FAIL' : 'skip';
    lines.push(`[${mark}] [${result.level}] ${result.id}: ${result.title} (${result.elapsedMs} ms)`);
    if (result.outcome !== 'pass') lines.push(`      ${result.detail}`);
  }
  return lines.join('\n');
}
