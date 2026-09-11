/**
 * End-of-day tournament reconciliation (#1016).
 *
 * Compares the three copies of tournament results that must agree before the relay is
 * torn down: relay retained finals (`state=all`), the local durable ledger, and the
 * operator's YellowFruit-import marks. The ideal result is an explicit safe-to-close
 * proof; anything else names its blockers instead of forcing equality.
 *
 * Two discrepancies are explained rather than failed:
 *
 * - The relay serves at most 128 finals per page with no cursor. A full page means the
 *   counts are lower bounds, and the report says so instead of claiming completeness.
 * - The relay retains acknowledged finals for seven days. A locally saved final older
 *   than that missing from the relay aged out of retention; a recent one missing is a
 *   genuine anomaly and blocks.
 *
 * Corrections are grouped by match, listed, and never auto-resolved: picking a winner
 * between two finals for one game is the operator's call in YellowFruit.
 */

export interface ReconcileRelayFinal {
  resultId: string;
  roomId: string;
  matchId: string | null;
  receivedAt: string;
  acked: boolean;
}

export interface ReconcileLocalResult {
  resultId: string;
  matchId: string | null;
  receivedAt: string;
  saved: boolean;
  ackPending: boolean;
  importStatus: 'new' | 'needs-import' | 'imported';
}

export interface ReconcileRoom {
  roomId: string;
  name: string;
  /** A room with an assignment still out when the day ends. */
  active: boolean;
}

export interface ReconcileInput {
  relayFinals: ReconcileRelayFinal[];
  /** True when the relay page filled up: counts are lower bounds, not exact. */
  relayTruncated: boolean;
  local: ReconcileLocalResult[];
  rooms: ReconcileRoom[];
  pendingPublication: number;
  pendingRecovery: number;
}

export interface ReconcileCorrection {
  matchId: string;
  resultIds: string[];
}

export interface TournamentReconciliation {
  relayCount: number;
  relayUnacked: number;
  localSavedCount: number;
  importedCount: number;
  relayOnly: string[];
  unsaved: string[];
  unacked: string[];
  agedOut: string[];
  localOnlyRecent: string[];
  corrections: ReconcileCorrection[];
  needsImport: string[];
  activeRooms: ReconcileRoom[];
  truncated: boolean;
  pendingPublication: number;
  pendingRecovery: number;
  blockers: string[];
  safeToClose: boolean;
}

/** Days the relay retains an acknowledged final before it stops serving it. */
export const relayRetentionDays = 7;

function daysOld(receivedAt: string, nowMs: number): number | null {
  const ms = Date.parse(receivedAt);
  if (Number.isNaN(ms)) return null;
  return (nowMs - ms) / (24 * 60 * 60 * 1000);
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Build the reconciliation report. Pure: every input arrives as data, so the whole
 * matrix — missing files, relay-only finals, unimported results, corrections, unacked
 * finals, active rooms, truncation — is unit-testable with no relay and no disk.
 */
export function buildTournamentReconciliation(
  input: ReconcileInput,
  nowMs: number = Date.now(),
): TournamentReconciliation {
  const relayIds = new Set(input.relayFinals.map((entry) => entry.resultId));
  const localById = new Map(input.local.map((entry) => [entry.resultId, entry]));

  const relayOnly = input.relayFinals
    .filter((entry) => !localById.has(entry.resultId))
    .map((entry) => entry.resultId);
  const unsaved = input.local.filter((entry) => !entry.saved).map((entry) => entry.resultId);
  const unacked = input.local
    .filter((entry) => entry.saved && entry.ackPending)
    .map((entry) => entry.resultId);
  const relayUnacked = input.relayFinals.filter((entry) => !entry.acked).length;

  const agedOut: string[] = [];
  const localOnlyRecent: string[] = [];
  for (const entry of input.local) {
    if (!entry.saved || relayIds.has(entry.resultId)) continue;
    // A saved final the relay no longer serves aged out of the seven-day retention when it
    // is old; a recent one missing is an anomaly, and an undated one is treated as recent
    // because assuming expiry would hide data loss.
    const age = daysOld(entry.receivedAt, nowMs);
    if (age !== null && age > relayRetentionDays) agedOut.push(entry.resultId);
    else localOnlyRecent.push(entry.resultId);
  }

  const byMatch = new Map<string, string[]>();
  for (const entry of input.relayFinals) {
    if (!entry.matchId) continue;
    const group = byMatch.get(entry.matchId) ?? [];
    group.push(entry.resultId);
    byMatch.set(entry.matchId, group);
  }
  const corrections: ReconcileCorrection[] = [...byMatch.entries()]
    .filter(([, resultIds]) => resultIds.length > 1)
    .map(([matchId, resultIds]) => ({ matchId, resultIds: [...resultIds].sort() }))
    .sort((left, right) => left.matchId.localeCompare(right.matchId));

  const needsImport = input.local
    .filter((entry) => entry.saved && entry.importStatus !== 'imported')
    .map((entry) => entry.resultId);
  const activeRooms = input.rooms.filter((room) => room.active);
  const localSavedCount = input.local.filter((entry) => entry.saved).length;
  const importedCount = input.local.filter(
    (entry) => entry.saved && entry.importStatus === 'imported',
  ).length;

  const blockers: string[] = [];
  if (relayOnly.length > 0)
    blockers.push(
      `${plural(relayOnly.length, 'final is', 'finals are')} on the relay but not saved locally — save before teardown.`,
    );
  if (unsaved.length > 0)
    blockers.push(`${plural(unsaved.length, 'local result is', 'local results are')} not saved to disk.`);
  if (unacked.length > 0 || relayUnacked > 0)
    blockers.push(
      `${plural(unacked.length + relayUnacked, 'final is', 'finals are')} saved but unacknowledged — drain the relay queue first.`,
    );
  if (localOnlyRecent.length > 0)
    blockers.push(
      `${plural(localOnlyRecent.length, 'recent saved final is', 'recent saved finals are')} missing from the relay — investigate before teardown.`,
    );
  if (corrections.length > 0)
    blockers.push(
      `${plural(corrections.length, 'match has', 'matches have')} multiple finals — resolve corrections in YellowFruit first.`,
    );
  if (needsImport.length > 0)
    blockers.push(
      `${plural(needsImport.length, 'saved result is', 'saved results are')} not marked imported in YellowFruit.`,
    );
  if (activeRooms.length > 0)
    blockers.push(
      `${plural(activeRooms.length, 'room still has', 'rooms still have')} an assignment out: ${activeRooms.map((room) => room.name).join(', ')}.`,
    );
  if (input.pendingPublication > 0)
    blockers.push(`${plural(input.pendingPublication, 'publication is', 'publications are')} still pending.`);
  if (input.pendingRecovery > 0)
    blockers.push(
      `${plural(input.pendingRecovery, 'recovery operation is', 'recovery operations are')} still pending.`,
    );
  if (input.relayTruncated)
    blockers.push(
      'the relay page filled up, so relay counts are lower bounds — completeness cannot be proven from here.',
    );

  return {
    relayCount: input.relayFinals.length,
    relayUnacked,
    localSavedCount,
    importedCount,
    relayOnly,
    unsaved,
    unacked,
    agedOut,
    localOnlyRecent,
    corrections,
    needsImport,
    activeRooms,
    truncated: input.relayTruncated,
    pendingPublication: input.pendingPublication,
    pendingRecovery: input.pendingRecovery,
    blockers,
    safeToClose: blockers.length === 0,
  };
}
