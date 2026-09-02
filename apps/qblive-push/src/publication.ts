/**
 * One publication's push state.
 *
 * # What is stored, and what is deliberately not
 *
 * This service must not become a second tournament database. It holds routing and lifecycle:
 * publisher authorization, the channel id per shard, notification device tokens, per-device
 * preferences, expiry, and the hash of the last shard state it sent.
 *
 * It does **not** hold standings, schedules, rosters, QBJ, scoring history, or any private Director
 * state. The tournament's own QBLive backend is the source of public state; this object never sees
 * it. See `docs/QBLIVE.md#push-service-stores-very-little`.
 */

import { DurableObject } from 'cloudflare:workers';

import { pushLimits, type PushClientKind, type ShardState } from './types';
import {
  allowedShards,
  ApnsChannelManager,
  ChannelError,
  ExternalChannelManager,
  type AllocationOutcome,
  type ChannelManager,
} from './channels';
import { providerToken } from './credential';
import type { ApnsEnvironment } from './apns';

interface ChannelRow extends Record<string, SqlStorageValue> {
  shard: number;
  channel_id: string;
  created_at: number;
  expires_at: number;
  last_hash: string | null;
  last_sent_at: number | null;
  last_revision: number;
}

interface DeviceRow extends Record<string, SqlStorageValue> {
  device_token: string;
  client_kind: string;
  followed_team_id: string | null;
  registered_at: number;
  expires_at: number;
}

export class PushPublication extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.ensureSchema();
  }

  /**
   * Create the schema if it is not there.
   *
   * Called from the constructor and again at the top of every public entry point. A Durable Object
   * whose storage was wiped — by a test's reset, or by a future maintenance path — keeps the same
   * instance, so without this the next call would fail with a SQLite error rather than doing its
   * job. `CREATE TABLE IF NOT EXISTS` on an existing schema is cheap.
   */
  private ensureSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS publication (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        publication_id TEXT NOT NULL,
        publisher_token_hash TEXT,
        team_count INTEGER NOT NULL DEFAULT 0,
        teams_per_shard INTEGER NOT NULL DEFAULT 16,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        ended INTEGER NOT NULL DEFAULT 0 CHECK (ended IN (0, 1))
      );
      CREATE TABLE IF NOT EXISTS channel (
        shard INTEGER PRIMARY KEY,
        channel_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        -- The hash of the last shard state actually sent. An unchanged state is not resent: the
        -- revision moves for reasons that change nothing on a Lock Screen.
        last_hash TEXT,
        last_sent_at INTEGER,
        last_revision INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS device (
        device_token TEXT PRIMARY KEY,
        client_kind TEXT NOT NULL DEFAULT 'app',
        followed_team_id TEXT,
        registered_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS device_team_idx ON device(followed_team_id);
    `);
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  /**
   * Register a publication for Apple push, returning its publisher token.
   *
   * Called once, by Director, when a tournament enables Apple background updates. `teamCount` is
   * what bounds how many channels this publication may ever hold — a four-team tournament cannot
   * ask for a thousand.
   */
  async register(options: {
    publicationId: string;
    teamCount: number;
    teamsPerShard: number;
    now: number;
  }): Promise<RegisterResult> {
    this.ensureSchema();
    const existing = this.publication();
    if (existing && !existing.ended) {
      return {
        ok: false,
        status: 409,
        code: 'conflict',
        message: 'This publication is already registered for Apple push.',
      };
    }
    const publisherToken = randomToken();
    const teamCount = Math.max(
      0,
      Math.min(pushLimits.maxTeamsPerShard * pushLimits.maxShardsPerPublication, options.teamCount),
    );
    this.sql.exec(
      `INSERT INTO publication (id, publication_id, publisher_token_hash, team_count, teams_per_shard,
                                created_at, expires_at, ended)
       VALUES (1, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(id) DO UPDATE SET
         publication_id = excluded.publication_id,
         publisher_token_hash = excluded.publisher_token_hash,
         team_count = excluded.team_count,
         teams_per_shard = excluded.teams_per_shard,
         expires_at = excluded.expires_at,
         ended = 0`,
      options.publicationId,
      await sha256Hex(publisherToken),
      teamCount,
      Math.max(1, Math.min(pushLimits.maxTeamsPerShard, options.teamsPerShard)),
      options.now,
      options.now + pushLimits.channelLifetimeMs,
    );
    return { ok: true, publisherToken };
  }

  private publication(): {
    publication_id: string;
    publisher_token_hash: string | null;
    team_count: number;
    teams_per_shard: number;
    expires_at: number;
    ended: boolean;
  } | null {
    const row = this.sql
      .exec<{
        publication_id: string;
        publisher_token_hash: string | null;
        team_count: number;
        teams_per_shard: number;
        expires_at: number;
        ended: number;
      }>(
        'SELECT publication_id, publisher_token_hash, team_count, teams_per_shard, expires_at, ended FROM publication WHERE id = 1',
      )
      .toArray()[0];
    return row ? { ...row, ended: row.ended !== 0 } : null;
  }

  /**
   * Verify a publisher token in constant time. Only the hash is stored.
   *
   * Returns a result rather than throwing. A thrown error does not survive the Durable Object RPC
   * boundary as its own class — it arrives in the Worker as a plain `Error` — so throwing here
   * would turn every 401 into a 500. That is worth stating: the failure was silent, and "the push
   * gateway is broken" and "your credential is wrong" are very different things to be told.
   */
  async authorize(token: string | null): Promise<AuthorizeResult> {
    this.ensureSchema();
    const row = this.publication();
    if (!row) {
      return {
        ok: false,
        status: 404,
        code: 'not-found',
        message: 'This publication is not registered for Apple push.',
      };
    }
    if (row.ended) return { ok: false, status: 410, code: 'gone', message: 'This publication has ended.' };
    if (!token) {
      return { ok: false, status: 401, code: 'unauthorized', message: 'A publisher credential is required.' };
    }
    if (!row.publisher_token_hash) {
      return {
        ok: false,
        status: 403,
        code: 'forbidden',
        message: 'This publication has no publisher credential.',
      };
    }
    if (!timingSafeEqual(await sha256Hex(token), row.publisher_token_hash)) {
      return {
        ok: false,
        status: 401,
        code: 'unauthorized',
        message: 'That publisher credential is not valid.',
      };
    }
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Channels
  // -------------------------------------------------------------------------

  /**
   * The channel for a shard, created on first request.
   *
   * Lazy on purpose. A 64-team tournament has four shards, and creating all four when Live starts
   * would consume four of Apple's ten thousand channels for teams nobody is following. A channel
   * appears when somebody actually wants an Activity in that shard.
   */
  async channelFor(shard: number, now = Date.now()): Promise<AllocationOutcome> {
    this.ensureSchema();
    const row = this.publication();
    if (!row) return { granted: false, reason: 'per-publication-limit', detail: 'not registered' };
    if (row.ended) return { granted: false, reason: 'per-publication-limit', detail: 'publication ended' };

    const existing = this.sql.exec<ChannelRow>('SELECT * FROM channel WHERE shard = ?', shard).toArray()[0];
    if (existing && existing.expires_at > now) {
      return { granted: true, channelId: existing.channel_id, reused: true };
    }

    const permitted = allowedShards(row.team_count, row.teams_per_shard, pushLimits.maxShardsPerPublication);
    if (shard < 0 || shard >= permitted) {
      return {
        granted: false,
        reason: 'per-publication-limit',
        detail: `this publication has ${row.team_count} teams, which allows ${permitted} shards`,
      };
    }

    const budget = await this.reserveGlobalBudget();
    if (!budget.granted) return budget;

    let channelId: string;
    try {
      channelId = await this.channelManager().create(row.publication_id, shard);
    } catch (error) {
      await this.releaseGlobalBudget();
      return {
        granted: false,
        reason: 'apple-refused',
        detail: error instanceof ChannelError ? error.message : String(error),
      };
    }
    this.sql.exec(
      `INSERT INTO channel (shard, channel_id, created_at, expires_at, last_hash, last_sent_at, last_revision)
       VALUES (?, ?, ?, ?, NULL, NULL, 0)
       ON CONFLICT(shard) DO UPDATE SET
         channel_id = excluded.channel_id,
         created_at = excluded.created_at,
         expires_at = excluded.expires_at,
         last_hash = NULL,
         last_revision = 0`,
      shard,
      channelId,
      now,
      now + pushLimits.channelLifetimeMs,
    );
    return { granted: true, channelId, reused: false };
  }

  /**
   * Whether this shard update is worth sending.
   *
   * Two gates. A state whose normalized hash matches the last one sent is dropped, because
   * Director's revision advances for reasons that change nothing glanceable — a room note edited, a
   * standings scope added. And a routine update within the coalescing window is dropped, because a
   * score changes several times a minute and a Lock Screen does not need to.
   */
  shouldSend(options: {
    shard: number;
    hash: string;
    revision: number;
    urgency: 'routine' | 'transition';
    now: number;
    coalesceMs: number;
  }): { send: boolean; reason: string } {
    this.ensureSchema();
    const row = this.sql
      .exec<ChannelRow>('SELECT * FROM channel WHERE shard = ?', options.shard)
      .toArray()[0];
    if (!row) return { send: false, reason: 'no channel for this shard' };
    // Stale updates never overwrite newer ones. Both APNs and a reconnecting publisher can
    // deliver out of order, and a score that goes backwards is worse than a late one.
    if (options.revision < row.last_revision) return { send: false, reason: 'older than what was sent' };
    if (row.last_hash === options.hash) return { send: false, reason: 'unchanged since the last send' };
    if (
      options.urgency === 'routine' &&
      row.last_sent_at !== null &&
      options.now - row.last_sent_at < options.coalesceMs
    ) {
      return { send: false, reason: 'inside the coalescing window' };
    }
    return { send: true, reason: 'changed' };
  }

  recordSend(shard: number, hash: string, revision: number, now = Date.now()): void {
    this.ensureSchema();
    this.sql.exec(
      'UPDATE channel SET last_hash = ?, last_sent_at = ?, last_revision = ? WHERE shard = ?',
      hash,
      now,
      revision,
      shard,
    );
  }

  channelId(shard: number): string | null {
    this.ensureSchema();
    return (
      this.sql.exec<ChannelRow>('SELECT * FROM channel WHERE shard = ?', shard).toArray()[0]?.channel_id ??
      null
    );
  }

  /**
   * End the publication: delete every channel and stop accepting pushes.
   *
   * Called when a tournament finalizes or its publication is deleted. Channels are deleted
   * explicitly rather than left to expire, because one counts against Apple's global ceiling
   * whether or not anybody is subscribed.
   */
  async end(now = Date.now()): Promise<{ deleted: number; failed: number }> {
    this.ensureSchema();
    const channels = this.sql.exec<ChannelRow>('SELECT * FROM channel').toArray();
    const manager = this.channelManager();
    let deleted = 0;
    let failed = 0;
    for (const channel of channels) {
      try {
        await manager.delete(channel.channel_id);
        deleted += 1;
        await this.releaseGlobalBudget();
      } catch {
        // Left in place so the reconciler retries. Reporting it deleted would leak a channel from
        // the budget's point of view, which is the failure that eventually exhausts the ceiling.
        failed += 1;
      }
    }
    this.sql.exec('DELETE FROM channel WHERE channel_id IN (SELECT channel_id FROM channel)');
    if (failed > 0) {
      for (const channel of channels.slice(deleted)) {
        this.sql.exec(
          'INSERT INTO channel (shard, channel_id, created_at, expires_at, last_revision) VALUES (?, ?, ?, ?, 0) ON CONFLICT(shard) DO NOTHING',
          channel.shard,
          channel.channel_id,
          channel.created_at,
          now,
        );
      }
    }
    this.sql.exec('UPDATE publication SET ended = 1 WHERE id = 1');
    this.sql.exec('DELETE FROM device');
    return { deleted, failed };
  }

  // -------------------------------------------------------------------------
  // Devices
  // -------------------------------------------------------------------------

  /**
   * Register a device for announcement notifications.
   *
   * A per-device token, unlike the Activity's shared channel. Announcements are low-frequency, so
   * per-device fanout is affordable and gives the audience routing a broadcast cannot.
   */
  registerDevice(options: {
    deviceToken: string;
    clientKind: PushClientKind;
    followedTeamId: string | null;
    now: number;
  }): RegisterDeviceResult {
    this.ensureSchema();
    const count =
      this.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM device').toArray()[0]?.count ?? 0;
    if (count >= pushLimits.maxDeviceTokensPerPublication) {
      return {
        ok: false,
        status: 429,
        code: 'rate-limited',
        message: 'This publication has too many registered devices.',
      };
    }
    this.sql.exec(
      `INSERT INTO device (device_token, client_kind, followed_team_id, registered_at, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(device_token) DO UPDATE SET
         client_kind = excluded.client_kind,
         followed_team_id = excluded.followed_team_id,
         expires_at = excluded.expires_at`,
      options.deviceToken,
      options.clientKind,
      options.followedTeamId,
      options.now,
      // An App Clip's notification window is eight hours; the full app's registration lasts the
      // tournament. Expiring both keeps this object from accumulating tokens for phones that
      // walked out of the building weeks ago.
      options.now + (options.clientKind === 'app-clip' ? 8 * 60 * 60 * 1000 : pushLimits.channelLifetimeMs),
    );
    return { ok: true };
  }

  /** The devices an announcement should reach. */
  audience(teamIds: string[], now = Date.now()): { deviceToken: string; clientKind: PushClientKind }[] {
    this.ensureSchema();
    const rows = this.sql.exec<DeviceRow>('SELECT * FROM device WHERE expires_at > ?', now).toArray();
    const wanted = new Set(teamIds);
    return rows
      .filter(
        (row) => wanted.size === 0 || (row.followed_team_id !== null && wanted.has(row.followed_team_id)),
      )
      .map((row) => ({
        deviceToken: row.device_token,
        clientKind: row.client_kind === 'app-clip' ? ('app-clip' as const) : ('app' as const),
      }));
  }

  forgetDevice(deviceToken: string): void {
    this.ensureSchema();
    this.sql.exec('DELETE FROM device WHERE device_token = ?', deviceToken);
  }

  status(now = Date.now()): Record<string, unknown> {
    this.ensureSchema();
    const row = this.publication();
    const channels = this.sql.exec<ChannelRow>('SELECT * FROM channel').toArray();
    const devices =
      this.sql
        .exec<{ count: number }>('SELECT COUNT(*) AS count FROM device WHERE expires_at > ?', now)
        .toArray()[0]?.count ?? 0;
    return {
      registered: row !== null,
      ended: row?.ended ?? false,
      teamCount: row?.team_count ?? 0,
      teamsPerShard: row?.teams_per_shard ?? 0,
      allowedShards: row
        ? allowedShards(row.team_count, row.teams_per_shard, pushLimits.maxShardsPerPublication)
        : 0,
      activeChannels: channels.length,
      devices,
    };
  }

  // -------------------------------------------------------------------------
  // Infrastructure
  // -------------------------------------------------------------------------

  private channelManager(): ChannelManager {
    if (this.env.EXTERNAL_CHANNEL_MANAGER_URL && this.env.EXTERNAL_CHANNEL_MANAGER_TOKEN) {
      return new ExternalChannelManager(
        this.env.EXTERNAL_CHANNEL_MANAGER_URL,
        this.env.EXTERNAL_CHANNEL_MANAGER_TOKEN,
      );
    }
    return new ApnsChannelManager({
      environment: (this.env.APNS_ENVIRONMENT as ApnsEnvironment) === 'sandbox' ? 'sandbox' : 'production',
      bundleId: this.env.APNS_BUNDLE_ID ?? 'com.qbsheet.live',
      providerToken: () => providerToken(this.env),
    });
  }

  /**
   * Take one channel from the global budget.
   *
   * Goes through the budget object rather than counting locally, because the ceiling is Apple's and
   * therefore global to the whole service. Deliberately *not* on the hot path: this runs on channel
   * creation, a handful of times per tournament, never per push.
   */
  private async reserveGlobalBudget(): Promise<AllocationOutcome> {
    const stub = this.env.PUSH_PUBLICATION.get(this.env.PUSH_PUBLICATION.idFromName('__budget__'));
    const response = await stub.fetch('https://budget/reserve', { method: 'POST' });
    if (response.ok) return { granted: true, channelId: '', reused: false };
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    return {
      granted: false,
      reason: 'budget-exhausted',
      detail: body.message ?? "QBSheet's Apple channel allocation is exhausted.",
    };
  }

  private async releaseGlobalBudget(): Promise<void> {
    const stub = this.env.PUSH_PUBLICATION.get(this.env.PUSH_PUBLICATION.idFromName('__budget__'));
    await stub.fetch('https://budget/release', { method: 'POST' }).catch(() => undefined);
  }

  /**
   * The budget routes, served by the same class under the reserved name `__budget__`.
   *
   * One class rather than a third Durable Object binding: the state is a counter, and a separate
   * binding would be another thing for a deployment to get wrong.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS budget (id INTEGER PRIMARY KEY CHECK (id = 1), used INTEGER NOT NULL DEFAULT 0)',
    );
    const used =
      this.sql.exec<{ used: number }>('SELECT used FROM budget WHERE id = 1').toArray()[0]?.used ?? 0;

    if (url.pathname === '/budget/reserve') {
      if (used >= pushLimits.globalChannelCeiling) {
        return Response.json(
          {
            error: 'rate-limited',
            message:
              "QBSheet's Apple channel allocation is fully used. Lock Screen updates are temporarily unavailable; everything else is working.",
            used,
            ceiling: pushLimits.globalChannelCeiling,
          },
          { status: 429 },
        );
      }
      this.sql.exec(
        'INSERT INTO budget (id, used) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET used = ?',
        used + 1,
        used + 1,
      );
      return Response.json({ used: used + 1, ceiling: pushLimits.globalChannelCeiling });
    }
    if (url.pathname === '/budget/release') {
      const next = Math.max(0, used - 1);
      this.sql.exec(
        'INSERT INTO budget (id, used) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET used = ?',
        next,
        next,
      );
      return Response.json({ used: next, ceiling: pushLimits.globalChannelCeiling });
    }
    if (url.pathname === '/budget') {
      return Response.json({ used, ceiling: pushLimits.globalChannelCeiling });
    }
    return Response.json({ error: 'not-found', message: 'No such route.' }, { status: 404 });
  }
}

/**
 * A refusal, returned rather than thrown.
 *
 * Durable Object RPC does not preserve a custom error class across the boundary, so an expected
 * outcome has to be a value. See `authorize`.
 */
export interface Refusal {
  ok: false;
  status: number;
  code: string;
  message: string;
}

export type AuthorizeResult = { ok: true } | Refusal;
export type RegisterResult = { ok: true; publisherToken: string } | Refusal;
export type RegisterDeviceResult = { ok: true } | Refusal;

export class PushError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PushError';
  }

  toResponse(): Response {
    return Response.json({ error: this.code, message: this.message }, { status: this.status });
  }
}

/**
 * A stable hash of a shard state, ignoring the revision.
 *
 * Mirrors `shardStateFingerprint` in `packages/qblive-activity`. FNV-1a: not cryptographic, because
 * this is a change detector and a collision costs one skipped update that the next one supersedes.
 */
export function shardStateHash(state: ShardState): string {
  const canonical = JSON.stringify(state.t);
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1)
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
