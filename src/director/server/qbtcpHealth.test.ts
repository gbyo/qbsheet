import { afterEach, describe, expect, test, vi } from 'vitest';
import { nowChips } from '../app/DirectorApp';
import { tournamentState } from '../../../tests/directorFixtures';
import {
  applyQbtcpHealthUpdate,
  deriveQbtcpOperationalHealth,
  qbtcpPollIntervalMs,
  qbtcpStaleAfterMs,
  qbtcpHealthSummary,
} from './qbtcpHealth';

afterEach(() => {
  vi.useRealTimers();
});

describe('QBTCP operational health', () => {
  test('requires a recent successful snapshot before showing healthy', () => {
    vi.useFakeTimers();
    const now = new Date('2026-09-09T12:00:00.000Z');
    vi.setSystemTime(now);
    const health = deriveQbtcpOperationalHealth(
      { running: true, pairedRooms: 5 },
      { lastSuccessfulAt: new Date(now.getTime() - 2 * qbtcpPollIntervalMs).toISOString(), error: null },
    );

    expect(health).toMatchObject({ kind: 'healthy', pairedRooms: 5 });
    expect(qbtcpHealthSummary(health)).toBe('5 paired rooms');
  });

  test('reports snapshot errors even while the native process is running', () => {
    const health = deriveQbtcpOperationalHealth(
      { running: true, pairedRooms: 3 },
      { lastSuccessfulAt: '2026-09-09T11:59:59.000Z', error: 'snapshot unavailable' },
      Date.parse('2026-09-09T12:00:00.000Z'),
    );

    expect(health).toEqual({ kind: 'error', source: 'snapshot', message: 'snapshot unavailable' });
  });

  test('becomes stale only after the five-poll freshness budget', () => {
    const lastSuccessfulAt = '2026-09-09T12:00:00.000Z';
    const beforeThreshold = deriveQbtcpOperationalHealth(
      { running: true, pairedRooms: 1 },
      { lastSuccessfulAt, error: null },
      Date.parse(lastSuccessfulAt) + qbtcpStaleAfterMs - 1,
    );
    const atThreshold = deriveQbtcpOperationalHealth(
      { running: true, pairedRooms: 1 },
      { lastSuccessfulAt, error: null },
      Date.parse(lastSuccessfulAt) + qbtcpStaleAfterMs,
    );

    expect(beforeThreshold.kind).toBe('healthy');
    expect(atThreshold).toMatchObject({ kind: 'stale', ageMs: qbtcpStaleAfterMs });
  });

  test('a successful recovery clears an earlier error and stale state', () => {
    const now = Date.parse('2026-09-09T12:00:00.000Z');
    const failed = deriveQbtcpOperationalHealth(
      { running: true },
      { lastSuccessfulAt: '2026-09-09T11:59:00.000Z', error: 'read failed' },
      now,
    );
    const recovered = deriveQbtcpOperationalHealth(
      { running: true, pairedRooms: 2 },
      { lastSuccessfulAt: new Date(now).toISOString(), error: null },
      now,
    );

    expect(failed.kind).toBe('error');
    expect(recovered).toMatchObject({ kind: 'healthy', pairedRooms: 2 });
  });

  test('a stale failed poll cannot replace a newer successful poll', () => {
    const current = {
      sequence: 2,
      health: { lastSuccessfulAt: '2026-09-09T12:00:00.000Z', error: null },
    };
    const staleFailure = {
      sequence: 1,
      health: { lastSuccessfulAt: '2026-09-09T11:59:00.000Z', error: 'old read failed' },
    };

    expect(applyQbtcpHealthUpdate(current, staleFailure)).toBe(current);
  });

  test('normal stop is off even if the previous ingestion had an error', () => {
    expect(
      deriveQbtcpOperationalHealth(
        { running: false, message: 'QBTCP server stopped.' },
        { lastSuccessfulAt: null, error: 'the stopped server cannot be read' },
      ),
    ).toEqual({ kind: 'off' });
  });

  test('the global chip reflects ingestion health, routes to Rooms, and stays absent in browser mode', () => {
    const state = tournamentState();
    const navigate = vi.fn();
    const errorChips = nowChips(
      state,
      { kind: 'error', source: 'snapshot', message: 'snapshot unavailable' },
      true,
      navigate,
    );
    const qbtcpErrorChip = errorChips.find((chip) => chip.label === 'QBTCP sync error');
    expect(qbtcpErrorChip).toMatchObject({ label: 'QBTCP sync error', tone: 'danger' });
    qbtcpErrorChip?.onSelect?.();
    expect(navigate).toHaveBeenCalledWith('rooms');

    const healthyChip = nowChips(
      state,
      { kind: 'healthy', pairedRooms: 2, lastSuccessfulAt: '2026-09-09T12:00:00.000Z' },
      true,
      navigate,
    ).find((chip) => chip.label === '2 rooms paired');
    expect(healthyChip).toMatchObject({ label: '2 rooms paired', tone: 'success' });

    const staleChip = nowChips(
      state,
      {
        kind: 'stale',
        pairedRooms: 2,
        lastSuccessfulAt: '2026-09-09T11:59:00.000Z',
        ageMs: qbtcpStaleAfterMs,
      },
      true,
      navigate,
    ).find((chip) => chip.label === 'QBTCP sync delayed');
    expect(staleChip).toMatchObject({ label: 'QBTCP sync delayed', tone: 'warning' });

    expect(
      nowChips(
        state,
        { kind: 'healthy', pairedRooms: 2, lastSuccessfulAt: '2026-09-09T12:00:00.000Z' },
        false,
        navigate,
      ).find((chip) => String(chip.label).startsWith('QBTCP')),
    ).toBeUndefined();
  });
});
