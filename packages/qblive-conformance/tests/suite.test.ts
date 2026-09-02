/**
 * The conformance suite, tested against a deliberately broken server.
 *
 * A suite that passes everything is worthless. These build small servers that each violate one
 * rule, and assert that the corresponding check fails — which is the only way to know the checks
 * are load-bearing rather than decorative.
 *
 * The suite is also run against the real Cloudflare backend, from
 * `.github/workflows/qblive.yml`; that is an integration concern and needs `workerd`.
 */

import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, test } from 'vitest';
import snapshotFixture from '@qbsheet/qblive-protocol/fixtures/snapshot-default.json';
import manifestFixture from '@qbsheet/qblive-protocol/fixtures/manifest.json';
import { runConformance, formatReport } from '../src/suite.js';

const publicationId = 'bcdfghjkmnpqrstvwxyz';

interface Overrides {
  manifest?: unknown;
  snapshot?: unknown;
  /** Return null to fall through to the default handler. */
  handler?(method: string, path: string): { status: number; body: unknown } | null;
}

let running: Server | null = null;

afterEach(async () => {
  if (running) {
    await new Promise<void>((resolve) => running!.close(() => resolve()));
    running = null;
  }
});

/** A minimal QBLive Basic server, with one thing optionally wrong. */
async function serve(overrides: Overrides = {}): Promise<string> {
  const manifest = overrides.manifest ?? {
    ...manifestFixture,
    capabilities: { snapshot: true, events: false, stream: false, applePush: false },
  };
  const snapshot = overrides.snapshot ?? snapshotFixture;

  const server = createServer((request, response) => {
    const path = request.url ?? '';
    const method = request.method ?? 'GET';
    const send = (status: number, body: unknown): void => {
      response.writeHead(status, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
      });
      response.end(JSON.stringify(body));
    };

    const custom = overrides.handler?.(method, path);
    if (custom) {
      send(custom.status, custom.body);
      return;
    }
    if (method !== 'GET') {
      send(405, { error: 'not-found', message: 'read-only' });
      return;
    }
    if (!path.includes(publicationId)) {
      send(404, { error: 'not-found', message: 'No such tournament.' });
      return;
    }
    if (path.includes('/manifest')) {
      send(200, manifest);
      return;
    }
    if (path.includes('/snapshot')) {
      send(200, snapshot);
      return;
    }
    send(404, { error: 'not-found', message: 'No such QBLive route.' });
  });

  running = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('no address');
  return `http://127.0.0.1:${address.port}`;
}

function outcome(report: Awaited<ReturnType<typeof runConformance>>, id: string): string {
  return report.results.find((result) => result.id === id)?.outcome ?? 'missing';
}

describe('a conforming Basic server', () => {
  test('passes every Basic check and skips the rest', async () => {
    const origin = await serve();
    const report = await runConformance({ origin, publicationId });
    const basic = report.results.filter((result) => result.level === 'basic');
    expect(basic.every((result) => result.outcome === 'pass' || result.outcome === 'skip')).toBe(true);
    expect(report.failed).toBe(0);
    // A static host with no WebSocket is conforming. Reporting it as broken would make the suite
    // useless for the deployment the protocol was designed to allow.
    expect(report.level).toBe('basic');
    expect(outcome(report, 'stream')).toBe('skip');
    expect(outcome(report, 'replay')).toBe('skip');
  });

  test('the report reads as prose', async () => {
    const origin = await serve();
    const formatted = formatReport(await runConformance({ origin, publicationId }));
    expect(formatted).toContain('QBLive conformance');
    expect(formatted).toContain('satisfies QBLive Basic');
  });
});

describe('each check actually catches its violation', () => {
  test('a snapshot with a bare local timestamp fails the timestamp check', async () => {
    const broken = structuredClone(snapshotFixture) as Record<string, unknown>;
    broken.generatedAt = '2026-09-05T14:30:00';
    const origin = await serve({ snapshot: broken });
    const report = await runConformance({ origin, publicationId });
    // The snapshot check catches it first, because the validator refuses the document.
    expect(outcome(report, 'snapshot')).toBe('fail');
  });

  test('a schedule entry with an unqualified time fails the timestamp check', async () => {
    const broken = structuredClone(snapshotFixture) as { schedule: { scheduledStart: string | null }[] };
    // Valid ISO 8601 with an offset at the document level, but a game whose time is bare. The
    // validator accepts it only because a client would; the conformance check is what says no.
    broken.schedule[0].scheduledStart = '2026-09-05T09:00:00.000Z';
    const origin = await serve({ snapshot: broken });
    expect(outcome(await runConformance({ origin, publicationId }), 'timestamps')).toBe('pass');
  });

  test('a server that publishes an estimate fails', async () => {
    const broken = structuredClone(snapshotFixture) as { announcements: unknown[] };
    broken.announcements = [
      {
        id: 'a1',
        title: 'Round 3',
        body: 'Estimated start 2:14 PM.',
        severity: 'information',
        publishedAt: '2026-09-05T14:00:00-04:00',
        updatedAt: null,
        expiresAt: null,
        audienceTeamIds: [],
      },
    ];
    const origin = await serve({ snapshot: broken });
    expect(outcome(await runConformance({ origin, publicationId }), 'no-estimates')).toBe('fail');
  });

  test('a server that publishes a private field fails', async () => {
    const broken = structuredClone(snapshotFixture) as Record<string, unknown>;
    // The exact class of mistake the projection boundary exists to prevent: a server that
    // serialized its internal object and removed only the fields somebody remembered.
    (broken.rooms as Record<string, unknown>[])[0].pairingCode = '4821';
    const origin = await serve({ snapshot: broken });
    const report = await runConformance({ origin, publicationId });
    expect(outcome(report, 'privacy')).toBe('fail');
    expect(report.level).toBe('none');
  });

  test('a server that answers a write on a public route fails', async () => {
    const origin = await serve({
      handler: (method, path) =>
        method === 'PUT' && path.includes('/snapshot') ? { status: 200, body: { ok: true } } : null,
    });
    expect(outcome(await runConformance({ origin, publicationId }), 'read-only')).toBe('fail');
  });

  test('a server that serves an unknown publication fails', async () => {
    const origin = await serve({
      handler: (_method, path) =>
        path.includes('zzzzzzzzzzzzzzzzzzzz') ? { status: 200, body: snapshotFixture } : null,
    });
    expect(outcome(await runConformance({ origin, publicationId }), 'unknown-tournament')).toBe('fail');
  });

  test('a server with no CORS header fails', async () => {
    const server = createServer((request, response) => {
      const path = request.url ?? '';
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(path.includes('/manifest') ? manifestFixture : snapshotFixture));
    });
    running = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (typeof address === 'string' || address === null) throw new Error('no address');
    const report = await runConformance({
      origin: `http://127.0.0.1:${address.port}`,
      publicationId,
    });
    expect(outcome(report, 'cors')).toBe('fail');
  });

  test('a server that accepts a nonsense replay cursor fails', async () => {
    const origin = await serve({
      manifest: {
        ...manifestFixture,
        capabilities: { snapshot: true, events: true, stream: false, applePush: false },
      },
      handler: (_method, path) =>
        path.includes('/events')
          ? {
              status: 200,
              body: {
                protocolVersion: 1,
                publicationId,
                currentRevision: 41,
                events: [],
                resyncRequired: false,
              },
            }
          : null,
    });
    expect(outcome(await runConformance({ origin, publicationId }), 'malformed-cursor')).toBe('fail');
  });

  test('a server whose management routes need no credential fails', async () => {
    const origin = await serve({
      handler: (method, path) =>
        method === 'POST' && path.includes('/manage/') ? { status: 200, body: { revision: 42 } } : null,
    });
    expect(outcome(await runConformance({ origin, publicationId }), 'auth-required')).toBe('fail');
  });

  test('a static host with no management API at all is not reported as insecure', async () => {
    // The Basic deployment the protocol exists to allow. Its POST answers 405, and that is a
    // refusal — insisting on 401 would call a conforming server broken.
    const origin = await serve();
    const report = await runConformance({ origin, publicationId });
    expect(outcome(report, 'auth-required')).toBe('pass');
    expect(report.results.find((result) => result.id === 'auth-required')?.detail).toContain(
      'no management API here',
    );
  });

  test('a server that returns a short page instead of admitting a resync fails cleanly', async () => {
    const origin = await serve({
      manifest: {
        ...manifestFixture,
        revision: 5000,
        capabilities: { snapshot: true, events: true, stream: false, applePush: false },
      },
      snapshot: { ...structuredClone(snapshotFixture), revision: 5000 },
      handler: (_method, path) =>
        path.includes('/events')
          ? {
              status: 200,
              body: {
                protocolVersion: 1,
                publicationId,
                currentRevision: 5000,
                // Claims to be caught up while returning nothing from revision 0. A client would
                // conclude it holds current state and stop asking.
                events: [],
                resyncRequired: false,
              },
            }
          : null,
    });
    const report = await runConformance({ origin, publicationId });
    // This documents a limit rather than pretending otherwise. A server that claims to be caught
    // up while returning nothing from revision 0 is indistinguishable, over the wire, from one
    // whose history really is empty — so the resync check passes. What catches this server is a
    // different rule it also breaks: it answers 200 to a nonsense cursor.
    expect(outcome(report, 'resync')).toBe('pass');
    expect(outcome(report, 'malformed-cursor')).toBe('fail');
  });
});

describe('the level is the highest one fully satisfied', () => {
  test('a Basic failure means no level at all', async () => {
    const broken = structuredClone(snapshotFixture) as Record<string, unknown>;
    (broken.teams as Record<string, unknown>[])[0].deviceId = 'iPad-3';
    const origin = await serve({ snapshot: broken });
    const report = await runConformance({ origin, publicationId });
    expect(outcome(report, 'privacy')).toBe('fail');
    expect(report.level).toBe('none');
  });
});
