/**
 * Schema v9: room records stop being the sole home of per-round staffing.
 *
 * The contract these tests hold is that upgrading costs the director nothing. A tournament written
 * by an older build must open with equivalent operations already in place, historical rounds must
 * not gain assignments nobody recorded, and a tournament that never used rooms must migrate to
 * exactly nothing.
 */

import { describe, expect, test } from 'vitest';
import { directorSchemaVersion, emptyDirectorState, type DirectorState } from '../domain';
import { effectiveAssignmentForGame, roomDefaultEquipmentIds } from '../domain';
import { normalizeDirectorState } from './stateMigrations';

/** A v8 document: staffing lives on the room, equipment is a single field. */
function legacyDocument(): Record<string, unknown> {
  const base = emptyDirectorState() as unknown as Record<string, unknown>;
  base.schemaVersion = 8;
  base.staff = [
    { id: 'staff-alice', name: 'Alice Johnson', roles: ['moderator'], available: true },
    { id: 'staff-bob', name: 'Bob Smith', roles: ['scorekeeper'], available: true },
  ];
  base.equipment = [{ id: 'equipment-1', name: 'Buzzer 1', kind: 'buzzer', available: true }];
  base.rooms = [
    {
      id: 'room-201',
      name: 'Room 201',
      status: 'available',
      available: true,
      moderatorId: 'staff-alice',
      scorekeeperId: 'staff-bob',
      equipmentId: 'equipment-1',
    },
  ];
  base.rounds = [
    legacyRound('round-1', 1, 'closed'),
    legacyRound('round-2', 2, 'released'),
    legacyRound('round-3', 3, 'planned'),
  ];
  base.scheduledGames = [
    legacyGame('game-1', 'round-1', 'room-201', 'accepted'),
    legacyGame('game-2', 'round-2', 'room-201', 'released'),
    legacyGame('game-3', 'round-3', 'room-201', 'scheduled'),
  ];
  base.teams = [team('team-1', 'Aiken'), team('team-2', 'Lakeside')];
  return base;
}

function team(id: string, displayName: string) {
  return {
    id,
    organizationId: null,
    displayName,
    teamLetter: '',
    seed: null,
    status: 'confirmed',
    createdAt: '2026-09-09T09:00:00.000Z',
    updatedAt: '2026-09-09T09:00:00.000Z',
  };
}

function legacyRound(id: string, number: number, status: string) {
  return {
    id,
    phaseId: 'phase-1',
    name: `Round ${number}`,
    number,
    revision: 1,
    status,
    packetId: null,
    scheduledGameIds: [],
    dayOrder: number,
    scheduledStart: null,
    releasedAt: status === 'closed' || status === 'released' ? '2026-09-09T10:00:00.000Z' : null,
    startedAt: null,
    closedAt: status === 'closed' ? '2026-09-09T11:00:00.000Z' : null,
  };
}

function legacyGame(id: string, roundId: string, roomId: string | null, status: string) {
  return {
    id,
    roundId,
    roomId,
    packetId: null,
    leftTeamId: 'team-1',
    rightTeamId: 'team-2',
    bye: false,
    status,
    assignmentRevision: 1,
  };
}

describe('schema v9 migration', () => {
  test('upgrades to the current schema without losing the tournament', () => {
    const migrated = normalizeDirectorState(legacyDocument());
    expect(migrated.schemaVersion).toBe(directorSchemaVersion);
    expect(migrated.rooms).toHaveLength(1);
    expect(migrated.scheduledGames).toHaveLength(3);
  });

  test('materializes equivalent operational assignments from the legacy room configuration', () => {
    const migrated = normalizeDirectorState(legacyDocument());
    const planned = migrated.operationalAssignments.find((entry) => entry.scheduledGameId === 'game-3');
    expect(planned).toMatchObject({
      roundId: 'round-3',
      kind: 'room',
      roomId: 'room-201',
      moderatorId: 'staff-alice',
      scorekeeperId: 'staff-bob',
      equipmentIds: ['equipment-1'],
    });
  });

  test('leaves closed rounds alone rather than inventing operational history', () => {
    const migrated = normalizeDirectorState(legacyDocument());
    expect(migrated.operationalAssignments.some((entry) => entry.roundId === 'round-1')).toBe(false);
    // The historical game itself stays addressable and unchanged.
    expect(migrated.scheduledGames.find((game) => game.id === 'game-1')?.roomId).toBe('room-201');
  });

  test('pins the room, which the schedule named, but not the inherited staff and equipment', () => {
    const migrated = normalizeDirectorState(legacyDocument());
    const planned = migrated.operationalAssignments.find((entry) => entry.scheduledGameId === 'game-3');
    // Pinning inherited defaults would freeze every upgraded tournament out of auto-repair.
    expect(planned?.pinned).toEqual({ room: true });
  });

  test('turns the single legacy equipment field into a default list', () => {
    const migrated = normalizeDirectorState(legacyDocument());
    const room = migrated.rooms[0]!;
    expect(roomDefaultEquipmentIds(room)).toEqual(['equipment-1']);
    // The legacy field survives so an older build reading this document still sees a default.
    expect(room.equipmentId).toBe('equipment-1');
  });

  test('the migrated document derives the same operations the legacy one displayed', () => {
    const migrated = normalizeDirectorState(legacyDocument());
    const game = migrated.scheduledGames.find((entry) => entry.id === 'game-3')!;
    const effective = effectiveAssignmentForGame(migrated, game);
    expect(effective).toMatchObject({
      origin: 'explicit',
      roomId: 'room-201',
      moderatorId: 'staff-alice',
      scorekeeperId: 'staff-bob',
      equipmentIds: ['equipment-1'],
    });
  });

  test('a tournament that never used rooms migrates to no assignments and stays usable', () => {
    const legacy = legacyDocument();
    legacy.rooms = [];
    legacy.staff = [];
    legacy.equipment = [];
    legacy.scheduledGames = [
      legacyGame('game-1', 'round-1', null, 'accepted'),
      legacyGame('game-3', 'round-3', null, 'scheduled'),
    ];
    const migrated = normalizeDirectorState(legacy);
    expect(migrated.operationalAssignments).toEqual([]);
    const game = migrated.scheduledGames.find((entry) => entry.id === 'game-3')!;
    expect(effectiveAssignmentForGame(migrated, game)).toMatchObject({
      origin: 'inherited',
      roomId: null,
      moderatorId: null,
      scorekeeperId: null,
      equipmentIds: [],
    });
  });

  test('migrating twice is idempotent', () => {
    const once = normalizeDirectorState(legacyDocument());
    const twice = normalizeDirectorState(structuredClone(once) as unknown as Record<string, unknown>);
    expect(twice.operationalAssignments).toEqual(once.operationalAssignments);
  });

  test('assignments left behind by a deleted game are pruned on load', () => {
    const stale = emptyDirectorState() as unknown as Record<string, unknown>;
    stale.schemaVersion = directorSchemaVersion;
    stale.rounds = [legacyRound('round-1', 1, 'planned')];
    stale.operationalAssignments = [
      {
        id: 'assignment-orphan',
        roundId: 'round-1',
        kind: 'room',
        scheduledGameId: 'game-gone',
        roomId: 'room-201',
        equipmentIds: [],
      },
    ];
    // An assignment describes a plan, not a result, so a plan for a game that no longer exists is
    // not history worth keeping — and a stale record would shadow the correct inherited one.
    expect(normalizeDirectorState(stale).operationalAssignments).toEqual([]);
  });

  test('a malformed assignment record is dropped rather than repaired into a guess', () => {
    const document = emptyDirectorState() as unknown as Record<string, unknown>;
    document.schemaVersion = directorSchemaVersion;
    document.rounds = [legacyRound('round-1', 1, 'planned')];
    document.operationalAssignments = [{ kind: 'room', roomId: 'room-201' }, { id: 'x' }];
    expect(normalizeDirectorState(document).operationalAssignments).toEqual([]);
  });

  test('a runner duty survives the load with its roster intact', () => {
    const document = emptyDirectorState() as unknown as Record<string, unknown>;
    document.schemaVersion = directorSchemaVersion;
    document.rounds = [legacyRound('round-1', 1, 'planned')];
    document.operationalAssignments = [
      {
        id: 'duty-runner',
        roundId: 'round-1',
        kind: 'runner',
        staffIds: ['staff-cara'],
        equipmentIds: [],
      },
    ];
    const migrated: DirectorState = normalizeDirectorState(document);
    expect(migrated.operationalAssignments).toEqual([
      {
        id: 'duty-runner',
        roundId: 'round-1',
        kind: 'runner',
        scheduledGameId: null,
        roomId: null,
        moderatorId: null,
        scorekeeperId: null,
        staffIds: ['staff-cara'],
        equipmentIds: [],
      },
    ]);
  });
});
