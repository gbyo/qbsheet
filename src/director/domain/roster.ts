import type { DirectorId } from '@qbsheet/tournament-domain';

/**
 * Native QBTCP does not assign a durable identity to an amendment record. Derive one from the
 * session and the original payload so polling, restart, and duplicate delivery are idempotent.
 */
export function rosterAmendmentId(sessionId: DirectorId, amendment: Record<string, unknown>): DirectorId {
  const input = `${sessionId}:${stableSerialize(amendment)}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `roster-amendment-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(',')}}`;
}
