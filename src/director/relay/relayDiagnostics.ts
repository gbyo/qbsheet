/**
 * Relay diagnostics: useful to an operator, useless to an attacker.
 *
 * # Allowlist, then scrub
 *
 * The bundle is built from explicitly safe inputs — endpoint, versions, revisions, counters,
 * error *codes* — so credentials, pairing codes, QBJ payloads, and student/player data have
 * no field to travel in. `scrubRelayDiagnostics` then runs over the finished bundle as
 * defense-in-depth: any secret-shaped key is redacted and any URL fragment (where pairing
 * codes live) is stripped, so a future caller passing a richer object cannot leak through
 * this module.
 */

export const relayRedacted = '[redacted]';

/**
 * Keys whose values must never appear in diagnostics. Exact `code` (the pairing bootstrap
 * secret travels as `code`) plus anything naming a token, credential, secret, pairing
 * material, or QBJ payload. Deliberately not a substring match on `code`, so `errorCode`
 * and other `*_code` telemetry survive.
 */
const secretKeyPattern =
  /^(code|.*(token|credential|secret|password|passcode|pairing|authorization|set-cookie|qbj|matchstate|progress|payload|roster|player|student).*)$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Strip URL fragments from a string: pairing codes live after the `#`. */
function stripFragment(value: string): string {
  const hash = value.indexOf('#');
  return hash === -1 ? value : value.slice(0, hash);
}

/**
 * Deep-scrub an arbitrary value for diagnostics. Objects lose secret-shaped keys, strings
 * lose fragments, arrays and nesting are traversed. Primitives pass through.
 */
export function scrubRelayDiagnostics(value: unknown): unknown {
  if (typeof value === 'string') return stripFragment(value);
  if (Array.isArray(value)) return value.map(scrubRelayDiagnostics);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = secretKeyPattern.test(key) ? relayRedacted : scrubRelayDiagnostics(entry);
    }
    return out;
  }
  return value;
}

export interface RelayDiagnosticConnectionTransition {
  at: string;
  from: string;
  to: string;
}

export interface SafeRelayDiagnosticInput {
  /** Relay origin. Fragments are stripped even here. */
  relayUrl: string;
  protocolVersion: number | null;
  relayRevision: number | null;
  mirrorRevision: number | null;
  lifecycle: string | null;
  roomsMirrored: number | null;
  roomsTotal: number | null;
  resultsUnacked: number | null;
  helpOpen: number | null;
  meteredRequestsEstimate: number | null;
  rowsWrittenEstimate: number | null;
  rowsPerAcceptedProgress: number | null;
  meteredRequestsShare: number | null;
  rowsWrittenShare: number | null;
  connectionTransitions: RelayDiagnosticConnectionTransition[];
  /** Error codes only — never messages, which can carry addresses or payloads. */
  lastSyncErrorCodes: string[];
  lanFallbackAvailable: boolean;
  lanFallbackAddress: string | null;
}

export interface RelayDiagnosticsBundle {
  relayUrl: string;
  protocol: { name: 'QBTCP'; version: number | null };
  relayRevision: number | null;
  mirrorRevision: number | null;
  lifecycle: string | null;
  rooms: { mirrored: number | null; total: number | null };
  retained: { resultsUnacked: number | null; helpOpen: number | null };
  budget: {
    meteredRequestsEstimate: number | null;
    rowsWrittenEstimate: number | null;
    rowsPerAcceptedProgress: number | null;
    meteredRequestsShare: number | null;
    rowsWrittenShare: number | null;
  };
  connectionTransitions: RelayDiagnosticConnectionTransition[];
  lastSyncErrorCodes: string[];
  lanFallback: { available: boolean; address: string | null };
  generatedAt: string;
}

/** Build the credential-safe diagnostics bundle. */
export function buildRelayDiagnostics(input: SafeRelayDiagnosticInput): RelayDiagnosticsBundle {
  const bundle: RelayDiagnosticsBundle = {
    relayUrl: stripFragment(input.relayUrl),
    protocol: { name: 'QBTCP', version: input.protocolVersion },
    relayRevision: input.relayRevision,
    mirrorRevision: input.mirrorRevision,
    lifecycle: input.lifecycle,
    rooms: { mirrored: input.roomsMirrored, total: input.roomsTotal },
    retained: { resultsUnacked: input.resultsUnacked, helpOpen: input.helpOpen },
    budget: {
      meteredRequestsEstimate: input.meteredRequestsEstimate,
      rowsWrittenEstimate: input.rowsWrittenEstimate,
      rowsPerAcceptedProgress: input.rowsPerAcceptedProgress,
      meteredRequestsShare: input.meteredRequestsShare,
      rowsWrittenShare: input.rowsWrittenShare,
    },
    connectionTransitions: input.connectionTransitions.map((transition) => ({ ...transition })),
    lastSyncErrorCodes: [...input.lastSyncErrorCodes],
    lanFallback: { available: input.lanFallbackAvailable, address: input.lanFallbackAddress },
    generatedAt: new Date().toISOString(),
  };
  return scrubRelayDiagnostics(bundle) as RelayDiagnosticsBundle;
}

/**
 * Assert a finished bundle carries no secret-shaped material. Used by tests and by any
 * exporter before writing a bundle to disk: returns the offending paths, empty when clean.
 */
export function findRelayDiagnosticLeaks(bundle: unknown): string[] {
  const leaks: string[] = [];
  const visit = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      if (value.includes('#') && /qbtcp-pair/i.test(value)) leaks.push(path);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    if (isRecord(value)) {
      for (const [key, entry] of Object.entries(value)) {
        const at = path ? `${path}.${key}` : key;
        if (secretKeyPattern.test(key) && entry !== relayRedacted) leaks.push(at);
        else visit(entry, at);
      }
    }
  };
  visit(bundle, '');
  return leaks;
}
