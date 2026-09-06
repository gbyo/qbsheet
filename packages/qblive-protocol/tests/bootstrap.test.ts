/**
 * The bootstrap URL is the only thing in a printed QR code, so its parser is the first thing an
 * attacker reaches. These tests are about what it refuses.
 */

import { describe, expect, test } from 'vitest';
import {
  assertPublicBackendOrigin,
  buildBootstrapUrl,
  isLocalHost,
  parseBootstrapUrl,
  qbliveUrl,
  QbliveBootstrapError,
} from '../src/bootstrap.js';

const publicationId = 'bcdfghjkmnpqrstvwxyz';

describe('building', () => {
  test('produces the documented shape', () => {
    expect(buildBootstrapUrl({ publicationId, backendOrigin: 'https://qblive.example.workers.dev' })).toBe(
      `https://live.qbsheet.com/t/${publicationId}?b=https%3A%2F%2Fqblive.example.workers.dev&v=1`,
    );
  });

  test('round trips', () => {
    const url = buildBootstrapUrl({ publicationId, backendOrigin: 'https://qblive.example.workers.dev' });
    expect(parseBootstrapUrl(url)).toEqual({
      version: 1,
      publicationId,
      backendOrigin: 'https://qblive.example.workers.dev',
    });
  });

  test('rejects an invalid publication id rather than printing an unusable QR', () => {
    expect(() => buildBootstrapUrl({ publicationId: 'short', backendOrigin: 'https://x.example' })).toThrow(
      QbliveBootstrapError,
    );
  });
});

describe('backend origins that must be refused', () => {
  test.each([
    ['javascript:alert(1)', 'a script URL'],
    ['data:text/html,<script>', 'a data URL'],
    ['file:///etc/passwd', 'a file URL'],
    ['http://evil.example.com', 'plain HTTP on the public internet'],
    ['https://user:secret@backend.example', 'embedded credentials'],
    ['https://backend.example/tenant/1', 'a path'],
    ['https://backend.example?token=abc', 'a query'],
    ['https://backend.example#fragment', 'a fragment'],
    ['not a url at all', 'garbage'],
    ['', 'nothing'],
  ])('%s (%s)', (value) => {
    expect(() => assertPublicBackendOrigin(value)).toThrow(QbliveBootstrapError);
  });

  test('a very long origin is refused before it reaches fetch', () => {
    expect(() => assertPublicBackendOrigin(`https://${'a'.repeat(300)}.example`)).toThrow(
      QbliveBootstrapError,
    );
  });

  test('HTTPS with a port is accepted', () => {
    expect(assertPublicBackendOrigin('https://backend.example:8443')).toBe('https://backend.example:8443');
  });
});

describe('local network mode', () => {
  test.each([
    'http://192.168.1.20:8790',
    'http://10.0.0.5:8790',
    'http://127.0.0.1:8790',
    'http://localhost:8790',
  ])('accepts %s only when LAN mode is explicitly allowed', (value) => {
    expect(assertPublicBackendOrigin(value, { allowInsecureLan: true })).toBe(value);
    expect(() => assertPublicBackendOrigin(value)).toThrow(QbliveBootstrapError);
  });

  test('a public address is never accepted over plain HTTP even in LAN mode', () => {
    expect(() => assertPublicBackendOrigin('http://8.8.8.8', { allowInsecureLan: true })).toThrow(
      QbliveBootstrapError,
    );
  });

  test('the private-range check does not accept lookalikes', () => {
    expect(isLocalHost('172.15.0.1')).toBe(false);
    expect(isLocalHost('172.16.0.1')).toBe(true);
    expect(isLocalHost('172.32.0.1')).toBe(false);
    expect(isLocalHost('192.168.999.1')).toBe(false);
    expect(isLocalHost('10.1.2.3.evil.example')).toBe(false);
  });
});

describe('parsing', () => {
  test('a link with no backend is refused', () => {
    expect(() => parseBootstrapUrl(`https://live.qbsheet.com/t/${publicationId}`)).toThrow(
      /does not name a tournament server/,
    );
  });

  test('a future bootstrap version asks for a newer client rather than guessing', () => {
    expect(() =>
      parseBootstrapUrl(`https://live.qbsheet.com/t/${publicationId}?b=https%3A%2F%2Fx.example&v=99`),
    ).toThrow(/needs a newer version/);
  });

  test('a self-hosted Live Web host parses the same way', () => {
    expect(
      parseBootstrapUrl(`https://live.myleague.example/t/${publicationId}?b=https%3A%2F%2Fx.example&v=1`)
        .publicationId,
    ).toBe(publicationId);
  });

  test('a credential smuggled into the backend parameter is refused', () => {
    expect(() =>
      parseBootstrapUrl(
        `https://live.qbsheet.com/t/${publicationId}?b=${encodeURIComponent('https://tok:en@x.example')}&v=1`,
      ),
    ).toThrow(QbliveBootstrapError);
  });

  test('a malformed percent escape in the publication id is reported as a bootstrap error', () => {
    expect(() =>
      parseBootstrapUrl('https://live.qbsheet.com/t/%E0%A4%A?b=https%3A%2F%2Fx.example&v=1'),
    ).toThrow(QbliveBootstrapError);
  });
});

describe('route construction', () => {
  test('builds the documented QBLive path', () => {
    expect(qbliveUrl('https://x.example', publicationId, 'snapshot')).toBe(
      `https://x.example/qblive/v1/tournaments/${publicationId}/snapshot`,
    );
  });

  test('tolerates a trailing slash on the origin', () => {
    expect(qbliveUrl('https://x.example/', publicationId, '/manifest')).toBe(
      `https://x.example/qblive/v1/tournaments/${publicationId}/manifest`,
    );
  });
});
