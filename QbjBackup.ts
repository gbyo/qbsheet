/**
 * Turning a saved result into a file the scorekeeper can hand to the statskeeper.
 *
 * This is the escape hatch that makes every other failure survivable: whatever has gone wrong with
 * the network, the server, or the address, a finished game can always leave the Chromebook as an
 * ordinary QBJ file on a USB stick or in an email.
 *
 * Two rules shape it. The file contains the game result and nothing else — no room token, no
 * session credentials, no device id — because a file that travels by USB stick and email is the
 * least controlled thing the tournament produces. And the filename says what the game is without
 * needing the file opened, because the person receiving six of them at once is standing in a
 * hallway.
 */
import { IRoomResultOutboxEntry } from './ResultOutbox';

/**
 * Keys stripped from a downloaded payload, matched case-insensitively after removing separators.
 *
 * MODAQ does not put any of these into a Match, so in practice this removes nothing. It is here
 * because "in practice nothing" is a property of the current MODAQ version rather than of the file
 * format, and the cost of being wrong is a room credential in a file that gets emailed around.
 */
const forbiddenKeys = new Set([
  'accesstoken',
  'token',
  'sessiontoken',
  'sessionid',
  'sessioncredentials',
  'roomtoken',
  'pairingcode',
  'deviceid',
  'authorization',
  'credentials',
  'secret',
]);

function isForbiddenKey(key: string): boolean {
  return forbiddenKeys.has(key.replace(/[-_\s]/g, '').toLowerCase());
}

/**
 * A deep copy of the payload with anything credential-shaped removed.
 *
 * Deliberately a copy: the outbox entry keeps the exact bytes it will upload, and the download must
 * not be able to change what the server eventually receives.
 */
export function sanitizeQbjForDownload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => sanitizeQbjForDownload(entry));
  if (typeof value !== 'object' || value === null) return value;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isForbiddenKey(key)) continue;
    output[key] = sanitizeQbjForDownload(entry);
  }
  return output;
}

/** One filename component: letters, digits and single hyphens, with nothing that needs escaping. */
export function sanitizeFileNamePart(value: string, fallback = 'Unknown'): string {
  const cleaned = value
    .normalize('NFKD')
    // Anything that is not a letter, digit or hyphen becomes a hyphen, including the separators a
    // filesystem or a shell would otherwise have an opinion about.
    .replace(/[^\p{L}\p{N}-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned === '' ? fallback : cleaned;
}

/**
 * The download name for one saved result, e.g. `R04_Room-204_Ninety-Six-A_vs_Greenwood.qbj`.
 *
 * Round first and zero-padded so a directory listing sorts into playing order, then the room, then
 * the teams. A result with no round or no room simply leaves that component out rather than
 * inventing one.
 */
export function outboxQbjFileName(
  entry: Pick<IRoomResultOutboxEntry, 'roundNumber' | 'roundName' | 'leftTeam' | 'rightTeam'>,
  roomName?: string,
): string {
  const parts: string[] = [];
  if (typeof entry.roundNumber === 'number' && Number.isFinite(entry.roundNumber)) {
    parts.push(`R${String(Math.trunc(entry.roundNumber)).padStart(2, '0')}`);
  } else if (entry.roundName) {
    parts.push(`R${sanitizeFileNamePart(entry.roundName, 'ound')}`);
  }
  if (roomName && roomName.trim() !== '') parts.push(sanitizeFileNamePart(roomName, 'Room'));
  parts.push(sanitizeFileNamePart(entry.leftTeam, 'Team-1'));
  parts.push('vs');
  parts.push(sanitizeFileNamePart(entry.rightTeam, 'Team-2'));
  return `${parts.join('_')}.qbj`;
}

/** The exact text written to the downloaded file. */
export function outboxQbjFileContents(entry: Pick<IRoomResultOutboxEntry, 'qbj'>): string {
  return JSON.stringify(sanitizeQbjForDownload(entry.qbj), null, 2);
}

/** The browser bits a download needs, kept injectable so the logic above stays testable. */
export interface IDownloadEnvironment {
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
  createAnchor: () => HTMLAnchorElement;
}

function defaultDownloadEnvironment(): IDownloadEnvironment | null {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return null;
  }
  return {
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    createAnchor: () => document.createElement('a'),
  };
}

/**
 * Save one result to the scorekeeper's downloads folder.
 *
 * @returns false when the browser gave us no way to do it, so the caller can say so rather than
 * appearing to have saved a file that does not exist.
 */
export function downloadOutboxQbj(
  entry: Pick<IRoomResultOutboxEntry, 'qbj' | 'roundNumber' | 'roundName' | 'leftTeam' | 'rightTeam'>,
  roomName?: string,
  environment: IDownloadEnvironment | null = defaultDownloadEnvironment(),
): boolean {
  if (!environment) return false;
  const blob = new Blob([outboxQbjFileContents(entry)], { type: 'application/json' });
  const url = environment.createObjectURL(blob);
  try {
    const anchor = environment.createAnchor();
    anchor.href = url;
    anchor.download = outboxQbjFileName(entry, roomName);
    anchor.rel = 'noopener';
    anchor.click();
    return true;
  } finally {
    // Give the browser a moment to start the download before the blob goes away.
    setTimeout(() => environment.revokeObjectURL(url), 10_000);
  }
}

/** Download the live first-party scoresheet before it has entered the outbox. */
export function downloadCurrentQbj(
  qbj: object,
  details: { roundName?: string; roundNumber?: number; roomName?: string; leftTeam: string; rightTeam: string },
): boolean {
  return downloadOutboxQbj(
    {
      qbj,
      roundName: details.roundName,
      roundNumber: details.roundNumber,
      leftTeam: details.leftTeam,
      rightTeam: details.rightTeam,
    },
    details.roomName,
  );
}
