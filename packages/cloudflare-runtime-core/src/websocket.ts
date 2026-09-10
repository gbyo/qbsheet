/**
 * Hibernating-WebSocket lifecycle helpers shared by QBSheet's Cloudflare backends.
 *
 * # What is here
 *
 * Versioned socket-attachment serialization (attachments must survive hibernation
 * reconstruction, where the constructor re-runs and only SQLite plus serialized
 * attachments persist) and a frame-size guard. No frame protocol: each service defines
 * its own frame types and never shares them.
 *
 * # What is deliberately NOT here
 *
 * Broadcast loops, authentication, ping/pong wiring, and close/error policy stay
 * service-specific — a spectator socket and a scorer socket have different trust
 * levels and different things they may be told.
 */

export const SOCKET_ATTACHMENT_VERSION = 1;

/**
 * Serialize a socket attachment for hibernation. The version travels with the payload
 * so a future deployment never misreads an old attachment as a new shape.
 */
export function encodeSocketAttachment(attachment: Record<string, unknown>): string {
  return JSON.stringify({ v: SOCKET_ATTACHMENT_VERSION, ...attachment });
}

/**
 * Decode a hibernated socket attachment. Returns null for garbage, wrong versions, or
 * non-object payloads — the caller closes such sockets rather than trusting them.
 */
export function decodeSocketAttachment(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 8192) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.v !== SOCKET_ATTACHMENT_VERSION) return null;
  const rest: Record<string, unknown> = { ...record };
  delete rest.v;
  return rest;
}

/** Whether a frame of `bytes` fits within `maxBytes`. Rejects nonsense bounds. */
export function frameFits(bytes: number, maxBytes: number): boolean {
  if (!Number.isFinite(bytes) || !Number.isFinite(maxBytes)) return false;
  if (maxBytes <= 0 || bytes < 0) return false;
  return bytes <= maxBytes;
}
