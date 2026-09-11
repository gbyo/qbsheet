/**
 * Pairing a scorer to a room, using the pairing protocol QBTCP already has.
 *
 * QBBridge invents no second mechanism. It mints the same eight-digit numeric code the native
 * QBTCP server mints, hashes it the way the relay stores it, and builds the same
 * `#qbtcp-pair?v=1&server=…&code=…&room=…` launch URL the scorer already knows how to open. A
 * scorekeeper pairs without ever learning that QBBridge exists.
 *
 * The plaintext code stays on this machine and on the paper or screen the scorekeeper reads. Only
 * its SHA-256 hex reaches the relay, and the code travels to the device in a URL *fragment*, which
 * a browser never sends to a server.
 */

import { buildInternetPairing } from '../../../../src/director/relay/relayPairing';
import { qrSvg } from '../../../../src/qr/QrEncoding';

/** The length and alphabet the native QBTCP server uses (`pairing_code` in `crates/qbtcp-server`). */
export function generatePairingCode(): string {
  const codeSpace = 100_000_000;
  // Reject the short tail of the Uint32 space so every eight-digit code has the same
  // probability. This stays within the exact-integer range of JavaScript numbers.
  const acceptedLimit = Math.floor(0x1_0000_0000 / codeSpace) * codeSpace;
  const sample = new Uint32Array(1);

  do {
    crypto.getRandomValues(sample);
  } while (sample[0] >= acceptedLimit);

  return String(sample[0] % codeSpace).padStart(8, '0');
}

/** The hash the relay stores and compares against. Lowercase hex, as `PUT manage/mirror` requires. */
export async function pairingCodeHash(code: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface PairingLink {
  /** The relay base a scorer joins its route paths onto. */
  server: string;
  /** The launch URL behind the QR code. Carries the code in its fragment and nothing else secret. */
  url: string;
}

export function pairingLink(options: {
  baseUrl: string;
  tournamentId: string;
  code: string;
  roomId: string;
}): PairingLink {
  return buildInternetPairing(options);
}

/** The QR for a launch URL, as inline SVG. */
export function pairingQrSvg(url: string, size = 132): string {
  return qrSvg(url, { size });
}
