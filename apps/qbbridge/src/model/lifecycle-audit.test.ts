import { describe, expect, test, vi } from 'vitest';
import {
  appendAuditEntry,
  loadAuditLog,
  maxAuditEntries,
  type AuditEntry,
  type AuditFieldValue,
} from './audit';
import {
  canFinish,
  canGoLive,
  canReopen,
  describeGuard,
  loadTournamentPhase,
  requiresOverride,
  saveTournamentPhase,
} from './lifecycle';

describe('audit log', () => {
  test('entries append with monotonic sequence numbers', () => {
    let log: AuditEntry[] = [];
    log = appendAuditEntry(log, 'room-created', { roomId: 'room-1' }, () => '2026-09-11T18:00:00Z').log;
    log = appendAuditEntry(log, 'room-removed', { roomId: 'room-1' }, () => '2026-09-11T18:01:00Z').log;
    expect(log.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(log[0]).toMatchObject({ action: 'room-created', fields: { roomId: 'room-1' } });
  });

  test('names never reach a detail, even when a caller passes them', () => {
    let log: AuditEntry[] = [];
    log = appendAuditEntry(
      log,
      'room-created',
      { roomId: 'room-1', room: 'Room 101' },
      () => '2026-09-11T18:00:00Z',
    ).log;
    log = appendAuditEntry(
      log,
      'yft-loaded',
      { tournamentId: 'Tournament_X', tournament: 'MEQBA Season Opener', teams: 12 },
      () => '2026-09-11T18:01:00Z',
    ).log;
    log = appendAuditEntry(
      log,
      'live-override',
      { action: 'remove-room', label: 'Remove room for Room 101' },
      () => '2026-09-11T18:02:00Z',
    ).log;
    expect(log[0]?.fields).toEqual({ roomId: 'room-1' });
    expect(log[1]?.fields).toEqual({ tournamentId: 'Tournament_X', teams: 12 });
    expect(log[2]?.fields).toEqual({ action: 'remove-room' });
    expect(JSON.stringify(log)).not.toMatch(/Room 101|Season Opener/);
  });

  test('non-scalar field values are stripped, not stored', () => {
    let log: AuditEntry[] = [];
    const hostile = { phase: 'live', blockers: 2, extra: { nested: true }, missing: undefined };
    log = appendAuditEntry(
      log,
      'lifecycle',
      hostile as unknown as Record<string, AuditFieldValue>,
      () => 't',
    ).log;
    expect(log[0]?.fields).toEqual({ phase: 'live', blockers: 2 });
  });

  test('the log trims oldest-first past the cap without reusing sequence numbers', () => {
    let log: AuditEntry[] = [{ seq: 41, at: 't', action: 'app-start', fields: {} }];
    for (let index = 0; index < maxAuditEntries; index += 1) {
      log = appendAuditEntry(log, 'relay-reachability', { reachable: true }, () => 't').log;
    }
    expect(log).toHaveLength(maxAuditEntries);
    expect(log[0]!.seq).toBeGreaterThan(41);
    const seqs = log.map((entry) => entry.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  test('hostile persisted shapes read as an empty log', () => {
    // The store shim is a plain object, not a DOM Storage: spy the instance the loader reads.
    const getItem = vi.spyOn(globalThis.localStorage, 'getItem');
    try {
      getItem.mockReturnValue('[{"seq":"1","at":1}]');
      expect(loadAuditLog()).toEqual([]);
      getItem.mockReturnValue('not json');
      expect(loadAuditLog()).toEqual([]);
      getItem.mockReturnValue('{"seq":1}');
      expect(loadAuditLog()).toEqual([]);
    } finally {
      getItem.mockRestore();
    }
  });

  test('broken sequence order rejects the whole persisted log', () => {
    const getItem = vi.spyOn(globalThis.localStorage, 'getItem');
    const entry = (seq: number): string => `{"seq":${seq},"at":"t","action":"app-start","fields":{}}`;
    try {
      // Decreasing, duplicate, fractional, and non-positive sequences all fork the next
      // sequence number, so none of them may load.
      getItem.mockReturnValue(`[${entry(2)},${entry(1)}]`);
      expect(loadAuditLog()).toEqual([]);
      getItem.mockReturnValue(`[${entry(1)},${entry(1)}]`);
      expect(loadAuditLog()).toEqual([]);
      getItem.mockReturnValue('[{"seq":1.5,"at":"t","action":"app-start","fields":{}}]');
      expect(loadAuditLog()).toEqual([]);
      getItem.mockReturnValue('[{"seq":0,"at":"t","action":"app-start","fields":{}}]');
      expect(loadAuditLog()).toEqual([]);
      // A clean log still loads, with stale keys sanitized to the current allowlist.
      getItem.mockReturnValue(
        `[{"seq":1,"at":"t","action":"room-created","fields":{"roomId":"room-1","room":"Room 101"}}]`,
      );
      expect(loadAuditLog()).toEqual([
        { seq: 1, at: 't', action: 'room-created', fields: { roomId: 'room-1' } },
      ]);
    } finally {
      getItem.mockRestore();
    }
  });

  test('a failed audit write reports instead of vanishing', () => {
    const setItem = vi.spyOn(globalThis.localStorage, 'setItem');
    try {
      setItem.mockImplementation(() => {
        throw new Error('storage unavailable');
      });
      expect(appendAuditEntry([], 'app-start', { version: 'x' }).persisted).toBe(false);
      setItem.mockRestore();
      expect(appendAuditEntry([], 'app-start', { version: 'x' }).persisted).toBe(true);
    } finally {
      setItem.mockRestore();
    }
  });
});

describe('tournament lifecycle', () => {
  test('setup runs free, live and finished require overrides', () => {
    expect(requiresOverride('setup', 'remove-room')).toBe(false);
    expect(requiresOverride('live', 'remove-room')).toBe(true);
    expect(requiresOverride('live', 'change-relay')).toBe(true);
    expect(requiresOverride('finished', 'reopen-tournament')).toBe(true);
  });

  test('transitions only move forward through the lifecycle', () => {
    expect(canGoLive('setup')).toBe(true);
    expect(canGoLive('live')).toBe(false);
    expect(canFinish('live')).toBe(true);
    expect(canFinish('setup')).toBe(false);
    expect(canReopen('finished')).toBe(true);
    expect(canReopen('live')).toBe(false);
  });

  test('guard descriptions name the subject and the consequence', () => {
    const guard = describeGuard('remove-room', 'Room 101');
    expect(guard.label).toMatch(/Room 101/);
    expect(guard.consequences.length).toBeGreaterThan(20);
  });

  test('unknown persisted phases read as setup', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    try {
      getItem.mockReturnValue('"archived"');
      expect(loadTournamentPhase()).toBe('setup');
      getItem.mockReturnValue(null);
      expect(loadTournamentPhase()).toBe('setup');
      saveTournamentPhase('live');
      expect(loadTournamentPhase()).toBe('live');
    } finally {
      getItem.mockRestore();
    }
  });
});
