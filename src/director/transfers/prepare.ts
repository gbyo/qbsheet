/**
 * Writing assignments to a destination, safely enough to be done during a round.
 *
 * # Order matters, and it is not the obvious one
 *
 * Directories, then the assignment files, then the README, then the manifest — the manifest last on
 * purpose. `transfer.json` names the files it expects; a reader that finds it should find them.
 * Writing it first produces a drive that claims twelve assignments during the ten seconds it takes
 * to write them, and a scorekeeper who looks at exactly the wrong moment concludes the drive is
 * broken.
 *
 * # Half a file is worse than no file
 *
 * Every write is atomic: a temporary file, flushed, then renamed over the destination. A scorekeeper
 * who pulls a stick mid-write gets the previous file or no file, never a truncated JSON document
 * that parses far enough to look like a game. The atomicity is the native layer's job; this file's
 * job is to never ask for a non-atomic write.
 *
 * # What "finished" is allowed to mean
 *
 * When every write has returned, Director says it has finished writing and that the drive should be
 * ejected normally. It does not say the drive is safe to remove, because it has not performed an
 * OS-level eject and cannot see the operating system's own write cache. Claiming otherwise is how a
 * tournament loses a round of assignments to a stick pulled at the wrong second.
 */
import type { DirectorState } from '../domain/model';
import {
  buildAssignment,
  selectScheduledGames,
  type AssignmentBuildFailure,
  type AssignmentSelection,
  type PreparedAssignment,
} from './assignment';
import { digestText } from './canonical';
import { uniqueFileName } from './filenames';
import { buildManifest, exchangePaths, joinPath, readmeText, type TransferManifestEntry } from './layout';
import type { TransferFileSystem } from './ports';

export interface PrepareRequest {
  /** Directory the director chose. The `QBSheet/` layout is created inside it. */
  basePath: string;
  /** What a person calls the destination, used in the transfer log and in messages. */
  destinationLabel: string;
  selection: AssignmentSelection;
  handoffInstruction?: string;
  directorBuild: string;
  /** Group assignments into `Assignments/Round N/` rather than one flat directory. */
  groupByRound?: boolean;
}

export interface PreparedWrite {
  assignment: PreparedAssignment;
  path: string;
  fileName: string;
  digest: string;
  byteLength: number;
}

export interface PrepareReport {
  ok: boolean;
  written: PreparedWrite[];
  failures: AssignmentBuildFailure[];
  warnings: string[];
  rootPath: string;
  manifestPath?: string;
  /** The sentence shown to the director when this finishes. */
  message: string;
  /** Set when nothing could be written at all. */
  error?: string;
}

function totalBytes(values: string[]): number {
  const encoder = new TextEncoder();
  return values.reduce((sum, value) => sum + encoder.encode(value).byteLength, 0);
}

/**
 * Build the files for a selection without touching a filesystem.
 *
 * Separated from writing so the UI can show what a "Prepare Round 6 files" click would produce, and
 * so the no-future-pairings and no-secrets tests can inspect exactly the bytes that would be
 * written rather than a reconstruction of them.
 */
export function planAssignments(
  state: DirectorState,
  selection: AssignmentSelection,
  options: { handoffInstruction?: string } = {},
): { assignments: PreparedAssignment[]; failures: AssignmentBuildFailure[]; warnings: string[] } {
  const games = selectScheduledGames(state, selection);
  const assignments: PreparedAssignment[] = [];
  const failures: AssignmentBuildFailure[] = [];
  const warnings = new Set<string>();
  const taken = new Set<string>();
  for (const game of games) {
    const built = buildAssignment(state, game.id, options);
    if (!built.ok) {
      failures.push(built.failure);
      continue;
    }
    const fileName = uniqueFileName(built.assignment.fileName, taken);
    taken.add(fileName.toLowerCase());
    built.assignment.warnings.forEach((warning) => warnings.add(warning));
    assignments.push({ ...built.assignment, fileName });
  }
  return { assignments, failures, warnings: [...warnings] };
}

function manifestEntry(assignment: PreparedAssignment): TransferManifestEntry {
  return {
    matchId: assignment.matchId,
    roundId: assignment.roundId,
    roundName: assignment.roundName,
    roundRevision: assignment.roundRevision,
    assignmentRevision: assignment.assignmentRevision,
    fileName: assignment.fileName,
    ...(assignment.roomName ? { room: assignment.roomName } : {}),
    teams: [assignment.leftTeamName, assignment.rightTeamName],
  };
}

/**
 * Write a selection to a destination.
 *
 * Partial success is a real outcome and is reported as one. A drive that fills up after eight of
 * twelve files leaves eight usable assignments and a message naming the four that did not fit;
 * discarding the eight to keep the operation atomic would be worse for every room that could have
 * had its file.
 */
export async function prepareAssignments(
  state: DirectorState,
  fileSystem: TransferFileSystem,
  request: PrepareRequest,
): Promise<PrepareReport> {
  const paths = exchangePaths(request.basePath);
  const plan = planAssignments(state, request.selection, {
    ...(request.handoffInstruction ? { handoffInstruction: request.handoffInstruction } : {}),
  });
  const warnings = [...plan.warnings];
  const base: PrepareReport = {
    ok: false,
    written: [],
    failures: plan.failures,
    warnings,
    rootPath: paths.root,
    message: '',
  };
  const tournament = state.tournament;
  if (!tournament)
    return { ...base, error: 'There is no open tournament.', message: 'No tournament is open.' };
  if (plan.assignments.length === 0)
    return {
      ...base,
      error: 'That selection contains no game with two teams.',
      message: 'There was nothing to prepare.',
    };

  const readme = readmeText(tournament.name);
  const requiredBytes = totalBytes([...plan.assignments.map((entry) => entry.text), readme]) * 1.1;
  try {
    const available = await fileSystem.availableBytes(request.basePath);
    if (available !== undefined && available < requiredBytes)
      return {
        ...base,
        error: `${request.destinationLabel} does not have room for ${plan.assignments.length} assignment files.`,
        message: `${request.destinationLabel} is full.`,
      };
  } catch {
    // Free space is advisory. A platform that cannot report it must not stop a director preparing a
    // stick; the write itself will fail with a real message if there genuinely is no room.
  }

  try {
    await fileSystem.createDirectory(paths.root);
    await fileSystem.createDirectory(paths.assignments);
    await fileSystem.createDirectory(paths.results);
  } catch (reason: unknown) {
    const message = reason instanceof Error ? reason.message : 'The destination could not be prepared.';
    return { ...base, error: message, message };
  }

  const written: PreparedWrite[] = [];
  const failures = [...plan.failures];
  const roundDirectories = new Set<string>();
  for (const assignment of plan.assignments) {
    const directory = request.groupByRound
      ? joinPath(paths.assignments, assignment.roundName.replace(/[\\/]/g, '-'))
      : paths.assignments;
    try {
      if (request.groupByRound && !roundDirectories.has(directory)) {
        await fileSystem.createDirectory(directory);
        roundDirectories.add(directory);
      }
      const path = joinPath(directory, assignment.fileName);
      await fileSystem.writeFileAtomic(path, assignment.text);
      written.push({
        assignment,
        path,
        fileName: assignment.fileName,
        digest: digestText(assignment.text),
        byteLength: new TextEncoder().encode(assignment.text).byteLength,
      });
    } catch (reason: unknown) {
      failures.push({
        scheduledGameId: assignment.scheduledGameId,
        reason: reason instanceof Error ? reason.message : 'That file could not be written.',
      });
    }
  }

  if (written.length === 0) {
    const message = failures[0]?.reason ?? 'No assignment files could be written.';
    return { ...base, failures, error: message, message };
  }

  let manifestPath: string | undefined;
  try {
    await fileSystem.writeFileAtomic(paths.readme, readme);
  } catch {
    warnings.push('The README could not be written. The assignment files are still complete.');
  }
  try {
    const manifest = buildManifest({
      tournamentId: tournament.id,
      tournamentName: tournament.name,
      preparedAt: new Date().toISOString(),
      directorBuild: request.directorBuild,
      assignments: written.map((entry) => manifestEntry(entry.assignment)),
      ...(request.handoffInstruction ? { handoffInstruction: request.handoffInstruction } : {}),
    });
    await fileSystem.writeFileAtomic(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
    manifestPath = paths.manifest;
  } catch {
    // The manifest is a hint. Losing it costs recognition specificity and nothing else, and every
    // `.qbj` on the drive remains a complete, self-contained, importable assignment.
    warnings.push('The transfer manifest could not be written. The assignment files remain usable.');
  }

  const count = written.length;
  const message =
    failures.length === 0
      ? `${count} assignment${count === 1 ? '' : 's'} prepared.\n\nQBSheet finished writing to ${request.destinationLabel}. Eject the drive normally before removing it.`
      : `${count} assignment${count === 1 ? '' : 's'} prepared; ${failures.length} could not be written.`;

  return {
    ok: true,
    written,
    failures,
    warnings,
    rootPath: paths.root,
    ...(manifestPath ? { manifestPath } : {}),
    message,
  };
}

/**
 * Create the exchange layout without writing any assignment.
 *
 * Used when a director adds a folder and wants it watched before a round exists. A folder with the
 * layout in place is one a scorekeeper can be pointed at immediately.
 */
export async function initializeExchange(
  fileSystem: TransferFileSystem,
  basePath: string,
  tournamentName: string,
): Promise<{ ok: boolean; rootPath: string; error?: string }> {
  const paths = exchangePaths(basePath);
  try {
    await fileSystem.createDirectory(paths.root);
    await fileSystem.createDirectory(paths.assignments);
    await fileSystem.createDirectory(paths.results);
    await fileSystem.writeFileAtomic(paths.readme, readmeText(tournamentName));
    return { ok: true, rootPath: paths.root };
  } catch (reason: unknown) {
    return {
      ok: false,
      rootPath: paths.root,
      error: reason instanceof Error ? reason.message : 'That folder could not be prepared.',
    };
  }
}
