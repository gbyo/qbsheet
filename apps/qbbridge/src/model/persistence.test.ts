/**
 * Reading state written by an older QBBridge.
 *
 * The v1 → v2 migration moved the matchup off the room and into a per-round plan. Everything else
 * in a live v1 state is something an operator cannot reconstruct on a tournament morning:
 *
 * * the **relay management credential**, which is exchanged once for a setup token that is then
 *   consumed — lose it and the recovery path is destroying the relay tournament and claiming again;
 * * the **active pairing codes**, which are printed on sheets taped to room doors and hashed on the
 *   relay, so a regenerated code locks every scorekeeper out;
 * * the **mirror revision**, which the relay fences on — a reset counter makes the next publish a
 *   stale-mirror refusal;
 * * **results**, with their saved paths and pending-ack bits, which are games.
 *
 * So the test below starts from a literal v1 JSON document rather than from something this build
 * constructed, and asserts field by field that all of it survives. A migration written against a
 * fixture the new code produced would prove only that the new code agrees with itself.
 */

import { beforeEach, describe, expect, test } from 'vitest';
import { loadedFixture } from '../tests/fixture';
import { currentStateVersion, loadState, saveState, storageKey } from './persistence';
import { planRound } from './publish';
import { pairingFor, pairingsForRound } from './roundPlans';

/**
 * A version 1 state as the shipped build wrote it.
 *
 * Copied shape-for-shape, including the `leftTeamId`/`rightTeamId` on the rooms that v2 does not
 * have. Do not regenerate this from current types: its value is that it is not current.
 */
const v1 = {
  version: 1,
  relay: {
    baseUrl: 'https://qbtcp-relay-spring.workers.dev',
    tournamentId: 'bcdfghjkmnpqrstvwxyz2345',
    managementToken: 'management-secret-do-not-lose',
    epoch: 1,
    revision: 7,
  },
  scorerReadiness: {
    status: 'ready',
    origin: 'https://qbsheet.com',
    message: 'https://qbsheet.com can pair and use this relay.',
    checkedAt: '2026-09-11T12:00:00.000Z',
  },
  yftPath: '/tournaments/spring.yft',
  tournamentName: 'Spring Invitational',
  rooms: [
    {
      id: 'room-1',
      name: 'Room 101',
      pairingCode: '48213906',
      pendingPairingCode: '99887766',
      leftTeamId: 'Team_Cony',
      rightTeamId: 'Team_Deering',
      relayPublished: true,
      publishedMatchId: 'qbbridge-match-abc123',
      publishedRoundId: 'Phase_Prelims__round_4',
      assignmentRevision: 3,
    },
    {
      id: 'room-2',
      name: 'Room 102',
      pairingCode: '19435077',
      pendingPairingCode: null,
      leftTeamId: 'Team_Wells',
      rightTeamId: null,
      relayPublished: true,
      publishedMatchId: null,
      publishedRoundId: null,
      assignmentRevision: 3,
    },
    {
      id: 'room-3',
      name: 'Room 103',
      pairingCode: '75038112',
      pendingPairingCode: null,
      leftTeamId: null,
      rightTeamId: null,
      relayPublished: false,
      publishedMatchId: null,
      publishedRoundId: null,
      assignmentRevision: 0,
    },
  ],
  pendingRoomRemovals: [
    {
      id: 'room-9',
      name: 'Room 109',
      pairingCode: '11223344',
      pendingPairingCode: null,
      assignmentRevision: 2,
    },
  ],
  retiredRoomIds: ['room-9'],
  selectedRoundId: 'Phase_Prelims__round_4',
  resultFolder: '/Users/operator/Documents/results',
  results: [
    {
      resultId: 'result-1',
      qbj: { type: 'Match', id: 'qbbridge-match-abc123' },
      receivedAt: '2026-09-11T12:30:00.000Z',
      savedPath: '/Users/operator/Documents/results/room-101.qbj',
      ackPending: true,
    },
    {
      resultId: 'result-2',
      qbj: { type: 'Match', id: 'qbbridge-match-def456' },
      receivedAt: '2026-09-11T12:40:00.000Z',
    },
  ],
};

function storeV1(overrides: Record<string, unknown> = {}): void {
  globalThis.localStorage.setItem(storageKey, JSON.stringify({ ...v1, ...overrides }));
}

describe('migrating a version 1 state', () => {
  beforeEach(() => globalThis.localStorage.clear());

  test('loses no relay credential, revision, or readiness', () => {
    storeV1();
    const state = loadState();
    expect(state.version).toBe(currentStateVersion);
    expect(state.relay).toEqual(v1.relay);
    // Named individually as well: a shallow object comparison that later drifts to a subset would
    // still pass, and the credential is the field that must never be the one dropped.
    expect(state.relay?.managementToken).toBe('management-secret-do-not-lose');
    expect(state.relay?.revision).toBe(7);
    expect(state.relay?.epoch).toBe(1);
    expect(state.scorerReadiness).toEqual(v1.scorerReadiness);
  });

  test('loses no file, folder, or selected round', () => {
    storeV1();
    const state = loadState();
    expect(state.yftPath).toBe('/tournaments/spring.yft');
    expect(state.tournamentName).toBe('Spring Invitational');
    expect(state.resultFolder).toBe('/Users/operator/Documents/results');
    expect(state.selectedRoundId).toBe('Phase_Prelims__round_4');
  });

  test('loses no physical room, pairing code, or publication fact', () => {
    storeV1();
    const rooms = loadState().rooms;
    expect(rooms.map((room) => room.id)).toEqual(['room-1', 'room-2', 'room-3']);
    expect(rooms[0]).toEqual({
      id: 'room-1',
      name: 'Room 101',
      pairingCode: '48213906',
      // A pending code is not active on the relay and must still be waiting to be published.
      pendingPairingCode: '99887766',
      relayPublished: true,
      publishedMatchId: 'qbbridge-match-abc123',
      publishedRoundId: 'Phase_Prelims__round_4',
      assignmentRevision: 3,
    });
    expect(rooms[1].relayPublished).toBe(true);
    expect(rooms[1].assignmentRevision).toBe(3);
    expect(rooms[2].pairingCode).toBe('75038112');
  });

  test('keeps the legacy matchup off the room entirely', () => {
    storeV1();
    for (const room of loadState().rooms) {
      // Not merely unread: absent. A stale matchup riding along under a type that says it does not
      // exist is the kind of thing that resurfaces as a published game two refactors later.
      expect(Object.keys(room)).not.toContain('leftTeamId');
      expect(Object.keys(room)).not.toContain('rightTeamId');
    }
  });

  test('loses no tombstone or retired room id', () => {
    storeV1();
    const state = loadState();
    expect(state.pendingRoomRemovals).toEqual(v1.pendingRoomRemovals);
    expect(state.retiredRoomIds).toEqual(['room-9']);
  });

  test('loses no result, saved path, or pending acknowledgment', () => {
    storeV1();
    const results = loadState().results;
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual(v1.results[0]);
    expect(results[0].savedPath).toBe('/Users/operator/Documents/results/room-101.qbj');
    expect(results[0].ackPending).toBe(true);
    expect(results[1].qbj).toEqual({ type: 'Match', id: 'qbbridge-match-def456' });
    expect(results[1].savedPath).toBeUndefined();
  });

  test('turns the rooms’ selections into the selected round’s plan', () => {
    storeV1();
    expect(loadState().roundPlans).toEqual([
      {
        roundId: 'Phase_Prelims__round_4',
        pairings: [
          { roomId: 'room-1', leftTeamId: 'Team_Cony', rightTeamId: 'Team_Deering' },
          // A half-entered room keeps the side it had.
          { roomId: 'room-2', leftTeamId: 'Team_Wells', rightTeamId: null },
        ],
      },
    ]);
  });

  test('attributes nothing when there is no round to attribute it to', () => {
    // Inventing a round — the file's first, say — would be guessing which round the operator was
    // about to publish, and the guess would be published as real assignments.
    storeV1({ selectedRoundId: null });
    expect(loadState().roundPlans).toEqual([]);
    expect(loadState().rooms).toHaveLength(3);
  });

  test('writes v2 from then on, under the same key', () => {
    storeV1();
    const migrated = loadState();
    expect(saveState(migrated).ok).toBe(true);
    const raw = JSON.parse(globalThis.localStorage.getItem(storageKey)!) as Record<string, unknown>;
    expect(raw.version).toBe(2);
    expect(raw.roundPlans).toHaveLength(1);
    // The key never moved, which is what makes the migration transparent rather than a silent
    // reset with the old value stranded beside it.
    expect(storageKey).toBe('qbbridge.state.v1');
    expect(loadState()).toEqual(migrated);
  });
});

describe('reading a version 2 state', () => {
  beforeEach(() => globalThis.localStorage.clear());

  test('restores the plans as written', () => {
    const state = {
      ...v1,
      version: 2,
      roundPlans: [
        {
          roundId: 'Phase_Prelims__round_1',
          pairings: [{ roomId: 'room-1', leftTeamId: 'Team_A', rightTeamId: 'Team_B' }],
        },
        {
          roundId: 'Phase_Prelims__round_2',
          pairings: [{ roomId: 'room-2', leftTeamId: 'Team_C', rightTeamId: null }],
        },
      ],
    };
    globalThis.localStorage.setItem(storageKey, JSON.stringify(state));
    expect(loadState().roundPlans).toEqual(state.roundPlans);
    // The v1 fields on the rooms are ignored rather than re-migrated over the real plans.
    expect(loadState().roundPlans).toHaveLength(2);
  });

  test('drops a stored pairing with nothing in it', () => {
    globalThis.localStorage.setItem(
      storageKey,
      JSON.stringify({
        ...v1,
        version: 2,
        roundPlans: [
          {
            roundId: 'Phase_Prelims__round_1',
            pairings: [
              { roomId: 'room-1', leftTeamId: null, rightTeamId: null },
              { roomId: 'room-2', leftTeamId: 'Team_C', rightTeamId: null },
            ],
          },
        ],
      }),
    );
    expect(loadState().roundPlans).toEqual([
      {
        roundId: 'Phase_Prelims__round_1',
        pairings: [{ roomId: 'room-2', leftTeamId: 'Team_C', rightTeamId: null }],
      },
    ]);
  });

  test('a version from the future is not guessed at', () => {
    globalThis.localStorage.setItem(storageKey, JSON.stringify({ ...v1, version: 3 }));
    expect(loadState().relay).toBeNull();
    expect(loadState().version).toBe(currentStateVersion);
  });

  test('conflicting duplicate rows cannot show one pairing while publishing another', () => {
    // The malformed plan shows A-vs-B in one row and C-vs-D in another for room-1. The UI reads
    // the first match and the publisher used to read the last, so restoring both would display
    // one game while sending the other.
    globalThis.localStorage.setItem(
      storageKey,
      JSON.stringify({
        ...v1,
        version: 2,
        roundPlans: [
          {
            roundId: 'Phase_Prelims__round_4',
            pairings: [
              { roomId: 'room-1', leftTeamId: 'Team_Cony', rightTeamId: 'Team_Deering' },
              { roomId: 'room-1', leftTeamId: 'Team_Wells', rightTeamId: 'Team_Windham A' },
              { roomId: 'room-2', leftTeamId: 'Team_Wells', rightTeamId: null },
            ],
          },
        ],
      }),
    );
    const state = loadState();
    // The conflicted room is unplanned rather than guessed at; the unambiguous row survives.
    expect(state.roundPlans).toEqual([
      {
        roundId: 'Phase_Prelims__round_4',
        pairings: [{ roomId: 'room-2', leftTeamId: 'Team_Wells', rightTeamId: null }],
      },
    ]);
    expect(pairingFor(state.roundPlans, 'Phase_Prelims__round_4', 'room-1')).toBeUndefined();

    // Publishing after the restore clears room-1 instead of sending a game the screen hides.
    const tournament = loadedFixture();
    const round = tournament.rounds.find((entry) => entry.id === 'Phase_Prelims__round_4')!;
    const plan = planRound(tournament, round, state.rooms, pairingsForRound(state.roundPlans, round.id));
    expect(plan.assignments.some((entry) => entry.roomId === 'room-1')).toBe(false);
    expect(plan.cleared.map((entry) => entry.roomId)).toContain('room-1');

    // Only the ambiguous plan data was discarded.
    expect(state.relay).toEqual(v1.relay);
    expect(state.rooms.map((room) => room.id)).toEqual(['room-1', 'room-2', 'room-3']);
    expect(state.rooms[0].pairingCode).toBe('48213906');
    expect(state.pendingRoomRemovals).toEqual(v1.pendingRoomRemovals);
    expect(state.results).toHaveLength(2);
  });

  test('duplicate round ids restore as one plan', () => {
    globalThis.localStorage.setItem(
      storageKey,
      JSON.stringify({
        ...v1,
        version: 2,
        roundPlans: [
          {
            roundId: 'Phase_Prelims__round_4',
            pairings: [{ roomId: 'room-1', leftTeamId: 'Team_Cony', rightTeamId: 'Team_Deering' }],
          },
          {
            roundId: 'Phase_Prelims__round_4',
            pairings: [
              // An exact repeat restores once rather than twice.
              { roomId: 'room-1', leftTeamId: 'Team_Cony', rightTeamId: 'Team_Deering' },
              { roomId: 'room-2', leftTeamId: 'Team_Wells', rightTeamId: 'Team_Windham A' },
            ],
          },
        ],
      }),
    );
    expect(loadState().roundPlans).toEqual([
      {
        roundId: 'Phase_Prelims__round_4',
        pairings: [
          { roomId: 'room-1', leftTeamId: 'Team_Cony', rightTeamId: 'Team_Deering' },
          { roomId: 'room-2', leftTeamId: 'Team_Wells', rightTeamId: 'Team_Windham A' },
        ],
      },
    ]);
  });

  test('a v1 state whose rooms share an id migrates to one pairing per room', () => {
    storeV1({ rooms: [...v1.rooms, { ...v1.rooms[0] }] });
    const state = loadState();
    expect(state.roundPlans).toHaveLength(1);
    expect(state.roundPlans[0].pairings.filter((entry) => entry.roomId === 'room-1')).toHaveLength(1);
  });
});
