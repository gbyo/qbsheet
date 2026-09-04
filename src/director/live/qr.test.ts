/**
 * The QR encoder.
 *
 * The test that matters is the round trip: the rendered code is decoded back with `jsqr`, the same
 * library the scorer already uses to *read* codes. Anything less would only prove the encoder is
 * self-consistent, and a QR that is self-consistently wrong still does not scan off a poster.
 */

import { describe, expect, test } from 'vitest';
import jsQR from 'jsqr';
import { buildBootstrapUrl } from '@qbsheet/qblive-protocol';
import { qrModules, qrSvg, QrEncodeError } from './qr';

/**
 * Rasterise the modules the way a camera would see them, then decode.
 *
 * Eight pixels per module and a four-module quiet zone: comfortably above what `jsqr` needs, and
 * the same quiet zone the printed page uses.
 */
function decode(text: string): string | null {
  const modules = qrModules(text);
  const scale = 8;
  const quiet = 4;
  const size = (modules.length + quiet * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  modules.forEach((row, rowIndex) => {
    row.forEach((dark, columnIndex) => {
      if (!dark) return;
      for (let y = 0; y < scale; y += 1) {
        for (let x = 0; x < scale; x += 1) {
          const pixelY = (rowIndex + quiet) * scale + y;
          const pixelX = (columnIndex + quiet) * scale + x;
          const offset = (pixelY * size + pixelX) * 4;
          data[offset] = 0;
          data[offset + 1] = 0;
          data[offset + 2] = 0;
          data[offset + 3] = 255;
        }
      }
    });
  });
  return jsQR(data, size, size)?.data ?? null;
}

describe('the generated code actually scans', () => {
  test('a QBSheet Live bootstrap URL round trips', () => {
    const url = buildBootstrapUrl({
      publicationId: 'bcdfghjkmnpqrstvwxyz',
      backendOrigin: 'https://qblive.example.workers.dev',
    });
    expect(decode(url)).toBe(url);
  });

  test('a long self-hosted backend URL round trips', () => {
    const url = buildBootstrapUrl({
      publicationId: 'bcdfghjkmnpqrstvwxyz',
      backendOrigin: 'https://qblive-backend.a-rather-long-workers-subdomain.workers.dev',
    });
    expect(decode(url)).toBe(url);
  });

  test('a local-network URL round trips', () => {
    const url = buildBootstrapUrl({
      publicationId: 'bcdfghjkmnpqrstvwxyz',
      backendOrigin: 'http://192.168.1.20:8790',
    });
    expect(decode(url)).toBe(url);
  });

  test.each([16, 40, 80, 120, 180, 213])('a %i-byte payload round trips', (length) => {
    // Walks the version boundaries, which is where an encoder gets the character-count field or the
    // block interleaving wrong.
    const text = 'A'.repeat(length);
    expect(decode(text)).toBe(text);
  });
});

describe('shape', () => {
  test('the matrix is square and version-sized', () => {
    const modules = qrModules(
      'https://live.qbsheet.com/t/bcdfghjkmnpqrstvwxyz?b=https%3A%2F%2Fx.example&v=1',
    );
    expect(modules.length).toBe(modules[0].length);
    // (version * 4) + 17, so every valid size is 17 mod 4.
    expect((modules.length - 17) % 4).toBe(0);
  });

  test('the three finder patterns are present', () => {
    const modules = qrModules('hello');
    const size = modules.length;
    for (const [top, left] of [
      [0, 0],
      [0, size - 7],
      [size - 7, 0],
    ]) {
      expect(modules[top][left]).toBe(true);
      expect(modules[top + 1][left + 1]).toBe(false);
      expect(modules[top + 3][left + 3]).toBe(true);
    }
  });

  test('a payload that is too long is refused rather than truncated', () => {
    expect(() => qrModules('A'.repeat(10000))).toThrow(QrEncodeError);
  });
});

describe('SVG output', () => {
  test('is one path with a quiet zone', () => {
    const svg = qrSvg('https://live.qbsheet.com/t/bcdfghjkmnpqrstvwxyz?b=https%3A%2F%2Fx.example&v=1');
    expect(svg).toContain('<svg');
    // One path, not one rect per module: a 41x41 code is 1,681 elements otherwise.
    expect(svg.match(/<path/g)).toHaveLength(1);
    expect(svg).toContain('shape-rendering="crispEdges"');
    expect(svg).toContain('aria-label');
  });

  test('the viewBox includes the quiet zone on both sides', () => {
    const modules = qrModules('hello');
    const svg = qrSvg('hello');
    const expected = modules.length + 8;
    expect(svg).toContain(`viewBox="0 0 ${expected} ${expected}"`);
  });
});
