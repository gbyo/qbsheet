/**
 * Deterministic fault injection for the tournament readiness test (#1011).
 *
 * Every acceptance bullet gets a failing setup with a rejected promise or a bad value —
 * no timers, no network, no randomness under test (the runner's one random secret is
 * confined to the credential/crypto checks, which take injected closures). A final case
 * plants hostile names through every reachable input and proves the redacted report
 * contains none of them.
 */

import { describe, expect, test } from 'vitest';
import { scoresheetOrigin } from '../../../../src/director/relay/relayConfig';
import { loadedFixture } from '../tests/fixture';
import { RelayError, type RelayHealth, type ScorerReadinessResult } from './relay';
import {
  readinessProbeCredentialKey,
  runReadinessTest,
  type ReadinessEnvironment,
  type ReadinessTournamentInput,
} from './readiness';

const health: RelayHealth = {
  tournamentId: 'tourney-1',
  directorEpoch: 3,
  revision: 7,
  activeController: 'primary',
  authenticatedAs: 'primary',
  controllerActive: true,
  backupProvisioned: true,
  backupControllerId: 'ctrl-2',
  backupControllerLabel: 'Backup laptop',
};

const scorerReady: ScorerReadinessResult = {
  origin: scoresheetOrigin,
  canPair: true,
  state: 'ready',
  message: 'pairing is open',
};

function tournamentInput(): ReadinessTournamentInput {
  const tournament = loadedFixture();
  return {
    id: tournament.id,
    teamCount: tournament.teams.length,
    playerCount: tournament.playerCount,
    roundCount: tournament.rounds.length,
    relevantWarningCount: 0,
    tournament,
    yftPath: '/tmp/meet.yft',
  };
}

function cleanEnvironment(overrides: Partial<ReadinessEnvironment> = {}): ReadinessEnvironment {
  return {
    tournament: tournamentInput(),
    relay: { baseUrl: 'https://relay.example.com', tournamentId: 'tourney-1', epoch: 3, revision: 7 },
    resultFolder: '/tmp/results',
    nativeHost: true,
    fetchHealth: async () => health,
    checkScorerReadiness: async () => scorerReady,
    probeDestination: async () => ({ probeBytes: 28, freeBytes: 10 * 1024 * 1024 * 1024 }),
    credentialRoundTrip: async () => {},
    ...overrides,
  };
}

function check(report: { checks: { id: string; status: string }[] }, id: string): string {
  const found = report.checks.find((entry) => entry.id === id);
  if (!found) throw new Error(`no readiness check named ${id}`);
  return found.status;
}

describe('tournament readiness', () => {
  test('a clean tournament setup reports green with nothing to fix', async () => {
    const seenKeys: string[] = [];
    const report = await runReadinessTest(
      cleanEnvironment({
        credentialRoundTrip: async (key) => {
          seenKeys.push(key);
        },
      }),
    );
    expect(report.overall).toBe('pass');
    expect(report.checks).toHaveLength(10);
    for (const entry of report.checks) {
      expect(entry.status).toBe('pass');
      expect(entry.fix).toBeNull();
    }
    // The only credential-store entry the run may touch is the synthetic probe key.
    expect(seenKeys).toEqual([readinessProbeCredentialKey]);
  });

  test('an unconfigured Bridge reports red with one fix per missing piece', async () => {
    const report = await runReadinessTest(
      cleanEnvironment({ tournament: null, relay: null, resultFolder: null }),
    );
    expect(report.overall).toBe('fail');
    expect(check(report, 'yellowfruit')).toBe('fail');
    expect(check(report, 'relay-health')).toBe('skip');
    expect(check(report, 'result-destination')).toBe('skip');
    const fixes = report.checks.filter((entry) => entry.status === 'fail').map((entry) => entry.fix);
    expect(fixes.length).toBeGreaterThan(0);
    for (const fix of fixes) expect(fix).toMatch(/\S/);
  });

  test('YellowFruit compatibility warnings fail before Round 1', async () => {
    const tournament = tournamentInput();
    tournament.relevantWarningCount = 2;
    const report = await runReadinessTest(cleanEnvironment({ tournament }));
    expect(report.overall).toBe('fail');
    expect(check(report, 'yellowfruit')).toBe('fail');
  });

  test('health for the wrong tournament fails instead of adopting it', async () => {
    const report = await runReadinessTest(
      cleanEnvironment({ fetchHealth: async () => ({ ...health, tournamentId: 'other-tourney' }) }),
    );
    expect(report.overall).toBe('fail');
    const entry = report.checks.find((item) => item.id === 'relay-health');
    expect(entry?.status).toBe('fail');
    expect(entry?.detail).toMatch(/wrong tournament/);
  });

  test('a rejected management credential fails with a credential fix', async () => {
    const report = await runReadinessTest(
      cleanEnvironment({
        fetchHealth: async () => {
          throw new RelayError('forbidden', 403);
        },
      }),
    );
    expect(check(report, 'relay-health')).toBe('fail');
    const entry = report.checks.find((item) => item.id === 'relay-health');
    expect(entry?.fix).toMatch(/management credential/i);
  });

  test('an unreachable relay fails with a network fix and skips position', async () => {
    const report = await runReadinessTest(
      cleanEnvironment({
        fetchHealth: async () => {
          throw new RelayError('dial tcp: no such host', null, 'relay_unreachable');
        },
      }),
    );
    expect(check(report, 'relay-health')).toBe('fail');
    expect(check(report, 'relay-position')).toBe('skip');
    expect(check(report, 'scorer-readiness')).toBe('skip');
  });

  test('a relay that refuses Scorer pairing fails with the relay message', async () => {
    const report = await runReadinessTest(
      cleanEnvironment({
        checkScorerReadiness: async () => ({
          origin: scoresheetOrigin,
          canPair: false,
          state: 'blocked',
          message: 'allowlist the origin first',
        }),
      }),
    );
    expect(report.overall).toBe('fail');
    const entry = report.checks.find((item) => item.id === 'scorer-readiness');
    expect(entry?.status).toBe('fail');
    expect(entry?.detail).toMatch(/allowlist the origin first/);
  });

  test('a relay that moved while away is reported and never adopted', async () => {
    const relay = { baseUrl: 'https://relay.example.com', tournamentId: 'tourney-1', epoch: 3, revision: 7 };
    const report = await runReadinessTest(
      cleanEnvironment({
        relay,
        fetchHealth: async () => ({ ...health, directorEpoch: 4 }),
      }),
    );
    expect(check(report, 'relay-position')).toBe('fail');
    const entry = report.checks.find((item) => item.id === 'relay-position');
    expect(entry?.detail).toMatch(/epoch 3→4/);
    expect(entry?.fix).toMatch(/Review/);
    // The local position the operator configured is untouched by the run.
    expect(relay.epoch).toBe(3);
  });

  test('an unwritable result folder fails with its own reason', async () => {
    const report = await runReadinessTest(
      cleanEnvironment({
        probeDestination: async () => {
          throw new Error('That result output folder no longer exists. Choose it again.');
        },
      }),
    );
    expect(check(report, 'result-destination')).toBe('fail');
    const entry = report.checks.find((item) => item.id === 'result-destination');
    expect(entry?.detail).toMatch(/no longer exists/);
  });

  test('a nearly full disk fails before it can strand a final', async () => {
    const report = await runReadinessTest(
      cleanEnvironment({ probeDestination: async () => ({ probeBytes: 28, freeBytes: 1024 }) }),
    );
    expect(check(report, 'result-destination')).toBe('fail');
  });

  test('a broken keychain fails before the tournament needs it', async () => {
    const report = await runReadinessTest(
      cleanEnvironment({
        credentialRoundTrip: async () => {
          throw new Error('The keychain refused the write.');
        },
      }),
    );
    expect(check(report, 'credential-store')).toBe('fail');
  });

  test('a browser run skips the native probes without going red', async () => {
    let probed = false;
    const report = await runReadinessTest(
      cleanEnvironment({
        nativeHost: false,
        probeDestination: async () => {
          probed = true;
          return { probeBytes: 1, freeBytes: 1 };
        },
      }),
    );
    expect(probed).toBe(false);
    expect(check(report, 'result-destination')).toBe('skip');
    expect(check(report, 'credential-store')).toBe('skip');
    expect(report.overall).toBe('pass');
  });

  test('the redacted record never carries names, secrets, or documents', async () => {
    const tournament = tournamentInput();
    tournament.tournament = {
      ...tournament.tournament,
      name: 'Fall Classic Bearer REDACTED-MARKER-OPS',
      teams: tournament.tournament.teams.map((team, index) => ({
        ...team,
        name: `Secret Academy ${index} REDACTED-MARKER-TEAM`,
        players: team.players.map((player, playerIndex) => ({
          ...player,
          name: `Secret Player ${playerIndex} REDACTED-MARKER-PLAYER`,
        })),
      })),
    };
    const report = await runReadinessTest(cleanEnvironment({ tournament }));
    const text = JSON.stringify(report);
    expect(text).not.toMatch(/REDACTED-MARKER-TEAM/);
    expect(text).not.toMatch(/REDACTED-MARKER-PLAYER/);
    expect(text).not.toMatch(/Bearer/);
    expect(text).not.toMatch(/readiness probe [0-9a-f]{32}/);
    expect(text).not.toMatch(/readiness-probe-token/);
    expect(text).not.toMatch(/123456789012345678901234/);
  });
});
