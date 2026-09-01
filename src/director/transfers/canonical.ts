/**
 * Identity and integrity for documents that arrive by any route.
 *
 * # One fingerprint, computed in one place
 *
 * The QBTCP server computes a SHA-256 fingerprint of its own (`result_fingerprint` in
 * `crates/qbtcp-server/src/model.rs`) and the scorer computes an FNV one for downloads
 * (`portableResultFingerprint` in `src/game/PortableQbj.ts`). Both canonicalize the same way —
 * sorted keys, transport extensions removed — but they are different hashes, so a QBTCP arrival
 * and its USB backup would never compare equal if Director trusted whatever fingerprint the
 * transport handed it.
 *
 * So Director does not. Every document, whatever route it took, is fingerprinted here. The
 * transport's own fingerprint is kept alongside for correlation with its logs, but the duplicate
 * check uses this one, because it is the only value computed the same way for both sides.
 *
 * The canonical form is deliberately identical to the Rust one: same excluded keys, same sorted
 * object entries, same array order. Only the hash differs, and it differs on both sides equally.
 *
 * # `digest` is a different question from `fingerprint`
 *
 * A fingerprint asks "is this the same *result*", ignoring transport metadata, so a backup matches
 * its original. A digest asks "is this the same *file*", over the exact bytes, so a file already
 * imported from a drive is recognised when the same drive is scanned again. Both are needed and
 * neither substitutes for the other.
 */

/** Extension keys that carry transport metadata rather than the result. Matches the Rust list. */
const transportKeys = new Set([
  '_qbtcp',
  '_qbsheet_source',
  '_scoresheet_source',
  '_yf_scorekeeper_recovery',
]);

/**
 * Key names that must never appear in a file Director writes.
 *
 * Matched loosely — separators removed, case folded — because the point is to catch a field
 * somebody added rather than to enumerate the fields that exist today. Kept in step with
 * `forbiddenKeys` in `src/game/PortableQbj.ts`; the scorer strips these on the way out of a device
 * and Director strips them on the way out of tournament control, which are two different doors into
 * the same hallway.
 */
const secretKeys = new Set([
  'accesstoken',
  'token',
  'sessiontoken',
  'sessionid',
  'sessioncredentials',
  'roomtoken',
  'pairingcode',
  'pairingurl',
  'authorization',
  'credentials',
  'secret',
  'deviceid',
  'serverurl',
  'recoveryjournal',
]);

const scorerRecoveryKey = '_yf_scorekeeper_recovery';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isSecretKey(key: string): boolean {
  const normalized = key.replace(/[-_\s]/g, '').toLowerCase();
  return secretKeys.has(normalized) || key === scorerRecoveryKey;
}

/**
 * A deep copy with anything credential-shaped and the private recovery layer removed.
 *
 * Subtractive and unconditional. Applied to every document Director writes to a file, including
 * ones built entirely by Director's own code that provably contain no secret today — the boundary
 * is a property of the file, not of this month's builder.
 */
export function stripSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => stripSecrets(entry)) as unknown as T;
  if (!isRecord(value)) return value;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isSecretKey(key)) continue;
    output[key] = stripSecrets(entry);
  }
  return output as T;
}

/** Every key path in a document whose name is credential-shaped. Used by tests and by the writer. */
export function findSecretKeys(value: unknown, path = '$'): string[] {
  if (Array.isArray(value))
    return value.flatMap((entry, index) => findSecretKeys(entry, `${path}[${index}]`));
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, entry]) =>
    isSecretKey(key) ? [`${path}.${key}`] : findSecretKeys(entry, `${path}.${key}`),
  );
}

/** Canonical JSON with object-key order made irrelevant and transport extensions omitted. */
export function canonicalResultJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalResultJson(entry)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !transportKeys.has(key))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalResultJson(entry)}`)
    .join(',')}}`;
}

/**
 * FNV-1a over a string, as 16 lowercase hex characters.
 *
 * BigInt rather than `crypto.subtle` because every caller here is synchronous and runs inside a
 * state reducer. This is an equality aid for reconciling two copies of a result a director will
 * still review; it is not an authenticity claim and nothing security-bearing depends on it.
 */
export function fnv1a64(input: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index) & 0xffff);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * The statistical identity of a result, ignoring how it travelled.
 *
 * One game scored once produces one of these whether it came back over the network, on a stick, or
 * through a browser download and a drag onto the window.
 */
export function resultFingerprint(qbj: unknown): string {
  return fnv1a64(canonicalResultJson(qbj));
}

/** The identity of a byte sequence: which file this is, not which result it holds. */
export function digestBytes(bytes: Uint8Array): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= BigInt(bytes[index]);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `${bytes.length.toString(16)}-${hash.toString(16).padStart(16, '0')}`;
}

export function digestText(value: string): string {
  return digestBytes(new TextEncoder().encode(value));
}
