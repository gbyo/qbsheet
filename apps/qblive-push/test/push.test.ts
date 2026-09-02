/**
 * The push gateway, in real `workerd`.
 *
 * What is tested for real: publisher authorization, the channel budget, lazy channel creation,
 * deduplication, coalescing, device registration and audience routing, payload construction, and
 * every bound.
 *
 * What cannot be: APNs itself. Apple advertises only `h2` in ALPN and drops HTTP/1.1, and local
 * `workerd` makes outbound subrequests over HTTP/1.1 — a documented local-only limitation
 * (cloudflare/workerd#4841). See `docs/QBLIVE_PUSH_PROTOTYPE.md`. So the channel manager is driven
 * through an injected `fetch`, and the tests below assert on what the gateway *decides*, which is
 * the part that has interesting behaviour.
 */

import { env, SELF, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { shardStateHash } from '../src/publication';
import { allowedShards, ApnsChannelManager, ChannelError, ExternalChannelManager } from '../src/channels';
import {
  broadcastPayload,
  BROADCAST_PAYLOAD_LIMIT,
  isRetryable,
  payloadBytes,
  tokenIsDead,
} from '../src/apns';
import { pushLimits, type ShardState } from '../src/types';

const publicationId = 'bcdfghjkmnpqrstvwxyz';
const origin = 'https://push.qbsheet.com';

function shardState(revision: number, score = 180): ShardState {
  return {
    r: revision,
    t: [
      { i: 0, m: 2, o: 1, s: score, x: 135, u: 13, rm: '104', rd: 2 },
      { i: 1, m: 2, o: 0, s: 135, x: score, u: 13, rm: '104', rd: 2 },
    ],
  };
}

/** Every test gets a fresh publication and a fresh budget. */
beforeEach(async () => {
  for (const name of [publicationId, '__budget__']) {
    const stub = env.PUSH_PUBLICATION.get(env.PUSH_PUBLICATION.idFromName(name));
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAll();
    });
  }
});

async function register(teamCount = 64, teamsPerShard = 16): Promise<string> {
  const response = await SELF.fetch(`${origin}/v1/publications`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ publicationId, teamCount, teamsPerShard }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { publisherToken: string };
  return body.publisherToken;
}

/** Give a shard a channel without going through Apple, which local workerd cannot reach. */
async function seedChannel(shard: number, channelId = `chan-${shard}`): Promise<void> {
  const stub = env.PUSH_PUBLICATION.get(env.PUSH_PUBLICATION.idFromName(publicationId));
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO channel (shard, channel_id, created_at, expires_at, last_hash, last_sent_at, last_revision)
       VALUES (?, ?, ?, ?, NULL, NULL, 0)
       ON CONFLICT(shard) DO UPDATE SET channel_id = excluded.channel_id`,
      shard,
      channelId,
      Date.now(),
      Date.now() + 3_600_000,
    );
  });
}

describe('health', () => {
  it('says whether push is configured without naming any tournament', async () => {
    const body = (await (await SELF.fetch(`${origin}/health`)).json()) as Record<string, unknown>;
    expect(body.service).toBe('qblive-push');
    expect(Object.keys(body).sort()).toEqual(['channelCeiling', 'configured', 'service']);
  });
});

describe('registration', () => {
  it('issues a publisher credential once', async () => {
    const token = await register();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const second = await SELF.fetch(`${origin}/v1/publications`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicationId, teamCount: 64, teamsPerShard: 16 }),
    });
    expect(second.status).toBe(409);
  });

  it('requires a team count, so channel allocation is bounded', async () => {
    const response = await SELF.fetch(`${origin}/v1/publications`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicationId }),
    });
    expect(response.status).toBe(400);
  });

  it('refuses a publication id that is not one', async () => {
    for (const id of ['AEIOU', 'short', '../../etc/passwd', 'a'.repeat(200)]) {
      const response = await SELF.fetch(`${origin}/v1/publications`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ publicationId: id, teamCount: 8 }),
      });
      expect(response.status, id).toBe(400);
    }
  });
});

describe('publisher authorization', () => {
  it('refuses an update with no credential', async () => {
    await register();
    const response = await SELF.fetch(`${origin}/v1/activity/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicationId, shard: 0, state: shardState(1) }),
    });
    expect(response.status).toBe(401);
  });

  it('refuses an update with the wrong credential', async () => {
    await register();
    const response = await SELF.fetch(`${origin}/v1/activity/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + '0'.repeat(64) },
      body: JSON.stringify({ publicationId, shard: 0, state: shardState(1) }),
    });
    expect(response.status).toBe(401);
  });

  it('refuses an update for a publication that was never registered', async () => {
    const response = await SELF.fetch(`${origin}/v1/activity/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
      body: JSON.stringify({ publicationId, shard: 0, state: shardState(1) }),
    });
    expect(response.status).toBe(404);
  });

  it('has no route that sends arbitrary APNs JSON', async () => {
    // The design rule: a publisher describes an intent, and the gateway builds the request. A
    // pass-through would be a way to send anything at all as QBSheet Live.
    for (const path of ['/v1/apns', '/apns', '/v1/send', '/v1/raw']) {
      const response = await SELF.fetch(`${origin}${path}`, { method: 'POST', body: '{}' });
      expect(response.status, path).toBe(404);
    }
  });
});

describe('channel allocation', () => {
  it('is bounded by the publication team count, not by what a caller asks for', async () => {
    await register(8, 16);
    // Eight teams and sixteen per shard is one shard. Shard 1 does not exist.
    const response = await SELF.fetch(`${origin}/v1/activity/channel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicationId, shard: 1 }),
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string; detail: string };
    expect(body.error).toBe('per-publication-limit');
    expect(body.detail).toContain('allows 1 shards');
  });

  it('refuses a negative shard', async () => {
    await register();
    const response = await SELF.fetch(`${origin}/v1/activity/channel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicationId, shard: -1 }),
    });
    expect(response.status).toBe(409);
  });

  it('reuses a channel rather than creating a second one for the same shard', async () => {
    await register();
    await seedChannel(0, 'chan-existing');
    const response = await SELF.fetch(`${origin}/v1/activity/channel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicationId, shard: 0 }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ channelId: 'chan-existing', reused: true });
  });

  it('reports exhaustion as a communicated degradation, not as a failure', async () => {
    await register();
    // Fill the global budget.
    const budget = env.PUSH_PUBLICATION.get(env.PUSH_PUBLICATION.idFromName('__budget__'));
    await runInDurableObject(budget, async (_instance, state) => {
      state.storage.sql.exec(
        'CREATE TABLE IF NOT EXISTS budget (id INTEGER PRIMARY KEY CHECK (id = 1), used INTEGER NOT NULL DEFAULT 0)',
      );
      state.storage.sql.exec(
        'INSERT INTO budget (id, used) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET used = ?',
        pushLimits.globalChannelCeiling,
        pushLimits.globalChannelCeiling,
      );
    });
    const response = await SELF.fetch(`${origin}/v1/activity/channel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicationId, shard: 0 }),
    });
    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe('budget-exhausted');
    // The sentence matters: only the Lock Screen degrades.
    expect(body.message).toContain('Everything else is working');
  });

  it('reports the budget as a number', async () => {
    const body = (await (await SELF.fetch(`${origin}/v1/budget`)).json()) as {
      used: number;
      ceiling: number;
    };
    expect(body.used).toBe(0);
    // Apple's documented ceiling is 10,000. QBSheet keeps a reserve.
    expect(body.ceiling).toBe(8000);
    expect(body.ceiling).toBeLessThan(10_000);
  });

  it('derives the allowed shard count from the team count', () => {
    expect(allowedShards(64, 16, 64)).toBe(4);
    expect(allowedShards(65, 16, 64)).toBe(5);
    expect(allowedShards(1, 16, 64)).toBe(1);
    expect(allowedShards(0, 16, 64)).toBe(0);
    // And is itself capped, so an inflated team count cannot ask for unbounded channels.
    expect(allowedShards(1_000_000, 1, 64)).toBe(64);
  });
});

describe('deduplication and coalescing', () => {
  it('drops an update whose state is unchanged', async () => {
    const token = await register();
    await seedChannel(0);
    const send = (state: ShardState) =>
      SELF.fetch(`${origin}/v1/activity/update`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ publicationId, shard: 0, state, urgency: 'transition' }),
      });

    expect(await (await send(shardState(1))).json()).toEqual({ queued: true });
    // Record the send, as the queue consumer would.
    const stub = env.PUSH_PUBLICATION.get(env.PUSH_PUBLICATION.idFromName(publicationId));
    await stub.recordSend(0, shardStateHash(shardState(1)), 1);

    // A later revision with identical glanceable content. Director's revision moves for reasons
    // that change nothing on a Lock Screen.
    const body = (await (await send(shardState(5))).json()) as { queued: boolean; reason: string };
    expect(body.queued).toBe(false);
    expect(body.reason).toContain('unchanged');
  });

  it('coalesces a routine update inside the window but not a transition', async () => {
    const token = await register();
    await seedChannel(0);
    const stub = env.PUSH_PUBLICATION.get(env.PUSH_PUBLICATION.idFromName(publicationId));
    await stub.recordSend(0, 'previous', 1);

    const send = (state: ShardState, urgency: 'routine' | 'transition') =>
      SELF.fetch(`${origin}/v1/activity/update`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ publicationId, shard: 0, state, urgency }),
      });

    const routine = (await (await send(shardState(2, 190), 'routine')).json()) as {
      queued: boolean;
      reason?: string;
    };
    expect(routine.queued).toBe(false);
    expect(routine.reason).toContain('coalescing');

    // A game starting or going final is not coalesced. That is the whole point of the distinction.
    expect(await (await send(shardState(3, 200), 'transition')).json()).toEqual({ queued: true });
  });

  it('drops an update older than what was already sent', async () => {
    const token = await register();
    await seedChannel(0);
    const stub = env.PUSH_PUBLICATION.get(env.PUSH_PUBLICATION.idFromName(publicationId));
    await stub.recordSend(0, 'previous', 50);
    const body = (await (
      await SELF.fetch(`${origin}/v1/activity/update`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ publicationId, shard: 0, state: shardState(10), urgency: 'transition' }),
      })
    ).json()) as { queued: boolean; reason: string };
    // A score that goes backwards is worse than a late one.
    expect(body.queued).toBe(false);
    expect(body.reason).toContain('older');
  });

  it('drops an update for a shard with no channel', async () => {
    const token = await register();
    const body = (await (
      await SELF.fetch(`${origin}/v1/activity/update`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ publicationId, shard: 0, state: shardState(1), urgency: 'transition' }),
      })
    ).json()) as { queued: boolean; reason: string };
    expect(body.queued).toBe(false);
    expect(body.reason).toContain('no channel');
  });

  it('the hash ignores the revision and notices a score', () => {
    expect(shardStateHash(shardState(1))).toBe(shardStateHash(shardState(99)));
    expect(shardStateHash(shardState(1, 180))).not.toBe(shardStateHash(shardState(1, 190)));
  });
});

describe('bounds', () => {
  it('refuses an oversized body', async () => {
    const token = await register();
    const response = await SELF.fetch(`${origin}/v1/activity/update`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'content-length': String(1024 * 1024),
      },
      body: JSON.stringify({ publicationId, shard: 0, state: shardState(1) }),
    });
    expect(response.status).toBe(413);
  });

  it('refuses a shard with too many teams', async () => {
    const token = await register();
    await seedChannel(0);
    const response = await SELF.fetch(`${origin}/v1/activity/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        publicationId,
        shard: 0,
        state: { r: 1, t: Array.from({ length: 64 }, (_unused, i) => ({ i, m: 0 })) },
      }),
    });
    expect(response.status).toBe(400);
  });

  it('refuses malformed JSON', async () => {
    const token = await register();
    const response = await SELF.fetch(`${origin}/v1/activity/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: 'not json',
    });
    expect(response.status).toBe(400);
  });
});

describe('announcement notifications', () => {
  it('registers a device and says nothing back', async () => {
    await register();
    const response = await SELF.fetch(`${origin}/v1/notifications/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        publicationId,
        deviceToken: 'a'.repeat(64),
        followedTeamId: 'team-a',
        clientKind: 'app',
      }),
    });
    // 204: nothing to say, and nothing about other devices to leak.
    expect(response.status).toBe(204);
  });

  it('refuses a device token that is not hexadecimal', async () => {
    await register();
    for (const token of ['not-hex', '', 'zz'.repeat(40)]) {
      const response = await SELF.fetch(`${origin}/v1/notifications/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ publicationId, deviceToken: token }),
      });
      expect(response.status, token).toBe(400);
    }
  });

  it('routes an audience by followed team', async () => {
    await register();
    const stub = env.PUSH_PUBLICATION.get(env.PUSH_PUBLICATION.idFromName(publicationId));
    for (const [token, team] of [
      ['a'.repeat(64), 'team-a'],
      ['b'.repeat(64), 'team-b'],
      ['c'.repeat(64), null],
    ] as const) {
      await stub.registerDevice({
        deviceToken: token,
        clientKind: 'app',
        followedTeamId: team,
        now: Date.now(),
      });
    }
    // An empty audience is everybody, including the device that follows nothing.
    expect((await stub.audience([])).length).toBe(3);
    // A targeted announcement reaches only that team's devices.
    const targeted = await stub.audience(['team-a']);
    expect(targeted.map((device) => device.deviceToken)).toEqual(['a'.repeat(64)]);
  });

  it('expires an App Clip registration sooner than the app', async () => {
    await register();
    const stub = env.PUSH_PUBLICATION.get(env.PUSH_PUBLICATION.idFromName(publicationId));
    const now = Date.now();
    await stub.registerDevice({
      deviceToken: 'a'.repeat(64),
      clientKind: 'app-clip',
      followedTeamId: null,
      now,
    });
    await stub.registerDevice({ deviceToken: 'b'.repeat(64), clientKind: 'app', followedTeamId: null, now });
    // Apple gives an App Clip an eight-hour ephemeral notification window; keeping the token past
    // it would mean pushing at a phone that cannot receive it.
    const afterNineHours = now + 9 * 60 * 60 * 1000;
    const survivors = await stub.audience([], afterNineHours);
    expect(survivors.map((device) => device.deviceToken)).toEqual(['b'.repeat(64)]);
  });

  it('refuses an announcement with no title or body', async () => {
    const token = await register();
    for (const body of [{ title: 'x' }, { body: 'y' }, {}]) {
      const response = await SELF.fetch(`${origin}/v1/announcements`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ publicationId, ...body }),
      });
      expect(response.status).toBe(400);
    }
  });

  it('queues an announcement for a valid publisher', async () => {
    const token = await register();
    const response = await SELF.fetch(`${origin}/v1/announcements`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        publicationId,
        title: 'Room change',
        body: 'Room 104 moves to 212.',
        severity: 'urgent',
        audienceTeamIds: ['team-a'],
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ queued: true });
  });
});

describe('ending a publication', () => {
  it('deletes every channel and stops accepting pushes', async () => {
    const token = await register();
    await seedChannel(0);
    await seedChannel(1);
    const stub = env.PUSH_PUBLICATION.get(env.PUSH_PUBLICATION.idFromName(publicationId));

    // The channel manager cannot reach Apple from local workerd, so deletion fails and the
    // channels are deliberately *kept* for the reconciler — reporting them deleted would leak
    // them from the budget's point of view, which is how a push service quietly runs out.
    const result = await stub.end();
    expect(result.deleted).toBe(0);
    expect(result.failed).toBe(2);

    // The publication is ended either way, so nothing further is accepted.
    const response = await SELF.fetch(`${origin}/v1/activity/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ publicationId, shard: 0, state: shardState(1) }),
    });
    expect(response.status).toBe(410);
  });

  it('forgets device tokens when the publication ends', async () => {
    await register();
    const stub = env.PUSH_PUBLICATION.get(env.PUSH_PUBLICATION.idFromName(publicationId));
    await stub.registerDevice({
      deviceToken: 'a'.repeat(64),
      clientKind: 'app',
      followedTeamId: null,
      now: Date.now(),
    });
    await stub.end();
    expect((await stub.audience([])).length).toBe(0);
  });
});

describe('what the gateway stores', () => {
  it('holds routing and lifecycle, and nothing that looks like tournament data', async () => {
    await register();
    await seedChannel(0);
    const stub = env.PUSH_PUBLICATION.get(env.PUSH_PUBLICATION.idFromName(publicationId));
    const tables = await runInDurableObject(stub, async (_instance, state) =>
      state.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .toArray()
        .map((row) => row.name),
    );
    // This service must not become a second tournament database. See
    // docs/QBLIVE.md#push-service-stores-very-little.
    expect(tables.sort()).toEqual(['channel', 'device', 'publication']);

    const columns = await runInDurableObject(stub, async (_instance, state) =>
      ['publication', 'channel', 'device'].flatMap((table) =>
        state.storage.sql
          .exec<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`)
          .toArray()
          .map((row) => `${table}.${row.name}`),
      ),
    );
    for (const forbidden of ['standing', 'schedule', 'roster', 'player', 'score', 'qbj', 'result']) {
      expect(columns.filter((column) => column.includes(forbidden))).toEqual([]);
    }
    // And the publisher credential is stored only as a hash.
    expect(columns).toContain('publication.publisher_token_hash');
    expect(columns.filter((column) => /token$/.test(column))).toEqual(['device.device_token']);
  });
});

describe('APNs payloads and outcomes', () => {
  it('builds the documented broadcast body', () => {
    const body = broadcastPayload({ state: shardState(41), event: 'update', timestamp: 1_757_088_000 });
    const parsed = JSON.parse(body) as { aps: Record<string, unknown> };
    expect(Object.keys(parsed)).toEqual(['aps']);
    expect(parsed.aps.event).toBe('update');
    expect(parsed.aps.timestamp).toBe(1_757_088_000);
    expect(parsed.aps['content-state']).toEqual(shardState(41));
  });

  it("a sixteen-team shard is far inside Apple's limit", () => {
    const state: ShardState = {
      r: 999_999,
      t: Array.from({ length: 16 }, (_unused, index) => ({
        i: index,
        m: 2 as const,
        on: 'Thomas Jefferson High School for Science and Technology B',
        s: 1885,
        x: 1440,
        u: 24,
        rm: 'Science Wing Room 231A',
        rd: 14,
        st: 1_757_088_000,
      })),
    };
    const bytes = payloadBytes(broadcastPayload({ state, event: 'update', timestamp: 1_757_088_000 }));
    // The measured figure in docs/QBLIVE_ACTIVITY.md.
    expect(bytes).toBeLessThan(BROADCAST_PAYLOAD_LIMIT * 0.6);
  });

  it('knows which APNs failures are worth retrying', () => {
    expect(
      isRetryable({ ok: false, status: 0, reason: null, requestId: null, transportError: 'ECONNRESET' }),
    ).toBe(true);
    expect(
      isRetryable({
        ok: false,
        status: 429,
        reason: 'TooManyRequests',
        requestId: null,
        transportError: null,
      }),
    ).toBe(true);
    expect(isRetryable({ ok: false, status: 503, reason: null, requestId: null, transportError: null })).toBe(
      true,
    );
    expect(
      isRetryable({
        ok: false,
        status: 403,
        reason: 'ExpiredProviderToken',
        requestId: null,
        transportError: null,
      }),
    ).toBe(true);
    // A bad topic or a bad channel is a configuration mistake. Retrying it forever is how a push
    // service spends a tournament's budget on nothing.
    expect(
      isRetryable({ ok: false, status: 400, reason: 'BadChannelId', requestId: null, transportError: null }),
    ).toBe(false);
    expect(
      isRetryable({
        ok: false,
        status: 403,
        reason: 'InvalidProviderToken',
        requestId: null,
        transportError: null,
      }),
    ).toBe(false);
  });

  it('knows which device tokens are dead for good', () => {
    expect(
      tokenIsDead({ ok: false, status: 410, reason: 'Unregistered', requestId: null, transportError: null }),
    ).toBe(true);
    expect(
      tokenIsDead({
        ok: false,
        status: 400,
        reason: 'BadDeviceToken',
        requestId: null,
        transportError: null,
      }),
    ).toBe(true);
    expect(tokenIsDead({ ok: false, status: 503, reason: null, requestId: null, transportError: null })).toBe(
      false,
    );
  });
});

describe('the channel manager is replaceable', () => {
  it('reports an unreachable Apple endpoint as retryable, not as a crash', async () => {
    const manager = new ApnsChannelManager({
      environment: 'sandbox',
      bundleId: 'com.qbsheet.live',
      providerToken: async () => 'token',
      fetchImpl: async () => {
        throw new TypeError('Network connection lost.');
      },
    });
    await expect(manager.create(publicationId, 0)).rejects.toThrow(ChannelError);
    await manager.create(publicationId, 0).catch((error: ChannelError) => {
      // The exact failure docs/QBLIVE_PUSH_PROTOTYPE.md exists to characterise.
      expect(error.retryable).toBe(true);
      expect(error.message).toContain('could not be reached');
    });
  });

  it('returns the channel id Apple put in the header', async () => {
    const manager = new ApnsChannelManager({
      environment: 'sandbox',
      bundleId: 'com.qbsheet.live',
      providerToken: async () => 'token',
      fetchImpl: async (_input, init) => {
        // The documented request: LiveActivity push type, MostRecentMessageStored.
        const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
        expect(body['push-type']).toBe('LiveActivity');
        expect(body['message-storage-policy']).toBe(1);
        return new Response(null, { status: 201, headers: { 'apns-channel-id': 'dHN0LXNyY2gtY2hubA==' } });
      },
    });
    expect(await manager.create(publicationId, 0)).toBe('dHN0LXNyY2gtY2hubA==');
  });

  it('treats a delete of an already-gone channel as success', async () => {
    const manager = new ApnsChannelManager({
      environment: 'sandbox',
      bundleId: 'com.qbsheet.live',
      providerToken: async () => 'token',
      fetchImpl: async () => new Response(null, { status: 404 }),
    });
    // 404 means Apple has already forgotten it, which is the state deletion was aiming for.
    await expect(manager.delete('chan')).resolves.toBeUndefined();
  });

  it('has an external implementation, so the prototype result is a config change', async () => {
    // If the deployed edge cannot reach port 2196, this is the whole fix. See
    // docs/QBLIVE_PUSH_PROTOTYPE.md#5.
    const manager = new ExternalChannelManager('https://channels.example', 'token', async (input) => {
      expect(String(input)).toBe('https://channels.example/create');
      return Response.json({ channelId: 'external-chan' });
    });
    expect(await manager.create(publicationId, 0)).toBe('external-chan');
  });
});
