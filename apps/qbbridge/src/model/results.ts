/**
 * Completed results, on the way from the relay to a folder.
 *
 * # The document is not touched
 *
 * The strongest rule in this application. QBSheet Scorer produced a correct completed QBJ, the
 * relay retained those exact bytes' meaning, and what gets written to disk is that document
 * serialized again. No import, no normalization, no recomputation, no re-identification, no
 * merging of a round into one file. The only thing QBBridge adds is the name of the file, and a
 * filename is never an identity.
 *
 * `resultSummary` reads a few fields for the list on screen. Reading is not rewriting: the value
 * written out is the parsed object it arrived as.
 */

import { fnv1a64 } from '../../../../src/director/transfers/canonical';
import { describeResult, type ResultDescription } from '../../../../src/qbj/resultDescription';

export interface ResultSummary {
  roundName: string | null;
  roundNumber: number | null;
  location: string | null;
  leftName: string | null;
  rightName: string | null;
  leftPoints: number | null;
  rightPoints: number | null;
}

/**
 * Name a per-result action for direct screen-reader navigation.
 *
 * The stable result id is included even when the descriptive fields are complete: a relay can
 * retain a corrected final for the same room and matchup, and those two rows must not collapse
 * into indistinguishable buttons.
 */
export function resultActionLabel(description: ResultDescription, resultId: string, saved: boolean): string {
  const verb = saved ? 'Save again' : 'Save';
  const context = [
    description.roundName ? `Round ${description.roundName}` : null,
    description.location,
  ].filter((part): part is string => part !== null && part !== '');
  const where = context.length > 0 ? ` — ${context.join(', ')}` : '';
  // An exception result must announce itself in the action: the operator handling it is doing
  // review work, not routine filing, and the label is where that decision gets made.
  if (description.kind === 'identified') {
    const matchup = [description.leftName, description.rightName].filter(
      (name): name is string => name !== null,
    );
    const what = matchup.length > 0 ? ` — ${[...context, matchup.join(' vs ')].join(', ')}` : where;
    return `${verb} result${what} (result ${resultId})`;
  }
  if (description.kind === 'partial') {
    const known = description.leftName ?? description.rightName ?? 'matchup';
    return `${verb} partially identified result — ${known}${where} (result ${resultId})`;
  }
  return `${verb} unidentified result${where} (result ${resultId})`;
}

export type ResultImportStatus = 'new' | 'needs-import' | 'imported';

/** Derive the visible handoff state without implying that YellowFruit was inspected. */
export function resultImportStatus(entry: {
  savedPath?: string;
  importStatus?: 'needs-import' | 'imported';
}): ResultImportStatus {
  if (!entry.savedPath) return 'new';
  return entry.importStatus === 'imported' ? 'imported' : 'needs-import';
}

/** Keep result names below the common 255-byte filesystem component limit, with some margin. */
export const maximumResultFileNameBytes = 240;
const resultFileExtension = '.result.qbj';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function objects(qbj: unknown): Record<string, unknown>[] {
  if (!isRecord(qbj) || !Array.isArray(qbj.objects)) return [];
  return qbj.objects.filter(isRecord);
}

/** The logical game identity carried by a completed result, when present. */
export function resultMatchId(qbj: unknown): string | null {
  if (isRecord(qbj) && qbj.type === 'Match' && typeof qbj.id === 'string') return qbj.id;
  const match = objects(qbj).find((entry) => entry.type === 'Match');
  return match && typeof match.id === 'string' ? match.id : null;
}

/**
 * Find the one match in a result document and describe it.
 *
 * A projection over the shared canonical description (`describeResult`): every consumer reads
 * the same parse, so a shape understood anywhere is understood here. Every field stays
 * optional — a summary that cannot be read produces blanks, not a result that cannot be saved —
 * and identification state travels alongside for callers that must not print placeholders.
 */
export function resultSummary(qbj: unknown): ResultSummary {
  const described = describeResult(qbj);
  return {
    roundName: described.roundName,
    roundNumber: described.roundNumber,
    location: described.location,
    leftName: described.leftName,
    rightName: described.rightName,
    leftPoints: described.leftPoints,
    rightPoints: described.rightPoints,
  };
}

/** The canonical description of one received result, with its identification state. */
export function describeBridgeResult(qbj: unknown): ResultDescription {
  return describeResult(qbj);
}

/** Strip what a filesystem will refuse, without inventing a name. */
function safePart(value: string): string {
  const printable = Array.from(value)
    .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .join('');
  return (
    printable
      .trim()
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, '-')
      .replace(/[.-]+$/g, '') || 'game'
  );
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const encoder = new TextEncoder();
  let bytes = 0;
  let result = '';
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength;
    if (bytes + characterBytes > maximumBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

/**
 * A descriptive filename, with a suffix that makes it this result's and no other's.
 *
 * # Why the suffix is not decoration
 *
 * The relay can hold more than one legitimate result for the same game: a room that submitted a
 * correction has two retained finals with the same match, the same room and the same two teams.
 * The descriptive part of the name is identical for both, and a second save over the first would
 * destroy a result that nobody had looked at yet.
 *
 * So the name ends in twelve hex characters derived from the relay's own `result_id` — the thing
 * that distinguishes the two. It is stable, so re-saving one result rewrites its own file rather
 * than accumulating copies, and it is a hash rather than a slice of the id because the relay's
 * ids are case-sensitive and two of them differing only in case would be one filename on a
 * case-insensitive volume.
 *
 * The suffix is filename convenience and never identity. The QBJ inside carries that, and a room
 * may rename any of these.
 */
export function resultFileName(summary: ResultSummary, resultId: string): string {
  const round =
    summary.roundNumber !== null
      ? `R${String(summary.roundNumber).padStart(2, '0')}`
      : summary.roundName
        ? `R${safePart(summary.roundName)}`
        : 'Game';
  const room = summary.location ? `_${safePart(summary.location)}` : '';
  const matchup =
    summary.leftName && summary.rightName
      ? `_${safePart(summary.leftName)}_vs_${safePart(summary.rightName)}`
      : '';
  const descriptivePrefix = `${round}${room}${matchup}`;
  const stableSuffix = `_${resultFileSuffix(resultId)}${resultFileExtension}`;
  const availablePrefixBytes = maximumResultFileNameBytes - new TextEncoder().encode(stableSuffix).byteLength;
  return `${truncateUtf8(descriptivePrefix, availablePrefixBytes)}${stableSuffix}`;
}

/**
 * The path the native writer returns for a result file.
 *
 * QBBridge only permits overwrite when this exact path is the one already stored for the result.
 * Keep the small platform-aware join here rather than comparing directories or filename suffixes:
 * a folder change must become a new exclusive save.
 */
export function resultFilePath(directory: string, fileName: string): string {
  const separator = directory.includes('\\') && !directory.includes('/') ? '\\' : '/';
  const trimmed = directory.replace(/[\\/]+$/g, '');
  return trimmed.length > 0 ? `${trimmed}${separator}${fileName}` : `${separator}${fileName}`;
}

/** Twelve lowercase hex characters that identify one retained relay result. */
export function resultFileSuffix(resultId: string): string {
  return fnv1a64(resultId).slice(0, 12);
}

/**
 * The bytes written to disk.
 *
 * Pretty-printed for a human who may open one in an editor. Formatting is the only difference from
 * what the relay returned: `sameQbjDocument` over the two is true, and a test proves it.
 */
export function resultFileContents(qbj: unknown): string {
  return `${JSON.stringify(qbj, null, 2)}\n`;
}

/**
 * Canonical JSON, omitting nothing.
 *
 * Deliberately not `canonicalResultJson` from the transfers helpers. That one ignores `_qbtcp` and
 * the source extensions, because its job is to decide whether two *arrivals* of one game agree
 * about the game. The question here is different and stricter: whether the file on disk is the
 * document the relay returned, every key of it. Key order and whitespace are the only things
 * allowed to differ.
 */
function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

/** True when two QBJ values are the same document, key order and whitespace aside. */
export function sameQbjDocument(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
