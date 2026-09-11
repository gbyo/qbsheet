/**
 * Pairing: the same protocol, the same code shape, the same link, and the code out of the mirror.
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { generatePairingCode, pairingCodeHash, pairingLink, pairingQrSvg } from './pairing';

const relay = { baseUrl: 'https://qbtcp-relay-test.workers.dev', tournamentId: 'bcdfghjkmnpqrstvwxyz2345' };

describe('pairing codes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('match the shape the native QBTCP server mints', () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      // Eight digits, zero-padded, which is what the relay's 4-to-64 bound and the LAN server
      // both accept. A scorekeeper reads it off a card.
      expect(generatePairingCode()).toMatch(/^[0-9]{8}$/);
    }
    expect(new Set(Array.from({ length: 40 }, generatePairingCode)).size).toBeGreaterThan(30);
  });

  test('rejects the uneven Uint32 tail before reducing to eight digits', () => {
    const getRandomValues = vi.spyOn(crypto, 'getRandomValues');
    getRandomValues
      .mockImplementationOnce((values) => {
        (values as Uint32Array)[0] = 4_200_000_000;
        return values;
      })
      .mockImplementationOnce((values) => {
        (values as Uint32Array)[0] = 123;
        return values;
      });

    expect(generatePairingCode()).toBe('00000123');
    expect(getRandomValues).toHaveBeenCalledTimes(2);
  });

  test('hash to the lowercase sha256 hex the relay stores', async () => {
    // `printf 48213906 | shasum -a 256`. Pinned to a literal rather than recomputed, so a change
    // of digest or encoding here shows up as a test failure instead of as rooms that cannot pair.
    expect(await pairingCodeHash('48213906')).toBe(
      '8a431fea903864d93de33d038c0e8ec533bada558610bafde44c25fedf265c7d',
    );
    expect(await pairingCodeHash('00000000')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('the launch link', () => {
  test('is the convention an ordinary scorer already opens', () => {
    const { server, url } = pairingLink({ ...relay, code: '48213906', roomId: 'room-1' });
    expect(server).toBe('https://qbtcp-relay-test.workers.dev/qbtcp/v1/tournaments/bcdfghjkmnpqrstvwxyz2345');
    expect(url.startsWith('https://qbsheet.com/#qbtcp-pair?')).toBe(true);
    const fragment = new URLSearchParams(url.slice(url.indexOf('#qbtcp-pair?') + '#qbtcp-pair?'.length));
    expect(fragment.get('v')).toBe('1');
    expect(fragment.get('server')).toBe(server);
    expect(fragment.get('code')).toBe('48213906');
    expect(fragment.get('room')).toBe('room-1');
  });

  test('keeps the code in the fragment, which a browser never sends to a server', () => {
    const { url } = pairingLink({ ...relay, code: '48213906', roomId: 'room-1' });
    const beforeFragment = url.slice(0, url.indexOf('#'));
    expect(beforeFragment).not.toContain('48213906');
  });

  test('carries no management credential', () => {
    const { url } = pairingLink({ ...relay, code: '48213906', roomId: 'room-1' });
    expect(url.toLowerCase()).not.toContain('bearer');
    expect(url.toLowerCase()).not.toContain('token');
  });

  test('a bad relay address is refused rather than producing a QR nobody can use', () => {
    expect(() => pairingLink({ ...relay, tournamentId: 'not-an-id', code: '1', roomId: 'r' })).toThrow();
  });
});

describe('the QR', () => {
  test('encodes the launch URL as inline SVG', () => {
    const { url } = pairingLink({ ...relay, code: '48213906', roomId: 'room-1' });
    const svg = pairingQrSvg(url);
    expect(svg).toContain('<svg');
    expect(svg).toContain('viewBox');
  });
});
