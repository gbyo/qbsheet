/**
 * Append-only operator history for incident reconstruction (#1016).
 *
 * Every entry is safe metadata — counts, ids, revisions, epochs, outcomes. Management
 * credentials, tokens, pairing codes, QBJ payloads, passphrases, and names (rooms,
 * tournaments, teams, people) must never reach a detail: fields are allowlisted per
 * action and re-sanitized on load, and the audit tests plant hostile values through
 * both paths to prove prohibited shapes are stripped, never stored.
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

/**
 * The only detail keys each action may persist. Names — rooms, tournaments, teams,
 * people — are never allowlisted: incident reconstruction gets ids, counts, revisions
 * and outcomes, and anything else is stripped before it can reach the disk.
 */
const auditFieldAllowlist: Record<AuditAction, readonly string[]> = {
  'app-start': ['version'],
  'yft-loaded': ['file', 'tournamentId', 'teams', 'rounds', 'warnings', 'startNew'],
  'room-created': ['roomId'],
  'room-renamed': ['roomId'],
  'room-removed': ['roomId', 'tombstone'],
  'pairing-code-regenerated': ['roomId'],
  'publication-confirmed': ['revision', 'rooms', 'cleared'],
  'relay-takeover': ['epoch'],
  'relay-transfer': ['epoch'],
  'recovery-package-created': [],
  'recovery-package-imported': ['tournamentId'],
  'result-saved': ['resultId', 'results', 'failed'],
  'result-acknowledged': ['results'],
  'result-import-marked': ['resultId', 'imported'],
  'fallback-exported': ['rooms'],
  'relay-reachability': ['reachable'],
  lifecycle: ['phase', 'safeToClose', 'reopened', 'blockers'],
  'live-override': ['action'],
  'readiness-run': [],
};

function isScalar(value: unknown): value is AuditFieldValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  // Non-finite numbers do not survive JSON persistence (they read back as null), so they are
  // stripped rather than stored as a value that means something else on reload.
  return typeof value === 'number' && Number.isFinite(value);
}

/** Strip prohibited keys and non-scalar values. Unknown actions keep no fields. */
export function sanitizeAuditFields(
  action: string,
  fields: Record<string, unknown>,
): Record<string, AuditFieldValue> {
  const allowed = (auditFieldAllowlist as Record<string, readonly string[]>)[action] ?? [];
  const clean: Record<string, AuditFieldValue> = {};
  for (const key of allowed) {
    const value = fields[key];
    if (value !== undefined && isScalar(value)) clean[key] = value;
  }
  return clean;
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

function isValidSequence(log: AuditEntry[]): boolean {
  let previous = 0;
  for (const entry of log) {
    if (!Number.isInteger(entry.seq) || entry.seq <= previous) return false;
    previous = entry.seq;
  }
  return true;
}

/**
 * Read the persisted log. Anything unrecognized reads as an empty log, never a crash.
 *
 * Entries keep their action and timestamp but their fields are re-sanitized on the way
 * in, so an older writer's extra keys cannot outlive the current allowlist. Sequence
 * numbers must be positive integers in strictly increasing order: `appendAuditEntry`
 * derives the next sequence from the final element, so a log that violates the order
 * is rejected whole rather than forked into duplicate sequences.
 */
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
    const entries = parsed.filter(isEntry);
    if (!isValidSequence(entries)) return [];
    return entries.map((entry) => ({
      ...entry,
      fields: sanitizeAuditFields(entry.action, entry.fields),
    }));
  } catch {
    return [];
  }
}

/**
 * Persist the log. Returns whether the write landed; diagnostics persistence must never
 * break the run it records, so callers surface a miss through the durability flag
 * instead of throwing.
 */
export function saveAuditLog(log: readonly AuditEntry[]): boolean {
  try {
    localStorage.setItem(auditStorageKey, JSON.stringify(log));
    return true;
  } catch {
    return false;
  }
}

/**
 * Append one entry and persist. Returns the new log and whether the write landed;
 * trims the oldest entries past the cap while keeping sequence numbers monotonic.
 */
export function appendAuditEntry(
  log: readonly AuditEntry[],
  action: AuditAction,
  fields: Record<string, AuditFieldValue>,
  now: () => string = () => new Date().toISOString(),
): { log: AuditEntry[]; persisted: boolean } {
  const seq = log.length === 0 ? 1 : log[log.length - 1]!.seq + 1;
  const next = [...log, { seq, at: now(), action, fields: sanitizeAuditFields(action, fields) }];
  const trimmed = next.length > maxAuditEntries ? next.slice(next.length - maxAuditEntries) : next;
  return { log: trimmed, persisted: saveAuditLog(trimmed) };
}
