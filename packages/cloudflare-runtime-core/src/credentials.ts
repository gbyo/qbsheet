/**
 * Credential primitives shared by QBSheet's Cloudflare backends.
 *
 * # What is here
 *
 * High-entropy token minting, SHA-256 hashing, constant-time comparison, and shape
 * checks — the mechanics every backend needs, with no policy attached. WebCrypto is the
 * only dependency, so this runs unchanged in workerd, Node 22, and the package's own
 * unit tests.
 *
 * # What is deliberately NOT here
 *
 * Authorization policy stays service-specific: which bearer opens which surface, token
 * lifetimes, claim/rotation flows, and where hashes are stored (separate Durable
 * Objects, separate tables) are per-service decisions. A compromised room scorer must
 * never become a path to Director collaboration authority, and sharing this file does
 * not share any credential: equal-shaped tokens from different services never
 * cross-accept because each service checks only the hashes in its own store
 * (`credential-isolation.test.ts` proves the mechanism).
 */

/** 32 random bytes as 64 lowercase hex characters. */
export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 of UTF-8 text as 64 lowercase hex characters. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Length-independent comparison of two hex digests.
 *
 * Both operands are hash-sized whenever the input was well formed; the length check is
 * for the malformed case and does not leak anything about the secret.
 */
export function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

/** Whether a value looks like a minted/stored token hash (64 lowercase hex chars). */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
