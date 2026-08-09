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
