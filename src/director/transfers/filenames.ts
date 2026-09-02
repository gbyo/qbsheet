/**
 * Filenames a person can read, on filesystems that disagree about what a filename is.
 *
 * # The name is for the human, never for the machine
 *
 * `Round 5 - Room 104 - Ninety Six A vs Greenwood A.qbj` exists so a scorekeeper handed a USB stick
 * can find their game without opening four files. Nothing in Director parses it. Identity comes out
 * of the QBJ — `Tournament.id`, `Match.id` — which is the whole reason the assignment carries them,
 * and a renamed file still lands on the right scheduled game.
 *
 * That has a consequence worth stating plainly: renaming a file does not reassign it. The README
 * Director writes onto every drive says so, because the alternative is a room "moving" a game by
 * renaming it and a result landing on somebody else's match.
 *
 * # What has to be sanitized, and why it is the union and not the platform's own rules
 *
 * A file written on macOS is read on Windows. So the rules applied are the union of all three:
 * Windows' reserved characters `<>:"/\|?*`, its reserved device names (`CON`, `PRN`, `AUX`, `NUL`,
 * `COM1`…`LPT9` — reserved with any extension), its refusal of trailing dots and spaces, control
 * characters, and a conservative length bound. Applying only the host's rules produces a stick that
 * works on the machine that wrote it.
 */

const windowsReserved = /[<>:"/\\|?*]/g;

/**
 * Strip C0 controls and DEL.
 *
 * A loop rather than a regular expression because a literal control range in source is both
 * unreadable and a lint error, and because iterating code points handles surrogate pairs correctly
 * where a naive character loop would split an emoji in a team name.
 */
function withoutControlCharacters(value: string): string {
  let output = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    output += character;
  }
  return output;
}
const reservedDeviceNames = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

/** Bound on the stem, leaving room for an extension and a de-duplicating suffix. */
export const maxFileStemLength = 120;

/**
 * Make one path segment safe everywhere.
 *
 * Never returns an empty string and never returns a path: a separator in the input becomes a
 * hyphen rather than a directory, so a team named `A/B` cannot walk out of the destination.
 */
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

export interface AssignmentFileNameParts {
  roundName: string;
  roomName?: string | null;
  leftTeam: string;
  rightTeam?: string | null;
}

/**
 * `Round 5 - Room 104 - Ninety Six A vs Greenwood A.qbj`
 *
 * Parts that are missing are left out rather than filled with a placeholder: a tournament without
 * named rooms gets `Round 5 - Ninety Six A vs Greenwood A.qbj`, which reads better than
 * `Round 5 - Unknown Room - …` and is no less identifiable.
 */
export function assignmentFileName(parts: AssignmentFileNameParts): string {
  const segments = [
    parts.roundName.trim() || 'Round',
    ...(parts.roomName?.trim() ? [parts.roomName.trim()] : []),
    `${parts.leftTeam.trim() || 'Team'} vs ${parts.rightTeam?.trim() || 'Bye'}`,
  ];
  return `${sanitizeFileSegment(segments.join(' - '), 'Assignment')}.qbj`;
}

/**
 * Give a name that is already taken a suffix rather than overwriting.
 *
 * Two rooms can legitimately produce the same name — the same two teams meeting again in a
 * playoff, in a tournament without room names — and silently replacing the first file would drop an
 * assignment that a room is waiting for.
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

export function isQbjFileName(name: string): boolean {
  return /\.qbj$/i.test(name.trim());
}

/**
 * A supported file that Transfers will read.
 *
 * `.json` is accepted alongside `.qbj` because a browser download, a mail client and a cloud web UI
 * all rename files, and refusing a valid QBJ document over its extension would send the director
 * back to renaming files by hand. The extension decides nothing else; the parse decides everything.
 */
export function isSupportedTransferFileName(name: string): boolean {
  return /\.(qbj|json)$/i.test(name.trim());
}
