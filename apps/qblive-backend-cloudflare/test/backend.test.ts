/**
 * The QBLive Cloudflare backend, exercised inside the real Workers runtime.
 *
 * These are the behaviours a spectator's phone and a Director's publication worker actually depend
 * on: revisions that only move forward, conflicts that report where the server really is, replay
 * that admits when it cannot help, and a public surface that refuses to be written to.
 */

import { env, SELF, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import snapshotFixture from '../../../packages/qblive-protocol/fixtures/snapshot-default.json';
import type { QbliveSnapshot } from '../src/protocol/types';

const publicationId = 'bcdfghjkmnpqrstvwxyz';
const base = `https://backend.example/qblive/v1`;
const publicBase = `${base}/tournaments/${publicationId}`;
const manageBase = `${base}/manage/tournaments/${publicationId}`;

function snapshotAt(revision: number, overrides: Partial<QbliveSnapshot> = {}): QbliveSnapshot {
  return {
    ...(structuredClone(snapshotFixture) as unknown as QbliveSnapshot),
    publicationId,
    revision,
    ...overrides,
  };
}

async function claim(): Promise<string> {
  const response = await SELF.fetch(`${base}/manage/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ setupToken: 'test-setup-token', publicationId }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { managementToken: string };
  return body.managementToken;
}

function authorized(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function publishSnapshot(token: string, revision: number, overrides: Partial<QbliveSnapshot> = {}) {
  return SELF.fetch(`${manageBase}/snapshot`, {
    method: 'PUT',
    headers: authorized(token),
    body: JSON.stringify({ snapshot: snapshotAt(revision, overrides) }),
  });
}

/**
 * Each test gets a fresh publication.
 *
 * The Durable Object is keyed by publication id, so "fresh" means wiping its storage rather than
 * using a new id — using a new id per test would leave the previous objects alive and make the
 * claim-once test meaningless.
 */
beforeEach(async () => {
  const stub = env.QBLIVE_PUBLICATION.get(env.QBLIVE_PUBLICATION.idFromName(publicationId));
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.deleteAll();
    for (const socket of state.getWebSockets()) socket.close(1000, 'test reset');
  });
});

describe('claiming a freshly deployed backend', () => {
  it('exchanges the setup token for a management credential exactly once', async () => {
    const token = await claim();
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const second = await SELF.fetch(`${base}/manage/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ setupToken: 'test-setup-token', publicationId }),
    });
    expect(second.status).toBe(403);
    expect(await second.json()).toMatchObject({ error: 'forbidden' });
  });

  it('refuses a wrong setup token', async () => {
    const response = await SELF.fetch(`${base}/manage/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ setupToken: 'wrong', publicationId }),
    });
    expect(response.status).toBe(401);
  });
});

describe('publishing', () => {
  it('serves a manifest and a snapshot after the first publish', async () => {
    const token = await claim();
    expect((await publishSnapshot(token, 1)).status).toBe(200);

    const manifest = await SELF.fetch(`${publicBase}/manifest`);
    expect(manifest.status).toBe(200);
    expect(await manifest.json()).toMatchObject({
      protocolVersion: 1,
      publicationId,
      revision: 1,
      final: false,
      capabilities: { snapshot: true, events: true, stream: true },
    });

    const snapshot = await SELF.fetch(`${publicBase}/snapshot`);
    expect(snapshot.status).toBe(200);
    expect(snapshot.headers.get('access-control-allow-origin')).toBe('*');
    const body = (await snapshot.json()) as QbliveSnapshot;
    expect(body.revision).toBe(1);
    expect(body.teams.length).toBeGreaterThan(0);
  });

  it('404s before anything has been published', async () => {
    await claim();
    expect((await SELF.fetch(`${publicBase}/snapshot`)).status).toBe(404);
  });

  it('advances by replacing named sections', async () => {
    const token = await claim();
    await publishSnapshot(token, 1);

    const response = await SELF.fetch(`${manageBase}/sections`, {
      method: 'POST',
      headers: authorized(token),
      body: JSON.stringify({
        baseRevision: 1,
        revision: 2,
        generatedAt: '2026-09-05T14:31:00.000Z',
        sections: { liveGames: [{ gameId: 'g', roundId: 'r', teamIds: ['team-a', 'team-b'], roomId: null }] },
      }),
    });
    expect(response.status).toBe(200);

    const snapshot = (await (await SELF.fetch(`${publicBase}/snapshot`)).json()) as QbliveSnapshot;
    expect(snapshot.revision).toBe(2);
    expect(snapshot.liveGames).toHaveLength(1);
    // Untouched sections survive a section update.
    expect(snapshot.teams.length).toBeGreaterThan(0);
  });

  it('reports its own revision when the publisher is out of date', async () => {
    const token = await claim();
    await publishSnapshot(token, 1);
    await publishSnapshot(token, 5);

    const response = await SELF.fetch(`${manageBase}/sections`, {
      method: 'POST',
      headers: authorized(token),
      body: JSON.stringify({
        baseRevision: 1,
        revision: 2,
        generatedAt: '2026-09-05T14:31:00.000Z',
        sections: { liveGames: [] },
      }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'conflict', currentRevision: 5 });
  });

  it('lets a full snapshot repair a conflict when the revision is newer', async () => {
    const token = await claim();
    await publishSnapshot(token, 5);
    expect((await publishSnapshot(token, 6)).status).toBe(200);
    const snapshot = (await (await SELF.fetch(`${publicBase}/snapshot`)).json()) as QbliveSnapshot;
    expect(snapshot.revision).toBe(6);
  });

  it('rejects a stale snapshot whose revision is older than the current one', async () => {
    const token = await claim();
    await publishSnapshot(token, 5);
    const response = await publishSnapshot(token, 3);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'conflict', currentRevision: 5 });
    const snapshot = (await (await SELF.fetch(`${publicBase}/snapshot`)).json()) as QbliveSnapshot;
    expect(snapshot.revision).toBe(5);
  });

  it('rejects a snapshot whose revision equals the current one', async () => {
    const token = await claim();
    await publishSnapshot(token, 5);
    const response = await publishSnapshot(token, 5);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'conflict', currentRevision: 5 });
    const snapshot = (await (await SELF.fetch(`${publicBase}/snapshot`)).json()) as QbliveSnapshot;
    expect(snapshot.revision).toBe(5);
  });

  it('rejects a malformed section update', async () => {
    const token = await claim();
    await publishSnapshot(token, 1);
    const response = await SELF.fetch(`${manageBase}/sections`, {
      method: 'POST',
      headers: authorized(token),
      body: JSON.stringify({
        baseRevision: 1,
        revision: 2,
        generatedAt: '2026-09-05T14:31:00.000Z',
        sections: { teams: [{ id: 'x' }] },
      }),
    });
    expect(response.status).toBe(400);
  });

  it('rejects an oversized body', async () => {
    const token = await claim();
    const response = await SELF.fetch(`${manageBase}/sections`, {
      method: 'POST',
      headers: { ...authorized(token), 'content-length': String(64 * 1024 * 1024) },
      body: JSON.stringify({
        baseRevision: 0,
        revision: 1,
        generatedAt: '2026-09-05T14:31:00.000Z',
        sections: {},
      }),
    });
    expect(response.status).toBe(413);
  });
});

describe('authentication', () => {
  it('refuses management routes with no credential', async () => {
    await claim();
    const response = await SELF.fetch(`${manageBase}/snapshot`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ snapshot: snapshotAt(1) }),
    });
    expect(response.status).toBe(401);
  });

  it('refuses management routes with the wrong credential', async () => {
    await claim();
    const response = await publishSnapshot('0'.repeat(64), 1);
    expect(response.status).toBe(401);
  });

  it('does not accept a management credential on a public route', async () => {
    const token = await claim();
    await publishSnapshot(token, 1);
    // A public GET with a credential is still just a public GET: it must not gain any power.
    const response = await SELF.fetch(`${publicBase}/snapshot`, { headers: authorized(token) });
    expect(response.status).toBe(200);
    // A write to a public route is refused as a method error, not silently answered like a read.
    const write = await SELF.fetch(`${publicBase}/snapshot`, { method: 'PUT', headers: authorized(token) });
    expect(write.status).toBe(405);
    const stillOne = (await (await SELF.fetch(`${publicBase}/snapshot`)).json()) as QbliveSnapshot;
    expect(stillOne.revision).toBe(1);
  });
});

describe('replay', () => {
  it('returns the events after a revision', async () => {
    const token = await claim();
    await publishSnapshot(token, 1);
    for (let revision = 2; revision <= 4; revision += 1) {
      await SELF.fetch(`${manageBase}/sections`, {
        method: 'POST',
        headers: authorized(token),
        body: JSON.stringify({
          baseRevision: revision - 1,
          revision,
          generatedAt: '2026-09-05T14:31:00.000Z',
          sections: { liveGames: [] },
        }),
      });
    }
    const response = await SELF.fetch(`${publicBase}/events?after=1`);
    const body = (await response.json()) as {
      events: { revision: number }[];
      currentRevision: number;
      resyncRequired: boolean;
    };
    expect(body.currentRevision).toBe(4);
    expect(body.resyncRequired).toBe(false);
    expect(body.events.map((event) => event.revision)).toEqual([2, 3, 4]);
  });

  it('says a resync is required rather than returning a page that looks complete', async () => {
    const token = await claim();
    // A snapshot published at revision 900 leaves nothing to replay from revision 1.
    await publishSnapshot(token, 900);
    const body = (await (await SELF.fetch(`${publicBase}/events?after=1`)).json()) as {
      resyncRequired: boolean;
      events: unknown[];
    };
    expect(body.resyncRequired).toBe(true);
    expect(body.events).toEqual([]);
  });

  it('rejects a nonsense cursor', async () => {
    await claim();
    expect((await SELF.fetch(`${publicBase}/events?after=-1`)).status).toBe(400);
    expect((await SELF.fetch(`${publicBase}/events?after=abc`)).status).toBe(400);
  });
});

describe('the WebSocket stream', () => {
  it('greets with the current revision and pushes events', async () => {
    const token = await claim();
    await publishSnapshot(token, 1);

    const response = await SELF.fetch(`${publicBase}/stream`, { headers: { upgrade: 'websocket' } });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    const frames: unknown[] = [];
    socket.accept();
    socket.addEventListener('message', (event) => frames.push(JSON.parse(String(event.data))));

    await vi.waitFor(() => expect(frames).toHaveLength(1));
    expect(frames[0]).toMatchObject({ type: 'hello', revision: 1, publicationId });

    await SELF.fetch(`${manageBase}/sections`, {
      method: 'POST',
      headers: authorized(token),
      body: JSON.stringify({
        baseRevision: 1,
        revision: 2,
        generatedAt: '2026-09-05T14:31:00.000Z',
        sections: { liveGames: [] },
      }),
    });

    await vi.waitFor(() => expect(frames).toHaveLength(2));
    expect(frames[1]).toMatchObject({ type: 'event', event: { revision: 2 } });
    socket.close();
  });

  it('cannot be used to change published state', async () => {
    const token = await claim();
    await publishSnapshot(token, 1);
    const response = await SELF.fetch(`${publicBase}/stream`, { headers: { upgrade: 'websocket' } });
    const socket = response.webSocket!;
    const frames: { type: string }[] = [];
    socket.accept();
    socket.addEventListener('message', (event) => frames.push(JSON.parse(String(event.data))));
    await vi.waitFor(() => expect(frames).toHaveLength(1));

    socket.send(JSON.stringify({ type: 'event', event: { revision: 99, generatedAt: 'x', sections: {} } }));
    await vi.waitFor(() => expect(frames).toHaveLength(2));
    expect(frames[1]).toMatchObject({ type: 'resync', currentRevision: 1 });

    const snapshot = (await (await SELF.fetch(`${publicBase}/snapshot`)).json()) as QbliveSnapshot;
    expect(snapshot.revision).toBe(1);
    socket.close();
  });

  it('refuses a stream request that is not a WebSocket upgrade', async () => {
    const token = await claim();
    await publishSnapshot(token, 1);
    expect((await SELF.fetch(`${publicBase}/stream`)).status).toBe(400);
  });
});

describe('lifecycle', () => {
  it('finalizes and keeps serving the final state', async () => {
    const token = await claim();
    await publishSnapshot(token, 1);
    const response = await SELF.fetch(`${manageBase}/finalize`, {
      method: 'POST',
      headers: authorized(token),
      body: JSON.stringify({ revision: 2, snapshot: snapshotAt(2, { final: true }) }),
    });
    expect(response.status).toBe(200);

    const manifest = (await (await SELF.fetch(`${publicBase}/manifest`)).json()) as { final: boolean };
    expect(manifest.final).toBe(true);
    // A finalized tournament stays publicly readable: that page is the tournament's record.
    expect((await SELF.fetch(`${publicBase}/snapshot`)).status).toBe(200);
  });

  it('refuses further section updates once final', async () => {
    const token = await claim();
    await publishSnapshot(token, 1);
    await SELF.fetch(`${manageBase}/finalize`, {
      method: 'POST',
      headers: authorized(token),
      body: JSON.stringify({ revision: 2, snapshot: snapshotAt(2, { final: true }) }),
    });
    const response = await SELF.fetch(`${manageBase}/sections`, {
      method: 'POST',
      headers: authorized(token),
      body: JSON.stringify({
        baseRevision: 2,
        revision: 3,
        generatedAt: '2026-09-05T14:31:00.000Z',
        sections: { liveGames: [] },
      }),
    });
    expect(response.status).toBe(409);
  });

  it('unpublishes to 410 and keeps the credential valid', async () => {
    const token = await claim();
    await publishSnapshot(token, 1);
    expect(
      (await SELF.fetch(`${manageBase}/unpublish`, { method: 'POST', headers: authorized(token) })).status,
    ).toBe(200);
    expect((await SELF.fetch(`${publicBase}/snapshot`)).status).toBe(410);
    expect((await SELF.fetch(`${publicBase}/manifest`)).status).toBe(410);
    // Recoverable: the same credential can publish again.
    expect((await publishSnapshot(token, 2)).status).toBe(200);
    expect((await SELF.fetch(`${publicBase}/snapshot`)).status).toBe(200);
  });

  it('deletes to 404 and revokes the credential', async () => {
    const token = await claim();
    await publishSnapshot(token, 1);
    expect((await SELF.fetch(manageBase, { method: 'DELETE', headers: authorized(token) })).status).toBe(200);
    expect((await SELF.fetch(`${publicBase}/snapshot`)).status).toBe(404);
    expect((await publishSnapshot(token, 2)).status).toBe(404);
  });
});

describe('routing', () => {
  it('refuses a publication id that is not a publication id', async () => {
    // Otherwise an arbitrary string would name an arbitrary new Durable Object in the TD's account.
    for (const id of ['../etc', 'a'.repeat(200), 'AAAA', 'aeiou']) {
      const response = await SELF.fetch(`${base}/tournaments/${encodeURIComponent(id)}/snapshot`);
      expect(response.status).toBe(404);
    }
  });

  it('answers CORS preflight', async () => {
    const response = await SELF.fetch(`${manageBase}/sections`, { method: 'OPTIONS' });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-headers')).toContain('authorization');
  });

  it('does not disclose which tournaments exist at the root', async () => {
    const response = await SELF.fetch('https://backend.example/health');
    expect(await response.json()).toEqual({ service: 'qblive', protocolVersion: 1 });
  });
});
