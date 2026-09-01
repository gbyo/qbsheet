/**
 * Reading a document that arrived from somewhere Director does not control.
 *
 * # Everything here is untrusted, including the parts that look trustworthy
 *
 * A file on a drive a scorekeeper handed over, a file that appeared in a synced folder, a file
 * dropped on the window, and a document that arrived over an authenticated QBTCP session are all
 * the same kind of input: bytes someone else produced. The session token says the connection is who
 * it claims to be, not that the payload is well-formed, so the bound, the depth check and the
 * prototype guard run on every document regardless of route.
 *
 * The bounds are here rather than at each call site because a bound that a caller can forget is a
 * bound that a caller will forget.
 *
 * # What a hostile file looks like
 *
 * Not usually malice. Usually a 2 GB video that got copied into the Results folder, a JSON file
 * nested a hundred thousand deep by a generator with a bug, a text file with a `.qbj` extension, or
 * a file half-written by a sync client that is still uploading. Each of those has to produce a
 * sentence a director can read, not a stalled window.
 */
import { maxQbjBytes } from './limits';

export type TransferParseResult = { ok: true; value: unknown; text: string } | { ok: false; reason: string };

/** Keys that are dangerous to assign, whatever the surrounding shape. */
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);

/** Deepest nesting accepted. Far past any real QBJ, far short of a stack overflow. */
export const maxJsonDepth = 64;
/** Most objects and arrays accepted in one document. A whole-tournament QBJ is well under this. */
export const maxJsonNodes = 200_000;

function inspect(value: unknown, depth: number, budget: { nodes: number }): string | null {
  if (depth > maxJsonDepth) return `The file is nested more than ${maxJsonDepth} levels deep.`;
  if (Array.isArray(value)) {
    budget.nodes += 1;
    if (budget.nodes > maxJsonNodes) return 'The file contains too many values to read safely.';
    for (const entry of value) {
      const failure = inspect(entry, depth + 1, budget);
      if (failure) return failure;
    }
    return null;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return 'The file contains a non-finite number.';
  if (typeof value !== 'object' || value === null) return null;
  budget.nodes += 1;
  if (budget.nodes > maxJsonNodes) return 'The file contains too many values to read safely.';
  for (const key of Object.keys(value)) {
    if (forbiddenKeys.has(key)) return 'The file contains a reserved JavaScript key and was refused.';
    const failure = inspect((value as Record<string, unknown>)[key], depth + 1, budget);
    if (failure) return failure;
  }
  return null;
}

/**
 * Decode UTF-8 bytes, refusing a size that has no business being a QBJ document.
 *
 * The length check runs before the decode so an enormous file costs a comparison rather than a
 * copy. A BOM is stripped because Windows tools write one and `JSON.parse` refuses it.
 */
export function decodeTransferText(
  bytes: Uint8Array,
): { ok: true; text: string } | { ok: false; reason: string } {
  if (bytes.byteLength === 0) return { ok: false, reason: 'The file is empty.' };
  if (bytes.byteLength > maxQbjBytes)
    return {
      ok: false,
      reason: `The file is ${Math.round(bytes.byteLength / 1024 / 1024)} MB, past the ${Math.round(maxQbjBytes / 1024 / 1024)} MB limit for a QBJ document.`,
    };
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { ok: true, text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text };
  } catch {
    return { ok: false, reason: 'The file is not valid UTF-8 text.' };
  }
}

/** Parse and bound a JSON document. Never throws; a refusal is a sentence, not an exception. */
export function parseTransferJson(text: string): TransferParseResult {
  if (text.length > maxQbjBytes) return { ok: false, reason: 'The file is too large to read as QBJ.' };
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, reason: 'The file is empty.' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, reason: 'The file is not valid JSON.' };
  }
  const failure = inspect(parsed, 0, { nodes: 0 });
  if (failure) return { ok: false, reason: failure };
  return { ok: true, value: parsed, text: trimmed };
}

export function parseTransferBytes(bytes: Uint8Array): TransferParseResult {
  const decoded = decodeTransferText(bytes);
  return decoded.ok ? parseTransferJson(decoded.text) : { ok: false, reason: decoded.reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The `Match` inside a document, whichever of the two accepted shapes it arrived in.
 *
 * The official serialization is preferred and a bare `Match` is supported, because MODAQ and older
 * workflows produce one and a director should not have to know which tool a room used.
 */
export function matchObject(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === 'Match') return value;
  if (!Array.isArray(value.objects)) return undefined;
  return value.objects.find(
    (entry): entry is Record<string, unknown> => isRecord(entry) && entry.type === 'Match',
  );
}

export function topLevelObject(value: unknown, type: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === type) return value;
  if (!Array.isArray(value.objects)) return undefined;
  return value.objects.find(
    (entry): entry is Record<string, unknown> => isRecord(entry) && entry.type === type,
  );
}

export interface QbjIdentity {
  tournamentId?: string;
  matchId?: string;
  roundRevision?: number;
  assignmentRevision?: number;
  roomId?: string;
  location?: string;
}

/**
 * Identity, read only from standard QBJ fields and the documented `_qbtcp` block.
 *
 * The filename is not consulted, here or anywhere. That is the profile's rule and the reason an
 * assignment carries `Tournament.id` and `Match.id` at all: reconciliation on this side is a lookup,
 * not a guess about what a room called the file after it downloaded it twice.
 */
export function readQbjIdentity(value: unknown): QbjIdentity {
  const match = matchObject(value);
  const tournament = topLevelObject(value, 'Tournament');
  const extension = match && isRecord(match._qbtcp) ? match._qbtcp : undefined;
  const finite = (candidate: unknown): number | undefined =>
    typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0 ? candidate : undefined;
  const text = (candidate: unknown): string | undefined =>
    typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined;
  return {
    ...(text(tournament?.id) ? { tournamentId: text(tournament?.id) } : {}),
    ...(text(match?.id) ? { matchId: text(match?.id) } : {}),
    ...(finite(extension?.round_revision) ? { roundRevision: finite(extension?.round_revision) } : {}),
    ...(finite(extension?.assignment_revision)
      ? { assignmentRevision: finite(extension?.assignment_revision) }
      : {}),
    ...(text(extension?.room_id) ? { roomId: text(extension?.room_id) } : {}),
    ...(text(match?.location) ? { location: text(match?.location) } : {}),
  };
}

/**
 * Whether a document holds a played game or an unplayed assignment.
 *
 * The distinction is the absence of scoring content, exactly as the assignment profile specifies —
 * an assignment is written without `tossups_read`, without team `points`, and without zeroed
 * totals, so a document that has any of them was scored. Getting this wrong in the permissive
 * direction imports an assignment as a 0-0 final, which is the single worst outcome this subsystem
 * can produce, so the check reads several signals rather than one.
 */
export function hasScoringContent(value: unknown): boolean {
  const match = matchObject(value);
  if (!match) return false;
  if (typeof match.tossups_read === 'number' && Number.isFinite(match.tossups_read)) return true;
  if (Array.isArray(match.match_questions) && match.match_questions.length > 0) return true;
  const teams = Array.isArray(match.match_teams) ? match.match_teams : [];
  return teams.some((entry) => {
    if (!isRecord(entry)) return false;
    if (typeof entry.points === 'number' && Number.isFinite(entry.points)) return true;
    if (entry.forfeit_loss === true) return true;
    const players = Array.isArray(entry.match_players) ? entry.match_players : [];
    return players.some(
      (player) => isRecord(player) && Array.isArray(player.answer_counts) && player.answer_counts.length > 0,
    );
  });
}
