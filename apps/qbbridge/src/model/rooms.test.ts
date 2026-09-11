/**
 * The pairing table's warnings, and only those.
 *
 * Everything checked here is something a person mistypes at 8am. Nothing checked here is a
 * tournament rule: a rematch, an unusual bracket and a carryover are all legal inputs, and
 * deciding otherwise is how a small utility becomes a scheduling engine.
 */

import { describe, expect, test } from 'vitest';
import { nextRoomId } from './identity';
import {
  newRoom,
  pairingWarnings,
  publishableRooms,
  resetRelayPublication,
  roomTombstone,
  type Room,
} from './rooms';

const name = (id: string) => id.replace('Team_', '');

function room(id: string, display: string, left: string | null, right: string | null): Room {
  return { ...newRoom(id, display, '11112222'), leftTeamId: left, rightTeamId: right };
}

describe('pairing warnings', () => {
  test('an empty room, a team against itself, a duplicate room name, a team in two rooms', () => {
    const rooms = [
      room('room-1', 'Room 101', 'Team_A', 'Team_B'),
      room('room-2', 'Room 101', 'Team_C', null),
      room('room-3', 'Room 103', 'Team_D', 'Team_D'),
      room('room-4', 'Room 104', 'Team_A', 'Team_E'),
    ];
    expect(pairingWarnings(rooms, name)).toEqual([
      { roomId: 'room-2', message: 'Another room is also called “Room 101”.' },
      { roomId: 'room-2', message: 'This room has no matchup yet.' },
      { roomId: 'room-3', message: 'Both sides are the same team.' },
      { roomId: 'room-4', message: 'A is also in another room this round.' },
    ]);
  });

  test('a complete, ordinary round warns about nothing', () => {
    const rooms = [
      room('room-1', 'Room 101', 'Team_A', 'Team_B'),
      room('room-2', 'Room 102', 'Team_C', 'Team_D'),
    ];
    expect(pairingWarnings(rooms, name)).toEqual([]);
  });

  test('a rematch is not a warning', () => {
    // The same two teams playing again is the operator's call, and YellowFruit validates it at
    // import if it matters.
    const rooms = [room('room-1', 'Room 101', 'Team_A', 'Team_B')];
    expect(pairingWarnings(rooms, name)).toEqual([]);
  });

  test('only rooms with two different teams are publishable', () => {
    const rooms = [
      room('room-1', 'Room 101', 'Team_A', 'Team_B'),
      room('room-2', 'Room 102', 'Team_C', null),
      room('room-3', 'Room 103', 'Team_D', 'Team_D'),
    ];
    expect(publishableRooms(rooms).map((entry) => entry.id)).toEqual(['room-1']);
  });
});

describe('room ids', () => {
  test('are stable and never collide with one already in use', () => {
    expect(nextRoomId([])).toBe('room-1');
    expect(nextRoomId([{ id: 'room-1' }])).toBe('room-2');
    // A removed middle room does not cause a reused id.
    expect(nextRoomId([{ id: 'room-1' }, { id: 'room-3' }])).toBe('room-4');
  });
});

describe('room publication identity', () => {
  test('new rooms are local-only and tombstones preserve the active code', () => {
    const room = newRoom('room-1', 'Room 101', '48213906');
    expect(room).toMatchObject({ pendingPairingCode: null, relayPublished: false });

    const tombstone = roomTombstone({
      ...room,
      pairingCode: '48213906',
      pendingPairingCode: '91374620',
      relayPublished: true,
      assignmentRevision: 3,
    });
    expect(tombstone).toEqual({
      id: 'room-1',
      name: 'Room 101',
      pairingCode: '48213906',
      pendingPairingCode: null,
      assignmentRevision: 3,
    });
  });

  test('changing relays preserves room setup but clears old relay facts', () => {
    const room = {
      ...newRoom('room-1', 'Room 101', '48213906'),
      leftTeamId: 'Team_A',
      rightTeamId: 'Team_B',
      relayPublished: true,
      publishedMatchId: 'match-1',
      publishedRoundId: 'round-4',
      assignmentRevision: 7,
    };
    expect(resetRelayPublication(room)).toEqual({
      ...room,
      relayPublished: false,
      publishedMatchId: null,
      publishedRoundId: null,
      assignmentRevision: 0,
    });
  });
});
