/**
 * The QBLive conformance suite.
 *
 * # What it is for
 *
 * QBLive is an open protocol. A third-party server that implements it is a first-class QBLive
 * server, and "first-class" is only meaningful if there is a way to check. This suite runs against
 * any server by base URL and reports what it does and does not satisfy.
 *
 * ```bash
 * npm run conformance --workspace=@qbsheet/qblive-conformance -- \
 *   --origin https://my-backend.example --publication <id> --management-token <token>
 * ```
 *
 * # How it decides
 *
 * Checks are grouped by the capability level they belong to. A Basic server that fails a Realtime
 * check is **conforming**; a Basic server that fails a Basic check is not. Reporting a static file
 * host as broken because it has no WebSocket would make the suite useless for the deployment the
 * protocol was designed to allow.
 *
 * Nothing here mutates a publication unless a management token is supplied, and the checks that do
 * are marked. A director can point this at a live tournament with read-only credentials and learn
 * something without risking anything.
 */

import {
  applyEvent,
  parseEventPage,
  parseManifest,
  parseSnapshot,
  QbliveValidationError,
  type QbliveManifest,
  type QbliveSnapshot,
} from '@qbsheet/qblive-protocol';

export type CheckLevel = 'basic' | 'realtime' | 'management';

export type CheckOutcome = 'pass' | 'fail' | 'skip';

export interface CheckResult {
  id: string;
  level: CheckLevel;
  title: string;
  outcome: CheckOutcome;
  detail: string;
  /** Milliseconds. Reported so a slow-but-correct server is visible as slow. */
  elapsedMs: number;
}

export interface ConformanceOptions {
  origin: string;
  publicationId: string;
  /** Supplied only when the caller wants the management checks, which write. */
  managementToken?: string;
  fetchImpl?: typeof fetch;
  /** Supplied in tests. Node before 22 has no global WebSocket. */
  webSocketImpl?: typeof WebSocket;
  /** How long to wait for a stream frame before calling it absent. */
  streamTimeoutMs?: number;
  /** Skip the check that uploads ~9 MB, for a run against a remote server over a slow link. */
  skipLargeUpload?: boolean;
}

export interface ConformanceReport {
  origin: string;
  publicationId: string;
  results: CheckResult[];
  /** The highest level the server satisfies completely. */
  level: 'none' | 'basic' | 'realtime';
  passed: number;
  failed: number;
  skipped: number;
}

class Recorder {
  readonly results: CheckResult[] = [];

  async run(
    id: string,
    level: CheckLevel,
    title: string,
    body: () => Promise<string | { skip: string }>,
  ): Promise<void> {
    const started = Date.now();
    try {
      const outcome = await body();
      if (typeof outcome === 'object') {
        this.results.push({
          id,
          level,
          title,
          outcome: 'skip',
          detail: outcome.skip,
          elapsedMs: Date.now() - started,
        });
      } else {
        this.results.push({
          id,
          level,
          title,
          outcome: 'pass',
          detail: outcome,
          elapsedMs: Date.now() - started,
        });
      }
    } catch (reason) {
      this.results.push({
        id,
        level,
        title,
        outcome: 'fail',
        detail: reason instanceof Error ? reason.message : String(reason),
        elapsedMs: Date.now() - started,
      });
    }
  }
}

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

export async function runConformance(options: ConformanceOptions): Promise<ConformanceReport> {
  const doFetch = options.fetchImpl ?? fetch;
  const origin = options.origin.replace(/\/$/, '');
  const base = `${origin}/qblive/v1/tournaments/${encodeURIComponent(options.publicationId)}`;
  const manage = `${origin}/qblive/v1/manage/tournaments/${encodeURIComponent(options.publicationId)}`;
  const recorder = new Recorder();

  let manifest: QbliveManifest | null = null;
  let snapshot: QbliveSnapshot | null = null;
  /**
   * The snapshot exactly as the server sent it.
   *
   * The privacy check reads this rather than the parsed value, because the validator *constructs*
   * a snapshot from the fields it knows and therefore silently drops an extra one. The question
   * this suite has to answer is what the server published, not what a client would keep.
   */
  let rawSnapshot = '';

  // -------------------------------------------------------------- basic

  await recorder.run('manifest', 'basic', 'GET manifest returns a valid QBLive manifest', async () => {
    const response = await doFetch(`${base}/manifest`);
    expect(response.ok, `manifest answered ${response.status}`);
    manifest = parseManifest(await response.json());
    expect(manifest.publicationId === options.publicationId, 'the manifest names a different publication');
    expect(manifest.capabilities.snapshot === true, 'a QBLive server must advertise snapshot support');
    return `revision ${manifest.revision}, capabilities ${describeCapabilities(manifest)}`;
  });

  await recorder.run('snapshot', 'basic', 'GET snapshot returns a valid QBLive snapshot', async () => {
    const response = await doFetch(`${base}/snapshot`);
    expect(response.ok, `snapshot answered ${response.status}`);
    rawSnapshot = await response.text();
    snapshot = parseSnapshot(JSON.parse(rawSnapshot));
    expect(snapshot.publicationId === options.publicationId, 'the snapshot names a different publication');
    return `revision ${snapshot.revision}, ${snapshot.teams.length} teams, ${snapshot.schedule.length} scheduled games`;
  });

  await recorder.run('cors', 'basic', 'Public routes allow cross-origin reads', async () => {
    const response = await doFetch(`${base}/snapshot`);
    const allow = response.headers.get('access-control-allow-origin');
    expect(allow === '*' || allow !== null, 'no access-control-allow-origin header on a public route');
    return `access-control-allow-origin: ${allow}`;
  });

  await recorder.run('timestamps', 'basic', 'Published timestamps carry an explicit offset', async () => {
    if (!snapshot) return { skip: 'no snapshot' };
    // A bare local time read by a phone in another zone is the exact bug the tournament timezone
    // exists to prevent, so the protocol forbids one and this is where a server finds out.
    const offsets = /(Z|[+-]\d{2}:\d{2})$/;
    expect(offsets.test(snapshot.generatedAt), 'generatedAt has no explicit offset');
    for (const game of snapshot.schedule) {
      if (game.scheduledStart) {
        expect(offsets.test(game.scheduledStart), `game ${game.id} has a scheduledStart with no offset`);
      }
    }
    return `tournament zone ${snapshot.tournament.timeZone}`;
  });

  await recorder.run('no-estimates', 'basic', 'No estimated start times are published', async () => {
    if (!rawSnapshot) return { skip: 'no snapshot' };
    // A protocol rule, not a UI convention: a parent who drives back for a 2:14 that was never real
    // has been misled by software.
    const serialized = rawSnapshot;
    for (const word of ['estimated', 'estimate', 'probably', 'expected start', 'approximately']) {
      expect(!serialized.toLowerCase().includes(word), `the snapshot contains "${word}"`);
    }
    return 'no estimate language in the published document';
  });

  await recorder.run('privacy', 'basic', 'No private tournament data is published', async () => {
    if (!rawSnapshot) return { skip: 'no snapshot' };
    const serialized = rawSnapshot.toLowerCase();
    // Field names, not values: a conformance suite cannot know a tournament's secrets, but it can
    // notice a server that publishes fields no public projection should contain.
    const forbidden = [
      'pairingcode',
      'pairingurl',
      'sessiontoken',
      'roomtoken',
      'deviceid',
      'managementtoken',
      'fingerprint',
      'rawsubmission',
      'rawqbj',
      'databasepath',
      'archivepath',
      'apnskey',
      'p8',
    ];
    const found = forbidden.filter((needle) => serialized.includes(`"${needle}"`));
    expect(found.length === 0, `the snapshot contains ${found.join(', ')}`);
    return `checked ${forbidden.length} forbidden field names`;
  });

  await recorder.run('unknown-tournament', 'basic', 'An unknown publication is not found', async () => {
    const response = await doFetch(`${origin}/qblive/v1/tournaments/zzzzzzzzzzzzzzzzzzzz/snapshot`);
    expect(
      response.status === 404 || response.status === 410,
      `an unknown publication answered ${response.status}`,
    );
    return `answered ${response.status}`;
  });

  await recorder.run('read-only', 'basic', 'Public routes refuse writes', async () => {
    const response = await doFetch(`${base}/snapshot`, { method: 'PUT', body: '{}' });
    expect(
      response.status >= 400,
      `a PUT to a public route answered ${response.status}; public routes must be read-only`,
    );
    return `answered ${response.status}`;
  });

  await recorder.run('malformed-cursor', 'basic', 'A malformed replay cursor is refused', async () => {
    if (!manifest?.capabilities.events) return { skip: 'this server does not advertise events' };
    for (const cursor of ['-1', 'abc', '9'.repeat(400)]) {
      const response = await doFetch(`${base}/events?after=${encodeURIComponent(cursor)}`);
      expect(response.status >= 400, `after=${cursor} answered ${response.status}`);
    }
    return 'negative, non-numeric and oversized cursors all refused';
  });

  // ------------------------------------------------------------ realtime

  await recorder.run('replay', 'realtime', 'GET events replays from a revision', async () => {
    if (!manifest?.capabilities.events) return { skip: 'this server does not advertise events' };
    if (!snapshot) return { skip: 'no snapshot' };
    const response = await doFetch(`${base}/events?after=${Math.max(0, snapshot.revision - 5)}`);
    expect(response.ok, `events answered ${response.status}`);
    const page = parseEventPage(await response.json());
    expect(page.publicationId === options.publicationId, 'the event page names a different publication');
    expect(page.currentRevision >= snapshot.revision, 'currentRevision went backwards');
    for (const event of page.events) {
      expect(event.revision > snapshot.revision - 5, 'an event older than the cursor was returned');
    }
    return `${page.events.length} events, current revision ${page.currentRevision}`;
  });

  await recorder.run('resync', 'realtime', 'A cursor outside the window asks for a resync', async () => {
    if (!manifest?.capabilities.events) return { skip: 'this server does not advertise events' };
    const response = await doFetch(`${base}/events?after=0`);
    expect(response.ok, `events answered ${response.status}`);
    const page = parseEventPage(await response.json());
    // Either the whole history is replayable, or the server says so. What it must not do is return
    // a short page that a client would mistake for being caught up.
    if (page.resyncRequired) {
      expect(page.events.length === 0, 'resyncRequired was set alongside events');
      return 'the server reports when it cannot replay from the beginning';
    }
    return `the whole history is replayable (${page.events.length} events)`;
  });

  await recorder.run('replay-applies', 'realtime', 'Replayed events apply onto a snapshot', async () => {
    if (!manifest?.capabilities.events || !snapshot) return { skip: 'this server does not advertise events' };
    const response = await doFetch(`${base}/events?after=${Math.max(0, snapshot.revision - 3)}`);
    const page = parseEventPage(await response.json());
    if (page.resyncRequired || page.events.length === 0) return { skip: 'no events to apply' };
    let applied = snapshot;
    for (const event of page.events) {
      if (event.revision > applied.revision) applied = applyEvent(applied, event);
    }
    // Re-validating proves the sections a server sends are the shapes the protocol says, which is
    // what a client would otherwise discover by crashing.
    parseSnapshot(applied);
    return `applied ${page.events.length} events cleanly`;
  });

  await recorder.run('stream', 'realtime', 'The WebSocket greets with the current revision', async () => {
    if (!manifest?.capabilities.stream) return { skip: 'this server does not advertise a stream' };
    const WebSocketImpl = options.webSocketImpl ?? globalThis.WebSocket;
    if (!WebSocketImpl) return { skip: 'no WebSocket implementation available' };
    const url = new URL(`${base}/stream`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const frame = await firstFrame(WebSocketImpl, url.toString(), options.streamTimeoutMs ?? 8000);
    expect(frame?.type === 'hello', `the first frame was ${JSON.stringify(frame?.type)}, expected "hello"`);
    expect(typeof frame.revision === 'number', 'the hello frame carried no revision');
    return `hello at revision ${frame.revision}`;
  });

  await recorder.run('stream-read-only', 'realtime', 'A spectator cannot write over the stream', async () => {
    if (!manifest?.capabilities.stream) return { skip: 'this server does not advertise a stream' };
    const WebSocketImpl = options.webSocketImpl ?? globalThis.WebSocket;
    if (!WebSocketImpl) return { skip: 'no WebSocket implementation available' };
    const before = snapshot?.revision ?? 0;
    const url = new URL(`${base}/stream`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    await sendAndClose(
      WebSocketImpl,
      url.toString(),
      JSON.stringify({
        type: 'event',
        event: { revision: 999999, generatedAt: '2026-01-01T00:00:00Z', sections: {} },
      }),
      options.streamTimeoutMs ?? 8000,
    );
    const after = parseManifest(await (await doFetch(`${base}/manifest`)).json());
    expect(
      after.revision === before,
      `the revision moved from ${before} to ${after.revision} after a spectator frame`,
    );
    return 'a spectator frame changed nothing';
  });

  // ---------------------------------------------------------- management

  const token = options.managementToken;

  /**
   * The rule is that an unauthenticated write must not *succeed* — not that it must answer 401.
   *
   * A QBLive Basic server is allowed to have no management API at all, and a static file host
   * answers 404 or 405 for a POST. Insisting on 401 would report the deployment the protocol was
   * specifically designed to allow as a security failure.
   */
  await recorder.run('auth-required', 'management', 'An unauthenticated write does not succeed', async () => {
    const response = await doFetch(`${manage}/sections`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseRevision: 0,
        revision: 1,
        generatedAt: '2026-01-01T00:00:00Z',
        sections: {},
      }),
    });
    expect(
      response.status >= 400,
      `an unauthenticated write answered ${response.status}; a write must never succeed without a credential`,
    );
    return response.status === 401 || response.status === 403
      ? `refused with ${response.status}`
      : `no management API here (answered ${response.status})`;
  });

  await recorder.run('auth-wrong', 'management', 'A wrong credential does not succeed', async () => {
    const response = await doFetch(`${manage}/sections`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer 0000000000000000' },
      body: JSON.stringify({
        baseRevision: 0,
        revision: 1,
        generatedAt: '2026-01-01T00:00:00Z',
        sections: {},
      }),
    });
    expect(response.status >= 400, `a wrong credential answered ${response.status}`);
    return response.status === 401 || response.status === 403
      ? `refused with ${response.status}`
      : `no management API here (answered ${response.status})`;
  });

  await recorder.run(
    'conflict',
    'management',
    'A stale base revision conflicts and reports the current one',
    async () => {
      if (!token) return { skip: 'no management token supplied' };
      if (!snapshot) return { skip: 'no snapshot' };
      const response = await doFetch(`${manage}/sections`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          // Deliberately wrong. A server that applies this cannot be recovered from a lost
          // acknowledgement, because the publisher and the server would silently diverge.
          baseRevision: Math.max(0, snapshot.revision - 100),
          revision: snapshot.revision + 1,
          generatedAt: new Date().toISOString(),
          sections: { liveGames: [] },
        }),
      });
      expect(response.status === 409, `a stale base revision answered ${response.status}, expected 409`);
      const body = (await response.json()) as { currentRevision?: number };
      expect(typeof body.currentRevision === 'number', 'the conflict did not report currentRevision');
      return `conflict reported current revision ${body.currentRevision}`;
    },
  );

  await recorder.run('malformed-body', 'management', 'A malformed section update is refused', async () => {
    if (!token) return { skip: 'no management token supplied' };
    const response = await doFetch(`${manage}/sections`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        baseRevision: snapshot?.revision ?? 0,
        revision: (snapshot?.revision ?? 0) + 1,
        generatedAt: new Date().toISOString(),
        sections: { teams: [{ id: 'x' }] },
      }),
    });
    expect(response.status === 400, `a malformed section update answered ${response.status}, expected 400`);
    return 'answered 400';
  });

  await recorder.run('oversized-body', 'management', 'An oversized body is refused', async () => {
    if (!token) return { skip: 'no management token supplied' };
    if (options.skipLargeUpload) return { skip: 'large uploads disabled for this run' };
    // A real oversized body rather than a lying `content-length`: that header is forbidden to
    // `fetch` and setting it makes the request fail locally, which would report a client problem
    // as a server one. This uploads about 9 MB, which is why `skipLargeUpload` exists for a run
    // pointed at a remote server over a slow link.
    const filler = 'x'.repeat(9 * 1024 * 1024);
    const response = await doFetch(`${manage}/sections`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        baseRevision: snapshot?.revision ?? 0,
        revision: (snapshot?.revision ?? 0) + 1,
        generatedAt: new Date().toISOString(),
        sections: { announcements: [] },
        filler,
      }),
    });
    expect(
      response.status === 413 || response.status === 400,
      `an oversized body answered ${response.status}, expected 413`,
    );
    return `answered ${response.status} for a 9 MB body`;
  });

  const results = recorder.results;
  const failedAt = (level: CheckLevel): boolean =>
    results.some((result) => result.level === level && result.outcome === 'fail');
  const level: ConformanceReport['level'] = failedAt('basic')
    ? 'none'
    : failedAt('realtime')
      ? 'basic'
      : results.some((result) => result.level === 'realtime' && result.outcome === 'pass')
        ? 'realtime'
        : 'basic';

  return {
    origin,
    publicationId: options.publicationId,
    results,
    level,
    passed: results.filter((result) => result.outcome === 'pass').length,
    failed: results.filter((result) => result.outcome === 'fail').length,
    skipped: results.filter((result) => result.outcome === 'skip').length,
  };
}

function describeCapabilities(manifest: QbliveManifest): string {
  return (['snapshot', 'events', 'stream', 'applePush'] as const)
    .filter((name) => manifest.capabilities[name])
    .join(', ');
}

interface HelloFrame {
  type?: string;
  revision?: number;
}

function firstFrame(WebSocketImpl: typeof WebSocket, url: string, timeoutMs: number): Promise<HelloFrame> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('the stream sent no frame before the timeout'));
    }, timeoutMs);
    socket.addEventListener('message', (event: MessageEvent) => {
      clearTimeout(timer);
      socket.close();
      try {
        resolve(JSON.parse(String(event.data)) as HelloFrame);
      } catch {
        reject(new Error('the stream sent a frame that is not JSON'));
      }
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('the stream could not be opened'));
    });
  });
}

function sendAndClose(
  WebSocketImpl: typeof WebSocket,
  url: string,
  payload: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(url);
    const timer = setTimeout(() => {
      socket.close();
      resolve();
    }, timeoutMs);
    socket.addEventListener('open', () => {
      socket.send(payload);
      // Give the server a moment to do the wrong thing before checking that it did not.
      setTimeout(() => {
        clearTimeout(timer);
        socket.close();
        resolve();
      }, 500);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('the stream could not be opened'));
    });
  });
}

/** A human-readable report, for a terminal. */
export function formatReport(report: ConformanceReport): string {
  const lines: string[] = [
    '',
    `QBLive conformance — ${report.origin}`,
    `Publication ${report.publicationId}`,
    '',
  ];
  for (const level of ['basic', 'realtime', 'management'] as const) {
    const forLevel = report.results.filter((result) => result.level === level);
    if (forLevel.length === 0) continue;
    lines.push(`${level.toUpperCase()}`);
    for (const result of forLevel) {
      const mark = result.outcome === 'pass' ? '  ok  ' : result.outcome === 'fail' ? ' FAIL ' : ' skip ';
      lines.push(`${mark} ${result.title}`);
      lines.push(`       ${result.detail}  (${result.elapsedMs} ms)`);
    }
    lines.push('');
  }
  lines.push(
    `${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped.`,
    report.level === 'none'
      ? 'This server does not satisfy QBLive Basic.'
      : `This server satisfies QBLive ${report.level === 'realtime' ? 'Realtime' : 'Basic'}.`,
    '',
  );
  return lines.join('\n');
}

export { QbliveValidationError };
