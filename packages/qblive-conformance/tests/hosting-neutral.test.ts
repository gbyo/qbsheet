/**
 * Hosting-neutral conformance: the suite tests observable behavior, not hosting.
 *
 * These run the suite against a minimal non-Cloudflare backend (plain Node
 * HTTP, in-memory state, no Durable Object, no Wrangler, no provider
 * headers) and against a local-only shaped server, proving the suite is
 * runnable outside Cloudflare and that capability-scoped mode does not
 * pretend local mode is a full remote backend.
 */

import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import snapshotFixture from '@qbsheet/qblive-protocol/fixtures/snapshot-default.json';
import manifestFixture from '@qbsheet/qblive-protocol/fixtures/manifest.json';
import { runConformance } from '../src/suite.js';
import { randomPublicationId, setupBackend } from '../src/setup.js';

const here = dirname(fileURLToPath(import.meta.url));
const suiteSource = readFileSync(resolve(here, '..', 'src', 'suite.ts'), 'utf8');
const setupSource = readFileSync(resolve(here, '..', 'src', 'setup.ts'), 'utf8');

let running: Server[] = [];

afterEach(async () => {
  await Promise.all(
    running.map((server) => new Promise<void>((resolveClose) => server.close(() => resolveClose()))),
  );
  running = [];
});

async function listen(
  handler: (
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
  ) => void,
): Promise<string> {
  const server = createServer(handler);
  running.push(server);
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('no address');
  return `http://127.0.0.1:${address.port}`;
}

function send(
  response: import('node:http').ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): void {
  response.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    ...extra,
  });
  response.end(JSON.stringify(body));
}

function readBody(request: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    let text = '';
    request.on('data', (chunk) => {
      text += chunk;
      if (text.length > 9 * 1024 * 1024 + 1024) {
        // Stop early on an oversized body; the handler answers 413.
        request.destroy();
        resolveBody(text);
      }
    });
    request.on('end', () => resolveBody(text));
    request.on('error', rejectBody);
  });
}

/** A minimal full QBLive backend with no Cloudflare dependency. */
async function serveFull(options: { setupToken?: string; stream?: boolean } = {}): Promise<{
  origin: string;
  publicationId: string;
}> {
  const publicationId = 'bcdfghjkmnpqrstvwxyz';
  const setupToken = options.setupToken ?? 'test-setup';
  let claimedToken: string | null = null;
  let revision = 0;
  let snapshot: Record<string, unknown> | null = null;
  const events: { revision: number; generatedAt: string; sections: unknown }[] = [];

  const origin = await listen(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    const path = url.pathname;
    const method = request.method ?? 'GET';

    if (method === 'POST' && path === '/qblive/v1/manage/claim') {
      const body = JSON.parse((await readBody(request)) || '{}') as {
        setupToken?: string;
        publicationId?: string;
      };
      if (claimedToken) {
        send(response, 403, { error: 'forbidden', message: 'already claimed' });
        return;
      }
      if (body.setupToken !== setupToken) {
        send(response, 401, { error: 'unauthorized', message: 'bad setup token' });
        return;
      }
      claimedToken = 'a'.repeat(64);
      send(response, 200, { publicationId: body.publicationId, managementToken: claimedToken, origin: '' });
      return;
    }

    const manageSnapshot = `/qblive/v1/manage/tournaments/${publicationId}/snapshot`;
    const manageSections = `/qblive/v1/manage/tournaments/${publicationId}/sections`;
    if (path === manageSnapshot || path === manageSections) {
      const auth = request.headers.authorization ?? '';
      if (auth !== `Bearer ${claimedToken}`) {
        send(response, 401, { error: 'unauthorized', message: 'bad credential' });
        return;
      }
      const text = await readBody(request);
      if (text.length > 8 * 1024 * 1024) {
        send(response, 413, { error: 'payload-too-large', message: 'too large' });
        return;
      }
      const body = JSON.parse(text || '{}') as Record<string, unknown>;
      if (path === manageSnapshot) {
        const next = (body.snapshot ?? body) as Record<string, unknown>;
        const nextRevision = next.revision as number;
        if (typeof nextRevision !== 'number' || nextRevision <= revision) {
          send(response, 409, { error: 'conflict', message: 'stale', currentRevision: revision });
          return;
        }
        revision = nextRevision;
        snapshot = { ...(snapshotFixture as Record<string, unknown>), ...next, publicationId };
        events.push({ revision, generatedAt: new Date().toISOString(), sections: {} });
        send(response, 200, { publicationId, revision, final: false });
        return;
      }
      const baseRevision = body.baseRevision as number;
      const nextRevision = body.revision as number;
      const sections = body.sections as Record<string, unknown>;
      if (typeof baseRevision !== 'number' || typeof nextRevision !== 'number') {
        send(response, 400, { error: 'bad-request', message: 'revisions required' });
        return;
      }
      if (nextRevision <= revision || baseRevision !== revision) {
        send(response, 409, { error: 'conflict', message: 'stale', currentRevision: revision });
        return;
      }
      const teams = (sections as Record<string, unknown>)?.teams as unknown[];
      if (Array.isArray(teams) && teams.some((team) => !(team as Record<string, unknown>)?.name)) {
        send(response, 400, { error: 'bad-request', message: 'malformed team' });
        return;
      }
      if (!sections || Object.keys(sections).length === 0) {
        send(response, 400, { error: 'bad-request', message: 'no sections' });
        return;
      }
      revision = nextRevision;
      events.push({ revision, generatedAt: new Date().toISOString(), sections });
      send(response, 200, { publicationId, revision, final: false });
      return;
    }

    if (method !== 'GET') {
      send(response, 405, { error: 'not-found', message: 'read-only' });
      return;
    }
    if (!path.includes(publicationId)) {
      send(response, 404, { error: 'not-found', message: 'No such tournament.' });
      return;
    }
    if (!claimedToken || !snapshot) {
      send(response, 404, { error: 'not-found', message: 'not published yet' });
      return;
    }
    if (path.includes('/manifest')) {
      send(
        response,
        200,
        {
          ...manifestFixture,
          publicationId,
          revision,
          capabilities: { snapshot: true, events: true, stream: options.stream ?? false, applePush: false },
        },
        { 'cache-control': 'no-cache' },
      );
      return;
    }
    if (path.includes('/snapshot')) {
      send(
        response,
        200,
        { ...snapshot, revision, publicationId },
        { 'cache-control': 'no-cache', etag: `"${revision}"` },
      );
      return;
    }
    if (path.includes('/events')) {
      const afterRaw = url.searchParams.get('after') ?? '0';
      if (!/^\d{1,32}$/.test(afterRaw)) {
        send(response, 400, { error: 'bad-request', message: 'bad cursor' });
        return;
      }
      const after = Number(afterRaw);
      const filtered = events.filter((event) => event.revision > after);
      send(
        response,
        200,
        {
          protocolVersion: 1,
          publicationId,
          currentRevision: revision,
          events: filtered,
          resyncRequired: false,
        },
        { 'cache-control': 'no-cache' },
      );
      return;
    }
    send(response, 404, { error: 'not-found', message: 'No such QBLive route.' });
  });
  return { origin, publicationId };
}

/** A local-only shaped server: public reads, no stream, no management API. */
async function serveLocal(): Promise<{ origin: string; publicationId: string }> {
  const publicationId = 'bcdfghjkmnpqrstvwxyz';
  const origin = await listen((request, response) => {
    const path = request.url ?? '';
    if (request.method !== 'GET') {
      send(response, 404, { error: 'not-found', message: 'no management here' });
      return;
    }
    if (!path.includes(publicationId)) {
      send(response, 404, { error: 'not-found', message: 'No such tournament.' });
      return;
    }
    if (path.includes('/manifest')) {
      send(
        response,
        200,
        {
          ...manifestFixture,
          publicationId,
          capabilities: { snapshot: true, events: true, stream: false, applePush: false },
        },
        { 'cache-control': 'no-cache' },
      );
      return;
    }
    if (path.includes('/snapshot')) {
      send(response, 200, snapshotFixture, { 'cache-control': 'no-cache' });
      return;
    }
    if (path.includes('/events')) {
      const url = new URL(path, 'http://x');
      const afterRaw = url.searchParams.get('after') ?? '0';
      if (!/^\d{1,32}$/.test(afterRaw)) {
        send(response, 400, { error: 'bad-request', message: 'bad cursor' });
        return;
      }
      send(
        response,
        200,
        { protocolVersion: 1, publicationId, currentRevision: 41, events: [], resyncRequired: false },
        { 'cache-control': 'no-cache' },
      );
      return;
    }
    send(response, 404, { error: 'not-found', message: 'No such QBLive route.' });
  });
  return { origin, publicationId };
}

describe('the standard setup/claim hook', () => {
  test('claims a fresh backend and publishes the first snapshot', async () => {
    const { origin, publicationId } = await serveFull({ setupToken: 'test-setup' });
    const snapshot = {
      ...(snapshotFixture as Record<string, unknown>),
      publicationId,
      revision: 1,
    };
    const setup = await setupBackend({
      origin,
      setupToken: 'test-setup',
      publicationId,
      initialSnapshot: snapshot,
    });
    expect(setup.managementToken).toMatch(/^[0-9a-f]{64}$/);

    const report = await runConformance({
      origin,
      publicationId,
      managementToken: setup.managementToken,
    });
    expect(report.failed).toBe(0);
  });

  test('a second claim fails even with the right token', async () => {
    const { origin, publicationId } = await serveFull({ setupToken: 'test-setup' });
    await setupBackend({ origin, setupToken: 'test-setup', publicationId });
    await expect(setupBackend({ origin, setupToken: 'test-setup', publicationId })).rejects.toThrow(
      /403|already|claim/i,
    );
  });

  test('a wrong setup token does not claim', async () => {
    const { origin, publicationId } = await serveFull({ setupToken: 'test-setup' });
    await expect(setupBackend({ origin, setupToken: 'wrong', publicationId })).rejects.toThrow(/401|claim/i);
  });

  test('random publication ids are valid', () => {
    for (let index = 0; index < 25; index += 1) {
      expect(randomPublicationId()).toMatch(/^[0-9bcdfghjkmnpqrstvwxyz]{20}$/);
    }
  });
});

describe('a non-Cloudflare backend', () => {
  test('passes the suite with no provider affordance', async () => {
    const { origin, publicationId } = await serveFull();
    await setupBackend({
      origin,
      setupToken: 'test-setup',
      publicationId,
      initialSnapshot: { ...(snapshotFixture as Record<string, unknown>), publicationId, revision: 1 },
    });
    const report = await runConformance({ origin, publicationId });
    // Without a management token the write checks skip; the public surface
    // still passes on a host with no Cloudflare code anywhere.
    expect(report.results.find((result) => result.id === 'manifest')?.outcome).toBe('pass');
    expect(report.results.find((result) => result.id === 'hosting-neutral')?.outcome).toBe('pass');
    expect(report.results.find((result) => result.id === 'invalid-id')?.outcome).toBe('pass');
    expect(report.results.find((result) => result.id === 'endpoints')?.outcome).toBe('pass');
  });
});

describe('capability-scoped local mode', () => {
  test('a local-only server passes with profile local', async () => {
    const { origin, publicationId } = await serveLocal();
    const report = await runConformance({ origin, publicationId, profile: 'local' });
    expect(report.failed).toBe(0);
    expect(report.results.find((result) => result.id === 'profile')?.outcome).toBe('pass');
    expect(report.results.find((result) => result.id === 'auth-required')?.detail).toContain(
      'no management API here',
    );
  });
});

describe('hosting neutrality is structural, not promised', () => {
  test('the suite imports no provider module', () => {
    // Prose may name providers; code must not import them. A protocol type
    // importing `cloudflare:workers` is the boundary violation (see #776).
    for (const source of [suiteSource, setupSource]) {
      expect(source).not.toMatch(/from\s+['"]cloudflare:/i);
      expect(source).not.toMatch(/require\(\s*['"]cloudflare:/i);
      expect(source).not.toMatch(/from\s+['"]wrangler/i);
      expect(source).not.toMatch(/require\(\s*['"]wrangler/i);
      const providerImports = source
        .split('\n')
        .filter((line) => /^\s*import\b/.test(line) && /cloudflare|wrangler|durable/i.test(line));
      expect(providerImports).toEqual([]);
    }
  });
});
