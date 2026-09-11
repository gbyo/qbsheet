/**
 * The one-button tournament readiness test (#1011).
 *
 * A control operator runs this on the actual tournament setup before Round 1. It exercises
 * the real configured environment — Bridge build, loaded YellowFruit tournament, relay,
 * Scorer pairing path, result destination, credential store, recovery crypto — with synthetic
 * probe identities only, and reports one concise green/red record with actionable fixes.
 *
 * Three rules keep the test itself safe:
 *
 * 1. It never mutates production state. Probe rooms, result ids, and credential keys carry
 *    the `readiness-probe` marker and are checked against the live tournament and relay ids
 *    before anything runs. Nothing is published, saved, acknowledged, or stored under a real
 *    name; the only writes are the destination probe's self-cleaning temp files and one
 *    credential-store entry that is deleted before the check passes.
 * 2. It never sees a secret. Relay connections stay behind the injected `fetchHealth` /
 *    `checkScorerReadiness` closures, so management tokens, pairing codes, recovery
 *    passphrases, and result QBJs cannot reach the report. Details carry counts, epochs,
 *    and origins — never names, teams, players, or documents.
 * 3. It reports, never adopts. A relay that moved under the local state fails the position
 *    check with a review fix; the runner changes no epoch, revision, or assignment.
 *
 * Everything impure arrives through `ReadinessEnvironment`, so the whole matrix is
 * deterministically fault-injectable in `readiness.test.ts` with no timers and no network.
 */

import { assignmentFingerprint, buildAssignment } from './assignment';
import { currentStateVersion, emptyState } from './persistence';
import { decryptRecoveryPackage, encryptRecoveryPackage, packageFormat, packageVersion } from './recovery';
import { RelayError, type RelayHealth, type ScorerReadinessResult } from './relay';
import { scoresheetOrigin } from '../../../../src/director/relay/relayConfig';
import type { BridgeTournament } from './tournament';
import packageJson from '../../package.json';

export type ReadinessStatus = 'pass' | 'fail' | 'skip';

export interface ReadinessCheck {
  id: string;
  label: string;
  status: ReadinessStatus;
  /** Redacted detail: counts, epochs, origins. Never names, secrets, or documents. */
  detail: string;
  /** What the operator should do, or null when nothing is needed. */
  fix: string | null;
}

export interface ReadinessReport {
  ranAt: string;
  bridgeVersion: string;
  overall: 'pass' | 'fail';
  checks: ReadinessCheck[];
}

/** Marker every synthetic probe identity carries, so probes can never pass as tournament data. */
export const readinessProbeMarker = 'readiness-probe';
/** Synthetic room probes are built under, never published. */
export const readinessProbeRoomId = 'readiness-probe-room';
/** Synthetic credential-store entries are written under, then deleted. */
export const readinessProbeCredentialKey = 'qbbridge.readiness-probe.credential';
/** A destination with less than this free cannot survive a tournament day. */
export const readinessMinimumFreeBytes = 100 * 1024 * 1024;

export interface ReadinessTournamentInput {
  id: string;
  teamCount: number;
  playerCount: number;
  roundCount: number;
  /** Compatibility warnings the loader already reported for the authoritative file. */
  relevantWarningCount: number;
  tournament: BridgeTournament;
  yftPath: string | null;
}

export interface ReadinessRelayInput {
  baseUrl: string;
  tournamentId: string;
  epoch: number;
  revision: number;
}

export interface DestinationProbeResult {
  probeBytes: number;
  freeBytes: number | null;
}

export interface ReadinessEnvironment {
  tournament: ReadinessTournamentInput | null;
  relay: ReadinessRelayInput | null;
  resultFolder: string | null;
  nativeHost: boolean;
  fetchHealth: () => Promise<RelayHealth>;
  checkScorerReadiness: () => Promise<ScorerReadinessResult>;
  probeDestination: (folder: string) => Promise<DestinationProbeResult>;
  /** Store a secret, read it back, compare, and delete it. Rejects on any mismatch. */
  credentialRoundTrip: (key: string, secret: string) => Promise<void>;
}

function pass(id: string, label: string, detail: string): ReadinessCheck {
  return { id, label, status: 'pass', detail, fix: null };
}

function fail(id: string, label: string, detail: string, fix: string): ReadinessCheck {
  return { id, label, status: 'fail', detail, fix };
}

function skip(id: string, label: string, detail: string, fix: string | null = null): ReadinessCheck {
  return { id, label, status: 'skip', detail, fix };
}

function randomProbeSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function checkRecoveryCrypto(): Promise<ReadinessCheck> {
  const marker = `readiness-${Date.now()}`;
  const passphrase = `readiness probe ${randomProbeSecret()}`;
  // Decrypt validates the payload the way it validates a real package, so the synthetic
  // state carries a synthetic backup-controller relay block. Every value is marked, held
  // in memory only, and never leaves this check.
  const synthetic = {
    ...emptyState(),
    relay: {
      baseUrl: 'https://readiness-probe.invalid',
      tournamentId: '123456789012345678901234',
      managementToken: 'readiness-probe-token',
      epoch: 0,
      revision: 0,
      controllerRole: 'backup' as const,
      controllerId: readinessProbeRoomId,
      controllerLabel: 'Readiness probe',
    },
  };
  try {
    const encrypted = await encryptRecoveryPackage(
      { kind: packageFormat, version: packageVersion, createdAt: marker, state: synthetic },
      passphrase,
    );
    const decrypted = await decryptRecoveryPackage(encrypted, passphrase);
    if (decrypted.createdAt !== marker) {
      return fail(
        'recovery-crypto',
        'Recovery crypto round-trip',
        'decrypting a freshly encrypted package returned different content.',
        'Reinstall QBSheet Bridge; the recovery path is broken in this build.',
      );
    }
    return pass(
      'recovery-crypto',
      'Recovery crypto round-trip',
      'a synthetic package encrypted and decrypted in memory; nothing was written.',
    );
  } catch (error) {
    return fail(
      'recovery-crypto',
      'Recovery crypto round-trip',
      `the package crypto failed before any real credential was involved: ${(error as Error).message}`,
      'Reinstall QBSheet Bridge; the recovery path is broken in this build.',
    );
  }
}

function isHttpsOrLoopback(baseUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:' || parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
}

/**
 * Run every readiness check against the injected environment and return the redacted report.
 * Check order is deliberate: cheap local proofs first, relay round-trips in the middle,
 * destination and credential side effects last.
 */
export async function runReadinessTest(environment: ReadinessEnvironment): Promise<ReadinessReport> {
  const checks: ReadinessCheck[] = [];
  const version = typeof packageJson.version === 'string' ? packageJson.version : 'unknown';

  checks.push(
    /^\d+\.\d+\.\d+$/.test(version) && currentStateVersion >= 2
      ? pass(
          'bridge-build',
          'Bridge build and state schema',
          `QBBridge ${version} understands state schema v${currentStateVersion}.`,
        )
      : fail(
          'bridge-build',
          'Bridge build and state schema',
          `unrecognized build or schema (version ${version}, schema v${currentStateVersion}).`,
          'Reinstall QBSheet Bridge from a pinned release before Round 1.',
        ),
  );

  const tournament = environment.tournament;
  if (!tournament) {
    checks.push(
      fail(
        'yellowfruit',
        'YellowFruit tournament',
        'no YellowFruit file is loaded.',
        'Load the authoritative YellowFruit file for this tournament.',
      ),
    );
  } else if (tournament.relevantWarningCount > 0) {
    checks.push(
      fail(
        'yellowfruit',
        'YellowFruit tournament',
        `${tournament.relevantWarningCount} compatibility warning(s) need review before publishing.`,
        'Reload the authoritative YellowFruit file and clear every compatibility warning.',
      ),
    );
  } else if (tournament.teamCount === 0 || tournament.roundCount === 0) {
    checks.push(
      fail(
        'yellowfruit',
        'YellowFruit tournament',
        'the loaded file has no publishable teams or rounds.',
        'Load the authoritative YellowFruit file for this tournament.',
      ),
    );
  } else {
    checks.push(
      pass(
        'yellowfruit',
        'YellowFruit tournament',
        `${tournament.teamCount} teams, ${tournament.playerCount} players, ` +
          `${tournament.roundCount} rounds, no compatibility warnings.`,
      ),
    );
  }

  const relay = environment.relay;
  let health: RelayHealth | null = null;
  if (!relay) {
    checks.push(skip('relay-health', 'Relay connection', 'no relay is connected.', 'Connect a relay.'));
  } else if (!isHttpsOrLoopback(relay.baseUrl)) {
    checks.push(
      fail(
        'relay-health',
        'Relay connection',
        'the relay address is not a valid https URL.',
        'Connect a relay over https before Round 1.',
      ),
    );
  } else {
    try {
      const seen = await environment.fetchHealth();
      if (seen.tournamentId !== relay.tournamentId) {
        checks.push(
          fail(
            'relay-health',
            'Relay connection',
            'the relay answers for the wrong tournament id; nothing was adopted.',
            'Connect the relay deployed for this tournament.',
          ),
        );
      } else if (!seen.controllerActive) {
        checks.push(
          fail(
            'relay-health',
            'Relay connection',
            'the relay reports no active controller.',
            'Claim or take over the relay, then re-run this test.',
          ),
        );
      } else {
        health = seen;
        checks.push(
          pass(
            'relay-health',
            'Relay connection',
            `epoch ${seen.directorEpoch}, revision ${seen.revision}, ` +
              `acting as ${seen.authenticatedAs}, backup control ` +
              `${seen.backupProvisioned ? 'provisioned' : 'not provisioned'}.`,
          ),
        );
      }
    } catch (error) {
      const status = error instanceof RelayError ? error.status : null;
      if (status === 401 || status === 403) {
        checks.push(
          fail(
            'relay-health',
            'Relay connection',
            'the relay rejected the management credential.',
            'The management credential was rejected: reconnect the relay or import the recovery package for this controller.',
          ),
        );
      } else {
        checks.push(
          fail(
            'relay-health',
            'Relay connection',
            `the relay is unreachable: ${(error as Error).message}`,
            'Check the relay URL, the network, and that the relay deployment is up.',
          ),
        );
      }
    }
  }

  if (!relay) {
    checks.push(
      skip('scorer-readiness', 'Scorer pairing path', 'no relay is connected.', 'Connect a relay.'),
    );
  } else if (!health) {
    checks.push(
      skip(
        'scorer-readiness',
        'Scorer pairing path',
        'the relay health check failed, so pairing was not probed.',
        null,
      ),
    );
  } else {
    try {
      const readiness = await environment.checkScorerReadiness();
      if (readiness.origin !== scoresheetOrigin || !readiness.canPair) {
        checks.push(
          fail(
            'scorer-readiness',
            'Scorer pairing path',
            `qbsheet.com pairing is blocked: ${readiness.message}`,
            'Allow the Scorer origin on the relay, then re-run this test.',
          ),
        );
      } else {
        checks.push(
          pass(
            'scorer-readiness',
            'Scorer pairing path',
            `the pinned Scorer origin pairs: ${readiness.message}`,
          ),
        );
      }
    } catch (error) {
      checks.push(
        fail(
          'scorer-readiness',
          'Scorer pairing path',
          `the pairing check failed: ${(error as Error).message}`,
          'Allow the Scorer origin on the relay, then re-run this test.',
        ),
      );
    }
  }

  if (!relay || !health) {
    checks.push(
      skip(
        'relay-position',
        'Relay position',
        'the relay health check failed, so the position is unknown.',
        null,
      ),
    );
  } else if (health.directorEpoch !== relay.epoch || health.revision !== relay.revision) {
    checks.push(
      fail(
        'relay-position',
        'Relay position',
        `the relay moved while away (epoch ${relay.epoch}→${health.directorEpoch}, ` +
          `revision ${relay.revision}→${health.revision}); nothing was adopted.`,
        'Review the relay position with the crew before publishing anything.',
      ),
    );
  } else {
    checks.push(
      pass(
        'relay-position',
        'Relay position',
        `epoch ${health.directorEpoch}, revision ${health.revision}: matches this Bridge.`,
      ),
    );
  }

  checks.push(checkAssignmentRoundTrip(tournament));
  checks.push(checkSyntheticIdentities(tournament, relay));

  if (!environment.resultFolder) {
    checks.push(
      skip(
        'result-destination',
        'Result destination',
        'no result folder is chosen.',
        'Choose the result folder, then re-run this test.',
      ),
    );
  } else if (!environment.nativeHost) {
    checks.push(
      skip(
        'result-destination',
        'Result destination',
        'destination probing needs the desktop application.',
        'Re-run this test in QBSheet Bridge on the tournament machine.',
      ),
    );
  } else {
    try {
      const probe = await environment.probeDestination(environment.resultFolder);
      if (probe.freeBytes !== null && probe.freeBytes < readinessMinimumFreeBytes) {
        checks.push(
          fail(
            'result-destination',
            'Result destination',
            `only ${formatBytes(probe.freeBytes)} free on the destination volume.`,
            'Free disk space on the tournament machine before Round 1.',
          ),
        );
      } else {
        checks.push(
          pass(
            'result-destination',
            'Result destination',
            `wrote, synced, renamed, read back, and deleted a ${probe.probeBytes} byte probe` +
              (probe.freeBytes === null
                ? '; free space unreported on this volume.'
                : `; ${formatBytes(probe.freeBytes)} free.`),
          ),
        );
      }
    } catch (error) {
      checks.push(
        fail(
          'result-destination',
          'Result destination',
          `the destination probe failed: ${(error as Error).message}`,
          'Choose a writable result folder, then re-run this test.',
        ),
      );
    }
  }

  if (!environment.nativeHost) {
    checks.push(
      skip(
        'credential-store',
        'Credential store',
        'the secure store needs the desktop application.',
        'Re-run this test in QBSheet Bridge on the tournament machine.',
      ),
    );
  } else {
    try {
      await environment.credentialRoundTrip(readinessProbeCredentialKey, `probe ${randomProbeSecret()}`);
      checks.push(
        pass(
          'credential-store',
          'Credential store',
          'a synthetic entry was stored, read back, compared, and deleted.',
        ),
      );
    } catch (error) {
      checks.push(
        fail(
          'credential-store',
          'Credential store',
          `the secure store round-trip failed: ${(error as Error).message}`,
          'Fix OS keychain access before the tournament needs a credential rescue.',
        ),
      );
    }
  }

  checks.push(await checkRecoveryCrypto());

  const setupComplete = tournament !== null && relay !== null && environment.resultFolder !== null;
  const overall = checks.some((entry) => entry.status === 'fail') || !setupComplete ? 'fail' : 'pass';
  return { ranAt: new Date().toISOString(), bridgeVersion: version, overall, checks };
}

function checkAssignmentRoundTrip(tournament: ReadinessTournamentInput | null): ReadinessCheck {
  const id = 'assignment-roundtrip';
  const label = 'Assignment build round-trip';
  if (!tournament) {
    return skip(id, label, 'no YellowFruit file is loaded.', 'Load the authoritative file.');
  }
  const round = tournament.tournament.rounds[0];
  const teams = tournament.tournament.teams;
  if (!round || teams.length < 2) {
    return fail(
      id,
      label,
      'the loaded file has no round with two pairable teams.',
      'Load the authoritative YellowFruit file for this tournament.',
    );
  }
  const input = {
    tournament: tournament.tournament,
    round,
    roomId: readinessProbeRoomId,
    roomName: 'Readiness probe',
    left: teams[0],
    right: teams[1],
    assignmentRevision: 1,
  };
  const first = buildAssignment(input);
  if (!first.ok) {
    return fail(
      id,
      label,
      `a probe assignment for the first round failed to build: ${first.error}`,
      'Reload the authoritative YellowFruit file and clear every compatibility warning.',
    );
  }
  const second = buildAssignment(input);
  if (!second.ok) {
    return fail(id, label, 'rebuilding the same probe assignment failed.', 'Re-run this test.');
  }
  const firstPrint = assignmentFingerprint(first.assignment.document);
  const secondPrint = assignmentFingerprint(second.assignment.document);
  if (firstPrint !== secondPrint) {
    return fail(
      id,
      label,
      'the same probe assignment fingerprinted differently twice.',
      'Reinstall QBSheet Bridge; assignment building is nondeterministic in this build.',
    );
  }
  return pass(
    id,
    label,
    `a synthetic probe assignment built twice with a stable fingerprint (${firstPrint.slice(0, 8)}…); nothing was published.`,
  );
}

function checkSyntheticIdentities(
  tournament: ReadinessTournamentInput | null,
  relay: ReadinessRelayInput | null,
): ReadinessCheck {
  const id = 'synthetic-identity';
  const label = 'Probe identities cannot pass as tournament data';
  const live = [tournament?.id, relay?.tournamentId].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  for (const probe of [readinessProbeRoomId, readinessProbeCredentialKey]) {
    if (!probe.includes(readinessProbeMarker)) {
      return fail(id, label, 'a probe identity lost its synthetic marker.', 'Re-run this test.');
    }
    if (live.includes(probe)) {
      return fail(
        id,
        label,
        'a probe identity collides with a live tournament identity.',
        'Stop: the probe configuration is unsafe. Do not run this test.',
      );
    }
  }
  return pass(
    id,
    label,
    'every probe identity carries the synthetic marker and matches no live tournament or relay id.',
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${bytes} B`;
}
