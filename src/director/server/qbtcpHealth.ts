import type { NativeServerStatus } from '../platform/native';

/** The native status poll and the QBTCP snapshot poll share this cadence. */
export const qbtcpPollIntervalMs = 1000;
/** Allow several missed polls before calling the ingestion path delayed. */
export const qbtcpStaleAfterMs = 5 * qbtcpPollIntervalMs;

export interface QbtcpIngestionHealth {
  lastSuccessfulAt: string | null;
  error: string | null;
}

export interface QbtcpHealthCursor {
  sequence: number;
  health: QbtcpIngestionHealth;
}

export type QbtcpOperationalHealth =
  | { kind: 'checking' }
  | { kind: 'off' }
  | { kind: 'unverified' }
  | { kind: 'healthy'; pairedRooms: number; lastSuccessfulAt: string }
  | { kind: 'stale'; pairedRooms: number; lastSuccessfulAt: string; ageMs: number }
  | { kind: 'error'; source: 'server' | 'snapshot'; message: string };

/** Accept only observations from a poll newer than the last applied observation. */
export function applyQbtcpHealthUpdate(
  current: QbtcpHealthCursor,
  update: QbtcpHealthCursor,
): QbtcpHealthCursor {
  return update.sequence > current.sequence ? update : current;
}

function serverErrorMessage(status: NativeServerStatus): string | null {
  if (status.running || !status.message) return null;
  return /^qbtcp server stopped\.?$/i.test(status.message.trim()) ? null : status.message;
}

function pairedRoomCount(status: NativeServerStatus): number {
  return Math.max(0, Math.floor(status.pairedRooms ?? 0));
}

/**
 * Derive the end-to-end QBTCP condition from process status and Director ingestion telemetry.
 * `server === null` means the native status is still being checked, not that a browser server is
 * stopped. Callers in browser mode should omit this model rather than showing native state.
 */
export function deriveQbtcpOperationalHealth(
  server: NativeServerStatus | null,
  ingestion: QbtcpIngestionHealth | undefined,
  now = Date.now(),
): QbtcpOperationalHealth {
  if (!server) return { kind: 'checking' };

  const serverError = serverErrorMessage(server);
  if (serverError) return { kind: 'error', source: 'server', message: serverError };
  if (!server.running) return { kind: 'off' };
  if (ingestion?.error) return { kind: 'error', source: 'snapshot', message: ingestion.error };
  if (!ingestion?.lastSuccessfulAt) return { kind: 'unverified' };

  const lastSuccessfulAt = Date.parse(ingestion.lastSuccessfulAt);
  if (!Number.isFinite(lastSuccessfulAt)) return { kind: 'unverified' };
  const ageMs = Math.max(0, now - lastSuccessfulAt);
  const pairedRooms = pairedRoomCount(server);
  if (ageMs >= qbtcpStaleAfterMs) {
    return { kind: 'stale', pairedRooms, lastSuccessfulAt: ingestion.lastSuccessfulAt, ageMs };
  }
  return { kind: 'healthy', pairedRooms, lastSuccessfulAt: ingestion.lastSuccessfulAt };
}

export function qbtcpHealthNeedsAttention(health: QbtcpOperationalHealth): boolean {
  return health.kind === 'error' || health.kind === 'stale' || health.kind === 'unverified';
}

export function qbtcpHealthSummary(health: QbtcpOperationalHealth): string {
  switch (health.kind) {
    case 'checking':
      return 'Checking native server';
    case 'off':
      return 'Server is stopped';
    case 'unverified':
      return 'Waiting for first snapshot';
    case 'healthy':
      return `${health.pairedRooms} paired room${health.pairedRooms === 1 ? '' : 's'}`;
    case 'stale':
      return 'Snapshot sync is delayed';
    case 'error':
      return health.source === 'snapshot' ? 'Snapshot ingestion needs attention' : 'Server needs attention';
  }
}
