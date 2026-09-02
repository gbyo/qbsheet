/**
 * The tournament Durable Object.
 *
 * One tournament, one Durable Object, one SQLite database. That mapping is the whole storage
 * design: a tournament's public state is small, is written by exactly one publisher, and is read by
 * everybody in one building — which is precisely the shape a Durable Object is for.
 *
 * # Hibernation
 *
 * Spectator WebSockets are accepted with `ctx.acceptWebSocket`, so the object hibernates between
 * updates and stops accruing duration charges while three hundred phones sit idle during a round.
 * Because hibernation re-runs the constructor, nothing that matters may live in an instance field —
 * everything is in SQLite or in a socket's serialized attachment.
 *
 * No application-level heartbeat: `setWebSocketAutoResponse` answers pings in the runtime without
 * waking the object, which is the whole point of using it.
 */

import { DurableObject } from 'cloudflare:workers';

import {
  QBLIVE_PROTOCOL_VERSION,
  qbliveSectionNames,
  type QbliveEvent,
  type QbliveManifest,
  type QbliveSections,
  type QbliveSnapshot,
} from './protocol/types';
import { parseSections, parseSnapshot, QbliveValidationError, qbliveLimits } from './protocol/validate';

/** The Worker's bindings. Declared in `./env.d.ts`; re-exported here so imports read naturally. */
export type Env = Cloudflare.Env;

/** How many superseded revisions to keep for replay. */
const replayWindow = 256;

/**
 * The largest management body accepted.
 *
 * A snapshot for a 512-team tournament with full player statistics is comfortably under this; a
 * body above it is a mistake or an attack, and either way the right answer is `413` rather than an
 * out-of-memory in somebody's Durable Object.
 */
const maxBodyBytes = qbliveLimits.maxBodyBytes;

type Lifecycle = 'live' | 'final' | 'unpublished';

interface PublicationRow extends Record<string, SqlStorageValue> {
  publication_id: string;
  revision: number;
  lifecycle: Lifecycle;
  generated_at: string;
  management_token_hash: string | null;
  created_at: string;
  updated_at: string;
}

export class QblivePublication extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.ensureSchema();
    // Answers client pings inside the runtime, so a hibernating object stays hibernating.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  /**
   * Create the schema if it is not there.
   *
   * Called from the constructor and again at the top of every request, because `destroy` deletes
   * all storage — including these tables — and the object keeps living afterwards. Without this,
   * the request after a delete would fail with a SQLite error instead of an honest 404.
   * `CREATE TABLE IF NOT EXISTS` on an existing schema is cheap.
   */
  private ensureSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS publication (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        publication_id TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        lifecycle TEXT NOT NULL DEFAULT 'live',
        generated_at TEXT NOT NULL DEFAULT '',
        management_token_hash TEXT,
        created_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS section (
        name TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        body TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS event (
        revision INTEGER PRIMARY KEY,
        generated_at TEXT NOT NULL,
        body TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS setup (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        consumed_at TEXT
      );
    `);
  }

  // -------------------------------------------------------------------------
  // Storage helpers
  // -------------------------------------------------------------------------

  private publication(): PublicationRow | null {
    return this.sql.exec<PublicationRow>('SELECT * FROM publication WHERE id = 1').toArray()[0] ?? null;
  }

  private requireLive(): PublicationRow {
    const row = this.publication();
    if (!row) throw new HttpError(404, 'not-found', 'No such tournament.');
    if (row.lifecycle === 'unpublished')
      throw new HttpError(410, 'gone', 'This tournament is no longer published.');
    return row;
  }

  private readSections(): QbliveSections | null {
    const rows = this.sql.exec<{ name: string; body: string }>('SELECT name, body FROM section').toArray();
    if (rows.length === 0) return null;
    const sections: Record<string, unknown> = {};
    for (const row of rows) sections[row.name] = JSON.parse(row.body);
    for (const name of qbliveSectionNames) if (sections[name] === undefined) return null;
    return sections as unknown as QbliveSections;
  }

  private writeSections(sections: Partial<QbliveSections>, revision: number): void {
    for (const [name, value] of Object.entries(sections)) {
      this.sql.exec(
        'INSERT INTO section (name, revision, body) VALUES (?, ?, ?) ' +
          'ON CONFLICT(name) DO UPDATE SET revision = excluded.revision, body = excluded.body',
        name,
        revision,
        JSON.stringify(value),
      );
    }
  }

  private appendEvent(event: QbliveEvent): void {
    this.sql.exec(
      'INSERT INTO event (revision, generated_at, body) VALUES (?, ?, ?) ' +
        'ON CONFLICT(revision) DO UPDATE SET generated_at = excluded.generated_at, body = excluded.body',
      event.revision,
      event.generatedAt,
      JSON.stringify(event),
    );
    // Trimming here rather than on a timer keeps the object's storage bounded without needing an
    // alarm that would wake a hibernating object for housekeeping.
    this.sql.exec('DELETE FROM event WHERE revision <= ?', event.revision - replayWindow);
  }

  private capabilities(): QbliveSnapshot['capabilities'] {
    const oldest = this.sql
      .exec<{ oldest: number | null }>('SELECT MIN(revision) AS oldest FROM event')
      .toArray()[0]?.oldest;
    return {
      snapshot: true,
      events: true,
      stream: true,
      // Set by the push gateway registration flow, which this backend does not itself perform.
      applePush: false,
      ...(oldest === null || oldest === undefined ? {} : { minimumReplayRevision: oldest - 1 }),
    };
  }

  private snapshot(): QbliveSnapshot | null {
    const row = this.publication();
    const sections = this.readSections();
    if (!row || !sections) return null;
    return {
      protocolVersion: QBLIVE_PROTOCOL_VERSION,
      publicationId: row.publication_id,
      revision: row.revision,
      generatedAt: row.generated_at,
      capabilities: this.capabilities(),
      final: row.lifecycle === 'final',
      ...sections,
    };
  }

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  /**
   * Compare a bearer token against the stored hash in constant time.
   *
   * Only the hash is stored: a Durable Object's storage is a copy of the credential otherwise, and
   * there is no reason for this object ever to be able to produce the token it accepts.
   */
  private async authorize(request: Request): Promise<PublicationRow> {
    const row = this.publication();
    if (!row) throw new HttpError(404, 'not-found', 'No such tournament.');
    const header = request.headers.get('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match) throw new HttpError(401, 'unauthorized', 'A management credential is required.');
    if (!row.management_token_hash) {
      throw new HttpError(403, 'forbidden', 'This backend has not been claimed yet.');
    }
    const presented = await sha256Hex(match[1]);
    if (!timingSafeEqual(presented, row.management_token_hash)) {
      throw new HttpError(401, 'unauthorized', 'That management credential is not valid.');
    }
    return row;
  }

  private async readJson(request: Request): Promise<unknown> {
    const declared = Number(request.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > maxBodyBytes) {
      throw new HttpError(413, 'payload-too-large', 'That publication update is too large.');
    }
    const text = await request.text();
    if (text.length > maxBodyBytes) {
      throw new HttpError(413, 'payload-too-large', 'That publication update is too large.');
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError(400, 'bad-request', 'That request body is not valid JSON.');
    }
  }

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    try {
      this.ensureSchema();
      return await this.route(request);
    } catch (reason) {
      if (reason instanceof HttpError) return reason.toResponse();
      if (reason instanceof QbliveValidationError) {
        return new HttpError(400, 'bad-request', reason.message).toResponse();
      }
      return new HttpError(
        500,
        'internal',
        'The tournament backend failed to handle that request.',
      ).toResponse();
    }
  }

  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.replace(/^\/+/, '');
    switch (`${request.method} ${action}`) {
      case 'GET manifest':
        return this.getManifest();
      case 'GET snapshot':
        return this.getSnapshot();
      case 'GET events':
        return this.getEvents(url);
      case 'GET stream':
        return this.openStream(request);
      case 'PUT manage/snapshot':
        return this.putSnapshot(request);
      case 'POST manage/sections':
        return this.postSections(request);
      case 'POST manage/announcements':
        return this.postAnnouncement(request);
      case 'POST manage/finalize':
        return this.finalize(request);
      case 'POST manage/unpublish':
        return this.unpublish(request);
      case 'DELETE manage':
        return this.destroy(request);
      case 'POST manage/claim':
        return this.claim(request);
      default:
        throw new HttpError(404, 'not-found', 'No such QBLive route.');
    }
  }

  // -------------------------------------------------------------------------
  // Public routes
  // -------------------------------------------------------------------------

  private getManifest(): Response {
    const row = this.requireLive();
    const sections = this.readSections();
    if (!sections) throw new HttpError(404, 'not-found', 'This tournament has not published yet.');
    const publicationId = row.publication_id;
    const base = `/qblive/v1/tournaments/${publicationId}`;
    const manifest: QbliveManifest = {
      protocolVersion: QBLIVE_PROTOCOL_VERSION,
      publicationId,
      revision: row.revision,
      generatedAt: row.generated_at,
      tournament: sections.tournament,
      capabilities: this.capabilities(),
      endpoints: { snapshot: `${base}/snapshot`, events: `${base}/events`, stream: `${base}/stream` },
      final: row.lifecycle === 'final',
    };
    return json(manifest, 200, { 'cache-control': 'no-cache' });
  }

  private getSnapshot(): Response {
    this.requireLive();
    const snapshot = this.snapshot();
    if (!snapshot) throw new HttpError(404, 'not-found', 'This tournament has not published yet.');
    return json(snapshot, 200, {
      'cache-control': 'no-cache',
      etag: `"${snapshot.revision}"`,
    });
  }

  private getEvents(url: URL): Response {
    const row = this.requireLive();
    const after = Number(url.searchParams.get('after') ?? '0');
    if (!Number.isInteger(after) || after < 0) {
      throw new HttpError(400, 'bad-request', '`after` must be a non-negative integer.');
    }
    const limit = clamp(Number(url.searchParams.get('limit') ?? '64'), 1, qbliveLimits.maxEventsPerPage);
    const oldest = this.sql
      .exec<{ oldest: number | null }>('SELECT MIN(revision) AS oldest FROM event')
      .toArray()[0]?.oldest;
    // A client asking from before the replay window cannot be caught up by any page we could send,
    // and a short page would look to it like being caught up. Say so instead.
    const resyncRequired =
      after < row.revision && (oldest === null || oldest === undefined || after < oldest - 1);
    const events = resyncRequired
      ? []
      : this.sql
          .exec<{ body: string }>(
            'SELECT body FROM event WHERE revision > ? ORDER BY revision ASC LIMIT ?',
            after,
            limit,
          )
          .toArray()
          .map((entry) => JSON.parse(entry.body) as QbliveEvent);
    return json({
      protocolVersion: QBLIVE_PROTOCOL_VERSION,
      publicationId: row.publication_id,
      currentRevision: row.revision,
      events,
      resyncRequired,
    });
  }

  private openStream(request: Request): Response {
    const row = this.requireLive();
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      throw new HttpError(400, 'bad-request', 'The stream endpoint requires a WebSocket upgrade.');
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // Hibernation-aware accept. The object may be evicted between messages; that is the point.
    this.ctx.acceptWebSocket(server);
    server.send(
      JSON.stringify({
        type: 'hello',
        protocolVersion: QBLIVE_PROTOCOL_VERSION,
        publicationId: row.publication_id,
        revision: row.revision,
      }),
    );
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Spectator sockets are read-only.
   *
   * A frame from a client is answered with a `resync` carrying the current revision, which is the
   * one thing a client could legitimately want and costs nothing. Nothing a spectator sends can
   * change published state; that is what the management API and its credential are for.
   */
  webSocketMessage(ws: WebSocket, _message: string | ArrayBuffer): void {
    const row = this.publication();
    if (!row) return;
    ws.send(JSON.stringify({ type: 'resync', currentRevision: row.revision }));
  }

  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    // 1005 means "no status received", which is not a valid code to send back.
    try {
      ws.close(code === 1005 ? 1000 : code, reason);
    } catch {
      // The socket is already gone; nothing to do.
    }
  }

  webSocketError(): void {
    // Nothing to clean up: connection state lives in the runtime, not in this object.
  }

  private broadcast(frame: unknown): void {
    const body = JSON.stringify(frame);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(body);
      } catch {
        // A socket that has gone away is not an error worth failing a publish over.
      }
    }
  }

  // -------------------------------------------------------------------------
  // Management routes
  // -------------------------------------------------------------------------

  /**
   * Claim a freshly deployed backend.
   *
   * Exchanges the deployment's one-time setup token for a durable management credential, exactly
   * once. The setup token is compared in constant time and the exchange is recorded, so a second
   * attempt fails even with the right token — a token that leaks after a successful claim is worth
   * nothing.
   */
  private async claim(request: Request): Promise<Response> {
    const expected = this.env.QBLIVE_SETUP_TOKEN;
    if (!expected) {
      throw new HttpError(403, 'forbidden', 'This backend has no setup token configured.');
    }
    const body = (await this.readJson(request)) as { setupToken?: unknown; publicationId?: unknown };
    if (typeof body.setupToken !== 'string' || typeof body.publicationId !== 'string') {
      throw new HttpError(400, 'bad-request', 'A setup token and a publication id are required.');
    }
    const consumed = this.sql
      .exec<{ consumed_at: string | null }>('SELECT consumed_at FROM setup WHERE id = 1')
      .toArray()[0];
    if (consumed?.consumed_at) {
      throw new HttpError(403, 'forbidden', 'This backend has already been claimed.');
    }
    if (!timingSafeEqual(await sha256Hex(body.setupToken), await sha256Hex(expected))) {
      throw new HttpError(401, 'unauthorized', 'That setup token is not valid.');
    }
    const managementToken = randomToken();
    const now = new Date().toISOString();
    this.sql.exec(
      'INSERT INTO publication (id, publication_id, revision, lifecycle, generated_at, management_token_hash, created_at, updated_at) ' +
        "VALUES (1, ?, 0, 'live', ?, ?, ?, ?) " +
        'ON CONFLICT(id) DO UPDATE SET publication_id = excluded.publication_id, ' +
        'management_token_hash = excluded.management_token_hash, updated_at = excluded.updated_at',
      body.publicationId,
      now,
      await sha256Hex(managementToken),
      now,
      now,
    );
    this.sql.exec(
      'INSERT INTO setup (id, consumed_at) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET consumed_at = excluded.consumed_at',
      now,
    );
    return json({ publicationId: body.publicationId, managementToken, origin: new URL(request.url).origin });
  }

  private async putSnapshot(request: Request): Promise<Response> {
    // Deliberately accepted while unpublished: publishing a full snapshot is how a director who
    // unpublished by mistake puts the tournament back. Delete, which is the irreversible one, has
    // already destroyed the credential by the time it could matter.
    const row = await this.authorize(request);
    const body = (await this.readJson(request)) as { snapshot?: unknown };
    const snapshot = parseSnapshot(body.snapshot ?? body);
    if (snapshot.publicationId !== row.publication_id) {
      throw new HttpError(400, 'bad-request', 'That snapshot is for a different publication.');
    }
    // A full snapshot is the conflict-repair path, so it is allowed to move the revision backwards
    // as well as forwards: the publisher is asserting the authoritative state, not appending to it.
    const sections: Partial<QbliveSections> = {};
    for (const name of qbliveSectionNames) {
      (sections as Record<string, unknown>)[name] = snapshot[name];
    }
    this.writeSections(sections, snapshot.revision);
    this.setRevision(
      row.publication_id,
      snapshot.revision,
      snapshot.generatedAt,
      snapshot.final ? 'final' : 'live',
    );
    const event: QbliveEvent = {
      revision: snapshot.revision,
      generatedAt: snapshot.generatedAt,
      sections,
      ...(snapshot.final ? { final: true } : {}),
    };
    this.appendEvent(event);
    this.broadcast({ type: 'event', event });
    return json({ publicationId: row.publication_id, revision: snapshot.revision, final: snapshot.final });
  }

  private async postSections(request: Request): Promise<Response> {
    const row = await this.authorize(request);
    if (row.lifecycle !== 'live') {
      throw new HttpError(409, 'conflict', 'This tournament is no longer accepting updates.', row.revision);
    }
    const body = (await this.readJson(request)) as {
      baseRevision?: unknown;
      revision?: unknown;
      generatedAt?: unknown;
      sections?: unknown;
    };
    if (typeof body.baseRevision !== 'number' || typeof body.revision !== 'number') {
      throw new HttpError(400, 'bad-request', '`baseRevision` and `revision` are required.');
    }
    if (typeof body.generatedAt !== 'string') {
      throw new HttpError(400, 'bad-request', '`generatedAt` is required.');
    }
    if (body.revision <= row.revision) {
      throw new HttpError(409, 'conflict', 'That revision has already been published.', row.revision);
    }
    if (body.baseRevision !== row.revision) {
      // The publisher's idea of where the tournament is does not match ours. Refusing with our
      // revision lets it repair with a full snapshot instead of stacking an update on the wrong base.
      throw new HttpError(409, 'conflict', 'The publication has moved on.', row.revision);
    }
    const sections = parseSections(body.sections);
    if (Object.keys(sections).length === 0) {
      throw new HttpError(400, 'bad-request', 'A section update must name at least one section.');
    }
    this.writeSections(sections, body.revision);
    this.setRevision(row.publication_id, body.revision, body.generatedAt, 'live');
    const event: QbliveEvent = { revision: body.revision, generatedAt: body.generatedAt, sections };
    this.appendEvent(event);
    this.broadcast({ type: 'event', event });
    return json({ publicationId: row.publication_id, revision: body.revision, final: false });
  }

  /**
   * An announcement is published as an `announcements` section update.
   *
   * A separate route rather than "just send sections" because Director treats an announcement as a
   * durable event with its own audit trail and its own push class, and because a push gateway needs
   * to be able to tell an announcement from a score tick without diffing.
   */
  private async postAnnouncement(request: Request): Promise<Response> {
    const row = await this.authorize(request);
    if (row.lifecycle !== 'live') {
      throw new HttpError(409, 'conflict', 'This tournament is no longer accepting updates.', row.revision);
    }
    const body = (await this.readJson(request)) as { revision?: unknown; announcement?: unknown };
    if (typeof body.revision !== 'number' || body.revision <= row.revision) {
      throw new HttpError(409, 'conflict', 'That revision has already been published.', row.revision);
    }
    const parsed = parseSections({ announcements: [body.announcement] });
    const announcement = parsed.announcements?.[0];
    if (!announcement) throw new HttpError(400, 'bad-request', 'An announcement is required.');
    const existing = this.readSections()?.announcements ?? [];
    const merged = [announcement, ...existing.filter((entry) => entry.id !== announcement.id)].slice(
      0,
      qbliveLimits.maxAnnouncements,
    );
    const generatedAt = announcement.updatedAt ?? announcement.publishedAt;
    this.writeSections({ announcements: merged }, body.revision);
    this.setRevision(row.publication_id, body.revision, generatedAt, 'live');
    const event: QbliveEvent = { revision: body.revision, generatedAt, sections: { announcements: merged } };
    this.appendEvent(event);
    this.broadcast({ type: 'event', event });
    return json({ publicationId: row.publication_id, revision: body.revision, final: false });
  }

  private async finalize(request: Request): Promise<Response> {
    const row = await this.authorize(request);
    const body = (await this.readJson(request)) as { revision?: unknown; snapshot?: unknown };
    const snapshot = parseSnapshot(body.snapshot);
    const sections: Partial<QbliveSections> = {};
    for (const name of qbliveSectionNames) (sections as Record<string, unknown>)[name] = snapshot[name];
    this.writeSections(sections, snapshot.revision);
    this.setRevision(row.publication_id, snapshot.revision, snapshot.generatedAt, 'final');
    const event: QbliveEvent = {
      revision: snapshot.revision,
      generatedAt: snapshot.generatedAt,
      sections,
      final: true,
    };
    this.appendEvent(event);
    this.broadcast({ type: 'final', revision: snapshot.revision });
    return json({ publicationId: row.publication_id, revision: snapshot.revision, final: true });
  }

  /**
   * Stop serving the tournament publicly while keeping it recoverable.
   *
   * Distinct from delete: the state stays, the credential stays valid, and a director who
   * unpublished by mistake can publish again. Sockets are closed because a client holding one
   * would otherwise keep showing a tournament that is no longer public.
   */
  private async unpublish(request: Request): Promise<Response> {
    const row = await this.authorize(request);
    this.sql.exec(
      "UPDATE publication SET lifecycle = 'unpublished', updated_at = ? WHERE id = 1",
      new Date().toISOString(),
    );
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.close(1000, 'unpublished');
      } catch {
        // Already gone.
      }
    }
    return json({ publicationId: row.publication_id, revision: row.revision, final: false });
  }

  /**
   * Destroy the publication.
   *
   * `deleteAll` rather than dropping tables, so nothing survives in key-value storage either. The
   * object stops existing; a later request to the same id gets a fresh, unclaimed one that cannot
   * be claimed without the setup token.
   */
  private async destroy(request: Request): Promise<Response> {
    const row = await this.authorize(request);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.close(1000, 'deleted');
      } catch {
        // Already gone.
      }
    }
    await this.ctx.storage.deleteAll();
    return json({ publicationId: row.publication_id, revision: row.revision, final: false });
  }

  private setRevision(
    publicationId: string,
    revision: number,
    generatedAt: string,
    lifecycle: Lifecycle,
  ): void {
    this.sql.exec(
      'INSERT INTO publication (id, publication_id, revision, lifecycle, generated_at, created_at, updated_at) ' +
        'VALUES (1, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, lifecycle = excluded.lifecycle, ' +
        'generated_at = excluded.generated_at, updated_at = excluded.updated_at',
      publicationId,
      revision,
      lifecycle,
      generatedAt,
      new Date().toISOString(),
      new Date().toISOString(),
    );
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly currentRevision?: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }

  toResponse(): Response {
    return json(
      {
        error: this.code,
        message: this.message,
        ...(this.currentRevision === undefined ? {} : { currentRevision: this.currentRevision }),
      },
      this.status,
    );
  }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Public tournament data, read by browsers on any origin. There is nothing here that a
      // cross-origin read could learn that a direct read could not, and no credentials are honoured.
      'access-control-allow-origin': '*',
      'access-control-expose-headers': 'etag',
      ...headers,
    },
  });
}

export function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(high, Math.max(low, Math.trunc(value)));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Length-independent comparison of two hex digests.
 *
 * Both operands are SHA-256 output, so they are the same length whenever the input was well formed;
 * the length check is for the malformed case and does not leak anything about the secret.
 */
export function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
