/**
 * The round-plan model.
 *
 * Everything here is a pure function over ids, which is the point: the rules about what a plan is
 * and when it changes are worth stating once, in a place that needs no React, no relay and no
 * `.yft`. The integration suite then only has to prove the hook calls these, not re-derive them.
 */

import { describe, expect, test } from 'vitest';
import { pairingMatchId } from './identity';
import {
  assignedRoomCount,
  completePairingsFor,
  dedupeRoundPlans,
  isCompletePairing,
  pairingFor,
  pairingsByRoom,
  pairingsForRound,
  planForRound,
  planPublicationStatus,
  plannedMatchId,
  plannedTeams,
  reconcilePlans,
  reconciliationChangedAnything,
  removeRoomFromPlans,
  setPlannedSide,
  type RoundPlan,
} from './roundPlans';
import { newRoom, type Room } from './rooms';

const R1 = 'Phase_Prelims__round_1';
const R2 = 'Phase_Prelims__round_2';

function plans(): RoundPlan[] {
  return [
    {
      roundId: R1,
      pairings: [
        { roomId: 'room-1', leftTeamId: 'Team_A', rightTeamId: 'Team_B' },
        { roomId: 'room-2', leftTeamId: 'Team_C', rightTeamId: null },
      ],
    },
    { roundId: R2, pairings: [{ roomId: 'room-1', leftTeamId: 'Team_C', rightTeamId: 'Team_D' }] },
  ];
}

describe('looking a pairing up', () => {
  test('finds a round, a room, and the two sides', () => {
    expect(planForRound(plans(), R1)?.pairings).toHaveLength(2);
    expect(planForRound(plans(), 'Round_Absent')).toBeUndefined();
    expect(planForRound(plans(), null)).toBeUndefined();
    expect(pairingFor(plans(), R1, 'room-2')?.leftTeamId).toBe('Team_C');
    expect(plannedTeams(plans(), R2, 'room-1')).toEqual({
      leftTeamId: 'Team_C',
      rightTeamId: 'Team_D',
    });
  });

  test('an unplanned room reads as two nulls rather than as a missing object', () => {
    // Every caller wants to render two empty dropdowns, so the absence is normalized here once.
    expect(plannedTeams(plans(), R1, 'room-9')).toEqual({ leftTeamId: null, rightTeamId: null });
    expect(pairingsForRound(plans(), 'Round_Absent')).toEqual([]);
  });

  test('only two different teams count as a complete matchup', () => {
    expect(isCompletePairing({ roomId: 'r', leftTeamId: 'A', rightTeamId: 'B' })).toBe(true);
    expect(isCompletePairing({ roomId: 'r', leftTeamId: 'A', rightTeamId: 'A' })).toBe(false);
    expect(isCompletePairing({ roomId: 'r', leftTeamId: 'A', rightTeamId: null })).toBe(false);
    expect(isCompletePairing(undefined)).toBe(false);
    expect(assignedRoomCount(plans(), R1)).toBe(1);
    expect(assignedRoomCount(plans(), R2)).toBe(1);
    expect(assignedRoomCount(plans(), 'Round_Absent')).toBe(0);
  });
});

describe('editing one round', () => {
  test('touches no other round', () => {
    const next = setPlannedSide(plans(), R1, 'room-1', 'left', 'Team_Z');
    expect(pairingFor(next, R1, 'room-1')?.leftTeamId).toBe('Team_Z');
    // The whole reason the model exists.
    expect(planForRound(next, R2)).toEqual(planForRound(plans(), R2));
  });

  test('creates the round and the room on first use', () => {
    const next = setPlannedSide([], 'Round_New', 'room-4', 'right', 'Team_Q');
    expect(next).toEqual([
      { roundId: 'Round_New', pairings: [{ roomId: 'room-4', leftTeamId: null, rightTeamId: 'Team_Q' }] },
    ]);
  });

  test('clearing the last side deletes the entry, and then the round', () => {
    // Sparse in both directions: "is anything planned here" stays a question about existence
    // rather than about a row of nulls.
    const one = setPlannedSide([], R1, 'room-1', 'left', 'Team_A');
    expect(pairingsForRound(one, R1)).toHaveLength(1);
    const none = setPlannedSide(one, R1, 'room-1', 'left', null);
    expect(none).toEqual([]);
  });

  test('clearing one of two sides keeps the entry', () => {
    const next = setPlannedSide(plans(), R1, 'room-1', 'right', null);
    expect(pairingFor(next, R1, 'room-1')).toEqual({
      roomId: 'room-1',
      leftTeamId: 'Team_A',
      rightTeamId: null,
    });
  });

  test('a plan keeps its position in the list rather than moving to the end', () => {
    // The array is persisted; a list that reshuffles on every keystroke makes every saved state a
    // different string for the same meaning.
    const next = setPlannedSide(plans(), R1, 'room-1', 'left', 'Team_Z');
    expect(next.map((plan) => plan.roundId)).toEqual([R1, R2]);
  });

  test('the input is never mutated', () => {
    const before = plans();
    setPlannedSide(before, R1, 'room-1', 'left', 'Team_Z');
    expect(before).toEqual(plans());
  });
});

describe('removing a room', () => {
  test('drops it from every round and forgets a round left empty', () => {
    const next = removeRoomFromPlans(plans(), 'room-1');
    expect(pairingFor(next, R1, 'room-1')).toBeUndefined();
    expect(pairingFor(next, R1, 'room-2')?.leftTeamId).toBe('Team_C');
    // Round 2 planned only that room, so it has nothing left to be.
    expect(planForRound(next, R2)).toBeUndefined();
  });
});

describe('reconciling against a reloaded file', () => {
  const known = (overrides?: {
    rounds?: string[];
    rooms?: string[];
    teams?: string[];
  }): { roundIds: Set<string>; roomIds: Set<string>; teamIds: Set<string> } => ({
    roundIds: new Set(overrides?.rounds ?? [R1, R2]),
    roomIds: new Set(overrides?.rooms ?? ['room-1', 'room-2']),
    teamIds: new Set(overrides?.teams ?? ['Team_A', 'Team_B', 'Team_C', 'Team_D']),
  });

  test('an unchanged file changes nothing and says so', () => {
    const report = reconcilePlans(plans(), known());
    expect(report.plans).toEqual(plans());
    expect(reconciliationChangedAnything(report)).toBe(false);
  });

  test('a removed round loses only that round', () => {
    const report = reconcilePlans(plans(), known({ rounds: [R1] }));
    expect(report.removedRoundIds).toEqual([R2]);
    expect(report.plans.map((plan) => plan.roundId)).toEqual([R1]);
    expect(planForRound(report.plans, R1)).toEqual(planForRound(plans(), R1));
  });

  test('a removed team clears only that side', () => {
    const report = reconcilePlans(plans(), known({ teams: ['Team_A', 'Team_C', 'Team_D'] }));
    expect(pairingFor(report.plans, R1, 'room-1')).toEqual({
      roomId: 'room-1',
      leftTeamId: 'Team_A',
      rightTeamId: null,
    });
    expect(report.clearedSideCount).toBe(1);
    expect(report.removedPairingCount).toBe(0);
    expect(reconciliationChangedAnything(report)).toBe(true);
  });

  test('a pairing whose every side is gone is deleted, and counted once', () => {
    const report = reconcilePlans(plans(), known({ teams: ['Team_C', 'Team_D'] }));
    expect(pairingFor(report.plans, R1, 'room-1')).toBeUndefined();
    expect(report.removedPairingCount).toBe(1);
    expect(report.clearedSideCount).toBe(2);
    // Round 2 referenced only surviving teams.
    expect(planForRound(report.plans, R2)).toEqual(planForRound(plans(), R2));
  });

  test('a removed room is dropped from every round it appears in', () => {
    const report = reconcilePlans(plans(), known({ rooms: ['room-2'] }));
    expect(report.removedRoomIds).toEqual(['room-1']);
    expect(planForRound(report.plans, R2)).toBeUndefined();
    expect(pairingFor(report.plans, R1, 'room-2')?.leftTeamId).toBe('Team_C');
  });

  test('identity is never repaired by name, label, or position', () => {
    // A renamed team keeps its id and survives; a team whose id changed is a different team and
    // its side is cleared. Guessing between those two is how two teams get sent to a game nobody
    // scheduled, so the model does not offer the option.
    const renamedButSameId = reconcilePlans(plans(), known());
    expect(renamedButSameId.clearedSideCount).toBe(0);
    const sameNameNewId = reconcilePlans(
      plans(),
      known({ teams: ['Team_A_v2', 'Team_B', 'Team_C', 'Team_D'] }),
    );
    expect(pairingFor(sameNameNewId.plans, R1, 'room-1')?.leftTeamId).toBeNull();
  });
});

describe('planned versus live', () => {
  const tournamentId = 'Tournament_1';
  const room = (overrides: Partial<Room> = {}): Room => ({
    ...newRoom('room-1', 'Room 101', '11112222'),
    ...overrides,
  });
  const pairing = { roomId: 'room-1', leftTeamId: 'Team_A', rightTeamId: 'Team_B' };
  const liveMatchId = pairingMatchId({
    tournamentId,
    roundId: R1,
    roomId: 'room-1',
    leftTeamId: 'Team_A',
    rightTeamId: 'Team_B',
  });

  test('derives the id a planned pairing would publish under', () => {
    expect(plannedMatchId({ tournamentId, roundId: R1, pairing })).toBe(liveMatchId);
    expect(
      plannedMatchId({
        tournamentId,
        roundId: R1,
        pairing: { roomId: 'room-1', leftTeamId: 'Team_A', rightTeamId: null },
      }),
    ).toBeNull();
  });

  test('nothing planned and nothing published', () => {
    expect(planPublicationStatus({ tournamentId, roundId: R1, room: room(), pairing: undefined })).toBe(
      'no-game',
    );
  });

  test('planned but never sent', () => {
    expect(planPublicationStatus({ tournamentId, roundId: R1, room: room(), pairing })).toBe('planned');
  });

  test('exactly what the relay is serving', () => {
    expect(
      planPublicationStatus({
        tournamentId,
        roundId: R1,
        room: room({ publishedRoundId: R1, publishedMatchId: liveMatchId }),
        pairing,
      }),
    ).toBe('live');
  });

  test('published, then edited', () => {
    expect(
      planPublicationStatus({
        tournamentId,
        roundId: R1,
        room: room({ publishedRoundId: R1, publishedMatchId: liveMatchId }),
        pairing: { roomId: 'room-1', leftTeamId: 'Team_A', rightTeamId: 'Team_C' },
      }),
    ).toBe('edited');
  });

  test('published, then emptied, still reads as edited rather than as nothing planned', () => {
    // The relay is serving a game for this round that the plan no longer wants. Reporting
    // "no game" would hide a live assignment.
    expect(
      planPublicationStatus({
        tournamentId,
        roundId: R1,
        room: room({ publishedRoundId: R1, publishedMatchId: liveMatchId }),
        pairing: undefined,
      }),
    ).toBe('edited');
  });

  test('a future round never inherits the live round’s publication', () => {
    // The bug this exists to prevent: while round 1 is live, the room-level status is `waiting`
    // for every room, and the operator entering round 2 would otherwise be told round 2 was
    // already published.
    expect(
      planPublicationStatus({
        tournamentId,
        roundId: R2,
        room: room({ publishedRoundId: R1, publishedMatchId: liveMatchId }),
        pairing: { roomId: 'room-1', leftTeamId: 'Team_C', rightTeamId: 'Team_D' },
      }),
    ).toBe('other-round');
    expect(
      planPublicationStatus({
        tournamentId,
        roundId: R2,
        room: room({ publishedRoundId: R1, publishedMatchId: liveMatchId }),
        pairing: undefined,
      }),
    ).toBe('other-round');
  });
});

describe('the canonical plan shape', () => {
  test('exact duplicate rows collapse to one', () => {
    const doubled: RoundPlan[] = [
      {
        roundId: R1,
        pairings: [
          { roomId: 'room-1', leftTeamId: 'Team_A', rightTeamId: 'Team_B' },
          { roomId: 'room-1', leftTeamId: 'Team_A', rightTeamId: 'Team_B' },
        ],
      },
    ];
    expect(dedupeRoundPlans(doubled)).toEqual([
      { roundId: R1, pairings: [{ roomId: 'room-1', leftTeamId: 'Team_A', rightTeamId: 'Team_B' }] },
    ]);
  });

  test('conflicting rows for one room leave that room unplanned, never guessed', () => {
    // The persisted plan shows A-vs-B in one row and C-vs-D in another for the same room.
    // Choosing either would be choosing a game the operator may not have meant, so the room
    // keeps no pairing at all — and every consumer then agrees it has none.
    const conflicted: RoundPlan[] = [
      {
        roundId: R1,
        pairings: [
          { roomId: 'room-1', leftTeamId: 'Team_A', rightTeamId: 'Team_B' },
          { roomId: 'room-1', leftTeamId: 'Team_C', rightTeamId: 'Team_D' },
          { roomId: 'room-2', leftTeamId: 'Team_C', rightTeamId: 'Team_D' },
        ],
      },
    ];
    expect(dedupeRoundPlans(conflicted)).toEqual([
      { roundId: R1, pairings: [{ roomId: 'room-2', leftTeamId: 'Team_C', rightTeamId: 'Team_D' }] },
    ]);
  });

  test('a conflict that empties a round drops the round', () => {
    const conflicted: RoundPlan[] = [
      {
        roundId: R1,
        pairings: [
          { roomId: 'room-1', leftTeamId: 'Team_A', rightTeamId: 'Team_B' },
          { roomId: 'room-1', leftTeamId: 'Team_C', rightTeamId: 'Team_D' },
        ],
      },
    ];
    expect(dedupeRoundPlans(conflicted)).toEqual([]);
  });

  test('duplicate round ids merge into one plan under the same per-room rule', () => {
    const doubled: RoundPlan[] = [
      { roundId: R1, pairings: [{ roomId: 'room-1', leftTeamId: 'Team_A', rightTeamId: 'Team_B' }] },
      { roundId: R1, pairings: [{ roomId: 'room-2', leftTeamId: 'Team_C', rightTeamId: 'Team_D' }] },
      { roundId: R2, pairings: [{ roomId: 'room-1', leftTeamId: 'Team_C', rightTeamId: 'Team_D' }] },
    ];
    expect(dedupeRoundPlans(doubled)).toEqual([
      {
        roundId: R1,
        pairings: [
          { roomId: 'room-1', leftTeamId: 'Team_A', rightTeamId: 'Team_B' },
          { roomId: 'room-2', leftTeamId: 'Team_C', rightTeamId: 'Team_D' },
        ],
      },
      { roundId: R2, pairings: [{ roomId: 'room-1', leftTeamId: 'Team_C', rightTeamId: 'Team_D' }] },
    ]);
  });

  test('a room conflicted across duplicate round ids is dropped while the rest merges', () => {
    const doubled: RoundPlan[] = [
      { roundId: R1, pairings: [{ roomId: 'room-1', leftTeamId: 'Team_A', rightTeamId: 'Team_B' }] },
      {
        roundId: R1,
        pairings: [
          { roomId: 'room-1', leftTeamId: 'Team_C', rightTeamId: 'Team_D' },
          { roomId: 'room-2', leftTeamId: 'Team_C', rightTeamId: 'Team_D' },
        ],
      },
    ];
    expect(dedupeRoundPlans(doubled)).toEqual([
      { roundId: R1, pairings: [{ roomId: 'room-2', leftTeamId: 'Team_C', rightTeamId: 'Team_D' }] },
    ]);
  });

  test('empty rows never survive canonicalization', () => {
    const sparse: RoundPlan[] = [
      {
        roundId: R1,
        pairings: [
          { roomId: 'room-1', leftTeamId: null, rightTeamId: null },
          { roomId: 'room-2', leftTeamId: 'Team_C', rightTeamId: null },
        ],
      },
    ];
    expect(dedupeRoundPlans(sparse)).toEqual([
      { roundId: R1, pairings: [{ roomId: 'room-2', leftTeamId: 'Team_C', rightTeamId: null }] },
    ]);
  });

  test('a plan without duplicates is returned unchanged', () => {
    expect(dedupeRoundPlans(plans())).toEqual(plans());
  });

  test('the room index keeps the first entry, like the UI lookup does', () => {
    const pairings = [
      { roomId: 'room-1', leftTeamId: 'Team_A', rightTeamId: 'Team_B' },
      { roomId: 'room-1', leftTeamId: 'Team_C', rightTeamId: 'Team_D' },
    ];
    expect(pairingsByRoom(pairings).get('room-1')).toEqual(pairings[0]);
  });
});

describe('the input a publish is built from', () => {
  test('is the complete pairings of one round, in the configured rooms’ order', () => {
    const rooms = [newRoom('room-2', 'B', '1'), newRoom('room-1', 'A', '2')];
    expect(completePairingsFor(plans(), R1, rooms)).toEqual([
      { roomId: 'room-1', leftTeamId: 'Team_A', rightTeamId: 'Team_B' },
    ]);
    expect(completePairingsFor(plans(), 'Round_Absent', rooms)).toEqual([]);
  });
});
