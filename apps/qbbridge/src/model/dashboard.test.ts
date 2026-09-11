/**
 * Operations dashboard matrix (#1012): every attention rule, the silence rule, transport
 * labeling, quota/global strip, and the redaction boundary. Hostile operator names,
 * help messages, and player data are planted through the relay parsers and the builder
 * to prove none reach the rooms, the strip, or the diagnostics bundle.
 */

import { describe, expect, test } from 'vitest';
import {
  buildOperationsDashboard,
  type DashboardInput,
  type DashboardLedgerInput,
  type DashboardRoomInput,
} from './dashboard';
import { parseDirectorSessions, parseOpenHelp, type DirectorSession } from './relay';

const NOW = Date.parse('2026-09-11T18:00:00Z');
const MIN = 60 * 1000;

function iso(minutesAgo: number): string {
  return new Date(NOW - minutesAgo * MIN).toISOString();
}

function room(overrides: Partial<DashboardRoomInput> = {}): DashboardRoomInput {
  return {
    roomId: 'room-1',
    name: 'Room 101',
    status: 'waiting',
    publishedMatchId: 'match-1',
    relayPublished: true,
    ...overrides,
  };
}

function session(overrides: Partial<DirectorSession> = {}): DirectorSession {
  return {
    sessionId: 'sess-1',
    roomId: 'room-1',
    matchId: 'match-1',
    status: 'open',
    updatedAt: iso(2),
    progressSequence: 12,
    progressUpdatedAt: iso(2),
    results: [],
    presence: [{ updatedAt: iso(1), expiresAt: iso(-5) }],
    ...overrides,
  };
}

function input(overrides: Partial<DashboardInput> = {}): DashboardInput {
  return {
    nowMs: NOW,
    rooms: [room()],
    sessions: [session()],
    openHelp: [],
    ledger: [],
    relayConnected: true,
    relayReachable: true,
    health: null,
    operationsError: null,
    fetchedAt: iso(0),
    resultFolder: '/tmp/results',
    lastWriteAt: iso(10),
    tournament: { name: 'Fall Classic', teams: 12, rounds: 5 },
    timeline: [],
    bridgeVersion: '0.2.1',
    ...overrides,
  };
}

describe('room attention', () => {
  test('an actively scoring room is ok and names its session match', () => {
    const board = buildOperationsDashboard(input());
    expect(board.rooms[0].level).toBe('ok');
    expect(board.rooms[0].headline).toBe('Scoring now');
    expect(board.rooms[0].sessionMatchIds).toEqual(['match-1']);
    expect(board.rooms[0].sessionCount).toBe(1);
    expect(board.attentionCount).toBe(0);
  });

  test('a published room with no session is a watch, not an alarm', () => {
    const board = buildOperationsDashboard(input({ sessions: [] }));
    expect(board.rooms[0].level).toBe('watch');
    expect(board.rooms[0].headline).toBe('Published, no scorer session');
  });

  test('an offline scorer is a watch with its last seen time, never a device', () => {
    const board = buildOperationsDashboard(
      input({
        sessions: [
          session({
            presence: [{ updatedAt: iso(4), expiresAt: iso(1) }],
            updatedAt: iso(4),
          }),
        ],
      }),
    );
    expect(board.rooms[0].level).toBe('watch');
    expect(board.rooms[0].headline).toMatch(/Scorer offline/);
    expect(board.rooms[0].headline).toMatch(/4 min ago/);
    expect(board.rooms[0].headline).not.toMatch(/scorer-ipad/);
  });

  test('a live heartbeat for another game never reads as scoring now', () => {
    const board = buildOperationsDashboard(
      input({
        sessions: [
          session({
            sessionId: 'sess-stale',
            matchId: 'match-9',
            presence: [{ updatedAt: iso(0), expiresAt: iso(-5) }],
            updatedAt: iso(0),
          }),
        ],
      }),
    );
    expect(board.rooms[0].level).toBe('watch');
    expect(board.rooms[0].headline).toBe('Session for a different game');
    expect(board.rooms[0].headline).not.toBe('Scoring now');
    expect(board.rooms[0].detail).toMatch(/match-9/);
    expect(board.rooms[0].detail).toMatch(/match-1/);
  });

  test('a matching session alongside a stale one still reads as scoring now', () => {
    const board = buildOperationsDashboard(
      input({
        sessions: [
          session(),
          session({ sessionId: 'sess-old', matchId: 'match-9', status: 'abandoned', presence: [] }),
        ],
      }),
    );
    expect(board.rooms[0].level).toBe('ok');
    expect(board.rooms[0].headline).toBe('Scoring now');
    expect(board.rooms[0].sessionMatchIds).toEqual(['match-1', 'match-9']);
    expect(board.rooms[0].sessionCount).toBe(2);
  });

  test('an unsaved final and a pending ACK are attention', () => {
    const ledger: DashboardLedgerInput[] = [
      { resultId: 'res-1', matchId: 'match-1', saved: false, ackPending: false },
    ];
    expect(buildOperationsDashboard(input({ ledger })).rooms[0].headline).toBe('Final received, not saved');
    const acked: DashboardLedgerInput[] = [
      { resultId: 'res-1', matchId: 'match-1', saved: true, ackPending: true },
    ];
    const board = buildOperationsDashboard(input({ ledger: acked }));
    expect(board.rooms[0].level).toBe('attention');
    expect(board.rooms[0].headline).toBe('Saved, ACK pending');
    expect(board.attentionCount).toBe(1);
  });

  test('an open help request names its category', () => {
    const board = buildOperationsDashboard(
      input({
        openHelp: [
          { id: 'h-1', roomId: 'room-1', category: 'scoring', createdAt: iso(3), updatedAt: iso(3) },
        ],
      }),
    );
    expect(board.rooms[0].level).toBe('attention');
    expect(board.rooms[0].headline).toMatch(/scoring/);
  });

  test('a long-quiet open session reads as quiet, not broken', () => {
    const board = buildOperationsDashboard(
      input({
        sessions: [
          session({
            presence: [],
            updatedAt: iso(45),
            progressUpdatedAt: null,
            progressSequence: null,
          }),
        ],
      }),
    );
    // No heartbeat ever, but the session is stale: quiet wins over unpaired noise.
    expect(board.rooms[0].level).toBe('watch');
    expect(board.rooms[0].silent).toBe(true);
    expect(board.rooms[0].headline).toBe('Paired, no heartbeat yet');
  });

  test('an unreachable relay reads local-only on every room', () => {
    const board = buildOperationsDashboard(input({ relayReachable: false }));
    expect(board.rooms[0].transport).toBe('local-only');
    expect(board.global.reachable).toBe(false);
  });
});

describe('global strip and diagnostics', () => {
  const health = {
    tournamentId: 'tourney-1',
    directorEpoch: 3,
    revision: 9,
    activeController: 'primary' as const,
    authenticatedAs: 'primary' as const,
    controllerActive: true,
    backupProvisioned: true,
    backupControllerId: 'ctrl-2',
    backupControllerLabel: 'Backup laptop',
    protocolVersion: 1,
    lifecycle: 'live',
    storage: { results_unacked: 2, help_open: 1 },
    counters: { metered_requests_estimate: 4100, rows_written_estimate: 900 },
    budget: { measured: {} },
  };

  test('quota pressure and controller state are visible before they become outages', () => {
    const board = buildOperationsDashboard(input({ health }));
    expect(board.global.epoch).toBe(3);
    expect(board.global.quota?.meteredRequests).toBe(4100);
    expect(board.global.quota?.resultsUnacked).toBe(2);
    expect(board.global.backupProvisioned).toBe(true);
  });

  test('a failed operations fetch is explicit, not an empty screen', () => {
    const board = buildOperationsDashboard(
      input({ health: null, sessions: [], operationsError: 'dial tcp: no such host' }),
    );
    expect(board.global.operationsError).toMatch(/no such host/);
    expect(board.global.quota).toBeNull();
  });

  test('the diagnostics bundle carries facts, never secrets or names', () => {
    const hostileSessions = parseDirectorSessions(
      [
        {
          session_id: 'sess-1',
          room_id: 'room-1',
          match_id: 'match-1',
          status: 'open',
          writer_device: 'SECRET-DEVICE-MARKER',
          updated_at: iso(1),
          presence: [
            {
              device_id: 'SECRET-DEVICE-MARKER',
              operator_name: 'SECRET-OPERATOR-MARKER',
              updated_at: iso(1),
              expires_at: iso(-5),
            },
          ],
          results: [
            {
              result_id: 'res-1',
              match_id: 'match-1',
              received_at: iso(1),
              director_ack_at: 'SECRET-ACK-MARKER',
            },
          ],
        },
      ],
      200,
    );
    // Device identity and relay-side ack claims stop at the parse boundary.
    expect(hostileSessions[0]).not.toHaveProperty('writerDevice');
    expect(hostileSessions[0]?.presence[0]).not.toHaveProperty('deviceId');
    expect(hostileSessions[0]?.results[0]).not.toHaveProperty('acked');
    const hostileHelp = parseOpenHelp(
      [
        {
          id: 'h-1',
          room_id: 'room-1',
          category: 'scoring',
          message: 'SECRET-MESSAGE-MARKER player SECRET-PLAYER-MARKER',
          device_id: 'd',
          operator_name: 'SECRET-OPERATOR-MARKER',
          created_at: iso(1),
          updated_at: iso(1),
        },
      ],
      200,
    );
    const board = buildOperationsDashboard(input({ sessions: hostileSessions, openHelp: hostileHelp }));
    const text = JSON.stringify(board);
    expect(text).not.toMatch(/SECRET-OPERATOR-MARKER/);
    expect(text).not.toMatch(/SECRET-MESSAGE-MARKER/);
    expect(text).not.toMatch(/SECRET-PLAYER-MARKER/);
    // Device identity is dropped at the boundary: liveness without attribution.
    expect(text).not.toMatch(/SECRET-DEVICE-MARKER/);
    expect(text).not.toMatch(/SECRET-ACK-MARKER/);
  });

  test('a snapshot that stopped refreshing reads as stale, not current', () => {
    expect(buildOperationsDashboard(input()).global.snapshotStale).toBe(false);
    const stale = buildOperationsDashboard(input({ fetchedAt: iso(30) }));
    expect(stale.global.snapshotStale).toBe(true);
    const never = buildOperationsDashboard(input({ fetchedAt: null }));
    // No snapshot at all is "not yet", not stale.
    expect(never.global.snapshotStale).toBe(false);
  });
});
