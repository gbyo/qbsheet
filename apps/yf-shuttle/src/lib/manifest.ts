/**
 * `.yf-shuttle.json`: the small transparent project manifest.
 *
 * The manifest records *intent and identity* — which tournament, which rooms, which assignments
 * were generated, which result file the operator chose when duplicates exist, and the confirmed
 * playoff slot mapping. The files themselves remain authoritative: scoring results, standings,
 * and advancement live in the QBJs and the `.yft`, never here. No credentials, tokens, browser
 * state, or results-as-truth may be stored in this file.
 */

import { PRESET_ID } from './schedule';

export const MANIFEST_VERSION = 1;
export const MANIFEST_FILE_NAME = '.yf-shuttle.json';

export interface ManifestRoom {
  slotId: string;
  displayName: string;
}

export interface ManifestAssignment {
  matchId: string;
  roundNumber: number;
  roundId: string;
  slotId: string;
  leftTeamId: string;
  rightTeamId: string;
  fileName: string;
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
  /** Match id → chosen OUT file name, when duplicate results exist for one game. */
  selectedResults: Record<string, string>;
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
    preparedRounds: [],
  };
}

export function parseManifest(text: string): { ok: true; manifest: ShuttleManifest } | { ok: false; error: string } {
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
  return {
    ok: true,
    manifest: {
      version: MANIFEST_VERSION,
      tournamentId: value.tournamentId,
      tournamentName: typeof value.tournamentName === 'string' ? value.tournamentName : '',
      tournamentFingerprint: typeof value.tournamentFingerprint === 'string' ? value.tournamentFingerprint : '',
      preset: PRESET_ID,
      rooms: (value.rooms as ManifestRoom[]).filter(
        (room) => typeof room?.slotId === 'string' && typeof room?.displayName === 'string',
      ),
      assignments: (value.assignments as ManifestAssignment[]).filter(
        (entry) =>
          typeof entry?.matchId === 'string' &&
          typeof entry?.roundNumber === 'number' &&
          typeof entry?.slotId === 'string',
      ),
      ...(value.playoffSlots && typeof value.playoffSlots === 'object'
        ? { playoffSlots: value.playoffSlots as Record<string, string> }
        : {}),
      selectedResults:
        value.selectedResults && typeof value.selectedResults === 'object' && !Array.isArray(value.selectedResults)
          ? (value.selectedResults as Record<string, string>)
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
 * The same tournament keeps its project: rooms, assignments, duplicate choices, and confirmed
 * playoff slots all still name real games. A different tournament never inherits them — the
 * caller starts fresh and says so, rather than silently reusing another event's project.
 */
export function resolveManifestOnLoad(
  existing: ShuttleManifest | null | undefined,
  tournamentId: string,
): { keep: true; manifest: ShuttleManifest } | { keep: false } {
  if (existing && existing.tournamentId === tournamentId) return { keep: true, manifest: existing };
  return { keep: false };
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
