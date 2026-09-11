import { describe, expect, test, vi } from 'vitest';
import FruityServerClient from '../src/integrations/fruity/FruityServerClient';
import { exchangePairingCode } from '../src/app/ControlPairing';

function fakeClient(
  baseUrl: string,
  joined:
    | {
        ok: true;
        value: { roomId: string; roomName: string; accessToken: string };
      }
    | { ok: false; error: string; status?: number; unsupported?: boolean },
): FruityServerClient {
  return {
    baseUrl,
    join: vi.fn(async () => joined),
  } as unknown as FruityServerClient;
}

describe('LAN pairing recovery outcomes', () => {
  test('surfaces a transient LAN failure without storing incomplete LAN credentials', async () => {
    const primary = fakeClient('https://relay.example/tournament', {
      ok: true,
      value: { roomId: 'room-1', roomName: 'Room 1', accessToken: 'relay-room-token' },
    });
    const lan = fakeClient('http://192.168.1.20:8787', { ok: false, error: 'offline' });

    const result = await exchangePairingCode(
      primary,
      '48213906',
      'room-1',
      'device-1',
      'http://192.168.1.20:8787',
      () => lan,
    );

    expect(result).toMatchObject({ ok: true, lanOutcome: 'transient-failure' });
    if (!result.ok) throw new Error(result.error);
    expect(result.value).toMatchObject({
      baseUrl: 'https://relay.example/tournament',
      roomId: 'room-1',
      roomToken: 'relay-room-token',
      deviceId: 'device-1',
    });
    expect(result.value).not.toHaveProperty('lanBaseUrl');
    expect(result.value).not.toHaveProperty('lanRoomToken');
  });

  test('distinguishes a LAN room mismatch from a transport failure', async () => {
    const primary = fakeClient('https://relay.example/tournament', {
      ok: true,
      value: { roomId: 'room-1', roomName: 'Room 1', accessToken: 'relay-room-token' },
    });
    const lan = fakeClient('http://192.168.1.20:8787', {
      ok: true,
      value: { roomId: 'room-2', roomName: 'Room 2', accessToken: 'other-room-token' },
    });

    const result = await exchangePairingCode(
      primary,
      '48213906',
      'room-1',
      'device-1',
      'http://192.168.1.20:8787',
      () => lan,
    );

    expect(result).toMatchObject({ ok: true, lanOutcome: 'room-mismatch' });
    if (!result.ok) throw new Error(result.error);
    expect(result.value).not.toHaveProperty('lanBaseUrl');
    expect(result.value).not.toHaveProperty('lanRoomToken');
  });

  test('treats an explicit LAN refusal as definitive rather than transient', async () => {
    const primary = fakeClient('https://relay.example/tournament', {
      ok: true,
      value: { roomId: 'room-1', roomName: 'Room 1', accessToken: 'relay-room-token' },
    });
    const lan = fakeClient('http://192.168.1.20:8787', {
      ok: false,
      error: 'pairing refused',
      status: 401,
    });

    const result = await exchangePairingCode(
      primary,
      '48213906',
      'room-1',
      'device-1',
      'http://192.168.1.20:8787',
      () => lan,
    );

    expect(result).toMatchObject({ ok: true, lanOutcome: 'rejected' });
  });
});
