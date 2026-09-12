import { describe, expect, test } from 'vitest';
import { emptyState, type BridgeState } from './persistence';
import {
  decryptRecoveryPackage,
  describeRecoveryFreshness,
  describeTakeoverDrift,
  encryptRecoveryPackage,
  readRecoveryDigests,
  readTakeoverReview,
  recoveryDigests,
  recoveryPackageState,
  yftFingerprint,
  type RecoveryBaseline,
  type RecoveryPackageState,
} from './recovery';
import { newRoom } from './rooms';
import type { RoundPlan } from './roundPlans';

const primaryToken = 'primary-management-secret';
const backupToken = 'backup-management-secret';

function stateWithRelay() {
  return {
    ...emptyState(),
    relay: {
      baseUrl: 'https://relay.example.workers.dev',
      tournamentId: 'bcdfghjkmnpqrstvwxyz2345',
      managementToken: primaryToken,
      epoch: 4,
      revision: 12,
      controllerRole: 'primary' as const,
    },
    tournamentName: 'Spring Invitational',
  };
}

describe('encrypted recovery packages', () => {
  test('encrypts only an opaque envelope and restores backup access', async () => {
    const payload = recoveryPackageState(stateWithRelay(), {
      managementToken: backupToken,
      controllerId: 'backup-123',
      label: 'Backup laptop',
    });
    const contents = await encryptRecoveryPackage(payload, 'correct horse battery staple');
    const envelope = JSON.parse(contents) as Record<string, unknown>;

    expect(envelope).toMatchObject({
      format: 'qbsheet-bridge-recovery',
      version: 1,
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 210000 },
      cipher: { name: 'AES-GCM' },
    });
    expect(contents).not.toContain(primaryToken);
    expect(contents).not.toContain(backupToken);
    expect(contents).not.toContain('Spring Invitational');

    const restored = await decryptRecoveryPackage(contents, 'correct horse battery staple');
    expect(restored.state.relay).toMatchObject({
      baseUrl: stateWithRelay().relay.baseUrl,
      tournamentId: stateWithRelay().relay.tournamentId,
      managementToken: backupToken,
      controllerRole: 'backup',
      controllerId: 'backup-123',
      controllerLabel: 'Backup laptop',
      epoch: 4,
      revision: 12,
    });
    expect(restored.state.relay?.managementToken).not.toBe(primaryToken);
  });

  test('rejects a wrong passphrase and tampering', async () => {
    const payload = recoveryPackageState(stateWithRelay(), {
      managementToken: backupToken,
      controllerId: 'backup-123',
      label: 'Backup laptop',
    });
    const contents = await encryptRecoveryPackage(payload, 'correct horse battery staple');
    await expect(decryptRecoveryPackage(contents, 'wrong passphrase')).rejects.toThrow(
      /could not be decrypted/i,
    );

    const envelope = JSON.parse(contents) as { ciphertext: string };
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -1)}${envelope.ciphertext.endsWith('A') ? 'B' : 'A'}`;
    await expect(
      decryptRecoveryPackage(JSON.stringify(envelope), 'correct horse battery staple'),
    ).rejects.toThrow(/could not be decrypted/i);
  });

  test('requires a relay, a backup credential, and a strong passphrase', async () => {
    expect(() =>
      recoveryPackageState(emptyState(), {
        managementToken: backupToken,
        controllerId: 'backup-123',
        label: 'Backup laptop',
      }),
    ).toThrow(/connect a relay/i);

    const payload = recoveryPackageState(stateWithRelay(), {
      managementToken: backupToken,
      controllerId: 'backup-123',
      label: 'Backup laptop',
    });
    await expect(encryptRecoveryPackage(payload, 'short')).rejects.toThrow(/12 characters/i);

    const notBackup = {
      ...payload,
      state: { ...payload.state, relay: { ...payload.state.relay!, controllerRole: 'primary' as const } },
    } as RecoveryPackageState;
    const contents = await encryptRecoveryPackage(notBackup, 'correct horse battery staple');
    await expect(decryptRecoveryPackage(contents, 'correct horse battery staple')).rejects.toThrow(
      /backup controller credential/i,
    );
  });
});

describe('recovery freshness', () => {
  function stateAtPackageTime(): BridgeState {
    return {
      ...emptyState(),
      yftFingerprint: yftFingerprint('yellowfruit-bytes'),
      relay: {
        baseUrl: 'https://relay.example.workers.dev',
        tournamentId: 'bcdfghjkmnpqrstvwxyz2345',
        managementToken: primaryToken,
        epoch: 4,
        revision: 12,
        controllerRole: 'primary',
      },
      rooms: [newRoom('room-1', 'Room 101', '11112222'), newRoom('room-2', 'Room 102', '33334444')],
      roundPlans: [
        {
          roundId: 'round-4',
          pairings: [{ roomId: 'room-1', leftTeamId: 'Team_A', rightTeamId: 'Team_B' }],
        } satisfies RoundPlan,
      ],
      results: [{ resultId: 'res-1', qbj: { game: 1 }, receivedAt: '2026-09-11T15:00:00Z' }],
    };
  }

  function baselineFor(state: BridgeState): RecoveryBaseline {
    return {
      createdAt: '2026-09-11T14:00:00.000Z',
      yftFingerprint: state.yftFingerprint,
      digests: recoveryDigests(state),
      relayEpoch: state.relay?.epoch ?? 0,
      relayRevision: state.relay?.revision ?? 0,
    };
  }

  test('fingerprints are stable identity hashes, not secrets', () => {
    expect(yftFingerprint('yellowfruit-bytes')).toBe(yftFingerprint('yellowfruit-bytes'));
    expect(yftFingerprint('yellowfruit-bytes')).toMatch(/^[0-9a-f]{16}$/);
    expect(yftFingerprint('yellowfruit-bytes')).not.toBe(yftFingerprint('yellowfruit-bytes!'));
  });

  test('digests ignore ordering but catch renames, code changes, and saves', () => {
    const state = stateAtPackageTime();
    const before = recoveryDigests(state);
    const reordered = {
      ...state,
      rooms: [...state.rooms].reverse(),
      roundPlans: state.roundPlans.map((plan) => ({ ...plan })),
    };
    expect(recoveryDigests(reordered)).toEqual(before);

    // A renamed room moves room identity but must not read as changed codes.
    const renamed = {
      ...state,
      rooms: state.rooms.map((room) => (room.id === 'room-1' ? { ...room, name: 'Room 103' } : room)),
    };
    const renamedDigests = recoveryDigests(renamed);
    expect(renamedDigests.roomIdentity).not.toBe(before.roomIdentity);
    expect(renamedDigests.pairingCodes).toBe(before.pairingCodes);

    // A regenerated code moves codes but must not read as rebuilt rooms.
    const recoded = {
      ...state,
      rooms: state.rooms.map((room) =>
        room.id === 'room-1' ? { ...room, pendingPairingCode: '99990000' } : room,
      ),
    };
    const recodedDigests = recoveryDigests(recoded);
    expect(recodedDigests.pairingCodes).not.toBe(before.pairingCodes);
    expect(recodedDigests.roomIdentity).toBe(before.roomIdentity);

    // A saved result moves the results digest.
    const saved = {
      ...state,
      results: state.results.map((entry) => ({ ...entry, savedPath: '/tournaments/results/r.qbj' })),
    };
    expect(recoveryDigests(saved).results).not.toBe(before.results);

    // ACK state, import markers, and saves are all operational result state: a package that
    // predates any of them must read as stale, never current.
    const acked = {
      ...state,
      results: state.results.map((entry) => ({ ...entry, ackPending: false as const })),
    };
    expect(recoveryDigests(acked).results).not.toBe(before.results);
    const imported = {
      ...state,
      results: state.results.map((entry) => ({ ...entry, importStatus: 'imported' as const })),
    };
    expect(recoveryDigests(imported).results).not.toBe(before.results);
  });

  test('a package-time state reads as current, and every category ages independently', () => {
    const state = stateAtPackageTime();
    const atCreation = { ...state, lastRecoveryPackage: baselineFor(state) };
    const fresh = describeRecoveryFreshness(atCreation, Date.parse('2026-09-11T14:30:00.000Z'));
    expect(fresh).toMatchObject({ stale: false, ageMs: 30 * 60 * 1000 });
    expect(fresh?.changed).toEqual({
      rooms: false,
      codes: false,
      plans: false,
      yft: false,
      relay: false,
      results: false,
    });

    const roomsMoved = {
      ...atCreation,
      rooms: [...atCreation.rooms, newRoom('room-3', 'Room 103', '55556666')],
    };
    expect(describeRecoveryFreshness(roomsMoved)?.changed.rooms).toBe(true);
    expect(describeRecoveryFreshness(roomsMoved)?.stale).toBe(true);

    const relayMoved = {
      ...atCreation,
      relay: atCreation.relay ? { ...atCreation.relay, revision: 13 } : null,
    };
    const relayFreshness = describeRecoveryFreshness(relayMoved);
    expect(relayFreshness?.changed).toMatchObject({ relay: true, rooms: false });
    expect(relayFreshness?.currentRelay).toEqual({ epoch: 4, revision: 13 });

    const yftReloaded = { ...atCreation, yftFingerprint: yftFingerprint('roster-changed-bytes') };
    expect(describeRecoveryFreshness(yftReloaded)?.changed).toMatchObject({ yft: true, plans: false });
  });

  test('no baseline means no opinion, and a bad date reads as age zero', () => {
    expect(describeRecoveryFreshness(emptyState())).toBeNull();
    const state = stateAtPackageTime();
    const baseline = { ...baselineFor(state), createdAt: 'not-a-date' };
    expect(describeRecoveryFreshness({ ...state, lastRecoveryPackage: baseline })?.ageMs).toBe(0);
  });

  test('stored digests are validated, never trusted', () => {
    const state = stateAtPackageTime();
    expect(readRecoveryDigests(recoveryDigests(state))).toEqual(recoveryDigests(state));
    expect(readRecoveryDigests(null)).toBeNull();
    expect(readRecoveryDigests({})).toBeNull();
    expect(readRecoveryDigests({ ...recoveryDigests(state), plans: 'xyz' })).toBeNull();
  });
});

describe('takeover drift', () => {
  const packaged = [
    { id: 'room-1', name: 'Room 101', publishedMatchId: null as string | null, assignmentRevision: 0 },
    { id: 'room-2', name: 'Room 102', publishedMatchId: 'match-old', assignmentRevision: 3 },
  ];

  test('only strictly newer relay proof counts as drift', () => {
    expect(describeTakeoverDrift(packaged, [])).toEqual([]);
    // Same revision is the package's own past, not an alarm.
    expect(
      describeTakeoverDrift(packaged, [{ roomId: 'room-2', matchId: 'match-old', assignmentRevision: 3 }]),
    ).toEqual([]);
    // Older events are history the package already survived.
    expect(
      describeTakeoverDrift(packaged, [{ roomId: 'room-2', matchId: 'match-older', assignmentRevision: 2 }]),
    ).toEqual([]);
    // Newer proof names both sides for the review.
    expect(
      describeTakeoverDrift(packaged, [{ roomId: 'room-2', matchId: 'match-new', assignmentRevision: 4 }]),
    ).toEqual([
      {
        roomId: 'room-2',
        roomName: 'Room 102',
        packageMatchId: 'match-old',
        liveMatchId: 'match-new',
        packageAssignmentRevision: 3,
        liveAssignmentRevision: 4,
      },
    ]);
  });

  test('rooms the package never held are always drift, and revision-less events prove nothing', () => {
    const drift = describeTakeoverDrift(packaged, [
      { roomId: 'room-9', matchId: 'match-new', assignmentRevision: 1 },
      { roomId: 'room-1', matchId: 'match-x', assignmentRevision: null },
    ]);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ roomId: 'room-9', packageMatchId: null, liveMatchId: 'match-new' });
  });

  test('stored reviews are validated, never trusted', () => {
    expect(readTakeoverReview(null)).toBeNull();
    expect(readTakeoverReview({ checkedAt: 'x', unknown: false, rooms: [], reviewed: 'yes' })).toBeNull();
    expect(
      readTakeoverReview({ checkedAt: 'x', unknown: false, rooms: [{ roomId: 'r' }], reviewed: false }),
    ).toBeNull();
    const review = {
      checkedAt: '2026-09-11T16:00:00.000Z',
      unknown: false,
      rooms: [
        {
          roomId: 'room-1',
          roomName: 'Room 101',
          packageMatchId: null,
          liveMatchId: 'match-1',
          packageAssignmentRevision: 0,
          liveAssignmentRevision: 1,
        },
      ],
      reviewed: false,
    };
    expect(readTakeoverReview(review)).toEqual(review);
  });
});
