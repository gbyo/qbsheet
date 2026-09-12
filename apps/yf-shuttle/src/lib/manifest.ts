/**
 * `.yf-shuttle.json`: the small transparent project manifest.
 *
 * The manifest records *intent and identity* — which tournament, which rooms, which assignments
 * were generated, which result file the operator chose when duplicates exist, and the confirmed
 * playoff slot mapping. The files themselves remain authoritative: scoring results, standings,
 * and advancement live in the QBJs and the `.yft`, never here. No credentials, tokens, browser
 * state, or results-as-truth may be stored in this file.
 */

import { sanitizeFileSegment } from './project';
import { PRESET_ID } from './schedule';

export const MANIFEST_VERSION = 1;
export const MANIFEST_FILE_NAME = '.yf-shuttle.json';

export interface ManifestRoom {
  slotId: string;
  displayName: string;
  /**
   * The sanitized single path segment used for this room's folders. The display name is
   * what the operator typed; the folder is what reached the disk. Match identity keys on
   * the slot id, never on either name.
   */
  folderName: string;
}

export interface ManifestAssignment {
  matchId: string;
  roundNumber: number;
  roundId: string;
  slotId: string;
  leftTeamId: string;
  rightTeamId: string;
  fileName: string;
  /**
   * Where the game came from: a real scheduled Match in the file (`yft`), or the printed
   * preset (absent). Decides the return path: file-sourced games fill a YellowFruit copy,
   * preset games batch for Games → Import — because stock YellowFruit appends imports and
   * must never see a completed game whose blank already sits in the file.
   */
  source?: string;
}

export interface ShuttleManifest {
  version: number;
  tournamentId: string;
  tournamentName: string;
  /** Fingerprint of the source tournament identity (id + team ids + seeds). */
  tournamentFingerprint: string;
  preset: typeof PRESET_ID;
  rooms: ManifestRoom[];
  assignments: ManifestAssignment[];
  /** Confirmed F1–F6 / B1–B6 team ids, once the operator confirms playoff slots. */
  playoffSlots?: Record<string, string>;
  /**
   * Match id → chosen result candidate identity (`folder/file#content-hash`), when duplicate
   * results exist for one game. Points at the physical file, never a bare basename.
   */
  selectedResults: Record<string, string>;
  /**
   * Match id → derived filename YF Shuttle wrote under `YellowFruit Import`. The ownership
   * record that lets a re-prepare overwrite its own copies and remove stale ones without
   * touching files the operator placed by hand.
   */
  derivedFiles: Record<string, string>;
  /** Round numbers whose import batch was prepared (derived files exist under YellowFruit Import). */
  preparedRounds: number[];
}

export function createManifest(input: {
  tournamentId: string;
  tournamentName: string;
  tournamentFingerprint: string;
  rooms: ManifestRoom[];
}): ShuttleManifest {
  return {
    version: MANIFEST_VERSION,
    tournamentId: input.tournamentId,
    tournamentName: input.tournamentName,
    tournamentFingerprint: input.tournamentFingerprint,
    preset: PRESET_ID,
    rooms: input.rooms,
    assignments: [],
    selectedResults: {},
    derivedFiles: {},
    preparedRounds: [],
  };
}

export function parseManifest(
  text: string,
): { ok: true; manifest: ShuttleManifest } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'The project file .yf-shuttle.json is not valid JSON.' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'The project file .yf-shuttle.json does not hold a project.' };
  }
  const value = parsed as Record<string, unknown>;
  if (value.version !== MANIFEST_VERSION) {
    return { ok: false, error: 'This project was written by a different version of YF Shuttle.' };
  }
  if (typeof value.tournamentId !== 'string' || !value.tournamentId) {
    return { ok: false, error: 'The project file has no tournament identity in it.' };
  }
  if (!Array.isArray(value.rooms) || !Array.isArray(value.assignments)) {
    return { ok: false, error: 'The project file is missing its rooms or assignments.' };
  }
  // Every assignment must be whole: a record missing its round, teams, or filename would
  // reconcile results against empty strings and report valid files as mismatches. Reject
  // the project with the exact record named rather than running on a corrupt one.
  const assignments: ManifestAssignment[] = [];
  for (const [index, entry] of (value.assignments as unknown[]).entries()) {
    const problems: string[] = [];
    const record = (entry ?? {}) as Record<string, unknown>;
    if (typeof record.matchId !== 'string' || !record.matchId) problems.push('matchId');
    if (
      typeof record.roundNumber !== 'number' ||
      !Number.isSafeInteger(record.roundNumber) ||
      record.roundNumber <= 0
    ) {
      problems.push('roundNumber');
    }
    if (typeof record.roundId !== 'string' || !record.roundId) problems.push('roundId');
    if (typeof record.slotId !== 'string' || !record.slotId) problems.push('slotId');
    if (typeof record.leftTeamId !== 'string' || !record.leftTeamId) problems.push('leftTeamId');
    if (typeof record.rightTeamId !== 'string' || !record.rightTeamId) problems.push('rightTeamId');
    if (typeof record.fileName !== 'string' || !record.fileName) problems.push('fileName');
    if (record.source !== undefined && record.source !== 'yft') problems.push('source');
    if (problems.length > 0) {
      return {
        ok: false,
        error: `The project file's assignment ${index + 1} is corrupt (bad ${problems.join(', ')}). Restore ${MANIFEST_FILE_NAME} from a copy, or recreate the project.`,
      };
    }
    assignments.push({
      matchId: record.matchId as string,
      roundNumber: record.roundNumber as number,
      roundId: record.roundId as string,
      slotId: record.slotId as string,
      leftTeamId: record.leftTeamId as string,
      rightTeamId: record.rightTeamId as string,
      fileName: record.fileName as string,
      ...(record.source === 'yft' ? { source: 'yft' as const } : {}),
    });
  }
  return {
    ok: true,
    manifest: {
      version: MANIFEST_VERSION,
      tournamentId: value.tournamentId,
      tournamentName: typeof value.tournamentName === 'string' ? value.tournamentName : '',
      tournamentFingerprint:
        typeof value.tournamentFingerprint === 'string' ? value.tournamentFingerprint : '',
      preset: PRESET_ID,
      rooms: (value.rooms as ManifestRoom[])
        .filter((room) => typeof room?.slotId === 'string' && typeof room?.displayName === 'string')
        .map((room) => ({
          slotId: room.slotId,
          displayName: room.displayName,
          // Projects written before folder names were tracked used the display name on disk.
          // Sanitize it into a safe segment rather than trusting it as a path.
          folderName:
            typeof room.folderName === 'string' && room.folderName
              ? room.folderName
              : sanitizeFileSegment(room.displayName, room.slotId),
        })),
      assignments,
      ...(value.playoffSlots && typeof value.playoffSlots === 'object'
        ? { playoffSlots: value.playoffSlots as Record<string, string> }
        : {}),
      selectedResults:
        value.selectedResults &&
        typeof value.selectedResults === 'object' &&
        !Array.isArray(value.selectedResults)
          ? (value.selectedResults as Record<string, string>)
          : {},
      derivedFiles:
        value.derivedFiles && typeof value.derivedFiles === 'object' && !Array.isArray(value.derivedFiles)
          ? (value.derivedFiles as Record<string, string>)
          : {},
      preparedRounds: Array.isArray(value.preparedRounds)
        ? (value.preparedRounds as unknown[]).filter(
            (entry): entry is number => typeof entry === 'number' && Number.isSafeInteger(entry),
          )
        : [],
    },
  };
}

/** Serialize for writing. Stable key order so diffs stay readable. */
export function manifestFileContents(manifest: ShuttleManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Decide what happens to the working project when a (possibly different) file is opened.
 *
 * The same event keeps its project only when the identity fingerprint still matches: rooms,
 * assignments, duplicate choices, and confirmed playoff slots all name real games of that
 * shape. A different tournament — or the same id with changed teams or seeds — never
 * inherits them, because the assignments were generated for another shape. The caller
 * starts fresh and says so.
 */
export function resolveManifestOnLoad(
  existing: ShuttleManifest | null | undefined,
  tournamentId: string,
  tournamentFingerprint: string,
): { keep: true; manifest: ShuttleManifest } | { keep: false; reason: 'different' | 'drifted' } {
  if (!existing || existing.tournamentId !== tournamentId) return { keep: false, reason: 'different' };
  if (existing.tournamentFingerprint !== tournamentFingerprint) return { keep: false, reason: 'drifted' };
  return { keep: true, manifest: existing };
}

export function assignmentByMatchId(
  manifest: ShuttleManifest,
  matchId: string,
): ManifestAssignment | undefined {
  return manifest.assignments.find((entry) => entry.matchId === matchId);
}

/** Display name for a slot, falling back to the slot id when the project renamed nothing. */
export function roomDisplayName(manifest: ShuttleManifest, slotId: string): string {
  return manifest.rooms.find((room) => room.slotId === slotId)?.displayName ?? slotId;
}

export type WriteOutcome = 'written' | 'identical' | 'conflicted';

export interface WrittenGame {
  matchId: string;
  roundNumber: number;
  roundId: string;
  slotId: string;
  leftTeamId: string;
  rightTeamId: string;
  fileName: string;
}

/**
 * Decide which planned games enter the manifest after an assignment-writing pass.
 *
 * Keyed by Match id throughout — never by display text, round substrings, or filenames. A game
 * joins the manifest only when its IN file was written or an identical file was already there.
 * A differing file is reported as exactly that game (round + room) and stays out, so the app
 * never expects a result for a Match file that never reached the room.
 */
export function partitionWrittenGames(
  planned: readonly WrittenGame[],
  outcomes: Readonly<Record<string, WriteOutcome>>,
): { entries: ManifestAssignment[]; conflicts: { roundNumber: number; slotId: string; matchId: string }[] } {
  const entries: ManifestAssignment[] = [];
  const conflicts: { roundNumber: number; slotId: string; matchId: string }[] = [];
  for (const game of planned) {
    const outcome = outcomes[game.matchId];
    if (outcome === 'written' || outcome === 'identical') {
      entries.push({ ...game });
    } else {
      conflicts.push({ roundNumber: game.roundNumber, slotId: game.slotId, matchId: game.matchId });
    }
  }
  return { entries, conflicts };
}

/**
 * Reopen a project from its manifest file with no session state at all.
 *
 * Pure so the recovery workflow is testable without storage: the caller supplies the manifest
 * bytes and, when available, the tournament id of an already-loaded `.yft`. A moved folder
 * works because nothing in the manifest is an absolute path — room folders resolve against
 * whichever project directory the operator chose.
 */
export function openProjectFromManifest(
  manifestText: string,
  loadedTournamentId?: string,
):
  | { ok: true; manifest: ShuttleManifest; needsYft: boolean }
  | { ok: false; error: string; needsYft: boolean } {
  const parsed = parseManifest(manifestText);
  if (!parsed.ok) return { ok: false, error: parsed.error, needsYft: false };
  if (loadedTournamentId === undefined) return { ok: true, manifest: parsed.manifest, needsYft: true };
  if (loadedTournamentId !== parsed.manifest.tournamentId) {
    return {
      ok: false,
      error: `That project belongs to a different tournament (“${parsed.manifest.tournamentName || parsed.manifest.tournamentId}”). Open its own YellowFruit file instead.`,
      needsYft: true,
    };
  }
  return { ok: true, manifest: parsed.manifest, needsYft: false };
}
