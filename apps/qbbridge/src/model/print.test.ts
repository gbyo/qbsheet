import { describe, expect, test } from 'vitest';
import { pairingLink } from './pairing';
import { buildRoomPrintData } from './print';
import { newRoom } from './rooms';

const relay = {
  baseUrl: 'https://relay.example.workers.dev',
  tournamentId: 'bcdfghjkmnpqrstvwxyz2345',
};

describe('room print data', () => {
  test('keeps the tournament, room, active code and exact canonical pairing URL', () => {
    const room = newRoom('room-204', 'Room 204', '48213906');
    const pairing = pairingLink({ ...relay, code: room.pairingCode, roomId: room.id });

    expect(buildRoomPrintData({ tournamentName: 'Spring Invitational', room, pairing })).toEqual({
      roomId: 'room-204',
      roomName: 'Room 204',
      tournamentName: 'Spring Invitational',
      pairingCode: '48213906',
      pairingUrl: pairing.url,
      tournamentControlUrl: pairing.server,
    });
  });

  test('uses the active code when a pending replacement is present on a room', () => {
    const room = {
      ...newRoom('room-204', 'Room 204', '48213906'),
      // #919 keeps the published code in `pairingCode` while a replacement waits for a mirror.
      pendingPairingCode: '91374620',
    };
    const pairing = pairingLink({ ...relay, code: room.pairingCode, roomId: room.id });
    const data = buildRoomPrintData({ tournamentName: 'Spring Invitational', room, pairing });

    expect(data.pairingCode).toBe('48213906');
    expect(data.pairingUrl).toContain('code=48213906');
    expect(JSON.stringify(data)).not.toContain('91374620');
  });

  test('keeps long room names and relay addresses readable as data for wrapping in CSS', () => {
    const room = newRoom('room-long', `Room ${'North '.repeat(18)}`, '00000007');
    const longRelay = {
      ...relay,
      baseUrl: `https://${'relay-segment.'.repeat(24)}example.workers.dev`,
    };
    const pairing = pairingLink({ ...longRelay, code: room.pairingCode, roomId: room.id });
    const data = buildRoomPrintData({ tournamentName: 'A Tournament With a Long Name', room, pairing });

    expect(data.roomName).toBe(room.name);
    expect(data.tournamentControlUrl).toBe(pairing.server);
    expect(data.pairingUrl).toBe(pairing.url);
  });

  test('has no management or setup credential field', () => {
    const room = newRoom('room-1', 'Room 1', '48213906');
    const pairing = pairingLink({ ...relay, code: room.pairingCode, roomId: room.id });
    const data = buildRoomPrintData({ tournamentName: 'Spring Invitational', room, pairing });

    expect(Object.keys(data)).not.toContain('managementToken');
    expect(Object.keys(data)).not.toContain('setupToken');
  });
});
