import { describe, expect, test, vi } from 'vitest';
import { appendAuditEntry, loadAuditLog, maxAuditEntries, type AuditEntry } from './audit';
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
    log = appendAuditEntry(log, 'room-created', { room: 'Room 101' }, () => '2026-09-11T18:00:00Z');
    log = appendAuditEntry(log, 'room-removed', { room: 'Room 101' }, () => '2026-09-11T18:01:00Z');
    expect(log.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(log[0]).toMatchObject({ action: 'room-created', fields: { room: 'Room 101' } });
  });

  test('the log trims oldest-first past the cap without reusing sequence numbers', () => {
    let log: AuditEntry[] = [{ seq: 41, at: 't', action: 'app-start', fields: {} }];
    for (let index = 0; index < maxAuditEntries; index += 1) {
      log = appendAuditEntry(log, 'relay-reachability', { reachable: true }, () => 't');
    }
    expect(log).toHaveLength(maxAuditEntries);
    expect(log[0].seq).toBeGreaterThan(41);
    const seqs = log.map((entry) => entry.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  test('hostile persisted shapes read as an empty log', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
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
