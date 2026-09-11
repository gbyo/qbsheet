/**
 * Append-only operator history for incident reconstruction (#1016).
 *
 * Every entry is safe metadata — counts, ids, revisions, epochs, outcomes. Management
 * credentials, tokens, pairing codes, QBJ payloads, passphrases, and team/player names
 * must never reach a detail: call sites pass structured scalar fields, and the audit
 * tests plant hostile values through the loaders to prove unknown shapes are dropped.
 *
 * The log survives restart in localStorage, capped so a long tournament cannot grow it
 * without bound. Sequence numbers stay monotonic across trims so a gap reads as a trim,
 * never as missing history.
 */

export type AuditAction =
  | 'app-start'
  | 'yft-loaded'
  | 'room-created'
  | 'room-renamed'
  | 'room-removed'
  | 'pairing-code-regenerated'
  | 'publication-confirmed'
  | 'relay-takeover'
  | 'relay-transfer'
  | 'recovery-package-created'
  | 'recovery-package-imported'
  | 'result-saved'
  | 'result-acknowledged'
  | 'result-import-marked'
  | 'fallback-exported'
  | 'relay-reachability'
  | 'lifecycle'
  | 'live-override'
  | 'readiness-run';

export type AuditFieldValue = string | number | boolean | null;

export interface AuditEntry {
  seq: number;
  at: string;
  action: AuditAction;
  fields: Record<string, AuditFieldValue>;
}

/** A long tournament day must not grow the log without bound; oldest entries trim first. */
export const maxAuditEntries = 500;

const auditStorageKey = 'qbbridge.audit.v1';

function isEntry(value: unknown): value is AuditEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.seq === 'number' &&
    typeof entry.at === 'string' &&
    typeof entry.action === 'string' &&
    typeof entry.fields === 'object' &&
    entry.fields !== null
  );
}

/** Read the persisted log. Anything unrecognized reads as an empty log, never a crash. */
export function loadAuditLog(): AuditEntry[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(auditStorageKey);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry);
  } catch {
    return [];
  }
}

function saveAuditLog(log: readonly AuditEntry[]): void {
  try {
    localStorage.setItem(auditStorageKey, JSON.stringify(log));
  } catch {
    // Diagnostics persistence must never break the run it records.
  }
}

/**
 * Append one entry and persist. Returns the new log; trims the oldest entries past the
 * cap while keeping sequence numbers monotonic.
 */
export function appendAuditEntry(
  log: readonly AuditEntry[],
  action: AuditAction,
  fields: Record<string, AuditFieldValue>,
  now: () => string = () => new Date().toISOString(),
): AuditEntry[] {
  const seq = log.length === 0 ? 1 : log[log.length - 1].seq + 1;
  const next = [...log, { seq, at: now(), action, fields: { ...fields } }];
  const trimmed = next.length > maxAuditEntries ? next.slice(next.length - maxAuditEntries) : next;
  saveAuditLog(trimmed);
  return trimmed;
}
