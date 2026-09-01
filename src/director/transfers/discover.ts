/**
 * Looking at a drive without going through it.
 *
 * # The rule this file exists to keep
 *
 * A USB stick handed to a tournament director belongs to a volunteer. It has their photos on it. It
 * has their tax return on it. Director looks in the places a QBSheet file would be and nowhere
 * else, and it never recurses into arbitrary directories on removable media.
 *
 * Concretely, three places and no more:
 *
 *   1. `QBSheet/Results` and `QBSheet/Assignments`, which Director itself created
 *   2. the root of the drive, shallowly and bounded, because "put it on the stick" is what a
 *      scorekeeper was actually told and the root is where they put it
 *   3. a directory the director explicitly chose
 *
 * A folder the director picked is treated with the same restraint. It is their folder rather than a
 * stranger's, but a recursive crawl of a Google Drive root is still a bad thing for an application
 * to do during a round.
 *
 * # Everything below is a hostile-input surface
 *
 * The counts, the sizes, the depth, the symlinks and the extensions are all bounded here rather
 * than at the point of parse, because by the time a 4 GB file is being decoded the damage is a
 * frozen window during round five. A file that trips a bound is skipped with a reason, never
 * silently — a director who put a file in the right folder and saw nothing happen deserves to know
 * why.
 */
import {
  maxFilesPerBatch,
  maxFilesPerDirectory,
  maxRemovableRootEntries,
  maxScanDepth,
  maxScanFileBytes,
} from './limits';
import {
  assignmentsDirectoryName,
  exchangePaths,
  manifestFileName,
  parseManifest,
  resultsDirectoryName,
  type TransferManifest,
} from './layout';
import { isSupportedTransferFileName } from './filenames';
import { parseTransferBytes } from './parse';
import type { TransferDirectoryEntry, TransferFileSystem } from './ports';

export interface ScanCandidate {
  fileName: string;
  path: string;
  byteLength: number;
  /** Which of the three places this was found in, for the "where did this come from" column. */
  origin: 'results' | 'assignments' | 'root' | 'chosen';
}

export interface ScanSkip {
  path: string;
  reason: string;
}

export interface ScanReport {
  candidates: ScanCandidate[];
  skipped: ScanSkip[];
  manifest?: TransferManifest;
  /** Set when the location itself could not be read. Not an exception: media disappears. */
  error?: string;
}

export interface ScanOptions {
  /** Include `QBSheet/Assignments`, so an unplayed assignment on the drive can be reported as one. */
  includeAssignments?: boolean;
  /** Look in the root of the volume. Only meaningful, and only done, for removable media. */
  includeRoot?: boolean;
  /** Ceiling on candidates returned across the whole scan. */
  limit?: number;
}

function supported(entry: TransferDirectoryEntry): boolean {
  return !entry.directory && isSupportedTransferFileName(entry.name);
}

/**
 * Read one directory, bounded, and say why anything was left out.
 *
 * Descends only while `depth` remains, which is what keeps `Assignments/Round 5/` reachable and
 * `Photos/2019/Italy/…` not. A symlink is never followed: on removable media it is either a
 * packaging artefact or a way to make Director read a path outside the folder it was given.
 */
async function collect(
  fileSystem: TransferFileSystem,
  path: string,
  origin: ScanCandidate['origin'],
  depth: number,
  limit: number,
  candidates: ScanCandidate[],
  skipped: ScanSkip[],
): Promise<void> {
  if (candidates.length >= limit) return;
  let entries: TransferDirectoryEntry[];
  try {
    entries = await fileSystem.listDirectory(path, maxFilesPerDirectory);
  } catch (reason: unknown) {
    skipped.push({
      path,
      reason: reason instanceof Error ? reason.message : 'That folder could not be read.',
    });
    return;
  }
  if (entries.length >= maxFilesPerDirectory)
    skipped.push({
      path,
      reason: `Only the first ${maxFilesPerDirectory} entries in this folder were examined.`,
    });
  for (const entry of entries) {
    if (candidates.length >= limit) return;
    if (entry.symlink) {
      skipped.push({ path: entry.path, reason: 'Links are not followed.' });
      continue;
    }
    if (entry.directory) {
      if (depth > 0) await collect(fileSystem, entry.path, origin, depth - 1, limit, candidates, skipped);
      continue;
    }
    if (!supported(entry)) continue;
    if (entry.byteLength > maxScanFileBytes) {
      skipped.push({ path: entry.path, reason: 'That file is too large to read as QBJ.' });
      continue;
    }
    candidates.push({ fileName: entry.name, path: entry.path, byteLength: entry.byteLength, origin });
  }
}

/** Read the transfer manifest at a root, if there is a readable one. */
async function readManifest(
  fileSystem: TransferFileSystem,
  path: string,
): Promise<TransferManifest | undefined> {
  try {
    const file = await fileSystem.readFile(path, maxScanFileBytes);
    const parsed = parseTransferBytes(file.bytes);
    return parsed.ok ? (parseManifest(parsed.value) ?? undefined) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Everything worth reading at a transfer location.
 *
 * Never throws. A drive pulled mid-scan produces a report with the candidates found so far and a
 * skip entry saying the drive went away, which is exactly what the director should see.
 */
export async function scanTransferLocation(
  fileSystem: TransferFileSystem,
  basePath: string,
  options: ScanOptions = {},
): Promise<ScanReport> {
  const limit = options.limit ?? maxFilesPerBatch;
  const paths = exchangePaths(basePath);
  const candidates: ScanCandidate[] = [];
  const skipped: ScanSkip[] = [];

  let hasExchange = false;
  try {
    hasExchange = await fileSystem.exists(paths.root);
  } catch (reason: unknown) {
    return {
      candidates: [],
      skipped: [],
      error: reason instanceof Error ? reason.message : 'That location could not be read.',
    };
  }

  const manifest = hasExchange ? await readManifest(fileSystem, paths.manifest) : undefined;

  if (hasExchange) {
    await collect(fileSystem, paths.results, 'results', maxScanDepth - 1, limit, candidates, skipped);
    if (options.includeAssignments)
      await collect(
        fileSystem,
        paths.assignments,
        'assignments',
        maxScanDepth - 1,
        limit,
        candidates,
        skipped,
      );
  }

  if (options.includeRoot) {
    // Shallow and bounded, and only the root itself: no descent into whatever else is on the stick.
    let entries: TransferDirectoryEntry[] = [];
    try {
      entries = await fileSystem.listDirectory(basePath, maxRemovableRootEntries);
    } catch (reason: unknown) {
      skipped.push({
        path: basePath,
        reason: reason instanceof Error ? reason.message : 'The drive could not be read.',
      });
    }
    for (const entry of entries) {
      if (candidates.length >= limit) break;
      if (entry.directory || entry.symlink) continue;
      if (!supported(entry)) continue;
      if (entry.byteLength > maxScanFileBytes) {
        skipped.push({ path: entry.path, reason: 'That file is too large to read as QBJ.' });
        continue;
      }
      candidates.push({
        fileName: entry.name,
        path: entry.path,
        byteLength: entry.byteLength,
        origin: 'root',
      });
    }
  }

  if (!hasExchange && !options.includeRoot)
    await collect(fileSystem, basePath, 'chosen', 1, limit, candidates, skipped);

  const seen = new Set<string>();
  const unique = candidates.filter((candidate) => {
    const key = candidate.path.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { candidates: unique, skipped, ...(manifest ? { manifest } : {}) };
}

/**
 * Does this volume hold anything QBSheet put there?
 *
 * Cheap on purpose: it is asked every time a drive appears, and the answer decides whether the
 * director sees a quiet line about the drive or nothing at all. A drive with no QBSheet directory
 * and no `.qbj` in its root is somebody's photo stick and produces no notification.
 */
export async function looksLikeTransferVolume(
  fileSystem: TransferFileSystem,
  mountPoint: string,
): Promise<{ recognized: boolean; resultCount: number; assignmentCount: number; error?: string }> {
  try {
    const paths = exchangePaths(mountPoint);
    if (await fileSystem.exists(paths.root)) {
      const report = await scanTransferLocation(fileSystem, mountPoint, { includeAssignments: true });
      return {
        recognized: true,
        resultCount: report.candidates.filter((entry) => entry.origin === 'results').length,
        assignmentCount: report.candidates.filter((entry) => entry.origin === 'assignments').length,
        ...(report.error ? { error: report.error } : {}),
      };
    }
    const entries = await fileSystem.listDirectory(mountPoint, maxRemovableRootEntries);
    const loose = entries.filter((entry) => !entry.directory && !entry.symlink && supported(entry));
    return { recognized: loose.length > 0, resultCount: loose.length, assignmentCount: 0 };
  } catch (reason: unknown) {
    return {
      recognized: false,
      resultCount: 0,
      assignmentCount: 0,
      error: reason instanceof Error ? reason.message : 'The drive could not be read.',
    };
  }
}

export { assignmentsDirectoryName, manifestFileName, resultsDirectoryName };
