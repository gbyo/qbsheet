/**
 * push.qbsheet.com — the QBSheet Live push gateway.
 *
 * # The smallest possible trusted component
 *
 * QBSheet operates exactly two things: `live.qbsheet.com`, which is static, and this. It exists
 * only because an APNs provider key authenticates as *the QBSheet Live app* and cannot be handed to
 * a tournament director's Cloudflare account.
 *
 * It is **not** the QBLive backend. It carries no tournament data. If it is down:
 *
 * ```
 * QBLive backend        healthy
 * Live Web              healthy
 * iOS foreground        healthy
 * schedules, standings, stats, results   healthy
 *
 * background Live Activity updates       degraded
 * APNs announcement notifications        degraded
 * ```
 *
 * Director says exactly that, rather than "QBSheet Live offline". See `docs/QBLIVE.md#13-apple-push`.
 *
 * # There is no route that sends arbitrary APNs JSON
 *
 * A publisher describes an intent — this shard's state changed, publish this announcement, end
 * these activities — and this Worker constructs the APNs request. A `POST /apns` taking a payload
 * would be a way to send anything at all as QBSheet Live.
 */

import { PushPublication, PushError, shardStateHash, type Refusal } from './publication';
import { ApnsCredential } from './credential';
import { pushLimits, type PushJob, type ShardState } from './types';
import { handlePushJob } from './sender';

export { PushPublication, ApnsCredential };

/**
 * Routine shard updates are coalesced to one per this interval.
 *
 * Fifteen seconds. A live score changes several times a minute; a Lock Screen read while walking
 * down a corridor does not need to. Foreground clients get the fast path from the tournament's own
 * WebSocket, so this interval costs nobody anything they were watching.
 */
const ROUTINE_COALESCE_MS = 15_000;

const publicationIdPattern = /^[0-9bcdfghjkmnpqrstvwxyz]{20}$/;

const corsHeaders: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '86400',
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: corsHeaders });
}

function publication(env: Env, publicationId: string): DurableObjectStub<PushPublication> {
  return env.PUSH_PUBLICATION.get(env.PUSH_PUBLICATION.idFromName(publicationId));
}

/** A bounded JSON body. A request over the limit is a mistake or an attack; either way, 413. */
async function readJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > pushLimits.maxBodyBytes) {
    throw new PushError(413, 'payload-too-large', 'That request is too large.');
  }
  const text = await request.text();
  if (text.length > pushLimits.maxBodyBytes) {
    throw new PushError(413, 'payload-too-large', 'That request is too large.');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new PushError(400, 'bad-request', 'That request body is not valid JSON.');
  }
}

/** Turn a Durable Object's refusal back into a `PushError` on this side of the RPC boundary. */
function refusal(result: Refusal): PushError {
  return new PushError(result.status, result.code, result.message);
}

function bearer(request: Request): string | null {
  const match = /^Bearer\s+(.+)$/i.exec((request.headers.get('authorization') ?? '').trim());
  return match ? match[1] : null;
}

function requirePublicationId(value: unknown): string {
  if (typeof value !== 'string' || !publicationIdPattern.test(value)) {
    throw new PushError(400, 'bad-request', 'A valid publication id is required.');
  }
  return value;
}

function parseShardState(value: unknown): ShardState {
  if (typeof value !== 'object' || value === null) {
    throw new PushError(400, 'bad-request', 'A shard state is required.');
  }
  const record = value as { r?: unknown; t?: unknown };
  if (typeof record.r !== 'number' || !Number.isInteger(record.r) || record.r < 0) {
    throw new PushError(400, 'bad-request', 'A shard state needs an integer revision.');
  }
  if (!Array.isArray(record.t) || record.t.length > pushLimits.maxTeamsPerShard) {
    throw new PushError(400, 'bad-request', `A shard holds at most ${pushLimits.maxTeamsPerShard} teams.`);
  }
  return value as ShardState;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (error) {
      if (error instanceof PushError) return error.toResponse();
      return json({ error: 'internal', message: 'The push gateway failed to handle that request.' }, 500);
    }
  },

  /**
   * The Queue consumer.
   *
   * Everything that talks to Apple goes through here, which is what absorbs a tournament burst: a
   * round ending puts a dozen shard updates in the queue at once, and they drain at a controlled
   * concurrency instead of opening a dozen simultaneous APNs connections.
   */
  async queue(batch: MessageBatch<PushJob>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        const outcome = await handlePushJob(message.body, env);
        if (outcome.retry) message.retry();
        else message.ack();
      } catch {
        // An unexpected failure retries. The queue's own dead-letter handling is the backstop, so
        // a permanently broken job cannot spin forever.
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, PushJob>;

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });

  if (url.pathname === '/' || url.pathname === '/health') {
    return json({
      service: 'qblive-push',
      // Says whether push is configured without saying anything about which tournaments exist.
      configured: Boolean(env.APNS_PRIVATE_KEY && env.APNS_KEY_ID && env.APNS_TEAM_ID),
      channelCeiling: pushLimits.globalChannelCeiling,
    });
  }

  /**
   * The global channel budget, as a number.
   *
   * Public because it is operational information about QBSheet's own capacity, not about anybody's
   * tournament, and because a Director asking "why can I not get Lock Screen updates" deserves an
   * answer that is checkable.
   */
  if (url.pathname === '/v1/budget' && request.method === 'GET') {
    const stub = env.PUSH_PUBLICATION.get(env.PUSH_PUBLICATION.idFromName('__budget__'));
    return json(await (await stub.fetch('https://budget/budget')).json());
  }

  // ---------------------------------------------------------- registration

  /**
   * Register a publication for Apple push. Returns a publisher credential, once.
   *
   * Called by Director when a tournament enables Apple background updates.
   */
  if (url.pathname === '/v1/publications' && request.method === 'POST') {
    const body = (await readJson(request)) as {
      publicationId?: unknown;
      teamCount?: unknown;
      teamsPerShard?: unknown;
    };
    const publicationId = requirePublicationId(body.publicationId);
    const teamCount = typeof body.teamCount === 'number' ? Math.trunc(body.teamCount) : 0;
    if (teamCount <= 0) {
      throw new PushError(
        400,
        'bad-request',
        'A team count is required, so channel allocation can be bounded.',
      );
    }
    const teamsPerShard = typeof body.teamsPerShard === 'number' ? Math.trunc(body.teamsPerShard) : 16;
    const result = await publication(env, publicationId).register({
      publicationId,
      teamCount,
      teamsPerShard,
      now: Date.now(),
    });
    if (!result.ok) throw refusal(result);
    return json({ publicationId, publisherToken: result.publisherToken });
  }

  // ------------------------------------------------------------- activities

  /**
   * The channel for a shard, created on first request.
   *
   * Called by a *client* rather than by a publisher, which is why it takes no publisher credential:
   * a channel id is not a secret — it is the identifier a device needs in order to subscribe, and
   * anybody who can open the tournament can already see everything the channel carries. What it
   * does need is a bound, and that comes from the publication's registered team count.
   */
  if (url.pathname === '/v1/activity/channel' && request.method === 'POST') {
    const body = (await readJson(request)) as { publicationId?: unknown; shard?: unknown };
    const publicationId = requirePublicationId(body.publicationId);
    const shard = typeof body.shard === 'number' ? Math.trunc(body.shard) : -1;
    const outcome = await publication(env, publicationId).channelFor(shard);
    if (!outcome.granted) {
      // Never a 500. This is an expected, communicated degradation.
      return json(
        {
          error: outcome.reason,
          message:
            outcome.reason === 'budget-exhausted'
              ? 'Lock Screen updates are temporarily unavailable. Everything else is working.'
              : outcome.reason === 'apple-refused'
                ? 'Apple could not create a channel for this tournament. Everything else is working.'
                : 'This tournament does not have Lock Screen updates for that team.',
          detail: outcome.detail,
        },
        outcome.reason === 'budget-exhausted' ? 429 : 409,
      );
    }
    return json({ channelId: outcome.channelId, reused: outcome.reused });
  }

  /** A publisher reporting that a shard's glanceable state changed. */
  if (url.pathname === '/v1/activity/update' && request.method === 'POST') {
    const body = (await readJson(request)) as {
      publicationId?: unknown;
      shard?: unknown;
      state?: unknown;
      urgency?: unknown;
    };
    const publicationId = requirePublicationId(body.publicationId);
    const stub = publication(env, publicationId);
    const authorized = await stub.authorize(bearer(request));
    if (!authorized.ok) throw refusal(authorized);
    const shard = typeof body.shard === 'number' ? Math.trunc(body.shard) : -1;
    const state = parseShardState(body.state);
    const urgency = body.urgency === 'transition' ? 'transition' : 'routine';

    const decision = await stub.shouldSend({
      shard,
      hash: shardStateHash(state),
      revision: state.r,
      urgency,
      now: Date.now(),
      coalesceMs: ROUTINE_COALESCE_MS,
    });
    if (!decision.send) {
      // Dropped before the queue, which is the cheapest place to drop it.
      return json({ queued: false, reason: decision.reason });
    }
    await env.PUSH_QUEUE.send({ kind: 'shard', publicationId, shard, state, urgency });
    return json({ queued: true });
  }

  /** A publisher's announcement, fanned out to registered devices. */
  if (url.pathname === '/v1/announcements' && request.method === 'POST') {
    const body = (await readJson(request)) as {
      publicationId?: unknown;
      title?: unknown;
      body?: unknown;
      severity?: unknown;
      audienceTeamIds?: unknown;
    };
    const publicationId = requirePublicationId(body.publicationId);
    const stub = publication(env, publicationId);
    const authorized = await stub.authorize(bearer(request));
    if (!authorized.ok) throw refusal(authorized);
    const title = typeof body.title === 'string' ? body.title.slice(0, pushLimits.maxAnnouncementTitle) : '';
    const text = typeof body.body === 'string' ? body.body.slice(0, pushLimits.maxAnnouncementBody) : '';
    if (!title || !text) throw new PushError(400, 'bad-request', 'An announcement needs a title and a body.');
    const audienceTeamIds = Array.isArray(body.audienceTeamIds)
      ? body.audienceTeamIds
          .filter((id): id is string => typeof id === 'string')
          .slice(0, pushLimits.maxAudienceTeams)
      : [];
    const severity =
      body.severity === 'urgent' || body.severity === 'important' ? body.severity : 'information';
    await env.PUSH_QUEUE.send({
      kind: 'announcement',
      publicationId,
      title,
      body: text,
      severity,
      audienceTeamIds,
    });
    return json({ queued: true });
  }

  /** End every Activity and delete every channel for a publication. */
  if (url.pathname === '/v1/activity/end' && request.method === 'POST') {
    const body = (await readJson(request)) as { publicationId?: unknown };
    const publicationId = requirePublicationId(body.publicationId);
    const stub = publication(env, publicationId);
    const authorized = await stub.authorize(bearer(request));
    if (!authorized.ok) throw refusal(authorized);
    await env.PUSH_QUEUE.send({ kind: 'end', publicationId });
    return json({ queued: true });
  }

  // ---------------------------------------------------------- notifications

  /**
   * Register a device for announcement notifications.
   *
   * No publisher credential: a device is registering itself. The publication has to exist and be
   * registered for push, which is the bound.
   */
  if (url.pathname === '/v1/notifications/register' && request.method === 'POST') {
    const body = (await readJson(request)) as {
      publicationId?: unknown;
      deviceToken?: unknown;
      followedTeamId?: unknown;
      clientKind?: unknown;
    };
    const publicationId = requirePublicationId(body.publicationId);
    if (typeof body.deviceToken !== 'string' || !/^[0-9a-f]{64,200}$/i.test(body.deviceToken)) {
      throw new PushError(400, 'bad-request', 'A hexadecimal APNs device token is required.');
    }
    const registered = await publication(env, publicationId).registerDevice({
      deviceToken: body.deviceToken.toLowerCase(),
      clientKind: body.clientKind === 'app-clip' ? 'app-clip' : 'app',
      followedTeamId: typeof body.followedTeamId === 'string' ? body.followedTeamId : null,
      now: Date.now(),
    });
    if (!registered.ok) throw refusal(registered);
    // 204: nothing to say, and nothing about other devices to leak.
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (url.pathname === '/v1/notifications/unregister' && request.method === 'POST') {
    const body = (await readJson(request)) as { publicationId?: unknown; deviceToken?: unknown };
    const publicationId = requirePublicationId(body.publicationId);
    if (typeof body.deviceToken !== 'string') {
      throw new PushError(400, 'bad-request', 'A device token is required.');
    }
    await publication(env, publicationId).forgetDevice(body.deviceToken.toLowerCase());
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // ---------------------------------------------------------------- status

  /**
   * What this publication's push state looks like, for the Director's status panel.
   *
   * Authenticated, because counts of registered devices are information about a tournament's
   * participants even though no token is returned.
   */
  if (url.pathname === '/v1/status' && request.method === 'POST') {
    const body = (await readJson(request)) as { publicationId?: unknown };
    const publicationId = requirePublicationId(body.publicationId);
    const stub = publication(env, publicationId);
    const authorized = await stub.authorize(bearer(request));
    if (!authorized.ok) throw refusal(authorized);
    ctx.passThroughOnException();
    return json(await stub.status());
  }

  return json({ error: 'not-found', message: 'No such route.' }, 404);
}
