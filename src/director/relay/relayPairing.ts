/**
 * Internet pairing links: one QR per room, served from the tournament relay.
 *
 * # One pairing, two transports
 *
 * An Internet-enabled room gets a single pairing QR/link whose `server=` value is the
 * tournament relay (`{baseUrl}/qbtcp/v1/tournaments/{tournamentId}`). The LAN address stays
 * available as fallback/recovery information, but it is attached to the same room — never a
 * second pairing workflow, never a second code. Regenerating a pairing code invalidates the old
 * one on both paths because both paths check the same mirrored pairing state.
 *
 * # Fragment discipline
 *
 * Links reuse QBTCP's fragment-based launch convention (`src/app/PairingLaunch.ts`): the
 * pairing code travels in the `#` fragment, which a browser never sends to a server, so codes
 * stay out of access logs, analytics, and referrers. Management credentials never appear in a
 * pairing link, a QR code, an export, or diagnostics — the QR payload is exactly the launch
 * URL, which carries only the server address, the room, and the short-lived bootstrap code.
 */

import { isRelayTournamentId, scoresheetOrigin } from './relayConfig';

export const pairingLaunchVersion = 1;

const maxServerLength = 512;
const maxCodeLength = 64;
const maxRoomIdLength = 128;

export class RelayPairingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayPairingError';
  }
}

/**
 * The `server=` value for an Internet pairing link: the tournament-scoped relay base.
 *
 * The scorer joins its route paths onto this string, the same way it joins them onto a LAN
 * `http://address:port` base. Consuming it over the scorer transport is #772's ownership;
 * this module only mints the address Directors hand out.
 */
export function internetServerForPairing(baseUrl: string, tournamentId: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (!base) throw new RelayPairingError('The relay address is missing.');
  if (!isRelayTournamentId(tournamentId)) {
    throw new RelayPairingError('That tournament id is not valid.');
  }
  const server = `${base}/qbtcp/v1/tournaments/${tournamentId}`;
  if (server.length > maxServerLength) throw new RelayPairingError('That relay address is too long.');
  return server;
}

/**
 * Build the launch URL behind a pairing QR/link.
 *
 * Same shape the native server mints for LAN
 * (`{scoresheet}#qbtcp-pair?v=1&server=…&code=…&room=…`), with the Internet relay as the
 * server. The code stays in the fragment: never sent to a server, never logged by one.
 */
export function buildPairingLaunchUrl(options: {
  server: string;
  code: string;
  roomId: string;
  lanServer?: string;
}): string {
  const { server, code, roomId, lanServer } = options;
  if (!server || server.length > maxServerLength) {
    throw new RelayPairingError('That pairing server address is not valid.');
  }
  if (!code || code.length > maxCodeLength) {
    throw new RelayPairingError('That pairing code is not valid.');
  }
  if (!roomId || roomId.length > maxRoomIdLength) {
    throw new RelayPairingError('That room is not valid for pairing.');
  }
  if (lanServer !== undefined && (!lanServer || lanServer.length > maxServerLength)) {
    throw new RelayPairingError('That LAN fallback address is not valid.');
  }
  const query =
    `v=${pairingLaunchVersion}` +
    `&server=${encodeURIComponent(server)}` +
    `&code=${encodeURIComponent(code)}` +
    `&room=${encodeURIComponent(roomId)}` +
    (lanServer && lanServer !== server ? `&lan=${encodeURIComponent(lanServer)}` : '');
  return `${scoresheetOrigin}/#qbtcp-pair?${query}`;
}

/** The full Internet pairing for one room: the server address and the launch URL behind its QR. */
export function buildInternetPairing(options: {
  baseUrl: string;
  tournamentId: string;
  code: string;
  roomId: string;
  lanServer?: string;
}): { server: string; url: string } {
  const server = internetServerForPairing(options.baseUrl, options.tournamentId);
  return {
    server,
    url: buildPairingLaunchUrl({
      server,
      code: options.code,
      roomId: options.roomId,
      ...(options.lanServer ? { lanServer: options.lanServer } : {}),
    }),
  };
}

/** Read the LAN endpoint from a native pairing launch URL without retaining its code. */
export function serverFromPairingLaunchUrl(url: string): string | null {
  const marker = '#qbtcp-pair?';
  const at = url.indexOf(marker);
  if (at === -1) return null;
  const server = new URLSearchParams(url.slice(at + marker.length)).get('server');
  if (!server || server.length > maxServerLength || !/^https?:\/\//i.test(server)) return null;
  return server;
}

/**
 * One room's pairing across both transports.
 *
 * `internetUrl` is the primary pairing directors share; `lanUrl` is the same room's LAN
 * fallback, or null where the LAN server is down. Both entries name the same `roomId`: a
 * scorekeeper never chooses between two unrelated pairings.
 */
export interface RoomPairing {
  roomId: string;
  roomName: string;
  /** The primary pairing QR/link: Internet relay as `server=`. Null until a code is issued. */
  internetUrl: string | null;
  /** Same room over LAN, for fallback/recovery display. Null while the LAN server is down. */
  lanUrl: string | null;
  /** ISO expiry of the active pairing code, shared by both transports. */
  codeExpiresAt: string | null;
}

export function roomPairing(options: {
  roomId: string;
  roomName: string;
  internet: { baseUrl: string; tournamentId: string; code: string } | null;
  lanUrl: string | null;
  codeExpiresAt: string | null;
}): RoomPairing {
  let internetUrl: string | null = null;
  if (options.internet) {
    const lanServer = options.lanUrl ? serverFromPairingLaunchUrl(options.lanUrl) : null;
    internetUrl = buildInternetPairing({
      baseUrl: options.internet.baseUrl,
      tournamentId: options.internet.tournamentId,
      code: options.internet.code,
      roomId: options.roomId,
      ...(lanServer ? { lanServer } : {}),
    }).url;
  }
  return {
    roomId: options.roomId,
    roomName: options.roomName,
    internetUrl,
    lanUrl: options.lanUrl,
    codeExpiresAt: options.codeExpiresAt,
  };
}

/**
 * Render a pairing URL safe for diagnostics, logs, and export bundles.
 *
 * Drops the fragment wholesale: the code is the only secret-shaped value a launch URL carries,
 * and a scrubbed URL still answers "which server and room" without it.
 */
export function scrubPairingUrl(url: string): string {
  const hash = url.indexOf('#');
  return hash === -1 ? url : url.slice(0, hash);
}

/** True when a URL still carries a fragment — i.e. it is not safe to log or export. */
export function pairingUrlCarriesFragment(url: string): boolean {
  return url.includes('#');
}
