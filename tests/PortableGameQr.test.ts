import { expect, test } from 'vitest';
import jsQR from 'jsqr';
import {
  encodePortableGameSetup,
  parsePortableGameSetup,
  portableSetupLimits,
} from '../src/game/PortableGameSetup';
import { encodeQr, qrSvg } from '../src/qr/QrEncoding';
import { maxDecodeEdge } from '../src/app/QrDecoding';
import { largePortableInput, portableInput } from './portableSetupFixtures';

/** Rasterize the actual exported SVG at the fallback decoder's maximum frame size. */
function decodeSvg(svg: string) {
  const modules = Number(/viewBox="0 0 (\d+)/.exec(svg)?.[1]);
  const dark = new Set([...svg.matchAll(/M(\d+) (\d+)h1v1h-1z/g)].map((m) => `${m[1]},${m[2]}`));
  const pixels = new Uint8ClampedArray(maxDecodeEdge * maxDecodeEdge * 4).fill(255);
  for (let y = 0; y < maxDecodeEdge; y++)
    for (let x = 0; x < maxDecodeEdge; x++) {
      if (
        dark.has(`${Math.floor((x * modules) / maxDecodeEdge)},${Math.floor((y * modules) / maxDecodeEdge)}`)
      ) {
        const offset = (y * maxDecodeEdge + x) * 4;
        pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 0;
      }
    }
  return jsQR(pixels, maxDecodeEdge, maxDecodeEdge, { inversionAttempts: 'dontInvert' })?.data;
}

test.each([false, true])(
  'exported SVG scans through jsQR and returns the complete setup (advanced=%s)',
  (advanced) => {
    const input = portableInput(advanced);
    const encoded = encodePortableGameSetup(input);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(encoded.version).toBeLessThanOrEqual(portableSetupLimits.qrVersion);
    expect(encoded.moduleCount).toBe(17 + 4 * encoded.version);
    const scanned = decodeSvg(encoded.svg);
    expect(scanned).toBe(encoded.text);
    expect(parsePortableGameSetup(scanned!)).toEqual({ ok: true, input });
  },
);

test('pairing URL decodes byte-for-byte through the replacement encoder', () => {
  const url =
    'https://example.org/scoresheet/#qbtcp-pair?v=1&server=http%3A%2F%2F192.168.1.20%3A3000&code=48213906&room=204';
  expect(decodeSvg(qrSvg(url))).toBe(url);
});

test('alphanumeric mode uses fewer modules than byte mode text', () => {
  expect(encodeQr('A'.repeat(500)).version).toBeLessThan(encodeQr('a'.repeat(500)).version);
});

test('the practical ceiling scans and the next denser setup is refused without truncation', () => {
  let last = encodePortableGameSetup(largePortableInput(1));
  let lastInput = largePortableInput(1);
  let refused = false;
  for (let count = 2; count <= 40; count++) {
    const input = largePortableInput(count);
    const result = encodePortableGameSetup(input);
    if (!result.ok) {
      expect(result.message).toMatch(/too large.*single QR/);
      refused = true;
      break;
    }
    last = result;
    lastInput = input;
  }
  expect(refused).toBe(true);
  expect(last.ok).toBe(true);
  if (last.ok) {
    expect(last.version).toBe(portableSetupLimits.qrVersion);
    expect(parsePortableGameSetup(decodeSvg(last.svg)!)).toEqual({ ok: true, input: lastInput });
  }
  const huge = largePortableInput(40);
  const before = JSON.stringify(huge);
  expect(encodePortableGameSetup(huge)).toMatchObject({ ok: false });
  expect(JSON.stringify(huge)).toBe(before);
});
