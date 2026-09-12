import { describe, expect, it } from 'vitest';
import {
  deriveRelayStatus,
  fetchRelayManagementHealth,
  formatRelayLastSync,
  quotaWarningFor,
  RelayHealthError,
  type RelayStatusInput,
} from './relayStatus';

const base: RelayStatusInput = {
  baseUrl: 'https://example.workers.dev',
  relay: 'connected',
  relayHealth: {
    relayRevision: 178,
    lifecycle: 'live',
    mirrorRevision: 12,
    resultsUnacked: 0,
    helpOpen: 0,
    meteredRequestsShare: 0.05,
    rowsWrittenShare: 0.1,
  },
  lastSyncAt: '2026-09-10T12:00:30.000Z',
  lastSyncError: null,
  roomsMirrored: 18,
  roomsTotal: 18,
  lanAvailable: true,
  lanAddress: '192.168.1.24:3000',
  lanPermissionIssue: null,
  qbliveOrigin: null,
  now: Date.parse('2026-09-10T12:00:45.000Z'),
};

describe('healthy relay status', () => {
  it('is quiet: summary lines, no warnings', () => {
    const view = deriveRelayStatus(base);
    expect(view).toMatchObject({
      primaryAddress: 'https://example.workers.dev',
      relay: 'Connected',
      lanFallback: 'Available · 192.168.1.24:3000',
      lastSync: 'Just now',
      roomsMirrored: '18 / 18',
    });
    expect(view.warnings).toEqual([]);
  });
});

describe('relay warnings', () => {
  it('flags an unreachable relay without hiding LAN fallback', () => {
    const view = deriveRelayStatus({ ...base, relay: 'unreachable' });
    expect(view.relay).toBe('Unreachable');
    expect(view.warnings.map((warning) => warning.code)).toContain('relay-unreachable');
    expect(view.lanFallback).toContain('Available');
  });

  it('flags credential, version, and publication failures with actions', () => {
    expect(deriveRelayStatus({ ...base, relay: 'credential-invalid' }).warnings).toMatchObject([
      { code: 'credential-invalid' },
    ]);
    const version = deriveRelayStatus({ ...base, relay: 'unsupported' });
    expect(version.relay).toBe('Unsupported version');
    expect(version.warnings.map((warning) => warning.code)).toContain('unsupported-version');
    const publication = deriveRelayStatus({ ...base, lastSyncError: 'mirror 503' });
    expect(publication.warnings.map((warning) => warning.code)).toContain('publication-failing');
    expect(publication.warnings[0]?.message).toContain('mirror 503');
  });

  it('names an unknown tournament instead of blaming the network', () => {
    const view = deriveRelayStatus({ ...base, relay: 'unclaimed' });
    expect(view.relay).toBe('Not claimed');
    const warning = view.warnings.find((warning) => warning.code === 'relay-unclaimed');
    expect(warning?.message).toMatch(/no tournament with this id/);
    expect(view.warnings.map((warning) => warning.code)).not.toContain('relay-unreachable');
  });

  it('warns on quota pressure from the relay estimates', () => {
    expect(quotaWarningFor(base.relayHealth)).toBeNull();
    const pressured = deriveRelayStatus({
      ...base,
      relayHealth: { ...base.relayHealth!, meteredRequestsShare: 0.85, rowsWrittenShare: 0.9 },
    });
    const quota = pressured.warnings.find((warning) => warning.code === 'quota-warning');
    expect(quota?.message).toMatch(/metered requests|row writes/);
  });

  it('warns when LAN fallback is unavailable or permission-blocked', () => {
    const down = deriveRelayStatus({ ...base, lanAvailable: false, lanAddress: null });
    expect(down.lanFallback).toBe('Unavailable');
    expect(down.warnings.map((warning) => warning.code)).toContain('lan-unavailable');
    const permission = deriveRelayStatus({
      ...base,
      lanPermissionIssue: 'Local-network permission was denied in system settings.',
    });
    expect(permission.warnings.map((warning) => warning.code)).toContain('lan-permission');
  });

  it('detects a shared QBLive budget only when the origins actually match', () => {
    const shared = deriveRelayStatus({
      ...base,
      baseUrl: 'https://ops.example.workers.dev',
      qbliveOrigin: 'https://ops.example.workers.dev/some/path',
    });
    expect(shared.warnings.map((warning) => warning.code)).toContain('qblive-shared-budget');

    const sharedInput = {
      ...base,
      baseUrl: 'https://ops.example.workers.dev',
      qbliveOrigin: 'https://ops.example.workers.dev/some/path' as string | null,
    };
    const separate = deriveRelayStatus({
      ...sharedInput,
      qbliveOrigin: 'https://spectator.example.workers.dev',
    });
    expect(separate.warnings.map((warning) => warning.code)).not.toContain('qblive-shared-budget');

    const none = deriveRelayStatus({ ...sharedInput, qbliveOrigin: null });
    expect(none.warnings.map((warning) => warning.code)).not.toContain('qblive-shared-budget');
  });

  it('renders an unconfigured relay without warnings', () => {
    const view = deriveRelayStatus({ ...base, baseUrl: null, relay: 'unconfigured' });
    expect(view.primaryAddress).toBe('Not configured');
    expect(view.warnings).toEqual([]);
  });
});

describe('management health failures', () => {
  const call = (status: number, body: unknown) =>
    fetchRelayManagementHealth(
      'https://example.workers.dev',
      'tournament-id',
      'management-credential',
      (async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
    ).then(
      () => {
        throw new Error('expected the health check to fail');
      },
      (reason: unknown) => reason,
    );

  it('maps an unknown tournament to unclaimed, not unreachable', async () => {
    // The health route gates on the tournament before the credential, so a typo'd id arrives
    // as 404 `not-found` — the status the old code folded into `unexpected` → `unreachable`.
    const failure = await call(404, { error: 'not-found', message: 'No such tournament.' });
    expect(failure).toBeInstanceOf(RelayHealthError);
    expect((failure as RelayHealthError).code).toBe('unclaimed');
    expect((failure as RelayHealthError).message).toMatch(/no tournament with this id/);
  });

  it('keeps genuine outages and refused credentials on their own codes', async () => {
    const refused = await call(401, { error: 'invalid_credential', message: 'Nope.' });
    expect((refused as RelayHealthError).code).toBe('credential-invalid');
    const broken = await call(503, { error: 'storage-unavailable', message: 'Down.' });
    expect((broken as RelayHealthError).code).toBe('unexpected');
  });
});

describe('last-sync formatting', () => {
  const now = Date.parse('2026-09-10T12:00:00.000Z');
  it('formats relative ages', () => {
    expect(formatRelayLastSync('2026-09-10T11:59:30.000Z', now)).toBe('Just now');
    expect(formatRelayLastSync('2026-09-10T11:55:00.000Z', now)).toBe('5 min ago');
    expect(formatRelayLastSync('2026-09-10T10:00:00.000Z', now)).toBe('2 h ago');
    expect(formatRelayLastSync(null, now)).toBe('Never');
    expect(formatRelayLastSync('not-a-date', now)).toBe('Unknown');
  });
});
