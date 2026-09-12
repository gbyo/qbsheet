/**
 * Small stable hashes for identities and fingerprints.
 *
 * The FNV-1a-64 implementation below is the same algorithm as `fnv1a64` in
 * `src/director/transfers/canonical.ts` (BigInt, 16 lowercase hex characters), copied here so
 * this utility does not depend on Director internals. Like the original, these are equality
 * aids for reconciling files an operator still reviews — not authenticity claims, and nothing
 * security-bearing depends on them.
 */

/** FNV-1a over a string, as 16 lowercase hex characters. */
export function fnv1a64(input: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index) & 0xffff);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

/** Canonical JSON with object-key order made irrelevant. Transport-agnostic: no keys omitted. */
export function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(',')}}`;
}

/** The identity of a small JSON value: which thing this is, for fingerprints and comparisons. */
export function fingerprintJson(value: unknown): string {
  return fnv1a64(stableJson(value));
}
