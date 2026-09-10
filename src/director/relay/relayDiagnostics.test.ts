import { describe, expect, it } from 'vitest';
import {
  buildRelayDiagnostics,
  findRelayDiagnosticLeaks,
  relayRedacted,
  scrubRelayDiagnostics,
  type SafeRelayDiagnosticInput,
} from './relayDiagnostics';

const input: SafeRelayDiagnosticInput = {
  relayUrl: 'https://example.workers.dev',
  protocolVersion: 1,
  relayRevision: 178,
  mirrorRevision: 12,
  lifecycle: 'live',
  roomsMirrored: 18,
  roomsTotal: 18,
  resultsUnacked: 0,
  helpOpen: 1,
  meteredRequestsEstimate: 1200,
  rowsWrittenEstimate: 43000,
  rowsPerAcceptedProgress: 1,
  meteredRequestsShare: 0.012,
  rowsWrittenShare: 0.43,
  connectionTransitions: [{ at: '2026-09-10T12:00:00.000Z', from: 'reconnecting', to: 'connected' }],
  lastSyncErrorCodes: ['mirror-503'],
  lanFallbackAvailable: true,
  lanFallbackAddress: '192.168.1.24:3000',
};

describe('relay diagnostics bundle', () => {
  it('carries the operational fields and nothing else', () => {
    const bundle = buildRelayDiagnostics(input);
    expect(bundle).toMatchObject({
      relayUrl: 'https://example.workers.dev',
      protocol: { name: 'QBTCP', version: 1 },
      relayRevision: 178,
      mirrorRevision: 12,
      rooms: { mirrored: 18, total: 18 },
      retained: { resultsUnacked: 0, helpOpen: 1 },
      lanFallback: { available: true, address: '192.168.1.24:3000' },
    });
    expect(findRelayDiagnosticLeaks(bundle)).toEqual([]);
  });

  it('contains no secrets even when the caller passes a hostile object through the scrubber', () => {
    const hostile = {
      relayUrl: 'https://example.workers.dev',
      managementToken: 'live-management-credential',
      nested: {
        setupToken: 'one-time-secret',
        authorization: 'Bearer live-management-credential',
        pairing_code: '48213906',
        code: '48213906',
        qbj: { type: 'Match', match_teams: [{ players: ['Student Name'] }] },
        progress: { matchState: 'secret-state' },
      },
      pairingUrl: 'https://qbsheet.com/#qbtcp-pair?v=1&server=x&code=48213906&room=room-204',
      errorCode: 'mirror-503',
      count: 3,
    };
    const scrubbed = scrubRelayDiagnostics(hostile) as Record<string, unknown>;
    const text = JSON.stringify(scrubbed);
    for (const secret of [
      'live-management-credential',
      'one-time-secret',
      '48213906',
      'Student Name',
      'secret-state',
    ]) {
      expect(text).not.toContain(secret);
    }
    // Redaction marks where values were removed; telemetry survives. A pairing URL never
    // belongs in diagnostics at all, so its key redacts wholesale rather than strip to origin.
    expect(scrubbed.managementToken).toBe(relayRedacted);
    expect(scrubbed.errorCode).toBe('mirror-503');
    expect(scrubbed.count).toBe(3);
    expect(scrubbed.pairingUrl).toBe(relayRedacted);
  });

  it('flags a bundle that still carries a pairing fragment', () => {
    const leaks = findRelayDiagnosticLeaks({
      pairingUrl: 'https://qbsheet.com/#qbtcp-pair?v=1&server=x&code=48213906&room=r',
    });
    expect(leaks).toContain('pairingUrl');
  });
});
