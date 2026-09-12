/**
 * Reading the OUT folders: which games came back, and which file speaks for each one.
 *
 * # Identity, not filenames
 *
 * Every returned file is identified by its QBJ `Match.id` and checked against the assignments
 * this project generated (the manifest). Filenames, the OUT folder a file was dropped in, team
 * names, and round labels are display and warnings only — a valid result in the wrong room's
 * OUT folder is still that game, and is used correctly with a non-blocking warning.
 *
 * # What is (and is not) checked here
 *
 * Checked: supported QBJ envelope, same tournament, known Match id, matching round and teams,
 * real scoring content (an untouched assignment copied to OUT is not a result). Not checked:
 * YellowFruit's statistical validity — YellowFruit itself parses, validates, warns, and imports
 * the batch. A forfeit (`forfeit_loss` on a side) counts as a decided game even with no points
 * on the board.
 */

import type { ManifestAssignment, ShuttleManifest } from './manifest';

export type PlayState = 'unplayed' | 'partial' | 'complete';

export interface ScannedInputFile {
  /** Room folder the file was found in (an OUT folder's parent room name). */
  folderName: string;
  fileName: string;
  /** Exact file bytes. */
  bytes: string;
  modifiedMs?: number;
}

export interface ParsedResult {
  folderName: string;
  fileName: string;
  modifiedMs?: number;
  matchId: string;
  tournamentId: string;
  roundId?: string;
  roundName?: string;
  roundNumber?: number;
  teamIds: [string, string];
  teamNames: [string, string];
  points: [number | undefined, number | undefined];
  /** `Left 320 – Right 295`, with `?` where a side has no points. */
  scoreLine: string;
  playState: PlayState;
  forfeit: boolean;
}

export type FileProblem =
  | { kind: 'unreadable'; message: string }
  | { kind: 'unsupported'; message: string }
  | { kind: 'foreign-tournament'; message: string }
  | { kind: 'unknown-game'; message: string }
  | { kind: 'not-a-result'; message: string }
  | { kind: 'mismatch'; message: string };

export interface ProblemFile {
  folderName: string;
  fileName: string;
  problem: FileProblem;
}

export interface AssignmentScan {
  assignment: ManifestAssignment;
  /** Scored candidates for this game (partial or complete, forfeit included). */
  candidates: ParsedResult[];
  /** Files carrying this Match id but no scoring content. Never results. */
  untouchedCopies: ParsedResult[];
  /** The operator's choice among duplicates, when it still points at a file on disk. */
  selectedFileName?: string;
  /** Whether the current selection resolves to exactly one candidate on disk. */
  needsChoice: boolean;
  /** Non-blocking: the game was found outside its own room's OUT folder. */
  wrongFolder?: { foundIn: string; expectedRoom: string; roundNumber: number };
  /** The candidate that will go into the YellowFruit batch, if exactly one is determined. */
  chosen?: ParsedResult;
}

export interface ScanReport {
  scans: AssignmentScan[];
  problems: ProblemFile[];
  scannedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function refId(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (isRecord(value)) {
    if (typeof value.$ref === 'string') return value.$ref;
    if (typeof value.id === 'string') return value.id;
  }
  return undefined;
}

function nonBlank(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? value : undefined;
}

/**
 * How much of a game a match already describes.
 *
 * Mirrors `playState` in `src/qbj/ParseQbjAssignment.ts`: an unplayed game has no
 * `tossups_read`, no `match_questions`, and no nonzero points. Extended only for forfeits —
 * a decided-forfeit game may carry no points at all, and must still read as a result.
 */
export function playStateOf(match: Record<string, unknown>): { state: PlayState; forfeit: boolean } {
  const sides = Array.isArray(match.match_teams) ? match.match_teams.filter(isRecord) : [];
  const forfeit = sides.some((side) => side.forfeit_loss === true);
  const tossupsRead = finiteNumber(match.tossups_read) ?? 0;
  const hasQuestions = Array.isArray(match.match_questions) && match.match_questions.length > 0;
  const hasPoints = sides.some((side) => {
    const points = finiteNumber(side.points);
    return points !== undefined && points !== 0;
  });
  if (forfeit) return { state: 'complete', forfeit: true };
  if (tossupsRead === 0 && !hasQuestions && !hasPoints) return { state: 'unplayed', forfeit: false };
  if (tossupsRead >= 1 && hasPoints && !hasQuestions) return { state: 'complete', forfeit: false };
  return { state: 'partial', forfeit: false };
}

/**
 * The round number QBJ implies.
 *
 * Mirrors `roundNumberOf` in `src/qbj/ParseQbjAssignment.ts`: an explicit numeric field wins;
 * otherwise a bare-integer name ("4") counts and anything else ("Playoff 2") yields nothing
 * rather than a wrong number.
 */
function roundNumberOf(round: Record<string, unknown> | null): number | undefined {
  if (!round) return undefined;
  const explicit = finiteNumber(round.number);
  if (explicit !== undefined) return explicit;
  if (typeof round.name !== 'string') return undefined;
  const name = round.name.trim();
  if (!/^[+-]?\d+$/.test(name)) return undefined;
  const parsed = Number(name);
  return Number.isFinite(parsed) ? parsed : undefined;
}

interface SpineContext {
  roundId?: string;
  roundName?: string;
  phaseId?: string;
}

/**
 * Where a match sits in the schedule, walking `Tournament.phases[].rounds[].matches[]`
 * literally and resolving only the match link — the traversal stock YellowFruit's
 * `FileParsing.findMatches` performs, so a document it can read is a document this can read.
 * Top-level Round objects are a fallback for producers that emit them alongside the spine.
 */
function spineContextFor(document: Record<string, unknown>[], matchId: string): SpineContext {
  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of document) {
    if (isRecord(entry) && typeof entry.id === 'string') byId.set(entry.id, entry);
  }
  const matchRefers = (entry: unknown): boolean => {
    if (!isRecord(entry)) return false;
    if (typeof entry.$ref === 'string') return entry.$ref === matchId;
    return entry.id === matchId;
  };
  const tournaments = document.filter((entry) => isRecord(entry) && entry.type === 'Tournament');
  for (const tournament of tournaments) {
    if (!isRecord(tournament) || !Array.isArray(tournament.phases)) continue;
    for (const phaseRef of tournament.phases) {
      const phase = isRecord(phaseRef) ? phaseRef : undefined;
      if (!phase || !Array.isArray(phase.rounds)) continue;
      for (const roundRef of phase.rounds) {
        if (!isRecord(roundRef) || !Array.isArray(roundRef.matches)) continue;
        if (roundRef.matches.some(matchRefers)) {
          return {
            ...(typeof roundRef.id === 'string' ? { roundId: roundRef.id } : {}),
            ...(typeof roundRef.name === 'string' ? { roundName: roundRef.name } : {}),
            ...(typeof phase.id === 'string' ? { phaseId: phase.id } : {}),
          };
        }
      }
    }
  }
  for (const entry of document) {
    if (!isRecord(entry) || entry.type !== 'Round' || !Array.isArray(entry.matches)) continue;
    if (entry.matches.some(matchRefers)) {
      return {
        ...(typeof entry.id === 'string' ? { roundId: entry.id } : {}),
        ...(typeof entry.name === 'string' ? { roundName: entry.name } : {}),
      };
    }
  }
  return {};
}

/** Parse one OUT file into a result candidate, or describe why it is not one. */
export function parseResultFile(
  file: ScannedInputFile,
): { ok: true; result: ParsedResult } | { ok: false; problem: FileProblem } {
  const where = `“${file.fileName}”`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.bytes);
  } catch {
    return { ok: false, problem: { kind: 'unreadable', message: `${where} is not valid JSON.` } };
  }
  if (!isRecord(parsed)) {
    return { ok: false, problem: { kind: 'unreadable', message: `${where} is not a QBJ document.` } };
  }
  // A bare Match object (MODAQ-style) carries no tournament envelope and can never be
  // reconciled to this project; say so plainly rather than misreading it.
  if (parsed.type === 'Match' || (parsed.version === undefined && Array.isArray(parsed.match_teams))) {
    return {
      ok: false,
      problem: {
        kind: 'unsupported',
        message: `${where} is a bare Match without a tournament envelope; only complete QBJ files can be batched.`,
      },
    };
  }
  if (typeof parsed.version !== 'string') {
    return {
      ok: false,
      problem: { kind: 'unsupported', message: `${where} states no QBJ version.` },
    };
  }
  if (parsed.version !== '2.1.1') {
    return {
      ok: false,
      problem: {
        kind: 'unsupported',
        message: `${where} is QBJ ${parsed.version}; this build reads QBJ 2.1.1.`,
      },
    };
  }
  if (!Array.isArray(parsed.objects)) {
    return { ok: false, problem: { kind: 'unreadable', message: `${where} has no QBJ objects in it.` } };
  }
  const objects = parsed.objects.filter(isRecord);
  const tournament = objects.find((entry) => entry.type === 'Tournament');
  if (!tournament) {
    return { ok: false, problem: { kind: 'unreadable', message: `${where} names no tournament.` } };
  }
  const tournamentId = nonBlank(tournament.id);
  if (!tournamentId) {
    return { ok: false, problem: { kind: 'unreadable', message: `${where} names no tournament id.` } };
  }
  const matches = objects.filter((entry) => entry.type === 'Match');
  if (matches.length === 0) {
    return { ok: false, problem: { kind: 'unreadable', message: `${where} contains no games.` } };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      problem: {
        kind: 'unsupported',
        message: `${where} contains ${matches.length} games; only one-game QBJ files can be batched.`,
      },
    };
  }
  const match = matches[0];
  const matchId = nonBlank(match.id);
  if (!matchId) {
    return { ok: false, problem: { kind: 'unreadable', message: `${where} has a game with no Match id.` } };
  }

  const sides = Array.isArray(match.match_teams) ? match.match_teams.filter(isRecord) : [];
  if (sides.length !== 2) {
    return {
      ok: false,
      problem: { kind: 'unreadable', message: `${where} does not have two teams in it.` },
    };
  }

  const teamById = new Map<string, string>();
  for (const entry of objects) {
    if (entry.type === 'Team' && typeof entry.id === 'string' && typeof entry.name === 'string') {
      teamById.set(entry.id, entry.name);
    }
  }
  const teamIds = sides.map((side) => refId(side.team) ?? '') as [string, string];
  const teamNames = sides.map((side, index) => {
    const id = teamIds[index];
    if (id && teamById.has(id)) return teamById.get(id)!;
    const inline = isRecord(side.team) ? nonBlank(side.team.name) : undefined;
    return inline ?? (id || 'Unnamed team');
  }) as [string, string];

  const spine = spineContextFor(objects, matchId);
  const spineRound =
    spine.roundId !== undefined
      ? (objects.find((entry) => entry.id === spine.roundId && entry.type === 'Round') ?? null)
      : null;
  const roundNumber =
    spine.roundName !== undefined || spineRound !== null
      ? roundNumberOf({
          ...(spineRound && typeof spineRound.number === 'number' ? { number: spineRound.number } : {}),
          ...(spine.roundName !== undefined ? { name: spine.roundName } : {}),
        })
      : undefined;

  const { state, forfeit } = playStateOf(match);
  const points = sides.map((side) => finiteNumber(side.points)) as [number | undefined, number | undefined];
  const scoreLine = `${teamNames[0]} ${points[0] ?? '?'} – ${teamNames[1]} ${points[1] ?? '?'}`;

  return {
    ok: true,
    result: {
      folderName: file.folderName,
      fileName: file.fileName,
      ...(file.modifiedMs !== undefined ? { modifiedMs: file.modifiedMs } : {}),
      matchId,
      tournamentId,
      ...(spine.roundId ? { roundId: spine.roundId } : {}),
      ...(spine.roundName ? { roundName: spine.roundName } : {}),
      ...(roundNumber !== undefined ? { roundNumber } : {}),
      teamIds,
      teamNames,
      points,
      scoreLine,
      playState: state,
      forfeit,
    },
  };
}

/**
 * Reconcile every scanned file against the manifest.
 *
 * Files are grouped by Match id; anything that cannot be reconciled lands in `problems` with
 * a specific, actionable message. Nothing here reads a filename, a folder, or a team name to
 * decide what a file is — those only produce warnings.
 */
export function reconcileScan(manifest: ShuttleManifest, files: ScannedInputFile[]): ScanReport {
  const byMatchId = new Map<string, ManifestAssignment>();
  for (const assignment of manifest.assignments) byMatchId.set(assignment.matchId, assignment);

  const roomOfFolder = new Map<string, string>();
  for (const room of manifest.rooms) roomOfFolder.set(room.displayName, room.slotId);

  const scans = new Map<string, AssignmentScan>();
  const scanFor = (assignment: ManifestAssignment): AssignmentScan => {
    let scan = scans.get(assignment.matchId);
    if (!scan) {
      scan = { assignment, candidates: [], untouchedCopies: [], needsChoice: false };
      scans.set(assignment.matchId, scan);
    }
    return scan;
  };

  const problems: ProblemFile[] = [];

  for (const file of files) {
    const parsed = parseResultFile(file);
    if (!parsed.ok) {
      problems.push({ folderName: file.folderName, fileName: file.fileName, problem: parsed.problem });
      continue;
    }
    const result = parsed.result;
    if (result.tournamentId !== manifest.tournamentId) {
      problems.push({
        folderName: file.folderName,
        fileName: file.fileName,
        problem: {
          kind: 'foreign-tournament',
          message: `“${file.fileName}” belongs to another tournament.`,
        },
      });
      continue;
    }
    const assignment = byMatchId.get(result.matchId);
    if (!assignment) {
      problems.push({
        folderName: file.folderName,
        fileName: file.fileName,
        problem: {
          kind: 'unknown-game',
          message: `“${file.fileName}” is not one of this project's assignments.`,
        },
      });
      continue;
    }
    // The file names the right game but describes a different one: stale regeneration, a
    // hand-edited file, or outright tampering. Never batch it silently.
    if (result.roundId !== undefined && result.roundId !== assignment.roundId) {
      problems.push({
        folderName: file.folderName,
        fileName: file.fileName,
        problem: {
          kind: 'mismatch',
          message: `“${file.fileName}” names this project's game but a different round.`,
        },
      });
      continue;
    }
    const teamSet = new Set(result.teamIds.filter(Boolean));
    if (
      result.teamIds.some((id) => !id) ||
      !teamSet.has(assignment.leftTeamId) ||
      !teamSet.has(assignment.rightTeamId)
    ) {
      problems.push({
        folderName: file.folderName,
        fileName: file.fileName,
        problem: {
          kind: 'mismatch',
          message: `“${file.fileName}” names this project's game but different teams.`,
        },
      });
      continue;
    }

    const scan = scanFor(assignment);
    if (result.playState === 'unplayed') {
      scan.untouchedCopies.push(result);
    } else {
      scan.candidates.push(result);
    }
  }

  for (const scan of scans.values()) {
    const expectedSlot = scan.assignment.slotId;
    const expectedRoom =
      manifest.rooms.find((room) => room.slotId === expectedSlot)?.displayName ?? expectedSlot;
    for (const candidate of scan.candidates) {
      const foundSlot = roomOfFolder.get(candidate.folderName);
      if (foundSlot !== undefined && foundSlot !== expectedSlot) {
        const foundRoom =
          manifest.rooms.find((room) => room.slotId === foundSlot)?.displayName ?? candidate.folderName;
        scan.wrongFolder = {
          foundIn: foundRoom,
          expectedRoom,
          roundNumber: scan.assignment.roundNumber,
        };
        break;
      }
    }
    const chosenName = manifest.selectedResults[scan.assignment.matchId];
    if (scan.candidates.length > 1) {
      const chosen = chosenName ? scan.candidates.find((entry) => entry.fileName === chosenName) : undefined;
      if (chosen) {
        scan.selectedFileName = chosen.fileName;
        scan.chosen = chosen;
        scan.needsChoice = false;
      } else {
        scan.selectedFileName = undefined;
        scan.chosen = undefined;
        scan.needsChoice = true;
      }
    } else if (scan.candidates.length === 1) {
      scan.selectedFileName = scan.candidates[0].fileName;
      scan.chosen = scan.candidates[0];
      scan.needsChoice = false;
    }
  }

  return { scans: [...scans.values()], problems, scannedAt: Date.now() };
}

/** Round-number → scans in that round, for progress display. */
export function groupScansByRound(scans: AssignmentScan[]): Map<number, AssignmentScan[]> {
  const groups = new Map<number, AssignmentScan[]>();
  for (const scan of scans) {
    const list = groups.get(scan.assignment.roundNumber) ?? [];
    list.push(scan);
    groups.set(scan.assignment.roundNumber, list);
  }
  return groups;
}
