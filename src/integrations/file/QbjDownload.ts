/**
 * Turning a result into a file somebody can carry.
 *
 * This is the escape hatch that makes every other failure survivable: whatever has gone wrong with
 * the network, the server, or the address the room was given, a finished game can always leave the
 * device as an ordinary QBJ file.
 *
 * Two rules shape it. The payload is whatever `portableQbj` produced and nothing else, so the file
 * that travels by USB stick and email is the least surprising object this application can make. And
 * the filename says what the game is without needing the file opened, because the person receiving
 * sixteen of them at once is standing in a hallway.
 *
 * Extracted from YellowFruit's room `QbjBackup`.
 */
import { IGamePackage } from '../../game/GamePackage';
import { IGameDefinition } from '../../game/GameDefinition';
import { portableQbj, portableQbjDocument } from '../../game/PortableQbj';
import { qbjFileName as qbjResultFileName } from '../../qbj/QbjResult';

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
 * The download name for one result, e.g. `R07_Room-204_Ninety-Six-A_vs_Greenwood.qbj`.
 *
 * Round first and zero-padded so a directory listing sorts into playing order, then the room, then
 * the teams. A game with no room simply leaves that component out rather than inventing one.
 */
export function qbjFileName(packageValue: IGamePackage): string {
  const parts: string[] = [];
  parts.push(`R${String(Math.trunc(packageValue.round.number)).padStart(2, '0')}`);
  const room = packageValue.room?.name;
  if (room && room.trim() !== '') parts.push(sanitizeFileNamePart(room, 'Room'));
  parts.push(sanitizeFileNamePart(packageValue.left.name, 'Team-1'));
  parts.push('vs');
  parts.push(sanitizeFileNamePart(packageValue.right.name, 'Team-2'));
  return `${parts.join('_')}.qbj`;
}

/** The exact text written to the file. */
export function qbjFileContents(qbj: object): string {
  return JSON.stringify(qbj, null, 2);
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

/** Write a file to the scorekeeper's downloads folder. */
export function downloadFile(
  contents: string,
  fileName: string,
  environment: IDownloadEnvironment | null = defaultDownloadEnvironment(),
): boolean {
  if (!environment) return false;
  const blob = new Blob([contents], { type: 'application/json' });
  const url = environment.createObjectURL(blob);
  try {
    const anchor = environment.createAnchor();
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = 'noopener';
    anchor.click();
    return true;
  } finally {
    // Give the browser a moment to start the download before the blob goes away.
    setTimeout(() => environment.revokeObjectURL(url), 10_000);
  }
}

/**
 * Save one result.
 *
 * @param qbj the scorer's payload, which may still carry its internal recovery layer. Sanitizing is
 * this function's job precisely so that no caller has to remember it was theirs.
 * @returns false when the browser gave us no way to write a file, so the caller can say so rather
 * than appearing to have saved something that does not exist.
 */
export function downloadQbj(
  qbj: object,
  packageValue: IGamePackage,
  environment: IDownloadEnvironment | null = defaultDownloadEnvironment(),
): boolean {
  return downloadFile(qbjFileContents(portableQbj(qbj, packageValue)), qbjFileName(packageValue), environment);
}

/**
 * Which shape of QBJ a download is asking for.
 *
 * `partial` and `result` are the same document; the word only changes the filename suffix, which is
 * human guidance and nothing else. `legacy-match` is the compatibility export — a bare Match, the
 * way MODAQ writes one — kept because the ecosystem reads it and placed behind the menu because it
 * is no longer what a QBJ file from this application means.
 */
export type QbjDownloadForm = 'partial' | 'result' | 'legacy-match';

/**
 * Save a serialized QBJ document.
 *
 * Everything leaving the device goes through `portableQbjDocument` first, so there is one place
 * where "could this file contain something it shouldn't" is answered rather than one per caller.
 */
export function downloadQbjDocument(
  document: object,
  definition: IGameDefinition,
  form: 'partial' | 'result',
  environment: IDownloadEnvironment | null = defaultDownloadEnvironment(),
): boolean {
  return downloadFile(
    qbjFileContents(portableQbjDocument(document)),
    qbjResultFileName(definition, form),
    environment,
  );
}

/**
 * Save the compatibility export.
 *
 * A bare Match has no envelope to carry the tournament's identity, so this is the one download that
 * still writes the legacy source block — see `PortableQbj`. It is a compatibility path, and
 * compatibility metadata is what it needs.
 */
export function downloadLegacyMatchOnly(
  match: object,
  definition: IGameDefinition,
  environment: IDownloadEnvironment | null = defaultDownloadEnvironment(),
): boolean {
  return downloadFile(qbjFileContents(portableQbj(match, definition)), qbjFileName(definition), environment);
}
