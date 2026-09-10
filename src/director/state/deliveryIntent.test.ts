/**
 * Per-game delivery intent mutations for #702.
 *
 * Routing one scheduled game persists exactly that game's intent: siblings
 * keep deriving, later games in the same room are unaffected, assignment
 * content and transfer history are never rewritten, and corrupt input is
 * rejected without touching state.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import type { DirectorState, ScheduledGame } from '../domain';
import { MemoryDirectorRepository } from '../persistence';
import { scheduledGame, team, tournamentState } from '../../../tests/directorFixtures';
import { useDirectorController, type DirectorController } from './useDirectorController';
import { deriveAssignmentReadiness, deriveGameDeliveryIntent } from '../transfers/deliveryStatus';

type Hook = ReturnType<typeof renderHook<DirectorController, unknown>>;

function room(id: string, name: string): DirectorState['rooms'][number] {
  return { id, name, available: true, status: 'live' } as DirectorState['rooms'][number];
}

function mixedState(): DirectorState {
  const state = tournamentState();
  state.rounds[0]!.deliveryMode = 'qbtcp';
  state.teams.push(team('team-a', 'Aiken'), team('team-b', 'Dorman'));
  state.rooms.push(room('room-101', 'Room 101'), room('room-103', 'Room 103'));
  state.scheduledGames.push(
    scheduledGame('game-101', 'team-a', 'team-b', {
      roundId: 'round-1',
      roomId: 'room-101',
      status: 'released',
    }),
    scheduledGame('game-103', 'team-a', 'team-b', {
      roundId: 'round-1',
      roomId: 'room-103',
      status: 'released',
    }),
  );
  state.qbtcpSessions.push({
    roomId: 'room-101',
    sessionId: 'session-101',
    deviceId: 'device-101',
    state: 'live',
    lastSeenAt: '2026-09-12T12:00:00.000Z',
    progress: null,
    helpRequestId: null,
  });
  return state;
}

async function openController(
  state: DirectorState,
): Promise<{ hook: Hook; repository: MemoryDirectorRepository }> {
  const repository = new MemoryDirectorRepository();
  await repository.save(state);
  const hook = renderHook(() => useDirectorController(repository));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return { hook, repository };
}

function gameOf(hook: Hook, id: string): ScheduledGame {
  const game = hook.result.current.state.scheduledGames.find((entry) => entry.id === id);
  if (!game) throw new Error(`missing scheduled game ${id}`);
  return game;
}

describe('setGameDeliveryIntent (#702)', () => {
  test('routing one game leaves its siblings deriving', async () => {
    const { hook } = await openController(mixedState());
    await act(async () => {
      expect(hook.result.current.setGameDeliveryIntent('game-103', { primary: 'file', fallbacks: [] })).toBe(
        true,
      );
    });
    const state = hook.result.current.state;
    expect(gameOf(hook, 'game-103').deliveryIntent).toEqual({ primary: 'file', fallbacks: [] });
    expect(gameOf(hook, 'game-101').deliveryIntent).toBeUndefined();
    expect(deriveGameDeliveryIntent(state, gameOf(hook, 'game-101')).source).toBe('session');
    expect(deriveGameDeliveryIntent(state, gameOf(hook, 'game-103'))).toEqual({
      primary: 'file',
      fallbacks: [],
      source: 'explicit',
    });
  });

  test('a QBTCP game can take a file fallback without changing its primary', async () => {
    const { hook } = await openController(mixedState());
    await act(async () => {
      expect(
        hook.result.current.setGameDeliveryIntent('game-101', { primary: 'qbtcp', fallbacks: ['file'] }),
      ).toBe(true);
    });
    const state = hook.result.current.state;
    expect(deriveGameDeliveryIntent(state, gameOf(hook, 'game-101'))).toEqual({
      primary: 'qbtcp',
      fallbacks: ['file'],
      source: 'explicit',
    });
    expect(gameOf(hook, 'game-103').deliveryIntent).toBeUndefined();
  });

  test('clearing restores the derived route', async () => {
    const { hook } = await openController(mixedState());
    await act(async () => {
      expect(
        hook.result.current.setGameDeliveryIntent('game-103', { primary: 'manual', fallbacks: [] }),
      ).toBe(true);
    });
    expect(gameOf(hook, 'game-103').deliveryIntent).toEqual({ primary: 'manual', fallbacks: [] });
    await act(async () => {
      expect(hook.result.current.setGameDeliveryIntent('game-103', undefined)).toBe(true);
    });
    expect(gameOf(hook, 'game-103').deliveryIntent).toBeUndefined();
    expect(deriveGameDeliveryIntent(hook.result.current.state, gameOf(hook, 'game-103')).source).toBe(
      'round-default',
    );
  });

  test('corrupt intent is rejected without touching state', async () => {
    const { hook } = await openController(mixedState());
    await act(async () => {
      expect(
        hook.result.current.setGameDeliveryIntent('game-103', { primary: 'usb' } as unknown as {
          primary: 'file';
        }),
      ).toBe(false);
    });
    expect(gameOf(hook, 'game-103').deliveryIntent).toBeUndefined();
    expect(hook.result.current.error).toMatch(/delivery route/i);
  });

  test('routing records an audit entry and preserves assignment content', async () => {
    const { hook } = await openController(mixedState());
    const before = gameOf(hook, 'game-103').assignmentRevision;
    await act(async () => {
      expect(hook.result.current.setGameDeliveryIntent('game-103', { primary: 'file', fallbacks: [] })).toBe(
        true,
      );
    });
    expect(gameOf(hook, 'game-103').assignmentRevision).toBe(before);
    const audit = hook.result.current.state.audit.at(-1);
    expect(audit?.type).toBe('delivery-intent-changed');
    expect(audit?.entityId).toBe('game-103');
  });

  test('a later game in the same room derives independently', async () => {
    const { hook } = await openController(mixedState());
    await act(async () => {
      expect(hook.result.current.setGameDeliveryIntent('game-103', { primary: 'file', fallbacks: [] })).toBe(
        true,
      );
    });
    // The room reuses Room 103 next round with no explicit route: it follows
    // the derivation, not the prior game's intent.
    const later: ScheduledGame = scheduledGame('game-203', 'team-a', 'team-b', {
      roundId: 'round-1',
      roomId: 'room-103',
      status: 'released',
    });
    const derived = deriveGameDeliveryIntent(hook.result.current.state, later);
    expect(later.deliveryIntent).toBeUndefined();
    expect(derived.source).toBe('round-default');
  });

  test('a fallback file for one game leaves siblings and history intact', async () => {
    const { hook } = await openController(mixedState());
    const revision = gameOf(hook, 'game-103').assignmentRevision;
    const transfersBefore = hook.result.current.state.transfers.assignments.length;
    await act(async () => {
      hook.result.current.recordPreparedAssignments({
        report: {
          ok: true,
          written: [
            {
              assignment: {
                scheduledGameId: 'game-103',
                matchId: 'game-103',
                roundId: 'round-1',
                roundName: 'Round 1',
                roundNumber: 1,
                roundRevision: 1,
                assignmentRevision: revision,
                roomName: 'Room 103',
                roomId: 'room-103',
                leftTeamName: 'Aiken',
                rightTeamName: 'Dorman',
                fileName: 'game-103.qbj',
                text: '{}',
                document: {},
                warnings: [],
              },
              path: '/mnt/usb/game-103.qbj',
              fileName: 'game-103.qbj',
              digest: 'digest-103',
              byteLength: 2,
            },
          ],
          failures: [],
          skipped: [],
          warnings: [],
          rootPath: '/mnt/usb',
          message: 'written',
        },
        transportKind: 'removable-drive',
        destinationLabel: 'SanDisk Ultra',
      });
    });
    const state = hook.result.current.state;
    // Exactly one history record, for exactly this game.
    expect(state.transfers.assignments.length).toBe(transfersBefore + 1);
    expect(state.transfers.assignments.at(-1)?.scheduledGameId).toBe('game-103');
    // The QBTCP route is still down, but the current backup is named…
    const readiness = deriveAssignmentReadiness(state, gameOf(hook, 'game-103'));
    expect(readiness.state).toBe('problem');
    expect(readiness.backupCurrent).toBe(true);
    expect(readiness.message).toMatch(/backup/i);
    // …while the sibling still derives from its own evidence.
    expect(gameOf(hook, 'game-101').deliveryIntent).toBeUndefined();
    expect(deriveGameDeliveryIntent(state, gameOf(hook, 'game-101')).source).toBe('session');
  });
});
