/**
 * A tournament-control server that speaks exactly one protocol, and refuses the other.
 *
 * # Why refusing matters more than answering
 *
 * A server that serves both surfaces cannot prove which one a client used. That is precisely how a
 * canonical route table and an unreachable `discover()` shipped together with a green test suite:
 * every request the application made landed somewhere, so nothing failed. So the QBTCP server here
 * answers `404` to every `/api/v1` path, and the legacy server answers `404` to discovery. Each one
 * is only usable by a client that genuinely speaks its protocol.
 *
 * # It is deliberately strict about the wire
 *
 * Progress must arrive inside a `{ sequence, match }` envelope with an integer sequence, a session
 * write must carry the session token and not the room token, and the assignment is served as a QBJ
 * document with its operational state in the sibling endpoint. A permissive fixture would let the
 * client's envelope regress without a test noticing, which is the failure this file exists to make
 * impossible.
 *
 * # Nothing here is a reference implementation
 *
 * It is the smallest server that can hold one room, one assignment at a time, and one session. It
 * makes no attempt at rate limiting, uniform pairing failure, or persistence, all of which QBTCP
 * requires of a real server and none of which a client contract test can observe.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readQbjScoringRules } from '../../src/qbj/QbjScoringRules';
import {
  IQbjTeamFixture,
  acfPowersScoringRules,
  assignmentDocument,
  greenwood,
  matchObject,
  ninetySix,
} from '../../tests/qbjDocuments';

export type ControlProtocol = 'qbtcp' | 'legacy';

export const pairingCode = '48213906';
export const roomId = 'room-204';
export const roomName = 'Room 204';

const roomToken = 'room-token-9f13';
const sessionToken = 'session-token-4a72';
const tournamentId = 'Tournament_spring-2026';
const tournamentName = 'Spring Invitational';

const clinton: IQbjTeamFixture = {
  id: 'Team_Clinton',
  registrationId: 'Registration_Clinton',
  name: 'Clinton',
  players: [
    { id: 'Player_Riley', name: 'Riley' },
    { id: 'Player_Quinn', name: 'Quinn' },
    { id: 'Player_Avery', name: 'Avery' },
    { id: 'Player_Rowan', name: 'Rowan' },
  ],
};

const emerald: IQbjTeamFixture = {
  id: 'Team_Emerald',
  registrationId: 'Registration_Emerald',
  name: 'Emerald',
  players: [
    { id: 'Player_Sam', name: 'Sam' },
    { id: 'Player_Drew', name: 'Drew' },
    { id: 'Player_Noor', name: 'Noor' },
    { id: 'Player_Wren', name: 'Wren' },
  ],
};

/** The two games this room plays, in order. */
export const rounds = {
  4: {
    matchId: 'Match_sm-4471',
    label: 'Round 4',
    left: ninetySix,
    right: greenwood,
    starters: ['Sarah', 'James', 'Alex', 'Taylor', 'Emma', 'Jordan', 'Morgan', 'Casey'],
  },
  5: {
    matchId: 'Match_sm-4472',
    label: 'Round 5',
    left: clinton,
    right: emerald,
    starters: ['Riley', 'Quinn', 'Avery', 'Rowan', 'Sam', 'Drew', 'Noor', 'Wren'],
  },
} as const;

export type RoundNumber = keyof typeof rounds;

/**
 * The assignment for a round, as a QBJ document.
 *
 * Deliberately carries no `handoff_instruction`: this is the tournament that wants the result over
 * the wire and nothing else, which is the case the completion screen's new behaviour turns on.
 */
export function assignmentFor(round: RoundNumber): object {
  const spec = rounds[round];
  return assignmentDocument({
    tournamentId,
    tournamentName,
    roundNumber: round,
    roundName: spec.label,
    teams: [spec.left, spec.right],
    scoringRules: acfPowersScoringRules(),
    matches: [
      matchObject({
        id: spec.matchId,
        left: spec.left,
        right: spec.right,
        location: roomName,
        qbtcp: { round_revision: 1, room_id: roomId, scorekeeper: { timed: false } },
      }),
    ],
  });
}

/**
 * The scoring rules the deprecated surface sends inline.
 *
 * Produced by the application's own QBJ rule reader rather than hand-written, so the two surfaces
 * are demonstrably describing the same tournament and a test that passes on one and fails on the
 * other is a protocol difference rather than a fixture difference.
 */
function legacyScoringFormat(): object {
  const read = readQbjScoringRules(acfPowersScoringRules(), false);
  if (!read.ok) throw new Error(`The test fixture's scoring rules are unusable: ${read.problems.join(' ')}`);
  return read.format;
}

/** The pre-QBTCP assignment shape for the same game, so the fallback path is exercised honestly. */
function legacyAssignmentFor(round: RoundNumber | null): object {
  const scoringFormat = legacyScoringFormat();
  if (round === null) {
    return {
      roomId,
      roomName,
      tournamentName,
      tournamentKey: tournamentId,
      current: null,
      session: null,
      scoringFormat,
      timedRounds: false,
    };
  }
  const spec = rounds[round];
  return {
    roomId,
    roomName,
    tournamentName,
    tournamentKey: tournamentId,
    current: {
      scheduledMatchId: spec.matchId,
      roundNumber: round,
      roundName: spec.label,
      roundRevision: 1,
      leftTeam: { name: spec.left.name, players: spec.left.players.map((player) => ({ name: player.name })) },
      rightTeam: {
        name: spec.right.name,
        players: spec.right.players.map((player) => ({ name: player.name })),
      },
      status: 'ready',
    },
    session: null,
    scoringFormat,
    timedRounds: false,
  };
}

export interface IProgressEnvelope {
  sequence: unknown;
  match: unknown;
}

export interface IHelpRequestFixture {
  id: string;
  roomId: string;
  roomName: string;
  category: string;
  message: string;
  status: 'open' | 'cancelled' | 'resolved';
  createdAt: string;
  updatedAt: string;
  deviceId: string;
}

export interface ITournamentControl {
  readonly origin: string;
  readonly protocol: ControlProtocol;
  /** Every path this server was asked for, so a test can prove which surface was used. */
  readonly requests: { method: string; path: string }[];
  /** Every progress body, exactly as it arrived. */
  readonly progress: IProgressEnvelope[];
  readonly results: object[];
  /** Every accepted help request created by this room. */
  readonly helpRequests: IHelpRequestFixture[];
  /** Every POST /help attempt, including attempts answered with a failure. */
  readonly helpPosts: { category: string; message: string }[];
  /** Every final result body, including bodies whose response was deliberately failed. */
  readonly resultAttempts: object[];
  /** Every explicit takeover this server was asked for, with the device that asked. */
  readonly takeovers: { deviceId: unknown; takeOver: unknown }[];
  /** How many session writes have been refused because another device holds the lock. */
  refusedWrites(): number;
  /** Which game the room is assigned, or null for "nothing to play". */
  assign(round: RoundNumber | null): void;
  /** Forget the pairing, as a restarted server would. The room token stops working. */
  revokeRoomToken(): void;
  /** Forget the session but keep the pairing — the failure that reopens rather than re-pairs. */
  revokeSessionToken(): void;
  /**
   * Give the write lock to some other device.
   *
   * Session writes then refuse with `409` and an offer, which is the state a phone taking over from
   * a dead Chromebook leaves the Chromebook in. Cleared only by an explicit takeover.
   */
  giveWriterTo(device: string): void;
  /** Who currently holds the write lock, or null for this room's own device. */
  writerHeldBy(): string | null;
  /** Make the next result request fail with a retryable server response. */
  failNextResult(status?: number, error?: string): void;
  /** Resolve the room's open help request, as tournament control would. */
  resolveHelpRequest(): void;
  /** Make the next help request fail without creating an open request. */
  failNextHelp(status?: number, error?: string): void;
  close(): Promise<void>;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let text = '';
    request.on('data', (chunk) => {
      text += chunk;
    });
    request.on('end', () => resolve(text));
  });
}

/**
 * Start a server on a loopback port.
 *
 * Loopback matters: it keeps the browser's Local Network Access permission and its mixed-content
 * rules out of the test, neither of which is what this test is about. It stays cross-origin, so the
 * CORS half of the protocol is still exercised.
 */
export async function startTournamentControl(protocol: ControlProtocol): Promise<ITournamentControl> {
  const requests: { method: string; path: string }[] = [];
  const progress: IProgressEnvelope[] = [];
  const results: object[] = [];
  const resultAttempts: object[] = [];
  const helpRequests: IHelpRequestFixture[] = [];
  const helpPosts: { category: string; message: string }[] = [];
  const takeovers: { deviceId: unknown; takeOver: unknown }[] = [];
  const openSessions = new Map<string, { matchId: string; token: string }>();
  let assigned: RoundNumber | null = 4;
  let roomTokenValid = true;
  let sessionTokenValid = true;
  let writerDevice: string | null = null;
  let refusedWrites = 0;
  let sessionCounter = 0;
  let nextResultFailure: { status: number; error: string } | null = null;
  let helpCounter = 0;
  let openHelp: IHelpRequestFixture | null = null;
  let nextHelpFailure: { status: number; error: string } | null = null;

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://control.invalid');
      const path = url.pathname;
      const method = request.method ?? 'GET';

      const origin = request.headers.origin;
      if (origin) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin');
      }
      response.setHeader(
        'Access-Control-Allow-Headers',
        'content-type, x-yf-room-token, x-yf-session-token, x-yf-device-id, x-yf-operator-name',
      );
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      if (method === 'OPTIONS') {
        response.writeHead(204).end();
        return;
      }

      requests.push({ method, path });

      const send = (status: number, body?: object, contentType = 'application/json') => {
        if (body === undefined) {
          response.writeHead(status).end();
          return;
        }
        const text = JSON.stringify(body);
        response.writeHead(status, {
          'Content-Type': contentType,
          'Content-Length': Buffer.byteLength(text),
        });
        response.end(text);
      };
      const refuse = (status: number, error: string, extra: object = {}) => send(status, { error, ...extra });

      const roomAuthorized = () => roomTokenValid && request.headers['x-yf-room-token'] === roomToken;
      const sessionAuthorized = () =>
        sessionTokenValid && request.headers['x-yf-session-token'] === sessionToken;
      const deviceForHelp = () => {
        const value = request.headers['x-yf-device-id'];
        return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
      };

      const helpVisibleToThisDevice = () =>
        openHelp !== null && openHelp.deviceId === deviceForHelp() ? openHelp : null;

      const helpResponse = (requestValue: IHelpRequestFixture | null) => ({ request: requestValue });

      const handleHelp = async (helpPath: string, helpMethod: string): Promise<boolean> => {
        const qbtcpHelp = helpPath === '/qbtcp/v1/help';
        const legacyHelp = helpPath === `/api/v1/rooms/${roomId}/help`;
        const deleteMatch = qbtcpHelp
          ? null
          : (/^\/qbtcp\/v1\/help\/([^/]+)$/.exec(helpPath) ??
            new RegExp(`^/api/v1/rooms/${roomId}/help/([^/]+)$`).exec(helpPath));
        if (!(qbtcpHelp || legacyHelp || deleteMatch)) return false;
        if (!roomAuthorized()) {
          refuse(401, 'This room is no longer paired.');
          return true;
        }
        if (helpMethod === 'GET' && (qbtcpHelp || legacyHelp)) {
          send(200, helpResponse(helpVisibleToThisDevice()));
          return true;
        }
        if (helpMethod === 'POST' && (qbtcpHelp || legacyHelp)) {
          const body = JSON.parse((await readBody(request)) || '{}') as {
            category?: unknown;
            message?: unknown;
          };
          const category = typeof body.category === 'string' ? body.category : '';
          const message = typeof body.message === 'string' ? body.message : '';
          helpPosts.push({ category, message });
          if (nextHelpFailure) {
            const failure = nextHelpFailure;
            nextHelpFailure = null;
            refuse(failure.status, failure.error);
            return true;
          }
          const existing = helpVisibleToThisDevice();
          if (existing) {
            send(200, helpResponse(existing));
            return true;
          }
          helpCounter += 1;
          const now = new Date().toISOString();
          openHelp = {
            id: `help-${helpCounter}`,
            roomId,
            roomName,
            category,
            message,
            status: 'open',
            createdAt: now,
            updatedAt: now,
            deviceId: deviceForHelp(),
          };
          helpRequests.push(openHelp);
          send(200, helpResponse(openHelp));
          return true;
        }
        if (helpMethod === 'DELETE' && deleteMatch) {
          const id = decodeURIComponent(deleteMatch[1]);
          if (!openHelp || openHelp.id !== id || openHelp.deviceId !== deviceForHelp()) {
            refuse(404, 'No such open request.');
            return true;
          }
          const now = new Date().toISOString();
          openHelp.status = 'cancelled';
          openHelp.updatedAt = now;
          send(200, helpResponse(openHelp));
          openHelp = null;
          return true;
        }
        refuse(405, 'Method not allowed.');
        return true;
      };

      /**
       * Refuse a write that another device owns.
       *
       * The session token is still perfectly valid — a device without the lock may read — so this is
       * `409` and never `401`. Conflating the two would send a room hunting for a pairing code to
       * fix a problem that a person standing next to the other device has to resolve.
       */
      const writerRefused = () => {
        if (writerDevice === null) return false;
        refusedWrites += 1;
        refuse(409, 'Another device is scoring this game.', {
          writer_device: writerDevice,
          can_take_over: true,
        });
        return true;
      };

      const openSession = async (matchId: string) => {
        // "When a session for that assignment is already open, the server returns the open session."
        for (const [id, open] of openSessions) {
          if (open.matchId === matchId) return { id, token: open.token };
        }
        sessionCounter += 1;
        const id = `sess-${sessionCounter}`;
        openSessions.set(id, { matchId, token: sessionToken });
        return { id, token: sessionToken };
      };

      // --- the surface this server does not speak ---------------------------------------------
      if (protocol === 'qbtcp' && path.startsWith('/api/v1')) {
        refuse(404, 'This server speaks QBTCP. The /api/v1 aliases are not deployed.');
        return;
      }
      if (protocol === 'legacy' && path.startsWith('/qbtcp/v1')) {
        refuse(404, 'Not found');
        return;
      }

      // --- QBTCP -------------------------------------------------------------------------------
      if (protocol === 'qbtcp') {
        if (path === '/qbtcp/v1' && method === 'GET') {
          send(200, {
            protocol: 'QBTCP',
            version: 1,
            capabilities: ['pairing', 'assignment', 'progress', 'result', 'recovery', 'help', 'presence'],
            qbj_version: '2.1.1',
            name: tournamentName,
          });
          return;
        }
        if (path === '/qbtcp/v1/rooms' && method === 'GET') {
          send(200, { rooms: [{ id: roomId, name: roomName }] });
          return;
        }
        if (path === '/qbtcp/v1/pair' && method === 'POST') {
          const body = JSON.parse((await readBody(request)) || '{}') as { code?: string };
          if (body.code !== pairingCode) {
            refuse(401, 'That code is not valid for this tournament.');
            return;
          }
          roomTokenValid = true;
          send(200, { roomId, roomName, token: roomToken });
          return;
        }
        if (path === '/qbtcp/v1/assignment/status' && method === 'GET') {
          if (!roomAuthorized()) {
            refuse(401, 'This room is no longer paired.');
            return;
          }
          const open = [...openSessions].find(
            ([, entry]) => assigned && entry.matchId === rounds[assigned].matchId,
          );
          send(200, {
            state: assigned === null ? 'none' : 'assigned',
            blocked_reason: null,
            blocked_message: null,
            session: open ? { session_id: open[0], resumable: true } : null,
            hold_new_starts: false,
            next:
              assigned === 4
                ? {
                    label: `${rounds[5].label} · ${rounds[5].left.name} vs ${rounds[5].right.name}`,
                  }
                : null,
          });
          return;
        }
        if (path === '/qbtcp/v1/assignment' && method === 'GET') {
          if (!roomAuthorized()) {
            refuse(401, 'This room is no longer paired.');
            return;
          }
          if (assigned === null) {
            send(204);
            return;
          }
          send(200, assignmentFor(assigned), 'application/vnd.quizbowl.qbj+json');
          return;
        }
        if (path === '/qbtcp/v1/sessions' && method === 'POST') {
          if (!roomAuthorized()) {
            refuse(401, 'This room is no longer paired.');
            return;
          }
          const body = JSON.parse((await readBody(request)) || '{}') as {
            match_id?: string;
            device_id?: string;
          };
          if (!body.match_id) {
            refuse(400, 'A session needs a match.');
            return;
          }
          sessionTokenValid = true;
          const opened = await openSession(body.match_id);
          send(200, { session_id: opened.id, token: opened.token, writer: true });
          return;
        }
        const writerMatch = /^\/qbtcp\/v1\/sessions\/([^/]+)\/writer$/.exec(path);
        if (writerMatch && method === 'POST') {
          if (!sessionAuthorized()) {
            refuse(401, 'This session is not open.');
            return;
          }
          const body = JSON.parse((await readBody(request)) || '{}') as {
            device_id?: string;
            take_over?: boolean;
          };
          takeovers.push({ deviceId: body.device_id, takeOver: body.take_over });
          if (body.take_over !== true) {
            refuse(400, 'A change of writer has to be asked for explicitly.');
            return;
          }
          writerDevice = null;
          send(200, { session_id: writerMatch[1], token: sessionToken, writer: true });
          return;
        }
        const progressMatch = /^\/qbtcp\/v1\/sessions\/([^/]+)\/progress$/.exec(path);
        if (progressMatch && method === 'PUT') {
          if (!sessionAuthorized()) {
            refuse(401, 'This session is not open.');
            return;
          }
          if (writerRefused()) return;
          const body = JSON.parse((await readBody(request)) || '{}') as IProgressEnvelope;
          progress.push(body);
          send(200, { accepted: true });
          return;
        }
        const resultMatch = /^\/qbtcp\/v1\/sessions\/([^/]+)\/result$/.exec(path);
        if (resultMatch && method === 'POST') {
          if (!sessionAuthorized()) {
            refuse(401, 'This session is not open.');
            return;
          }
          if (writerRefused()) return;
          const body = JSON.parse((await readBody(request)) || '{}') as object;
          resultAttempts.push(body);
          if (nextResultFailure) {
            const failure = nextResultFailure;
            nextResultFailure = null;
            refuse(failure.status, failure.error);
            return;
          }
          const duplicate = results.length > 0;
          results.push(body);
          send(200, {
            accepted: true,
            match_id: assigned === null ? null : rounds[assigned].matchId,
            fingerprint: `fp-${results.length}`,
            duplicate,
          });
          return;
        }
        if (path === '/qbtcp/v1/presence' && method === 'POST') {
          send(200, {});
          return;
        }
        if (await handleHelp(path, method)) return;
        refuse(404, 'Not found');
        return;
      }

      // --- the deprecated surface --------------------------------------------------------------
      if (path === '/api/v1/status' && method === 'GET') {
        send(200, { status: 'ok' });
        return;
      }
      if (path === '/api/v1/tournament' && method === 'GET') {
        send(200, {
          tournamentKey: tournamentId,
          name: tournamentName,
          scoringFormat: null,
          timedRounds: false,
          roundCount: 9,
          teamCount: 12,
        });
        return;
      }
      if (path === '/api/v1/join/rooms' && method === 'GET') {
        send(200, { rooms: [{ id: roomId, name: roomName }], roomScoringMode: 'paired' });
        return;
      }
      if (path === '/api/v1/join' && method === 'POST') {
        const body = JSON.parse((await readBody(request)) || '{}') as { code?: string };
        if (body.code !== pairingCode) {
          refuse(401, 'That code is not valid for this tournament.');
          return;
        }
        roomTokenValid = true;
        send(200, { roomId, roomName, accessToken: roomToken });
        return;
      }
      if (path === `/api/v1/rooms/${roomId}/assignment` && method === 'GET') {
        if (!roomAuthorized()) {
          refuse(401, 'This room is no longer paired.');
          return;
        }
        send(200, legacyAssignmentFor(assigned));
        return;
      }
      if (path === `/api/v1/rooms/${roomId}/sessions` && method === 'POST') {
        if (!roomAuthorized()) {
          refuse(401, 'This room is no longer paired.');
          return;
        }
        const body = JSON.parse((await readBody(request)) || '{}') as { scheduledMatchId?: string };
        if (!body.scheduledMatchId) {
          refuse(400, 'A session needs a match.');
          return;
        }
        sessionTokenValid = true;
        const opened = await openSession(body.scheduledMatchId);
        send(200, { sessionId: opened.id, token: opened.token });
        return;
      }
      if (/^\/api\/v1\/sessions\/([^/]+)\/snapshot$/.test(path) && method === 'PUT') {
        if (!sessionAuthorized()) {
          refuse(401, 'This session is not open.');
          return;
        }
        const body = JSON.parse((await readBody(request)) || '{}') as Record<string, unknown>;
        // Bare on this surface, so it is recorded in the same shape for the test to compare against.
        progress.push({ sequence: undefined, match: body });
        send(200, { accepted: true });
        return;
      }
      if (/^\/api\/v1\/sessions\/([^/]+)\/final$/.test(path) && method === 'POST') {
        if (!sessionAuthorized()) {
          refuse(401, 'This session is not open.');
          return;
        }
        const body = JSON.parse((await readBody(request)) || '{}') as object;
        resultAttempts.push(body);
        if (nextResultFailure) {
          const failure = nextResultFailure;
          nextResultFailure = null;
          refuse(failure.status, failure.error);
          return;
        }
        results.push(body);
        send(200, { accepted: true });
        return;
      }
      if (await handleHelp(path, method)) return;
      refuse(404, 'Not found');
    })().catch(() => {
      response.writeHead(500).end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${address.port}`,
    protocol,
    requests,
    progress,
    results,
    helpRequests,
    helpPosts,
    resultAttempts,
    takeovers,
    refusedWrites() {
      return refusedWrites;
    },
    assign(round) {
      assigned = round;
    },
    revokeRoomToken() {
      roomTokenValid = false;
    },
    revokeSessionToken() {
      sessionTokenValid = false;
    },
    giveWriterTo(device) {
      writerDevice = device;
    },
    writerHeldBy() {
      return writerDevice;
    },
    failNextResult(status = 503, error = 'Tournament control is temporarily unavailable.') {
      nextResultFailure = { status, error };
    },
    resolveHelpRequest() {
      if (openHelp) {
        openHelp.status = 'resolved';
        openHelp.updatedAt = new Date().toISOString();
      }
      openHelp = null;
    },
    failNextHelp(status = 503, error = 'Tournament control is temporarily unavailable.') {
      nextHelpFailure = { status, error };
    },
    close() {
      return new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}
