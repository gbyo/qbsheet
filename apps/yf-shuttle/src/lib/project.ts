/**
 * Project folder layout and safe filenames.
 *
 * The sanitizer follows the same union-of-platforms rules as
 * `src/director/transfers/filenames.ts`: a file written on macOS is read on Windows, so
 * Windows reserved characters, reserved device names, trailing dots/spaces, control
 * characters, and a conservative length bound all apply everywhere. A separator in a team or
 * room name becomes a hyphen rather than a directory, so a name can never walk out of the
 * project folder.
 */

export const MANIFEST_NAME = '.yf-shuttle.json';
export const IMPORT_ROOT_NAME = 'YellowFruit Import';
export const IN_DIR_NAME = 'IN';
export const OUT_DIR_NAME = 'OUT';

const windowsReserved = /[<>:"/\\|?*]/g;
const maxFileStemLength = 120;

const reservedDeviceNames = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

function withoutControlCharacters(value: string): string {
  let output = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    output += character;
  }
  return output;
}

/** Make one path segment safe everywhere. Never returns an empty string or a path. */
export function sanitizeFileSegment(value: string, fallback = 'file'): string {
  const collapsed = withoutControlCharacters(value.normalize('NFC'))
    .replace(windowsReserved, '-')
    .replace(/\s+/g, ' ')
    .trim();
  const trimmed = collapsed.replace(/[. ]+$/g, '').trim();
  const bounded = trimmed.slice(0, maxFileStemLength).replace(/[. ]+$/g, '');
  if (!bounded) return fallback;
  const [stem] = bounded.split('.');
  return reservedDeviceNames.has(stem.toLowerCase()) ? `_${bounded}` : bounded;
}

/** `R01 - 319 - Clinton vs Wren B.qbj`. Human guidance only; never an identity. */
export function assignmentFileName(input: {
  roundNumber: number;
  roomName: string;
  leftTeamName: string;
  rightTeamName: string;
}): string {
  const round = `R${String(input.roundNumber).padStart(2, '0')}`;
  const matchup = `${input.leftTeamName.trim() || 'Team'} vs ${input.rightTeamName.trim() || 'Bye'}`;
  const parts = [round, input.roomName.trim() || 'Room', matchup];
  return `${sanitizeFileSegment(parts.join(' - '), 'Assignment')}.qbj`;
}

/** `YellowFruit Import/Round N`, the flat folder the director imports from YellowFruit. */
export function importFolderName(roundNumber: number): string {
  return `Round ${roundNumber}`;
}

/**
 * Join path segments with `/`. The native layer resolves them against the project root; every
 * segment entering here has passed through `sanitizeFileSegment` or is a fixed literal, so no
 * segment can be absolute or climb out.
 */
export function joinPath(...segments: string[]): string {
  return segments.join('/');
}

/** All directories a fresh project needs, relative to the tournament folder. */
export function projectDirectories(roomNames: readonly string[], rounds: readonly number[]): string[] {
  const directories: string[] = [];
  for (const room of roomNames) {
    directories.push(joinPath(room, IN_DIR_NAME));
    directories.push(joinPath(room, OUT_DIR_NAME));
  }
  for (const round of rounds) {
    directories.push(joinPath(IMPORT_ROOT_NAME, importFolderName(round)));
  }
  return directories;
}

/**
 * Give a taken destination name a suffix rather than overwriting.
 *
 * Two rooms can legitimately produce the same descriptive name, and silently replacing the
 * first file would drop a result somebody may not have imported yet.
 */
export function uniqueFileName(candidate: string, taken: ReadonlySet<string>): string {
  if (!taken.has(candidate.toLowerCase())) return candidate;
  const dot = candidate.lastIndexOf('.');
  const stem = dot > 0 ? candidate.slice(0, dot) : candidate;
  const extension = dot > 0 ? candidate.slice(dot) : '';
  for (let index = 2; index < 1000; index += 1) {
    const next = `${stem} (${index})${extension}`;
    if (!taken.has(next.toLowerCase())) return next;
  }
  return `${stem} (${Date.now()})${extension}`;
}

/** Keep a browser-chosen folder name honest: exactly one safe segment. */
export function safeFolderName(value: string, fallback = 'Tournament'): string {
  return sanitizeFileSegment(value, fallback);
}
