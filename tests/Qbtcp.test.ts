/**
 * The protocol surface, and the boundary between what travels and what does not.
 *
 * These are the tests that keep the migration honest in two directions: a server that has never
 * heard of QBTCP must keep working, and nothing that identifies a room or a device may reach a file.
 */
import { describe, expect, test } from 'vitest';
import {
  legacyRoutes,
  qbtcpPrefix,
  qbtcpRoutes,
  readDiscovery,
  routesFor,
  supports,
} from '../src/qbtcp/QbtcpRoutes';
import FruityServerClient, { qbjMediaType } from '../src/integrations/fruity/FruityServerClient';
import { classifyPoll, classifyWrite } from '../src/app/useConnectedRuntime';
import { RoomConnectionState } from '../src/app/ConnectionState';
import { IStoredGameRecord, needsHandoff } from '../src/game/GameStore';
import { assignmentDocument } from './qbjDocuments';
import {
  portableQbj,
  portableQbjDocument,
  portableResultFingerprint,
  readResultOrigin,
  readSourceMetadata,
  stripInternalState,
} from '../src/game/PortableQbj';
import { qbtcpExtensionKey } from '../src/qbj/QbtcpExtension';
import { scorerRecoveryKey } from '../src/scorer/ScorerRecovery';
import { validPackage } from './packages';

const discoveryBody = {
  protocol: 'QBTCP',
  version: 1,
  capabilities: ['pairing', 'assignment', 'progress', 'result'],
  qbj_version: '2.1.1',
  name: 'Spring Invitational',
};

describe('discovery', () => {
  test('a QBTCP server is recognized and its capabilities read', () => {
    const discovery = readDiscovery(discoveryBody);

    expect(discovery?.version).toBe(1);
    expect(discovery?.qbjVersion).toBe('2.1.1');
    expect(supports(discovery, 'assignment')).toBe(true);
    expect(supports(discovery, 'telepathy')).toBe(false);
  });

  test('anything that is not a QBTCP announcement is simply not one', () => {
    expect(readDiscovery({ status: 'ok' })).toBeNull();
    expect(readDiscovery(null)).toBeNull();
    expect(readDiscovery('QBTCP')).toBeNull();
  });

  test('a server that does not answer discovery keeps working on the legacy surface', () => {
    expect(routesFor(null)).toBe(legacyRoutes);
    expect(routesFor(null).assignmentIsQbj).toBe(false);
  });

  test('a protocol version this client does not know degrades rather than guessing', () => {
    const future = readDiscovery({ ...discoveryBody, version: 2 });

    // Announced, understood to exist, and deliberately not spoken.
    expect(future?.version).toBe(2);
    expect(routesFor(future)).toBe(legacyRoutes);
  });

  test('a version 1 server gets the canonical surface', () => {
    expect(routesFor(readDiscovery(discoveryBody))).toBe(qbtcpRoutes);
  });
});

describe('the canonical route surface', () => {
  test('every canonical path is under the protocol prefix', () => {
    const paths = [
      qbtcpRoutes.discovery,
      qbtcpRoutes.pair,
      qbtcpRoutes.rooms,
      qbtcpRoutes.assignment('room-204'),
      qbtcpRoutes.assignmentStatus('room-204') ?? '',
      qbtcpRoutes.openSession('room-204'),
      qbtcpRoutes.presence('room-204'),
      qbtcpRoutes.help('room-204'),
      qbtcpRoutes.progress('sess-1'),
      qbtcpRoutes.result('sess-1'),
      qbtcpRoutes.recovery('sess-1'),
    ];

    for (const path of paths) expect(path.startsWith(qbtcpPrefix)).toBe(true);
  });

  test('a room id never appears in a canonical path, because the token already scopes it', () => {
    expect(qbtcpRoutes.assignment('room-204')).toBe('/qbtcp/v1/assignment');
    expect(qbtcpRoutes.presence('room-204')).toBe('/qbtcp/v1/presence');
    expect(qbtcpRoutes.openSession('room-204')).toBe('/qbtcp/v1/sessions');
    // The legacy surface does route on it, which is why both tables exist.
    expect(legacyRoutes.assignment('room-204')).toContain('room-204');
  });

  test('the renamed session writes point at the same operations', () => {
    expect(qbtcpRoutes.progress('sess-1')).toBe('/qbtcp/v1/sessions/sess-1/progress');
    expect(legacyRoutes.progress('sess-1')).toBe('/api/v1/sessions/sess-1/snapshot');
    expect(qbtcpRoutes.result('sess-1')).toBe('/qbtcp/v1/sessions/sess-1/result');
    expect(legacyRoutes.result('sess-1')).toBe('/api/v1/sessions/sess-1/final');
  });

  test('identifiers in paths are escaped', () => {
    expect(qbtcpRoutes.session('a/../b')).toBe('/qbtcp/v1/sessions/a%2F..%2Fb');
    expect(qbtcpRoutes.helpItem('room-204', 'x y')).toBe('/qbtcp/v1/help/x%20y');
  });
});

/**
 * A recording server, small enough to assert against directly.
 *
 * The browser contract test proves the application reaches the right surface. These prove the
 * shapes it puts on the wire when it gets there, which is the half a screenshot cannot show.
 */
function recordingFetch(handler: (path: string, init: RequestInit) => { status?: number; body?: unknown }) {
  const calls: { path: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetchImpl = (async (input: string, init: RequestInit = {}) => {
    const path = input.replace('http://control.test', '');
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({
      path,
      method: init.method ?? 'GET',
      headers,
      body: typeof init.body === 'string' && init.body !== '' ? JSON.parse(init.body) : undefined,
    });
    const answer = handler(path, init);
    const text = answer.body === undefined ? '' : JSON.stringify(answer.body);
    return {
      ok: (answer.status ?? 200) < 400,
      status: answer.status ?? 200,
      text: async () => text,
    } as Response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const qbtcpDiscovery = {
  protocol: 'QBTCP',
  version: 1,
  capabilities: ['pairing', 'assignment', 'progress', 'result', 'help', 'presence'],
  name: 'Spring Invitational',
};

describe('what the client puts on the wire', () => {
  const identity = { roomId: 'room-204', token: 'room-token', deviceId: 'device-1', roomName: 'Room 204' };
  const credentials = { sessionId: 'sess-1', token: 'session-token' };

  function qbtcpServer(overrides: Record<string, { status?: number; body?: unknown }> = {}) {
    return recordingFetch((path) => {
      if (path in overrides) return overrides[path];
      if (path === '/qbtcp/v1') return { body: qbtcpDiscovery };
      if (path === '/qbtcp/v1/assignment/status') return { body: { state: 'assigned', session: null } };
      if (path === '/qbtcp/v1/assignment') return { body: assignmentDocument() };
      if (path.startsWith('/api/v1')) return { status: 404, body: { error: 'Not found' } };
      return { body: {} };
    });
  }

  test('discovery happens before the first authenticated call, without being asked for', async () => {
    const { calls, fetchImpl } = qbtcpServer();
    // No `discover()` here on purpose: a caller that forgets must not end up on the old surface.
    await new FruityServerClient('http://control.test', fetchImpl).assignment(identity);

    expect(calls[0].path).toBe('/qbtcp/v1');
    expect(calls.map((call) => call.path)).toContain('/qbtcp/v1/assignment');
    expect(calls.some((call) => call.path.startsWith('/api/v1'))).toBe(false);
  });

  test('a server that does not answer discovery is talked to on the deprecated surface', async () => {
    const { calls, fetchImpl } = recordingFetch((path) => {
      if (path === '/qbtcp/v1') return { status: 404, body: { error: 'Not found' } };
      if (path.endsWith('/assignment')) {
        return {
          body: { roomId: 'room-204', roomName: 'Room 204', tournamentName: 'T', current: null, session: null, scoringFormat: null, timedRounds: false },
        };
      }
      return { body: {} };
    });
    const client = new FruityServerClient('http://control.test', fetchImpl);

    const result = await client.assignment(identity);

    expect(client.isQbtcp).toBe(false);
    expect(result.ok).toBe(true);
    expect(calls.map((call) => call.path)).toContain('/api/v1/rooms/room-204/assignment');
  });

  test('progress travels in a sequenced envelope, and the sequence is not inside the match', async () => {
    const { calls, fetchImpl } = qbtcpServer();
    const client = new FruityServerClient('http://control.test', fetchImpl);

    await client.putSnapshot(credentials, { tossups_read: 3 }, 41);
    await client.putSnapshot(credentials, { tossups_read: 4 }, 42);

    const sent = calls.filter((call) => call.path === '/qbtcp/v1/sessions/sess-1/progress');
    expect(sent).toHaveLength(2);
    expect(sent[0].method).toBe('PUT');
    expect(sent[0].headers['x-yf-session-token']).toBe('session-token');
    // Transport metadata beside the match, never a field invented inside the QBJ.
    expect(sent[0].body).toEqual({ sequence: 41, match: { tossups_read: 3 } });
    expect((sent[0].body as { match: object }).match).not.toHaveProperty('sequence');
    expect(sent[1].body).toEqual({ sequence: 42, match: { tossups_read: 4 } });
  });

  test('the deprecated surface gets the snapshot bare, because it has no envelope', async () => {
    const { calls, fetchImpl } = recordingFetch((path) =>
      path === '/qbtcp/v1' ? { status: 404, body: {} } : { body: {} },
    );

    await new FruityServerClient('http://control.test', fetchImpl).putSnapshot(credentials, { tossups_read: 3 }, 41);

    const sent = calls.find((call) => call.path === '/api/v1/sessions/sess-1/snapshot');
    expect(sent?.body).toEqual({ tossups_read: 3 });
  });

  test('a result is sent as a QBJ document, and a duplicate is read as an answer rather than a failure', async () => {
    const { calls, fetchImpl } = qbtcpServer({
      '/qbtcp/v1/sessions/sess-1/result': {
        body: { accepted: true, duplicate: true, match_id: 'Match_sm-4471', fingerprint: 'fp-4471' },
      },
    });

    const result = await new FruityServerClient('http://control.test', fetchImpl).postFinal(credentials, {
      tossups_read: 20,
    });

    const sent = calls.find((call) => call.path === '/qbtcp/v1/sessions/sess-1/result');
    expect(sent?.headers['Content-Type']).toBe(qbjMediaType);
    expect(result.ok && result.value).toEqual({
      accepted: true,
      duplicate: true,
      matchId: 'Match_sm-4471',
      fingerprint: 'fp-4471',
    });
  });

  test('a session is opened with the fields QBTCP names, and its answer is read back', async () => {
    const { calls, fetchImpl } = qbtcpServer({
      '/qbtcp/v1/sessions': { body: { session_id: 'sess-9f13', token: 'session-token', writer: true } },
    });

    const opened = await new FruityServerClient('http://control.test', fetchImpl).openSession(identity, 'sm-4471');

    const sent = calls.find((call) => call.path === '/qbtcp/v1/sessions');
    expect(sent?.body).toEqual({ match_id: 'sm-4471', device_id: 'device-1' });
    expect(sent?.headers['x-yf-room-token']).toBe('room-token');
    expect(opened.ok && opened.value).toEqual({ sessionId: 'sess-9f13', token: 'session-token', writer: true });
  });

  test('the room capability is read under the name QBTCP gives it', async () => {
    const { fetchImpl } = qbtcpServer({
      '/qbtcp/v1/pair': { body: { roomId: 'room-204', roomName: 'Room 204', token: 'opaque-room-token' } },
    });

    const joined = await new FruityServerClient('http://control.test', fetchImpl).join('48213906');

    expect(joined.ok && joined.value.accessToken).toBe('opaque-room-token');
  });

  test('an assignment and its operational state arrive as one normalized answer', async () => {
    const { fetchImpl } = qbtcpServer();

    const result = await new FruityServerClient('http://control.test', fetchImpl).assignment(identity);

    expect(result.ok && result.value.state).toBe('assigned');
    expect(result.ok && result.value.scheduledMatchId).toBe('Match_sm-4471');
    expect(result.ok && result.value.definition?.left.name).toBe('Ninety Six');
    // The QBJ parser produced it, so the standard identities came with it.
    expect(result.ok && result.value.definition?.origin).toBe('qbj');
    expect(result.ok && result.value.tournamentKey).toBe('Tournament_spring-2026');
  });

  test('a status of none is answered without fetching a document there is no point reading', async () => {
    const { calls, fetchImpl } = qbtcpServer({
      '/qbtcp/v1/assignment/status': { body: { state: 'none', session: null } },
    });

    const result = await new FruityServerClient('http://control.test', fetchImpl).assignment(identity);

    expect(result.ok && result.value.state).toBe('none');
    expect(result.ok && result.value.definition).toBeNull();
    expect(calls.some((call) => call.path === '/qbtcp/v1/assignment')).toBe(false);
  });

  test('a 204 is nothing assigned, not an empty game and not an error', async () => {
    // No status endpoint — an early server that shipped the assignment route first — so the body is
    // the only thing speaking, and `204 No Content` has to say what `state: "none"` says.
    const { fetchImpl } = qbtcpServer({
      '/qbtcp/v1/assignment/status': { status: 404, body: { error: 'Not found' } },
      '/qbtcp/v1/assignment': { status: 204 },
    });

    const result = await new FruityServerClient('http://control.test', fetchImpl).assignment(identity);

    expect(result.ok && result.value.state).toBe('none');
    expect(result.ok && result.value.definition).toBeNull();
    expect(result.ok && result.value.errors).toBeUndefined();
  });

  test('an unreachable probe is retried rather than pinning the client to the old surface', async () => {
    let reachable = false;
    const { calls, fetchImpl } = recordingFetch((path) => {
      // Nothing answers at all until the network comes back: no status, which is what a client must
      // not mistake for "this server does not speak QBTCP".
      if (!reachable) throw new Error('offline');
      if (path === '/qbtcp/v1') return { body: qbtcpDiscovery };
      if (path === '/qbtcp/v1/assignment/status') return { body: { state: 'none', session: null } };
      return { body: {} };
    });
    const client = new FruityServerClient('http://control.test', fetchImpl);

    await client.assignment(identity);
    expect(client.isQbtcp).toBe(false);

    const duringOutage = calls.length;
    reachable = true;
    await client.assignment(identity);

    // Asked again once something could answer, and everything after that answer is canonical. What
    // it tried while nothing was listening does not matter; being stuck there afterwards would.
    expect(client.isQbtcp).toBe(true);
    const afterRecovery = calls.slice(duringOutage);
    expect(afterRecovery.map((call) => call.path)).toContain('/qbtcp/v1');
    expect(afterRecovery.map((call) => call.path)).toContain('/qbtcp/v1/assignment/status');
    expect(afterRecovery.some((call) => call.path.startsWith('/api/v1'))).toBe(false);
  });

  test('a session tournament control still has open is reported so the room can rejoin it', async () => {
    const { fetchImpl } = qbtcpServer({
      '/qbtcp/v1/assignment/status': {
        body: { state: 'assigned', session: { session_id: 'sess-9f13', resumable: true } },
      },
    });

    const result = await new FruityServerClient('http://control.test', fetchImpl).assignment(identity);

    expect(result.ok && result.value.session).toEqual({ sessionId: 'sess-9f13', resumable: true });
  });

  test('an assignment control cannot describe is an error the room is told, not an empty screen', async () => {
    const { fetchImpl } = qbtcpServer({
      '/qbtcp/v1/assignment': { body: { version: '2.1.1', objects: [{ type: 'Tournament', name: 'T' }] } },
    });

    const result = await new FruityServerClient('http://control.test', fetchImpl).assignment(identity);

    expect(result.ok && result.value.state).toBe('assigned');
    expect(result.ok && result.value.definition).toBeNull();
    expect(result.ok && result.value.errors?.length).toBeGreaterThan(0);
  });

  /**
   * "A client MUST NOT infer support from the absence of an error."
   *
   * Which means the route is never requested, not that its answer is handled gracefully. Probing to
   * see what comes back *is* the inference the protocol forbids, and against a server that answers
   * an unadvertised route with something plausible it is how a room acts on a guess.
   */
  describe('a capability discovery did not advertise', () => {
    const routeFor: Record<string, string> = {
      pairing: '/qbtcp/v1/pair',
      assignment: '/qbtcp/v1/assignment',
      progress: '/qbtcp/v1/sessions/sess-1/progress',
      result: '/qbtcp/v1/sessions/sess-1/result',
      recovery: '/qbtcp/v1/sessions/sess-1/recovery',
      help: '/qbtcp/v1/help',
      presence: '/qbtcp/v1/presence',
    };
    const every = Object.keys(routeFor);

    const attempt = (client: FruityServerClient, capability: string) => {
      if (capability === 'pairing') return client.join('48213906');
      if (capability === 'assignment') return client.assignment(identity);
      if (capability === 'progress') return client.putSnapshot(credentials, { tossups_read: 3 }, 41);
      if (capability === 'result') return client.postFinal(credentials, { tossups_read: 20 });
      if (capability === 'recovery') return client.recover(credentials);
      if (capability === 'help') return client.requestHelp(identity, 'protest', 'A ruling needs a person.');
      return client.updatePresence(identity, { ready: true });
    };

    for (const capability of every) {
      test(`is not requested: ${capability}`, async () => {
        const withoutIt = every.filter((entry) => entry !== capability);
        const { calls, fetchImpl } = recordingFetch((path) =>
          path === '/qbtcp/v1' ? { body: { ...qbtcpDiscovery, capabilities: withoutIt } } : { body: {} },
        );
        const client = new FruityServerClient('http://control.test', fetchImpl);

        const result = await attempt(client, capability);

        expect(result.ok).toBe(false);
        expect(result.ok === false && result.unsupported).toBe(true);
        expect(calls.map((call) => call.path)).not.toContain(routeFor[capability]);
      });
    }

    test('the room is told before it pairs, not after it has scored a game', async () => {
      const { fetchImpl } = recordingFetch((path) =>
        path === '/qbtcp/v1' ? { body: { ...qbtcpDiscovery, capabilities: ['pairing', 'assignment'] } } : { body: {} },
      );
      const client = new FruityServerClient('http://control.test', fetchImpl);
      await client.verify();

      // A server that cannot take a result is not one this room can score against, and finding that
      // out at the end of a round is finding it out too late to do anything about.
      expect(client.missingCapabilities()).toEqual(['result']);
    });

    test('a pre-QBTCP server is not measured against a document it does not publish', async () => {
      const { fetchImpl } = recordingFetch((path) => (path === '/qbtcp/v1' ? { status: 404, body: {} } : { body: {} }));
      const client = new FruityServerClient('http://control.test', fetchImpl);
      await client.verify();

      expect(client.isQbtcp).toBe(false);
      expect(client.missingCapabilities()).toEqual([]);
    });
  });
});

describe('which repair a refusal calls for', () => {
  test('a refused session token reopens the session rather than asking for a code', () => {
    expect(classifyWrite({ ok: false, status: 401, error: 'no' })).toEqual({ sessionProblem: true, conflict: null });
  });

  /**
   * The two the protocol is careful to separate, and the reason it is careful.
   *
   * `401` is a credential control does not accept: a new pairing code fixes it. `403` is a
   * credential it accepts and will not act on — most often this page's origin missing from the
   * server's allowlist — and no code a director can read out will change that. A client that reads
   * the second as the first throws away a working room capability and sets the scorekeeper a task
   * that cannot succeed, in the middle of a round.
   */
  test('an unrecognized credential asks for a new code', () => {
    const classified = classifyPoll({ ok: false, status: 401, error: 'Unknown room token.' });

    expect(classified.credentialProblem).toBe(true);
    expect(classified.forbidden).toBe(false);
  });

  test('a credential that is recognized and refused keeps the pairing it already has', () => {
    const classified = classifyPoll({
      ok: false,
      status: 403,
      error: 'This browser origin is not approved.',
      detail: 'This browser origin is not approved.',
    });

    expect(classified.credentialProblem).toBe(false);
    expect(classified.forbidden).toBe(true);
    // Not offline either: the server is right there, and answered.
    expect(classified.connection).toBe(RoomConnectionState.Connected);
  });

  test('a writer conflict is a person’s decision, and the offer comes from the server', () => {
    const offered = classifyWrite({
      ok: false,
      status: 409,
      error: 'Another device is scoring this game.',
      payload: { writer_device: 'device-2', can_take_over: true },
    });
    expect(offered.conflict).toEqual({ writerDevice: 'device-2', canTakeOver: true });

    // A conflict with a recorded result carries no offer, so no takeover button appears.
    const notOffered = classifyWrite({ ok: false, status: 409, error: 'Already recorded.', payload: {} });
    expect(notOffered.conflict).toEqual({ canTakeOver: false });
  });

  test('an unreachable server is neither, because nothing refused anything', () => {
    expect(classifyWrite({ ok: false, error: 'Could not reach tournament control.' })).toEqual({
      sessionProblem: false,
      conflict: null,
    });
  });
});

describe('who still owes somebody a copy of the result', () => {
  function finished(overrides: Partial<IStoredGameRecord> = {}): IStoredGameRecord {
    return {
      version: 1,
      id: 'match:sm-4471',
      identity: 'match:sm-4471',
      attempt: 1,
      gameKey: 'sess-1',
      package: validPackage(),
      setup: { left: { name: 'A', players: [] }, right: { name: 'B', players: [] } },
      events: [],
      connected: true,
      createdAt: '2026-04-11T14:00:00.000Z',
      updatedAt: '2026-04-11T15:00:00.000Z',
      completedAt: '2026-04-11T15:00:00.000Z',
      serverDelivery: 'sent',
      ...overrides,
    };
  }

  test('a result tournament control accepted, with nothing else asked for, is delivered', () => {
    expect(needsHandoff(finished())).toBe(false);
  });

  test('a submission that has not landed still has to be carried', () => {
    expect(needsHandoff(finished({ serverDelivery: 'pending' }))).toBe(true);
    expect(needsHandoff(finished({ serverDelivery: 'rejected' }))).toBe(true);
  });

  test('a tournament that asked for the file by name is still asking', () => {
    const instructed = finished({
      package: { ...validPackage(), handoffInstruction: 'Upload to the Round 4 folder.' },
    });
    expect(needsHandoff(instructed)).toBe(true);
    expect(needsHandoff({ ...instructed, qbjDownloadedAt: '2026-04-11T15:01:00.000Z' })).toBe(true);
    expect(
      needsHandoff({
        ...instructed,
        qbjDownloadedAt: '2026-04-11T15:01:00.000Z',
        handoffAcknowledgedAt: '2026-04-11T15:02:00.000Z',
      }),
    ).toBe(false);
  });

  test('a game with no tournament control behind it only ever had the file', () => {
    const offline = finished({ connected: false, serverDelivery: 'none' });
    expect(needsHandoff(offline)).toBe(true);
    expect(needsHandoff({ ...offline, qbjDownloadedAt: '2026-04-11T15:01:00.000Z' })).toBe(false);
  });

  test('an unfinished game owes nobody anything yet', () => {
    expect(needsHandoff(finished({ completedAt: undefined, serverDelivery: 'pending' }))).toBe(false);
  });
});

describe('the portable boundary', () => {
  const withSecrets = {
    tossups_read: 20,
    match_teams: [{ points: 300 }],
    roomToken: 'super-secret',
    'session-token': 'also-secret',
    deviceId: 'device-1',
    [scorerRecoveryKey]: { events: [{ type: 'tossup-dead' }] },
  };

  test('credentials and the private recovery journal never leave the device', () => {
    const stripped = stripInternalState(withSecrets) as Record<string, unknown>;

    expect(stripped.roomToken).toBeUndefined();
    expect(stripped['session-token']).toBeUndefined();
    expect(stripped.deviceId).toBeUndefined();
    expect(stripped[scorerRecoveryKey]).toBeUndefined();
    // The game itself is untouched.
    expect(stripped.tossups_read).toBe(20);
  });

  test('a serialized document goes through the same boundary', () => {
    const document = { version: '2.1.1', objects: [{ type: 'Match', ...withSecrets }] };

    const portable = portableQbjDocument(document) as { objects: Record<string, unknown>[] };

    expect(portable.objects[0].roomToken).toBeUndefined();
    expect(portable.objects[0][scorerRecoveryKey]).toBeUndefined();
    expect(portable.objects[0].tossups_read).toBe(20);
  });

  test('a serialized document is not given a legacy source block', () => {
    const document = { version: '2.1.1', objects: [{ type: 'Match', id: 'Match_1' }] };

    const portable = portableQbjDocument(document) as Record<string, unknown>;

    // Its identity is already in Tournament, Round and Match; restating it would be duplication.
    expect(portable._qbsheet_source).toBeUndefined();
  });
});

describe('the result fingerprint', () => {
  const scored = { tossups_read: 20, match_teams: [{ points: 300 }, { points: 250 }] };

  test('transport metadata does not change it', () => {
    const bare = portableResultFingerprint(scored);
    const viaQbtcp = portableResultFingerprint({
      ...scored,
      [qbtcpExtensionKey]: { version: 1, round_revision: 3, room_id: 'room-204' },
    });
    const viaLegacyBlock = portableResultFingerprint({ ...scored, _qbsheet_source: { roundRevision: 3 } });

    // The same game scored once is one result, however it travelled.
    expect(viaQbtcp).toBe(bare);
    expect(viaLegacyBlock).toBe(bare);
  });

  test('key order does not change it', () => {
    const reordered = { match_teams: [{ points: 300 }, { points: 250 }], tossups_read: 20 };

    expect(portableResultFingerprint(reordered)).toBe(portableResultFingerprint(scored));
  });

  test('the private recovery journal does not change it', () => {
    const withJournal = { ...scored, [scorerRecoveryKey]: { events: [1, 2, 3] } };

    expect(portableResultFingerprint(withJournal)).toBe(portableResultFingerprint(scored));
  });

  test('actually different statistics do change it', () => {
    const different = { ...scored, match_teams: [{ points: 305 }, { points: 250 }] };

    expect(portableResultFingerprint(different)).not.toBe(portableResultFingerprint(scored));
  });
});

describe('reading where a result came from', () => {
  test('the new extension is preferred', () => {
    const origin = readResultOrigin({
      [qbtcpExtensionKey]: { version: 1, round_revision: 4, room_id: 'room-204' },
    });

    expect(origin).toEqual({ roundRevision: 4, roomId: 'room-204' });
  });

  test('a result written before the migration still reconciles', () => {
    const legacy = portableQbj({ tossups_read: 20 }, validPackage());

    expect(readSourceMetadata(legacy)?.roundRevision).toBe(1);
    expect(readResultOrigin(legacy)?.roundRevision).toBe(1);
  });

  test('a result with neither block says so rather than inventing a revision', () => {
    expect(readResultOrigin({ tossups_read: 20 })).toBeNull();
  });
});
