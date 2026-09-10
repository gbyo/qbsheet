/**
 * The Internet QBTCP operational status: one quiet surface when healthy, explicit warnings
 * when anything needs a director's attention.
 *
 * ```
 * Internet QBTCP
 * Primary address     https://example.workers.dev
 * Relay               Connected
 * LAN fallback        Available · 192.168.1.24:xxxx
 * Last sync           Just now
 * Rooms mirrored      18 / 18
 * ```
 *
 * This module derives that surface from already-fetched inputs — relay health, LAN server
 * status, sync telemetry — so it stays a pure function over observations rather than a second
 * thing that performs network requests. A healthy tournament renders the summary lines only;
 * every warning carries an action, never just a color.
 */

export type RelayConnection =
  'connected' | 'unreachable' | 'credential-invalid' | 'unsupported' | 'unconfigured';

export type RelayWarningCode =
  | 'relay-unreachable'
  | 'unsupported-version'
  | 'credential-invalid'
  | 'publication-failing'
  | 'quota-warning'
  | 'lan-unavailable'
  | 'lan-permission'
  | 'qblive-shared-budget';

export interface RelayWarning {
  code: RelayWarningCode;
  message: string;
}

export interface RelayHealthView {
  relayRevision: number;
  lifecycle: string;
  mirrorRevision: number | null;
  resultsUnacked: number;
  helpOpen: number;
  meteredRequestsShare: number | null;
  rowsWrittenShare: number | null;
}

/**
 * The management-health document, read tolerantly: every nested object is optional, because
 * a future relay may add dimensions and an older Director must still render what it knows.
 */
export interface RelayManagementHealth {
  protocolVersion: number | null;
  relayRevision: number | null;
  lifecycle: string | null;
  mirrorRevision: number | null;
  resultsUnacked: number | null;
  helpOpen: number | null;
  meteredRequestsEstimate: number | null;
  rowsWrittenEstimate: number | null;
  rowsPerAcceptedProgress: number | null;
  meteredRequestsShare: number | null;
  rowsWrittenShare: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function readRelayManagementHealth(value: unknown): RelayManagementHealth | null {
  const record = asRecord(value);
  if (!record) return null;
  const mirror = asRecord(record.mirror);
  const storage = asRecord(record.storage);
  const budget = asRecord(record.budget);
  const measured = asRecord(budget?.measured);
  const headroom = asRecord(budget?.headroom);
  return {
    protocolVersion: asNumber(record.protocolVersion),
    relayRevision: asNumber(record.relayRevision),
    mirrorRevision: mirror ? asNumber(mirror.revision) : null,
    lifecycle: typeof record.lifecycle === 'string' ? record.lifecycle : null,
    resultsUnacked: storage ? asNumber(storage.results_unacked) : null,
    helpOpen: storage ? asNumber(storage.help_open) : null,
    meteredRequestsEstimate: measured ? asNumber(measured.metered_requests_estimate) : null,
    rowsWrittenEstimate: measured ? asNumber(measured.rows_written_estimate) : null,
    rowsPerAcceptedProgress: measured ? asNumber(measured.rows_per_accepted_progress) : null,
    meteredRequestsShare: headroom ? asNumber(headroom.metered_requests_share) : null,
    rowsWrittenShare: headroom ? asNumber(headroom.rows_written_share) : null,
  };
}

export function healthViewOf(health: RelayManagementHealth): RelayHealthView {
  return {
    relayRevision: health.relayRevision ?? 0,
    lifecycle: health.lifecycle ?? 'unknown',
    mirrorRevision: health.mirrorRevision,
    resultsUnacked: health.resultsUnacked ?? 0,
    helpOpen: health.helpOpen ?? 0,
    meteredRequestsShare: health.meteredRequestsShare,
    rowsWrittenShare: health.rowsWrittenShare,
  };
}

export type RelayHealthFailureCode =
  'unreachable' | 'credential-invalid' | 'unclaimed' | 'unsupported' | 'unexpected';

export class RelayHealthError extends Error {
  readonly code: RelayHealthFailureCode;
  constructor(code: RelayHealthFailureCode, message: string) {
    super(message);
    this.name = 'RelayHealthError';
    this.code = code;
  }
}

/** Fetch the authenticated management-health document. Throws a coded `RelayHealthError`. */
export async function fetchRelayManagementHealth(
  baseUrl: string,
  tournamentId: string,
  managementToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RelayManagementHealth> {
  const url = `${baseUrl.replace(/\/$/, '')}/qbtcp/v1/manage/tournaments/${tournamentId}/health`;
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { authorization: `Bearer ${managementToken}` } });
  } catch {
    throw new RelayHealthError('unreachable', 'The tournament relay could not be reached.');
  }
  if (response.status === 401) {
    throw new RelayHealthError('credential-invalid', 'The stored relay credential was refused.');
  }
  if (response.status === 403) {
    throw new RelayHealthError('unclaimed', 'That relay has not been claimed yet.');
  }
  if (!response.ok) {
    throw new RelayHealthError('unexpected', `The relay health check failed (${response.status}).`);
  }
  const health = readRelayManagementHealth(await response.json().catch(() => null));
  if (!health) {
    throw new RelayHealthError('unexpected', 'The relay answered health with an unreadable document.');
  }
  if (health.protocolVersion !== null && health.protocolVersion !== 1) {
    throw new RelayHealthError(
      'unsupported',
      `That relay speaks protocol version ${health.protocolVersion}, which this Director does not support.`,
    );
  }
  return health;
}

export interface RelayStatusInput {
  /** Null when Internet QBTCP was never configured. */
  baseUrl: string | null;
  relay: RelayConnection;
  relayHealth: RelayHealthView | null;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  roomsMirrored: number | null;
  roomsTotal: number | null;
  lanAvailable: boolean;
  lanAddress: string | null;
  lanPermissionIssue: string | null;
  /** QBLive backend origin, when one is configured — for the shared-budget heuristic. */
  qbliveOrigin: string | null;
  now?: number;
}

export interface RelayStatusView {
  primaryAddress: string;
  relay: string;
  lanFallback: string;
  lastSync: string;
  roomsMirrored: string;
  warnings: RelayWarning[];
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin.toLowerCase();
  } catch {
    return null;
  }
}

export function formatRelayLastSync(lastSyncAt: string | null, now = Date.now()): string {
  if (!lastSyncAt) return 'Never';
  const at = Date.parse(lastSyncAt);
  if (!Number.isFinite(at)) return 'Unknown';
  const ageMs = Math.max(0, now - at);
  if (ageMs < 60_000) return 'Just now';
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return lastSyncAt;
}

const quotaWarnAt = 0.8;

/** Warn when the relay's own estimates say a Free-tier dimension is nearly spent. */
export function quotaWarningFor(health: RelayHealthView | null): RelayWarning | null {
  if (!health) return null;
  const dimensions: string[] = [];
  if (health.meteredRequestsShare !== null && health.meteredRequestsShare >= quotaWarnAt) {
    dimensions.push('metered requests');
  }
  if (health.rowsWrittenShare !== null && health.rowsWrittenShare >= quotaWarnAt) {
    dimensions.push('SQLite row writes');
  }
  if (dimensions.length === 0) return null;
  return {
    code: 'quota-warning',
    message:
      `Relay resource pressure: ${dimensions.join(' and ')} near the Workers Free daily allowance ` +
      `(see relay diagnostics). Lengthen the scorer progress cadence, and do not share this ` +
      `account's request budget with high-traffic spectator Workers.`,
  };
}

export function deriveRelayStatus(input: RelayStatusInput): RelayStatusView {
  const now = input.now ?? Date.now();
  const warnings: RelayWarning[] = [];

  if (!input.baseUrl) {
    return {
      primaryAddress: 'Not configured',
      relay: 'Not configured',
      lanFallback: input.lanAvailable
        ? `Available${input.lanAddress ? ` · ${input.lanAddress}` : ''}`
        : 'Unavailable',
      lastSync: 'Never',
      roomsMirrored: '—',
      warnings,
    };
  }

  let relayLabel: string;
  switch (input.relay) {
    case 'connected':
      relayLabel = 'Connected';
      break;
    case 'unreachable':
      relayLabel = 'Unreachable';
      warnings.push({
        code: 'relay-unreachable',
        message:
          'The tournament relay could not be reached. Scoring continues over LAN fallback where available.',
      });
      break;
    case 'credential-invalid':
      relayLabel = 'Credential invalid';
      warnings.push({
        code: 'credential-invalid',
        message: 'The stored relay credential was refused. Re-claim or rotate it before the next round.',
      });
      break;
    case 'unsupported':
      relayLabel = 'Unsupported version';
      warnings.push({
        code: 'unsupported-version',
        message:
          'That relay speaks a protocol version this Director does not support. Update Director or redeploy the relay.',
      });
      break;
    case 'unconfigured':
      relayLabel = 'Not configured';
      break;
  }

  if (input.lastSyncError) {
    warnings.push({
      code: 'publication-failing',
      message: `State publication is failing: ${input.lastSyncError}`,
    });
  }

  const quota = quotaWarningFor(input.relayHealth);
  if (quota) warnings.push(quota);

  let lanFallback: string;
  if (input.lanPermissionIssue) {
    lanFallback = 'Permission issue';
    warnings.push({ code: 'lan-permission', message: input.lanPermissionIssue });
  } else if (input.lanAvailable) {
    lanFallback = `Available${input.lanAddress ? ` · ${input.lanAddress}` : ''}`;
  } else {
    lanFallback = 'Unavailable';
    warnings.push({
      code: 'lan-unavailable',
      message: 'LAN fallback is unavailable. An internet or relay outage would stop scoring.',
    });
  }

  // The request allowance is account-wide. Matching origins prove sharing; anything else is
  // unknowable from here, so documentation — not invention — covers the rest.
  const relayOrigin = originOf(input.baseUrl);
  const liveOrigin = input.qbliveOrigin ? originOf(input.qbliveOrigin) : null;
  if (relayOrigin && liveOrigin && relayOrigin === liveOrigin) {
    warnings.push({
      code: 'qblive-shared-budget',
      message:
        'This relay shares its Cloudflare account with a QBLive Worker. Spectator traffic and ' +
        'scoring draw from the same Workers Free request budget — prefer the self-hosted QBServer for QBLive.',
    });
  }

  return {
    primaryAddress: input.baseUrl,
    relay: relayLabel,
    lanFallback,
    lastSync: formatRelayLastSync(input.lastSyncAt, now),
    roomsMirrored:
      input.roomsMirrored !== null && input.roomsTotal !== null
        ? `${input.roomsMirrored} / ${input.roomsTotal}`
        : '—',
    warnings,
  };
}
