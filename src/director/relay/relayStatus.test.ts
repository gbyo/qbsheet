import { describe, expect, it } from 'vitest';
import {
  deriveRelayStatus,
  formatRelayLastSync,
  quotaWarningFor,
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
