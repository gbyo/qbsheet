import { describe, expect, it } from 'vitest';
import {
  buildInternetPairing,
  buildPairingLaunchUrl,
  internetServerForPairing,
  pairingUrlCarriesFragment,
  RelayPairingError,
  roomPairing,
  scrubPairingUrl,
} from './relayPairing';

const baseUrl = 'https://qbtcp-relay-abc.xyz123.workers.dev';
const tournamentId = 'bcdfghjkmnpqrstvwxyz1234';
const server = `${baseUrl}/qbtcp/v1/tournaments/${tournamentId}`;

describe('Internet pairing links', () => {
  it('uses the tournament relay as the primary server= value', () => {
    const pairing = buildInternetPairing({
      baseUrl,
      tournamentId,
      code: '48213906',
      roomId: 'room-204',
      lanServer: 'http://192.168.1.24:3000',
    });
    expect(pairing.server).toBe(server);
    const parsed = new URL(pairing.url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe('https://qbsheet.com/');
    const fragment = new URLSearchParams(parsed.hash.replace(/^#qbtcp-pair\?/, ''));
    expect(fragment.get('server')).toBe(server);
    expect(fragment.get('code')).toBe('48213906');
    expect(fragment.get('room')).toBe('room-204');
    expect(fragment.get('v')).toBe('1');
    expect(fragment.get('lan')).toBe('http://192.168.1.24:3000');
  });

  it('keeps the pairing code fragment-only: nothing secret in the fetchable URL', () => {
    const { url } = buildInternetPairing({ baseUrl, tournamentId, code: '48213906', roomId: 'room-204' });
    const query = new URL(url).search;
    expect(query).toBe('');
    expect(pairingUrlCarriesFragment(url)).toBe(true);
  });

  it('scrubs the fragment for diagnostics while keeping server and room answerable', () => {
    const { url } = buildInternetPairing({ baseUrl, tournamentId, code: '48213906', roomId: 'room-204' });
    const scrubbed = scrubPairingUrl(url);
    expect(scrubbed).not.toContain('48213906');
    expect(scrubbed).not.toContain('#');
    expect(pairingUrlCarriesFragment(scrubbed)).toBe(false);
  });

  it('never carries a management credential', () => {
    const { url } = buildInternetPairing({
      baseUrl,
      tournamentId,
      code: '48213906',
      roomId: 'room-204',
    });
    expect(url).not.toMatch(/token|credential|secret|bearer|password/i);
  });

  it('round-trips through the scorer launch-link shape', () => {
    const url = buildPairingLaunchUrl({ server: 'http://192.168.1.24:3000', code: '00000001', roomId: 'r' });
    expect(url).toBe(
      'https://qbsheet.com/#qbtcp-pair?v=1&server=http%3A%2F%2F192.168.1.24%3A3000&code=00000001&room=r',
    );
  });

  it('refuses invalid pairing inputs instead of minting a broken link', () => {
    expect(() => internetServerForPairing(baseUrl, 'short')).toThrow(RelayPairingError);
    expect(() => buildPairingLaunchUrl({ server, code: '', roomId: 'room-204' })).toThrow(RelayPairingError);
    expect(() => buildPairingLaunchUrl({ server: '', code: '48213906', roomId: 'room-204' })).toThrow(
      RelayPairingError,
    );
  });
});

describe('LAN fallback association', () => {
  it('belongs to the same logical room, not a second pairing workflow', () => {
    const pairing = roomPairing({
      roomId: 'room-204',
      roomName: 'Room 204',
      internet: { baseUrl, tournamentId, code: '48213906' },
      lanUrl: buildPairingLaunchUrl({
        server: 'http://192.168.1.24:3000',
        code: '48213906',
        roomId: 'room-204',
      }),
      codeExpiresAt: '2026-09-10T12:00:00.000Z',
    });
    expect(pairing.roomId).toBe('room-204');
    expect(pairing.internetUrl).toContain(encodeURIComponent(server));
    expect(pairing.internetUrl).toContain(encodeURIComponent('http://192.168.1.24:3000'));
    expect(pairing.lanUrl).toContain(encodeURIComponent('http://192.168.1.24:3000'));
    // Same code, same room, both fragments: one pairing, two transports.
    for (const url of [pairing.internetUrl, pairing.lanUrl]) {
      const fragment = new URL(url as string).hash;
      expect(fragment).toContain('code=48213906');
      expect(fragment).toContain('room=room-204');
    }
  });

  it('represents a down LAN server as missing fallback, not a missing pairing', () => {
    const pairing = roomPairing({
      roomId: 'room-204',
      roomName: 'Room 204',
      internet: { baseUrl, tournamentId, code: '48213906' },
      lanUrl: null,
      codeExpiresAt: null,
    });
    expect(pairing.internetUrl).not.toBeNull();
    expect(pairing.lanUrl).toBeNull();
  });

  it('represents an unissued code as no Internet URL yet', () => {
    const pairing = roomPairing({
      roomId: 'room-204',
      roomName: 'Room 204',
      internet: null,
      lanUrl: null,
      codeExpiresAt: null,
    });
    expect(pairing.internetUrl).toBeNull();
  });
});
