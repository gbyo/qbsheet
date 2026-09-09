import { afterEach, describe, expect, test, vi } from 'vitest';
import { mergeNativePairingInvitation, pruneExpiredNativePairingInvitations } from './useNativeServerStatus';
import type { NativeServerStatus } from '../platform/native';

const issuedAt = '2026-09-09T12:00:00.000Z';

function invitation(
  roomId: string,
  expiresAt: string,
  pairingCode: string,
): NonNullable<NativeServerStatus['pairingInvitations']>[number] {
  return {
    roomId,
    roomName: roomId,
    pairingCode,
    pairingUrl: `https://qbsheet.com/#qbtcp-pair?code=${pairingCode}`,
    issuedAt,
    expiresAt,
    expiresInSeconds: 900,
  };
}

afterEach(() => vi.useRealTimers());

describe('native QBTCP invitation lifecycle', () => {
  test('fake clock expires rooms independently and removes their usable credentials', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-09T12:05:00.000Z'));
    const status = pruneExpiredNativePairingInvitations({
      running: true,
      pairingInvitations: [
        invitation('room-101', '2026-09-09T12:10:00.000Z', '10101010'),
        invitation('room-102', '2026-09-09T12:04:00.000Z', '20202020'),
      ],
    });

    expect(status.pairingInvitations?.map((entry) => entry.roomId)).toEqual(['room-101']);
    expect(status.expiredPairingRoomIds).toEqual(['room-102']);
    expect(status.pairingCode).toBe('10101010');
    expect(status.pairingUrl).toContain('10101010');
  });

  test('reissuing a room clears its expired marker and replaces rather than duplicates state', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-09T12:05:00.000Z'));
    const status = mergeNativePairingInvitation(
      {
        running: true,
        expiredPairingRoomIds: ['room-101'],
        pairingInvitations: [invitation('room-101', '2026-09-09T12:04:00.000Z', '30303030')],
      },
      invitation('room-101', '2026-09-09T12:20:00.000Z', '40404040'),
    );

    expect(status.expiredPairingRoomIds).toEqual([]);
    expect(status.pairingInvitations).toHaveLength(1);
    expect(status.pairingInvitations?.[0].pairingCode).toBe('40404040');
  });

  test('malformed absolute deadlines are never treated as active', () => {
    const status = pruneExpiredNativePairingInvitations({
      running: true,
      pairingInvitations: [invitation('room-101', 'not-a-date', '30303030')],
    });
    expect(status.pairingInvitations).toEqual([]);
    expect(status.expiredPairingRoomIds).toEqual(['room-101']);
  });

  test('a stopped or restarted runtime cannot retain old invitation UI state', () => {
    const stopped = pruneExpiredNativePairingInvitations({
      running: false,
      expiredPairingRoomIds: ['room-101'],
      pairingCode: '10101010',
      pairingUrl: 'https://qbsheet.com/old',
      pairingInvitations: [invitation('room-101', '2026-09-09T12:20:00.000Z', '10101010')],
    });
    expect(stopped.pairingInvitations).toEqual([]);
    expect(stopped.pairingCode).toBeUndefined();
    expect(stopped.pairingUrl).toBeUndefined();
    expect(stopped.expiredPairingRoomIds).toEqual([]);
  });
});
