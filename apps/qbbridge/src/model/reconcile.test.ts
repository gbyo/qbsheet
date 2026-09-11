import { describe, expect, test } from 'vitest';
import { buildTournamentReconciliation, type ReconcileInput } from './reconcile';

const NOW = Date.parse('2026-09-11T18:00:00Z');
const HOUR = 60 * 60 * 1000;

function final(
  resultId: string,
  overrides: Partial<{ roomId: string; matchId: string | null; ageHours: number; acked: boolean }> = {},
) {
  return {
    resultId,
    roomId: overrides.roomId ?? 'room-1',
    matchId: overrides.matchId ?? `match-${resultId}`,
    receivedAt: new Date(NOW - (overrides.ageHours ?? 1) * HOUR).toISOString(),
    acked: overrides.acked ?? true,
  };
}

function local(
  resultId: string,
  overrides: Partial<{
    matchId: string | null;
    ageHours: number;
    saved: boolean;
    ackPending: boolean;
    importStatus: 'new' | 'needs-import' | 'imported';
  }> = {},
) {
  return {
    resultId,
    matchId: overrides.matchId ?? `match-${resultId}`,
    receivedAt: new Date(NOW - (overrides.ageHours ?? 1) * HOUR).toISOString(),
    saved: overrides.saved ?? true,
    ackPending: overrides.ackPending ?? false,
    importStatus: overrides.importStatus ?? ('imported' as const),
  };
}

function input(overrides: Partial<ReconcileInput> = {}): ReconcileInput {
  return {
    relayFinals: [],
    relayTruncated: false,
    local: [],
    rooms: [],
    pendingPublication: 0,
    pendingRecovery: 0,
    heartbeatUnknown: false,
    ...overrides,
  };
}

function room(
  roomId: string,
  name: string,
  overrides: Partial<{ lastHeartbeatAt: string | null; lastActivityAt: string | null }> = {},
) {
  return {
    roomId,
    name,
    active: true as const,
    lastHeartbeatAt: overrides.lastHeartbeatAt ?? null,
    lastActivityAt: overrides.lastActivityAt ?? null,
  };
}

describe('final tournament reconciliation', () => {
  test('a clean tournament proves safe to close', () => {
    const report = buildTournamentReconciliation(
      input({
        relayFinals: [final('a'), final('b')],
        local: [local('a'), local('b')],
      }),
      NOW,
    );
    expect(report.safeToClose).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.relayCount).toBe(2);
    expect(report.localSavedCount).toBe(2);
    expect(report.importedCount).toBe(2);
  });

  test('a relay-only final blocks until it is saved locally', () => {
    const report = buildTournamentReconciliation(
      input({ relayFinals: [final('a'), final('ghost')], local: [local('a')] }),
      NOW,
    );
    expect(report.safeToClose).toBe(false);
    expect(report.relayOnly).toEqual(['ghost']);
    expect(report.blockers.some((blocker) => blocker.includes('not saved locally'))).toBe(true);
  });

  test('unsaved and unacknowledged finals block with distinct reasons', () => {
    const report = buildTournamentReconciliation(
      input({
        relayFinals: [final('a'), final('b', { acked: false })],
        local: [local('a', { saved: false }), local('b', { ackPending: true })],
      }),
      NOW,
    );
    expect(report.safeToClose).toBe(false);
    expect(report.unsaved).toEqual(['a']);
    expect(report.unacked).toEqual(['b']);
    expect(report.relayUnacked).toBe(1);
  });

  test('two finals for one match are listed as a correction, never merged', () => {
    const report = buildTournamentReconciliation(
      input({
        relayFinals: [final('orig', { matchId: 'match-1' }), final('corr', { matchId: 'match-1' })],
        local: [local('orig', { matchId: 'match-1' }), local('corr', { matchId: 'match-1' })],
      }),
      NOW,
    );
    expect(report.safeToClose).toBe(false);
    expect(report.corrections).toEqual([{ matchId: 'match-1', resultIds: ['corr', 'orig'] }]);
  });

  test('an old saved final missing from the relay aged out; a recent one is anomalous', () => {
    const report = buildTournamentReconciliation(
      input({
        relayFinals: [],
        local: [
          local('old', { ageHours: 24 * 10 }),
          local('recent', { ageHours: 2 }),
          local('undated', { ageHours: 1 }),
        ],
      }),
      NOW,
    );
    expect(report.agedOut).toEqual(['old']);
    expect(report.localOnlyRecent).toEqual(['recent', 'undated']);
    expect(report.safeToClose).toBe(false);
  });

  test('a full relay page refuses to claim completeness', () => {
    const relayFinals = Array.from({ length: 128 }, (_, index) => final(`r-${index}`));
    const report = buildTournamentReconciliation(
      input({
        relayFinals,
        relayTruncated: true,
        local: relayFinals.map((entry) => local(entry.resultId)),
      }),
      NOW,
    );
    expect(report.safeToClose).toBe(false);
    expect(report.truncated).toBe(true);
    expect(report.blockers.some((blocker) => blocker.includes('lower bounds'))).toBe(true);
  });

  test('active rooms and pending operations block the close', () => {
    const report = buildTournamentReconciliation(
      input({
        rooms: [room('room-9', 'Room 9')],
        pendingPublication: 1,
        pendingRecovery: 1,
      }),
      NOW,
    );
    expect(report.safeToClose).toBe(false);
    expect(report.activeRooms).toHaveLength(1);
    expect(report.blockers).toHaveLength(3);
  });

  test('a heartbeating room blocks as live mid-game', () => {
    const report = buildTournamentReconciliation(
      input({
        rooms: [
          room('live', 'Room Live', {
            lastHeartbeatAt: new Date(NOW - 30 * 1000).toISOString(),
            lastActivityAt: new Date(NOW - 30 * 1000).toISOString(),
          }),
        ],
      }),
      NOW,
    );
    expect(report.safeToClose).toBe(false);
    expect(report.blockers.some((blocker) => blocker.includes('do not close mid-game'))).toBe(true);
    expect(report.blockers.some((blocker) => blocker.includes('Room Live'))).toBe(true);
  });

  test('a recently active room without a heartbeat reads as in flight, not live', () => {
    const report = buildTournamentReconciliation(
      input({
        rooms: [
          room('recent', 'Room Recent', {
            lastActivityAt: new Date(NOW - 2 * 60 * 1000).toISOString(),
          }),
        ],
      }),
      NOW,
    );
    expect(report.safeToClose).toBe(false);
    expect(report.blockers.some((blocker) => blocker.includes('Room Recent (active moments ago)'))).toBe(
      true,
    );
    expect(report.blockers.some((blocker) => blocker.includes('mid-game'))).toBe(false);
  });

  test('a quiet room is named as having no live heartbeat', () => {
    const report = buildTournamentReconciliation(
      input({
        rooms: [
          room('quiet', 'Room Quiet', {
            lastActivityAt: new Date(NOW - 3 * HOUR).toISOString(),
          }),
        ],
      }),
      NOW,
    );
    expect(report.safeToClose).toBe(false);
    expect(report.blockers.some((blocker) => blocker.includes('Room Quiet (no live heartbeat)'))).toBe(true);
  });

  test('an unreadable sessions feed degrades to the plain assignment-out blocker', () => {
    const report = buildTournamentReconciliation(
      input({
        rooms: [room('mystery', 'Room Mystery')],
        heartbeatUnknown: true,
      }),
      NOW,
    );
    expect(report.safeToClose).toBe(false);
    const blocker = report.blockers.find((entry) => entry.includes('Room Mystery'));
    expect(blocker).toBeDefined();
    expect(blocker).not.toMatch(/heartbeat|mid-game|moments ago/);
  });

  test('unimported saves are named so YellowFruit import can finish them', () => {
    const report = buildTournamentReconciliation(
      input({
        relayFinals: [final('a')],
        local: [local('a', { importStatus: 'needs-import' })],
      }),
      NOW,
    );
    expect(report.safeToClose).toBe(false);
    expect(report.needsImport).toEqual(['a']);
  });
});
