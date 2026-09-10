/**
 * A minimal scripted QBTCP relay for testing the conformance suite.
 *
 * Speaks just enough of the relay surface for `runRelayConformance` to exercise every check:
 * claim, mirror (with fencing), pairing (uniform refusal), sessions, results with idempotency,
 * events, acks, health, help, and a hand-rolled RFC 6455 WebSocket endpoint (Node has no server
 * side built in). Each rule can be broken on demand, so the tests prove the checks are
 * load-bearing rather than decorative.
 */

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

export interface StubOptions {
  badDescriptor?: boolean;
  noReceipt?: boolean;
  acceptStaleMirror?: boolean;
  scopeConfusion?: boolean;
  notDuplicate?: boolean;
}

interface OpenSocket {
  socket: Socket;
  authed: boolean;
  buffer: Buffer;
}

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sendText(socket: Socket, text: string): void {
  const payload = Buffer.from(text);
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x81, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    throw new Error('stub frame too large');
  }
  socket.write(Buffer.concat([header, payload]));
}

export class StubRelay {
  private server: Server;
  private sockets = new Set<OpenSocket>();
  private managementToken = 'm'.repeat(64);
  private claimedTournament = 'stub-tournament';
  private mirrorRevision = 0;
  private pairingHash: string | null = null;
  private results: { result_id: string; retry_key: string | null; qbj: unknown }[] = [];
  readonly origin: Promise<string>;

  constructor(private options: StubOptions = {}) {
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        if (!response.headersSent) {
          response.writeHead(500, { 'content-type': 'application/json' });
          response.end('{}');
        }
      });
    });
    this.server.on('upgrade', (request, socket) => this.handleUpgrade(request, socket as unknown as Socket));
    this.origin = new Promise<string>((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server.address();
        if (typeof address === 'string' || address === null) throw new Error('no address');
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
  }

  async close(): Promise<void> {
    for (const entry of this.sockets) entry.socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private send(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  }

  private async readBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    if (text.trim() === '') return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }

  private isManager(request: IncomingMessage): boolean {
    if (this.options.scopeConfusion) return true;
    return request.headers.authorization === `Bearer ${this.managementToken}`;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://stub');
    const path = url.pathname;
    const method = request.method ?? 'GET';
    const body = await this.readBody(request);

    if (path === '/health' && method === 'GET') {
      this.send(response, 200, { service: 'qbtcp-relay', protocolVersion: 1 });
      return;
    }
    if (path === '/qbtcp/v1/manage/claim' && method === 'POST') {
      const setup = (body as { setupToken?: string }).setupToken;
      if (setup !== 'good-token') {
        this.send(response, 401, { error: 'invalid_credential', message: 'That setup token is not valid.' });
        return;
      }
      this.claimedTournament = (body as { tournamentId?: string }).tournamentId ?? 'stub-tournament';
      this.send(response, 200, {
        tournamentId: this.claimedTournament,
        managementToken: this.managementToken,
      });
      return;
    }

    const tournament = /^\/qbtcp\/v1\/tournaments\/([^/]+)\/(.+)$/.exec(path);
    if (tournament) {
      const [, tournamentId, action] = tournament;
      if (tournamentId !== this.claimedTournament) {
        this.send(response, 404, { error: 'not_found', message: 'No such tournament.' });
        return;
      }
      if (action === 'discovery' && method === 'GET') {
        this.send(response, 200, {
          protocol: 'QBTCP',
          version: 1,
          capabilities: [
            'pairing',
            'assignment',
            'progress',
            'result',
            'recovery',
            'help',
            'presence',
            'stream',
          ],
          qbj_version: '2.1.1',
          stream: this.options.badDescriptor
            ? {
                endpoint: 'https://evil.example/stream',
                frames: 2,
                retains_finals: false,
                mirrors_assignment: false,
                replay: [],
                max_frame_bytes: 0,
                ticket: 'yes',
                token: 'leaked',
              }
            : {
                endpoint: `/qbtcp/v1/tournaments/t/stream`,
                frames: 1,
                retains_finals: true,
                mirrors_assignment: true,
                replay: ['sequence', 'resync'],
                max_frame_bytes: 1_048_576,
                ticket: false,
              },
        });
        return;
      }
      if (action === 'pair' && method === 'POST') {
        const code = (body as { code?: unknown }).code;
        const roomId = (body as { room_id?: unknown }).room_id;
        const match =
          typeof code === 'string' &&
          this.pairingHash !== null &&
          sha256Hex(code) === this.pairingHash &&
          (roomId === undefined || roomId === 'room-a');
        if (!match) {
          this.send(response, 401, { error: 'pairing_refused', message: 'The pairing code is not valid.' });
          return;
        }
        this.send(response, 200, { room_id: 'room-a', room_name: 'Room A', token: 'roomtok' });
        return;
      }
      if (action === 'sessions' && method === 'POST') {
        if (request.headers['x-yf-room-token'] !== 'roomtok') {
          this.send(response, 401, {
            error: 'invalid_credential',
            message: 'The supplied credential is not valid.',
          });
          return;
        }
        this.send(response, 200, { session_id: 'sess-1', token: 'sesstok', writer: true });
        return;
      }
      const resultPost = /^sessions\/([^/]+)\/result$/.exec(action);
      if (resultPost && method === 'POST') {
        const retryKey = (body as { retry_key?: string }).retry_key ?? null;
        const existing = this.results.find(
          (entry) => entry.retry_key !== null && entry.retry_key === retryKey,
        );
        if (existing && !this.options.notDuplicate) {
          this.send(response, 200, {
            received: true,
            review_required: true,
            accepted_by_director: false,
            duplicate: true,
            match_id: 'conf-match-1',
            fingerprint: 'fp',
            result_id: existing.result_id,
          });
          return;
        }
        const resultId = `result-${this.results.length + 1}`;
        this.results.push({ result_id: resultId, retry_key: retryKey, qbj: (body as { qbj?: unknown }).qbj });
        this.send(response, 200, {
          received: true,
          review_required: true,
          accepted_by_director: false,
          duplicate: false,
          match_id: 'conf-match-1',
          fingerprint: 'fp',
          result_id: resultId,
        });
        return;
      }
      if (action === 'help' && method === 'POST') {
        this.send(response, 200, { request: { id: 'help-1', status: 'open' } });
        return;
      }
      this.send(response, 404, { error: 'not_found', message: 'No such relay route.' });
      return;
    }

    const managed = /^\/qbtcp\/v1\/manage\/tournaments\/([^/]+)(?:\/(.+))?$/.exec(path);
    if (managed) {
      if (!this.isManager(request)) {
        this.send(response, 401, {
          error: 'invalid_credential',
          message: 'That management credential is not valid.',
        });
        return;
      }
      const action = managed[2] ?? '';
      if (action === 'mirror' && method === 'PUT') {
        const revision = (body as { revision?: number }).revision ?? 0;
        if (!this.options.acceptStaleMirror && revision <= this.mirrorRevision) {
          this.send(response, 409, {
            error: 'conflict',
            message: 'stale',
            currentRevision: this.mirrorRevision,
          });
          return;
        }
        this.mirrorRevision = revision;
        const rooms = (body as { rooms?: { pairing_code_hash?: string }[] }).rooms ?? [];
        for (const room of rooms) {
          if (room.pairing_code_hash) this.pairingHash = room.pairing_code_hash;
        }
        const round = (body as { rooms?: { round_revision?: number }[] }).rooms?.[0]?.round_revision;
        this.send(response, 200, { tournamentId: 'x', revision });
        if (round === 4)
          this.broadcast({
            version: 1,
            type: 'assignment-changed',
            sequence: 9,
            payload: { round_revision: 4 },
          });
        return;
      }
      if (action === 'events' && method === 'GET') {
        this.send(response, 200, {
          tournamentId: 'x',
          currentRevision: 9,
          events: this.results.map((entry, index) => ({
            revision: index + 1,
            kind: 'result',
            entity_id: entry.result_id,
            body: {},
            created_at: '',
          })),
          resyncRequired: false,
        });
        return;
      }
      if (action === 'results' && method === 'GET') {
        this.send(response, 200, {
          tournamentId: 'x',
          revision: 9,
          results: this.results.map((entry) => ({
            ...entry,
            session_id: 'sess-1',
            room_id: 'room-a',
            received_at: '',
          })),
        });
        return;
      }
      if (action === 'acks' && method === 'POST') {
        const ids = new Set((body as { results?: string[] }).results ?? []);
        const acked = this.results.filter((entry) => ids.has(entry.result_id)).length;
        this.results = this.results.filter((entry) => !ids.has(entry.result_id));
        this.send(response, 200, { acked_results: acked, acked_help: 0 });
        return;
      }
      if (action === 'sessions' && method === 'GET') {
        this.send(response, 200, {
          tournamentId: 'x',
          revision: 9,
          sessions: [
            { session_id: 'sess-1', room_id: 'room-a', progress_sequence: 1, results: [], presence: [] },
          ],
        });
        return;
      }
      if (action === 'health' && method === 'GET') {
        this.send(response, 200, {
          tournamentId: 'x',
          capabilities: { retainsFinals: true, mirrorsAssignment: true, ticket: false },
          mirror: { revision: this.mirrorRevision, director_epoch: 1 },
          counters: { http_requests: 10, progress_accepted: 1 },
          budget: { limits: { rows_written_per_day: 100_000 }, headroom: {} },
          storage: {},
        });
        return;
      }
      const resolve = /^help\/([^/]+)\/resolve$/.exec(action);
      if (resolve && method === 'POST') {
        this.send(response, 200, { request: { id: resolve[1], status: 'resolved' } });
        return;
      }
      this.send(response, 404, { error: 'not_found', message: 'No such relay route.' });
      return;
    }

    this.send(response, 404, { error: 'not_found', message: 'No such relay route.' });
  }

  private broadcast(frame: unknown): void {
    for (const entry of this.sockets) {
      if (entry.authed) sendText(entry.socket, JSON.stringify(frame));
    }
  }

  private handleUpgrade(request: IncomingMessage, socket: Socket): void {
    const key = request.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1')
      .update(key + WS_GUID)
      .digest('base64');
    // RFC 6455: a client that offers subprotocols fails the connection unless the server
    // selects one. The stub selects the only framing it speaks.
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        'Sec-WebSocket-Protocol: qbtcp.stream.v1\r\n' +
        '\r\n',
    );
    const entry: OpenSocket = { socket, authed: false, buffer: Buffer.alloc(0) };
    this.sockets.add(entry);
    socket.on('data', (data: Buffer) => {
      entry.buffer = Buffer.concat([entry.buffer, data]);
      for (const text of this.takeFrames(entry)) this.handleFrame(entry, text);
    });
    socket.on('close', () => this.sockets.delete(entry));
    socket.on('error', () => this.sockets.delete(entry));
  }

  /** Parse client frames, unmasking payloads per RFC 6455. */
  private takeFrames(entry: OpenSocket): string[] {
    const out: string[] = [];
    for (;;) {
      if (entry.buffer.length < 2) return out;
      const opcode = entry.buffer[0] & 0x0f;
      const masked = (entry.buffer[1] & 0x80) !== 0;
      let length = entry.buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (entry.buffer.length < 4) return out;
        length = entry.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (entry.buffer.length < 10) return out;
        length = Number(entry.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (masked && entry.buffer.length < offset + 4) return out;
      const mask = masked ? entry.buffer.subarray(offset, offset + 4) : null;
      const start = offset + (masked ? 4 : 0);
      if (entry.buffer.length < start + length) return out;
      const payload = Buffer.from(entry.buffer.subarray(start, start + length));
      entry.buffer = entry.buffer.subarray(start + length);
      if (opcode === 0x8) {
        entry.socket.end();
        return out;
      }
      if (opcode === 0x9) {
        entry.socket.write(Buffer.from([0x8a, 0x00]));
        continue;
      }
      if (opcode !== 0x1 && opcode !== 0x0) continue;
      if (mask) {
        for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
      }
      out.push(payload.toString('utf8'));
    }
  }

  private handleFrame(entry: OpenSocket, text: string): void {
    let frame: { version?: number; type?: string; session_id?: string; payload?: Record<string, unknown> };
    try {
      frame = JSON.parse(text) as typeof frame;
    } catch {
      sendText(
        entry.socket,
        JSON.stringify({ version: 1, type: 'error', payload: { code: 'malformed', message: 'bad' } }),
      );
      return;
    }
    if (!entry.authed) {
      if (frame.type !== 'authenticate') {
        sendText(
          entry.socket,
          JSON.stringify({
            version: 1,
            type: 'error',
            payload: { code: 'unauthorized', message: 'auth first' },
          }),
        );
        return;
      }
      const payload = frame.payload ?? {};
      if (payload.room_token !== 'roomtok' && payload.session_token !== 'sesstok') {
        sendText(
          entry.socket,
          JSON.stringify({ version: 1, type: 'error', payload: { code: 'unauthorized', message: 'no' } }),
        );
        return;
      }
      entry.authed = true;
      sendText(
        entry.socket,
        JSON.stringify({
          version: 1,
          type: 'hello',
          sequence: 9,
          payload: { tournament_id: this.claimedTournament, relay_revision: 9 },
        }),
      );
      return;
    }
    if (frame.version !== 1) {
      sendText(
        entry.socket,
        JSON.stringify({
          version: 1,
          type: 'error',
          payload: { code: 'unsupported-version', message: 'v1 only' },
        }),
      );
      return;
    }
    switch (frame.type) {
      case 'final': {
        if (this.options.noReceipt) return;
        sendText(
          entry.socket,
          JSON.stringify({
            version: 1,
            type: 'receipt',
            session_id: frame.session_id,
            payload: {
              received: true,
              review_required: true,
              accepted_by_director: false,
              duplicate: false,
              result_id: 'result-1',
            },
          }),
        );
        this.results.push({ result_id: 'result-1', retry_key: 'conf-retry-1', qbj: {} });
        return;
      }
      case 'recover': {
        sendText(
          entry.socket,
          JSON.stringify({
            version: 1,
            type: 'recovery',
            session_id: frame.session_id,
            payload: { session_id: frame.session_id, status: 'open' },
          }),
        );
        return;
      }
      default:
        return;
    }
  }
}
