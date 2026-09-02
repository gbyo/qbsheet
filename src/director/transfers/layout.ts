/**
 * The shape Director gives a drive or a folder, and the small manifest that makes it recognisable.
 *
 * # Why the layout is fixed and the manifest is optional
 *
 * The directory names are fixed so that a person who has seen one QBSheet drive can read the next
 * one, and so that scanning a drive means looking in two places rather than crawling it. The
 * manifest is optional because a tournament will lose it: a scorekeeper copies the four files they
 * were told about, a cloud client syncs a subfolder, a drive gets reformatted and refilled by hand.
 *
 * So `transfer.json` is a hint, never a requirement. Every `.qbj` in `Assignments/` is a complete,
 * self-contained assignment, and every `.qbj` in `Results/` is read on its own terms. Delete the
 * manifest and nothing stops working — recognition gets slightly less specific, which is the
 * correct amount of damage for losing a hint.
 *
 * `transfer.json` is *not* a tournament format and not a scoresheet format. It says what was put on
 * this drive and when. Nothing scores from it and nothing imports a tournament out of it.
 */

export const exchangeRootName = 'QBSheet';
export const assignmentsDirectoryName = 'Assignments';
export const resultsDirectoryName = 'Results';
export const manifestFileName = 'transfer.json';
export const readmeFileName = 'README.txt';

export const transferManifestVersion = 1;

/** What the manifest says about one prepared assignment. Identity, not content. */
export interface TransferManifestEntry {
  matchId: string;
  roundId: string;
  roundName: string;
  roundRevision: number;
  assignmentRevision: number;
  fileName: string;
  room?: string;
  teams: string[];
}

/**
 * The transport manifest.
 *
 * Every field here is either identity that the `.qbj` files already carry, or a fact about the
 * transfer itself. There is deliberately no field a credential could be put in: no token, no
 * pairing code, no server address, no session. A drive is the least controlled thing a tournament
 * owns and this file rides on it.
 */
export interface TransferManifest {
  manifestVersion: number;
  tournamentId: string;
  tournamentName: string;
  preparedAt: string;
  directorBuild: string;
  assignments: TransferManifestEntry[];
  /** Free text the director wants the room to read. Displayed, never interpreted. */
  handoffInstruction?: string;
}

export interface ExchangePaths {
  root: string;
  assignments: string;
  results: string;
  manifest: string;
  readme: string;
}

/** Join path segments with a separator this platform's filesystem accepts. */
export function joinPath(base: string, ...segments: string[]): string {
  const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  const trimmedBase = base.replace(/[\\/]+$/, '');
  const tail = segments.map((segment) => segment.replace(/^[\\/]+|[\\/]+$/g, '')).filter(Boolean);
  return tail.length === 0 ? trimmedBase : `${trimmedBase}${separator}${tail.join(separator)}`;
}

export function lastPathSegment(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

/**
 * Where the exchange lives under a chosen directory.
 *
 * A directory that is already the `QBSheet` root is used as-is rather than nested, so that
 * re-adding a drive Director has already prepared does not produce `QBSheet/QBSheet/`.
 */
export function exchangePaths(base: string): ExchangePaths {
  const root =
    lastPathSegment(base).toLowerCase() === exchangeRootName.toLowerCase()
      ? base.replace(/[\\/]+$/, '')
      : joinPath(base, exchangeRootName);
  return {
    root,
    assignments: joinPath(root, assignmentsDirectoryName),
    results: joinPath(root, resultsDirectoryName),
    manifest: joinPath(root, manifestFileName),
    readme: joinPath(root, readmeFileName),
  };
}

export function buildManifest(input: {
  tournamentId: string;
  tournamentName: string;
  preparedAt: string;
  directorBuild: string;
  assignments: TransferManifestEntry[];
  handoffInstruction?: string;
}): TransferManifest {
  return {
    manifestVersion: transferManifestVersion,
    tournamentId: input.tournamentId,
    tournamentName: input.tournamentName,
    preparedAt: input.preparedAt,
    directorBuild: input.directorBuild,
    assignments: input.assignments,
    ...(input.handoffInstruction ? { handoffInstruction: input.handoffInstruction } : {}),
  };
}

/**
 * Read a manifest, forgivingly.
 *
 * A manifest that is malformed, from a newer Director, or truncated by a sync client mid-write
 * returns `null` and the drive is read as if it had none. Refusing a drive because its hint file is
 * unreadable would be the manifest becoming a requirement through the back door.
 */
export function parseManifest(value: unknown): TransferManifest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.manifestVersion !== transferManifestVersion) return null;
  const tournamentId = typeof candidate.tournamentId === 'string' ? candidate.tournamentId : '';
  const tournamentName = typeof candidate.tournamentName === 'string' ? candidate.tournamentName : '';
  if (!tournamentId) return null;
  const rawAssignments = Array.isArray(candidate.assignments) ? candidate.assignments : [];
  const assignments = rawAssignments.flatMap((entry): TransferManifestEntry[] => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.matchId !== 'string' || typeof record.fileName !== 'string') return [];
    return [
      {
        matchId: record.matchId,
        roundId: typeof record.roundId === 'string' ? record.roundId : '',
        roundName: typeof record.roundName === 'string' ? record.roundName : '',
        roundRevision: Number.isFinite(record.roundRevision) ? Number(record.roundRevision) : 1,
        assignmentRevision: Number.isFinite(record.assignmentRevision)
          ? Number(record.assignmentRevision)
          : 1,
        fileName: record.fileName,
        ...(typeof record.room === 'string' ? { room: record.room } : {}),
        teams: Array.isArray(record.teams) ? record.teams.filter((team) => typeof team === 'string') : [],
      },
    ];
  });
  return {
    manifestVersion: transferManifestVersion,
    tournamentId,
    tournamentName,
    preparedAt: typeof candidate.preparedAt === 'string' ? candidate.preparedAt : '',
    directorBuild: typeof candidate.directorBuild === 'string' ? candidate.directorBuild : '',
    assignments,
    ...(typeof candidate.handoffInstruction === 'string'
      ? { handoffInstruction: candidate.handoffInstruction }
      : {}),
  };
}

/**
 * The note a scorekeeper actually reads, written to the root of every prepared exchange.
 *
 * Short on purpose. The one non-obvious rule — that renaming a file does not change which game it
 * is — earns its two lines because the mistake it prevents puts a result on the wrong match.
 */
export function readmeText(tournamentName: string): string {
  return [
    'QBSheet tournament files',
    '',
    `Tournament: ${tournamentName}`,
    '',
    'Assignments are in the Assignments folder.',
    '',
    'Open the QBJ file for your room/game in QBSheet.',
    '',
    'When the game is finished, save the completed QBJ file in',
    'the Results folder or return the downloaded QBJ file to the',
    'tournament data table.',
    '',
    'Do not rename files merely to change their assigned game.',
    'QBSheet reads the assignment identity from the file.',
    '',
  ].join('\n');
}

/**
 * Providers whose sync folders behave differently enough to be worth a sentence to the director.
 *
 * Detected from the path because that is all Director has and all it wants: no provider API, no
 * account, no OAuth. Being wrong costs one advisory line, which is why a guess is acceptable here
 * and nowhere else in this subsystem.
 */
const cloudMarkers: Array<{ pattern: RegExp; provider: string }> = [
  { pattern: /(^|[\\/])google ?drive([\\/]|$)/i, provider: 'Google Drive' },
  { pattern: /(^|[\\/])my ?drive([\\/]|$)/i, provider: 'Google Drive' },
  { pattern: /(^|[\\/])onedrive[^\\/]*([\\/]|$)/i, provider: 'OneDrive' },
  { pattern: /(^|[\\/])dropbox([\\/]|$)/i, provider: 'Dropbox' },
  { pattern: /(^|[\\/])(mobile ?documents|iclouddrive|icloud ?drive)([\\/]|$)/i, provider: 'iCloud Drive' },
  { pattern: /(^|[\\/])sync(thing)?([\\/]|$)/i, provider: 'Syncthing' },
  { pattern: /(^|[\\/])box([\\/]|$)/i, provider: 'Box' },
];

export function detectCloudProvider(path: string): string | undefined {
  return cloudMarkers.find((marker) => marker.pattern.test(path))?.provider;
}

/**
 * The advice, and the limits of it.
 *
 * Director cannot make a provider pin a folder offline and does not pretend to. It says the thing a
 * TD can act on and moves out of the way; nothing blocks on this.
 */
export function cloudOfflineAdvice(provider: string): string {
  return `${provider} may keep files online only. For tournament-day reliability, make this exchange folder available offline in your sync app.`;
}
