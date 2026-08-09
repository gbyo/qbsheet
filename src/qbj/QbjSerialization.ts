/**
 * The official QBJ serialization envelope, and the boundary every QBJ document crosses.
 *
 * # One envelope, three inputs
 *
 * A room is handed QBJ in whichever shape the tool upstream of it happened to produce. There are
 * three in circulation and this module recognizes all of them:
 *
 *   - the official serialization, `{ version, objects: [...] }`
 *   - a bare `Match` object, which is what MODAQ writes and what older workflows pass around
 *   - a `{ version, objects }` document whose objects are keyed by `type` rather than listed
 *
 * Recognizing a shape is all that happens here. Interpreting it is `ParseQbjAssignment`'s job, and
 * the separation matters: the shape check is the part that has to be hostile, and the interpretation
 * is the part that has to be forgiving. Mixing them produces a parser that is lenient about exactly
 * the wrong things.
 *
 * # Untrusted, including over an authenticated connection
 *
 * A document that arrived over QBTCP with a valid session token is no more trustworthy than one that
 * arrived on a USB stick — the token says the server is who it claims, not that the payload is
 * well-formed. So the bound, the JSON shape check, and the prototype-pollution guard run on every
 * document regardless of where it came from.
 */

/**
 * The QBJ serialization version this scoresheet reads and writes.
 *
 * Taken from the reference tournament-control implementation's `validQbjVersions`, which accepts
 * exactly this one. Writing anything else would produce a file that the software most likely to
 * receive it refuses, so this is not a place to be forward-looking.
 */
export const qbjSerializationVersion = '2.1.1';

/** Versions this scoresheet will read. Deliberately the same single entry it writes. */
export const supportedQbjVersions: readonly string[] = [qbjSerializationVersion];

/** The registered media type for a QBJ document. Used for downloads and for QBTCP bodies alike. */
export const qbjMimeType = 'application/vnd.quizbowl.qbj+json';

/**
 * Largest QBJ document that will be read into memory.
 *
 * A one-game assignment is a few kilobytes. A whole-tournament QBJ for a large event with
 * question-level data is much bigger, so this is more generous than the `.qbg` bound — but still
 * small enough that a refusal is instant on a Chromebook.
 */
export const maxQbjBytes = 8 * 1024 * 1024;

/** A QBJ object keyed however the schema keys it. Deliberately loose: this is wire format. */
export type QbjObject = Record<string, unknown>;

export interface IQbjDocument {
  version: string;
  objects: QbjObject[];
}

export type QbjDocumentShape =
  /** `{ version, objects }` as the serialization defines it. */
  | { kind: 'serialized'; document: IQbjDocument }
  /** A bare `Match`, as MODAQ and legacy workflows produce. */
  | { kind: 'match-only'; match: QbjObject };

export type QbjReadResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/**
 * Keys that must never be accepted from a document, because assigning them walks up the prototype
 * chain rather than setting a property.
 *
 * The scoresheet rebuilds every object it keeps rather than passing parsed input through, which
 * already defeats this. The guard is here anyway because "already defeated elsewhere" is a property
 * that quietly stops being true.
 */
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);

export function isPlainObject(value: unknown): value is QbjObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A non-negative integer, which is what every count and score in QBJ is. */
export function wholeNumber(value: unknown): value is number {
  return finiteNumber(value) && Number.isInteger(value) && value >= 0;
}

export function nonBlankString(value: unknown, max = 500): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max;
}

/**
 * Walk a parsed value and refuse it if any object in it carries a dangerous key.
 *
 * Depth-bounded rather than recursive-until-it-stops: a document nested a thousand deep is not a
 * tournament, and a stack overflow inside a validator is a denial of service against the room.
 */
function hasUnsafeKeys(value: unknown, depth = 0): boolean {
  if (depth > 64) return true;
  if (Array.isArray(value)) return value.some((entry) => hasUnsafeKeys(entry, depth + 1));
  if (!isPlainObject(value)) return false;
  for (const key of Object.keys(value)) {
    if (forbiddenKeys.has(key)) return true;
    if (hasUnsafeKeys(value[key], depth + 1)) return true;
  }
  return false;
}

/** Read JSON text as an untrusted QBJ payload. Bounds and shape only; no interpretation. */
export function parseQbjText(text: string): QbjReadResult<unknown> {
  if (text.length > maxQbjBytes) {
    return { ok: false, errors: ['That file is too large to be a QBJ document.'] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['That file is not readable as JSON.'] };
  }
  if (hasUnsafeKeys(parsed)) {
    return { ok: false, errors: ['That file contains unsafe property names and was not read.'] };
  }
  return { ok: true, value: parsed };
}

/**
 * Decide which of the recognized shapes a parsed value is.
 *
 * A `Match` is identified by `type: "Match"` or, for the many exports that omit `type`, by carrying
 * `match_teams`. That second test is what makes MODAQ's output readable, and it is deliberately
 * narrow: a document with neither an `objects` array nor `match_teams` is not something to guess at.
 */
export function readQbjShape(value: unknown): QbjReadResult<QbjDocumentShape> {
  if (!isPlainObject(value)) {
    return { ok: false, errors: ['This file does not contain a QBJ document.'] };
  }

  if (Array.isArray(value.objects)) {
    const version = value.version;
    if (typeof version !== 'string' || version.trim() === '') {
      return { ok: false, errors: ['This QBJ document does not say which schema version it uses.'] };
    }
    if (!supportedQbjVersions.includes(version)) {
      return {
        ok: false,
        errors: [
          `This QBJ document uses schema version ${version}, which this scoresheet cannot read. It reads version ${qbjSerializationVersion}.`,
        ],
      };
    }
    const objects = value.objects.filter(isPlainObject);
    if (objects.length !== value.objects.length) {
      return { ok: false, errors: ['This QBJ document contains entries that are not objects.'] };
    }
    return { ok: true, value: { kind: 'serialized', document: { version, objects } } };
  }

  if (value.type === 'Match' || Array.isArray(value.match_teams)) {
    return { ok: true, value: { kind: 'match-only', match: value } };
  }

  return {
    ok: false,
    errors: ['This file is not a QBJ document. A QBJ file has an "objects" list or is a single match.'],
  };
}

/** Every object in a document whose `type` matches, in document order. */
export function objectsOfType(document: IQbjDocument, type: string): QbjObject[] {
  return document.objects.filter((entry) => entry.type === type);
}

/** The first object of a type, or null. For the types the serialization allows only one of. */
export function firstOfType(document: IQbjDocument, type: string): QbjObject | null {
  return objectsOfType(document, type)[0] ?? null;
}

/**
 * Resolve a QBJ reference.
 *
 * QBJ lets an object be either embedded in place or referenced by `{ "$ref": "id" }`, and producers
 * differ on which they use for the same field. A consumer that handles only one of them reads half
 * the files in circulation.
 */
export function resolveRef(value: unknown, byId: ReadonlyMap<string, QbjObject>): QbjObject | null {
  if (!isPlainObject(value)) return null;
  const ref = value.$ref;
  if (typeof ref === 'string') return byId.get(ref) ?? null;
  return value;
}

/** Index a document's objects by `id`, for reference resolution. */
export function indexById(document: IQbjDocument): Map<string, QbjObject> {
  const byId = new Map<string, QbjObject>();
  for (const entry of document.objects) {
    if (typeof entry.id === 'string' && entry.id !== '') byId.set(entry.id, entry);
  }
  return byId;
}

/** Wrap objects in the official envelope. The only way this application writes a QBJ document. */
export function buildQbjDocument(objects: QbjObject[]): IQbjDocument {
  return { version: qbjSerializationVersion, objects };
}
