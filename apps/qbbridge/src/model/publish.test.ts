/**
 * Publishing a round.
 *
 * The relay-facing facts this pins are the ones that would break a room rather than a screen: a
 * plaintext pairing code must never reach the mirror, its hash must, the assignment must land in
 * the right room, the revision must advance, and a room that is being given a new round must not
 * lose the room identity that lets a scorer reconnect.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { pairingCodeHash } from './pairing';
import { planRoomSetup, planRound, publicationReviewItems, publishRound } from './publish';
import {
  relayClaim,
  relayCheckScorerReadiness,
  relayFetchResults,
  RelayError,
  type RelayConnection,
} from './relay';
import { newRoom, pairingWarnings, roomTombstone, type Room } from './rooms';
import type { PlannedPairing } from './roundPlans';
import { loadedFixture } from '../tests/fixture';
import * as native from './native';

const connection: RelayConnection = {
  baseUrl: 'https://qbtcp-relay-test.workers.dev',
  tournamentId: 'bcdfghjkmnpqrstvwxyz2345',
  managementToken: 'management-secret',
};

interface Call {
  method: string;
  url: string;
  bearer?: string;
  body?: unknown;
}

function stubRelay(answer: (call: Call) => native.RelayResponse): Call[] {
  const calls: Call[] = [];
  vi.spyOn(native, 'relayRequest').mockImplementation(async (options) => {
    calls.push(options);
    return answer(options);
  });
  return calls;
}

/** The physical rooms. Deliberately carrying no matchup — that is the round plan's job now. */
function roomsFor(): Room[] {
  return [
    newRoom('room-1', 'Room 101', '48213906'),
    newRoom('room-2', 'Room 102', '19435077'),
    // Never given a matchup below: this room is cleared rather than omitted.
    newRoom('room-3', 'Room 103', '75038112'),
  ];
}

function teamId(name: string): string {
  return loadedFixture().teams.find((team) => team.name === name)!.id;
}

/** One round's planned pairings, as the Rooms screen would have saved them. */
function pairingsFor(): PlannedPairing[] {
  return [
    { roomId: 'room-1', leftTeamId: teamId('Cony'), rightTeamId: teamId('Deering') },
    { roomId: 'room-2', leftTeamId: teamId('Wells'), rightTeamId: teamId('Windham A') },
  ];
}

describe('planning a round', () => {
  test('covers every configured room, not only the ones playing', () => {
    const tournament = loadedFixture();
    const plan = planRound(tournament, tournament.rounds[3], roomsFor(), pairingsFor());

    // Room 103 has no matchup. It is still in the plan — as a room whose assignment is being
    // cleared — because a room left out of a mirror keeps whatever the relay last gave it.
    expect(plan.publications.map((entry) => entry.roomId)).toEqual(['room-1', 'room-2', 'room-3']);
    expect(plan.assignments.map((entry) => entry.roomId)).toEqual(['room-1', 'room-2']);
    expect(plan.cleared).toEqual([
      { roomId: 'room-3', roomName: 'Room 103', reason: 'No matchup chosen for this round.' },
    ]);
    // Each room's first publication is issue 1.
    expect(plan.assignments.map((entry) => entry.assignmentRevision)).toEqual([1, 1]);
    // Two rooms, two different games.
    expect(new Set(plan.assignments.map((entry) => entry.matchId)).size).toBe(2);
  });

  test('a team that is no longer in the file clears that room rather than leaving it alone', () => {
    const tournament = loadedFixture();
    const rooms = roomsFor();
    const pairings = pairingsFor();
    pairings[0] = { ...pairings[0], rightTeamId: 'Team_Deleted' };
    const plan = planRound(tournament, tournament.rounds[0], rooms, pairings);

    expect(plan.assignments.map((entry) => entry.roomId)).toEqual(['room-2']);
    // Not "skipped": skipping is what would leave Room 101 serving its previous game.
    expect(plan.cleared).toContainEqual({
      roomId: 'room-1',
      roomName: 'Room 101',
      reason: 'A team in this room is not in the loaded YellowFruit file. Reload the file.',
    });
    expect(plan.publications.find((entry) => entry.roomId === 'room-1')?.assignment).toBeNull();
  });

  test('a room with the same team on both sides is cleared, not published', () => {
    const tournament = loadedFixture();
    const rooms = roomsFor();
    const pairings = pairingsFor();
    pairings[0] = { ...pairings[0], rightTeamId: pairings[0].leftTeamId };
    const plan = planRound(tournament, tournament.rounds[0], rooms, pairings);
    expect(plan.assignments.map((entry) => entry.roomId)).toEqual(['room-2']);
    expect(plan.cleared.map((entry) => entry.reason)).toContain('Both sides of this room are the same team.');
  });

  test('reviews clears, duplicate teams, and duplicate room names without duplicate noise', () => {
    const tournament = loadedFixture();
    const rooms = roomsFor();
    rooms[1] = { ...rooms[1]!, name: rooms[0]!.name };
    const pairings: PlannedPairing[] = [
      { roomId: 'room-1', leftTeamId: teamId('Cony'), rightTeamId: teamId('Deering') },
      { roomId: 'room-2', leftTeamId: teamId('Cony'), rightTeamId: teamId('Wells') },
      { roomId: 'room-3', leftTeamId: teamId('Wells'), rightTeamId: teamId('Wells') },
    ];
    const plan = planRound(tournament, tournament.rounds[0]!, rooms, pairings);
    const teamName = (id: string) => tournament.teams.find((team) => team.id === id)?.name ?? id;
    const items = publicationReviewItems(
      plan,
      pairingWarnings(rooms, pairings, teamName),
      rooms,
      pairings,
      teamName,
    );

    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringMatching(/name.*used by 2 configured rooms/i) }),
        expect.objectContaining({ message: expect.stringMatching(/Cony.*multiple rooms/i) }),
        expect.objectContaining({ message: expect.stringMatching(/same team.*will be cleared/i) }),
      ]),
    );
    expect(items.filter((item) => /same team/i.test(item.message))).toHaveLength(1);
  });

  test('a duplicated room row publishes the entry the UI shows', () => {
    // Persistence removes duplicates before they arrive here, but an in-memory duplicate must
    // still read the same way in both places: the UI lookup takes the first match.
    const tournament = loadedFixture();
    const plan = planRound(tournament, tournament.rounds[3], roomsFor(), [
      { roomId: 'room-1', leftTeamId: teamId('Cony'), rightTeamId: teamId('Deering') },
      { roomId: 'room-1', leftTeamId: teamId('Wells'), rightTeamId: teamId('Windham A') },
    ]);
    const room1 = plan.assignments.find((entry) => entry.roomId === 'room-1')!;
    expect([room1.leftTeamName, room1.rightTeamName]).toEqual(['Cony', 'Deering']);
  });
});

describe('the mirror body', () => {
  beforeEach(() => vi.restoreAllMocks());

  test('carries hashed pairing codes, the right assignment per room, and the next revision', async () => {
    const calls = stubRelay(() => ({ status: 200, body: '{}' }));
    const tournament = loadedFixture();
    const rooms = roomsFor();
    const plan = planRound(tournament, tournament.rounds[3], rooms, pairingsFor());

    const outcome = await publishRound(connection, {
      epoch: 1,
      lastRevision: 6,
      tournamentName: tournament.name,
      plan,
      rooms,
    });

    expect(outcome.revision).toBe(7);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].url).toBe(
      'https://qbtcp-relay-test.workers.dev/qbtcp/v1/manage/tournaments/bcdfghjkmnpqrstvwxyz2345/mirror',
    );
    expect(calls[0].bearer).toBe('management-secret');

    const body = calls[0].body as {
      director_epoch: number;
      revision: number;
      rooms: Record<string, unknown>[];
      sessions: unknown[];
    };
    expect(body).toMatchObject({ director_epoch: 1, revision: 7 });
    expect(body.rooms.map((room) => room.room_id)).toEqual(['room-1', 'room-2', 'room-3']);

    // The plaintext code is nowhere in the bytes; its hash is on its own room.
    const text = JSON.stringify(body);
    expect(text).not.toContain('48213906');
    expect(text).not.toContain('19435077');
    expect(body.rooms[0].pairing_code_hash).toBe(await pairingCodeHash('48213906'));
    expect(body.rooms[1].pairing_code_hash).toBe(await pairingCodeHash('19435077'));
    expect(body.rooms[2].pairing_code_hash).toBe(await pairingCodeHash('75038112'));
    expect(String(body.rooms[0].pairing_code_hash)).toMatch(/^[0-9a-f]{64}$/);

    // The unused room is present with no game: the relay reads an absent `assignment_qbj` as an
    // explicit null and clears the column, which is what stops it serving a stale round.
    expect(body.rooms[2].assignment_qbj).toBeUndefined();
    expect(body.rooms[2].match_id).toBeUndefined();

    // The assignment in each playing room is that room's own game.
    for (const [index, assignment] of plan.assignments.entries()) {
      const room = body.rooms[index];
      expect(room.match_id).toBe(assignment.matchId);
      expect(room.assignment_revision).toBe(1);
      expect(JSON.stringify(room.assignment_qbj)).toContain(String(assignment.matchId));
    }
    expect(JSON.stringify(body.rooms[0].assignment_qbj)).not.toContain('Wells');

    // No session state is sent, so no scorer-created session is touched. Sending anything here
    // is how a round change would abandon a room's live game.
    expect(body.sessions).toEqual([]);
  });

  test('a room keeps its pairing hash when it is given the next round', async () => {
    const calls = stubRelay(() => ({ status: 200, body: '{}' }));
    const tournament = loadedFixture();
    const rooms = roomsFor();

    await publishRound(connection, {
      epoch: 1,
      lastRevision: 0,
      tournamentName: tournament.name,
      plan: planRound(tournament, tournament.rounds[3], rooms, pairingsFor()),
      rooms,
    });
    // Round five, same rooms, same codes, and each room keeps its identity.
    const nextRooms = rooms.map((room) => ({ ...room, assignmentRevision: 1 }));
    await publishRound(connection, {
      epoch: 1,
      lastRevision: 1,
      tournamentName: tournament.name,
      plan: planRound(tournament, tournament.rounds[4], nextRooms, pairingsFor()),
      rooms: nextRooms,
    });

    const first = (calls[0].body as { rooms: Record<string, unknown>[] }).rooms;
    const second = (calls[1].body as { rooms: Record<string, unknown>[] }).rooms;
    expect(second.map((room) => room.room_id)).toEqual(first.map((room) => room.room_id));
    // The relay replaces a listed room's columns wholesale, so restating the hash is what keeps
    // the QR on the wall working in round five.
    expect(second.map((room) => room.pairing_code_hash)).toEqual(first.map((room) => room.pairing_code_hash));
    // A new round is a new game and a new issue.
    expect(second.map((room) => room.match_id)).not.toEqual(first.map((room) => room.match_id));
    // Every room's issue advances, the cleared one included: a scorer still holding the old
    // assignment can tell it was superseded rather than merely left alone.
    expect(second.map((room) => room.assignment_revision)).toEqual([2, 2, 2]);
  });

  test('a stale publication is reported, not worked around', async () => {
    stubRelay(() => ({
      status: 409,
      body: JSON.stringify({ code: 'conflict', currentRevision: 12 }),
    }));
    const tournament = loadedFixture();
    const rooms = roomsFor();
    await expect(
      publishRound(connection, {
        epoch: 1,
        lastRevision: 3,
        tournamentName: tournament.name,
        plan: planRound(tournament, tournament.rounds[0], rooms, pairingsFor()),
        rooms,
      }),
    ).rejects.toThrow(/revision 12.*Nothing was sent to the rooms/);
  });

  test('a round with no matchups can publish a clear-only mirror', async () => {
    const calls = stubRelay(() => ({ status: 200, body: '{}' }));
    const tournament = loadedFixture();
    // No plan for this round at all, which is what an unpaired round looks like.
    const rooms = roomsFor();
    const outcome = await publishRound(connection, {
      epoch: 1,
      lastRevision: 0,
      tournamentName: tournament.name,
      plan: planRound(tournament, tournament.rounds[0], rooms, []),
      rooms,
    });
    expect(outcome).toMatchObject({
      revision: 1,
      assignments: [],
      clearedRoomIds: ['room-1', 'room-2', 'room-3'],
    });
    expect(calls).toHaveLength(1);
    const body = calls[0].body as { rooms: Record<string, unknown>[]; sessions: unknown[] };
    expect(body.rooms).toHaveLength(3);
    expect(body.rooms.every((room) => room.assignment_qbj === undefined && room.match_id === undefined)).toBe(
      true,
    );
    expect(body.rooms.every((room) => room.pairing_expires_at === undefined)).toBe(true);
    expect(body.sessions).toEqual([]);
  });

  test('a pending code is hashed only when its mirror is published', async () => {
    const calls = stubRelay(() => ({ status: 200, body: '{}' }));
    const tournament = loadedFixture();
    const [room] = roomsFor();
    const pending = '91374620';
    const setupRoom = { ...room, pendingPairingCode: pending };

    await publishRound(connection, {
      epoch: 1,
      lastRevision: 0,
      tournamentName: tournament.name,
      plan: planRoomSetup([setupRoom]),
      rooms: [setupRoom],
    });

    const mirrored = (calls[0].body as { rooms: Record<string, unknown>[] }).rooms[0];
    expect(mirrored.pairing_code_hash).toBe(await pairingCodeHash(pending));
    expect(mirrored.pairing_code_hash).not.toBe(await pairingCodeHash(room.pairingCode));
    expect(mirrored.pairing_expires_at).toBeUndefined();
  });

  test('a removed room is cleared with its active code, never its pending replacement', async () => {
    const calls = stubRelay(() => ({ status: 200, body: '{}' }));
    const tournament = loadedFixture();
    const room = { ...roomsFor()[0], assignmentRevision: 3, pendingPairingCode: '91374620' };
    const tombstone = roomTombstone(room);

    await publishRound(connection, {
      epoch: 1,
      lastRevision: 4,
      tournamentName: tournament.name,
      plan: planRoomSetup([], [tombstone]),
      rooms: [],
      tombstones: [tombstone],
    });

    const mirrored = (calls[0].body as { rooms: Record<string, unknown>[] }).rooms[0];
    expect(mirrored).toMatchObject({ room_id: room.id, name: room.name, assignment_revision: 4 });
    expect(mirrored.pairing_code_hash).toBe(await pairingCodeHash(room.pairingCode));
    expect(mirrored.pairing_code_hash).not.toBe(await pairingCodeHash('91374620'));
    expect(mirrored.assignment_qbj).toBeUndefined();
    expect(mirrored.match_id).toBeUndefined();
  });

  test('with no rooms at all there is nothing to publish', async () => {
    const calls = stubRelay(() => ({ status: 200, body: '{}' }));
    const tournament = loadedFixture();
    await expect(
      publishRound(connection, {
        epoch: 1,
        lastRevision: 0,
        tournamentName: tournament.name,
        plan: planRound(tournament, tournament.rounds[0], [], []),
        rooms: [],
      }),
    ).rejects.toThrow(/no rooms to publish/i);
    expect(calls).toEqual([]);
  });
});

describe('the other two relay calls', () => {
  beforeEach(() => vi.restoreAllMocks());

  test('claim exchanges a setup token for a management credential', async () => {
    const calls = stubRelay(() => ({
      status: 200,
      body: JSON.stringify({
        tournamentId: 'bcdfghjkmnpqrstvwxyz2345',
        managementToken: 'fresh-secret',
      }),
    }));
    const claimed = await relayClaim({
      baseUrl: 'https://qbtcp-relay-test.workers.dev/',
      tournamentId: 'bcdfghjkmnpqrstvwxyz2345',
      setupToken: 'one-time',
    });
    expect(claimed.managementToken).toBe('fresh-secret');
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://qbtcp-relay-test.workers.dev/qbtcp/v1/manage/claim',
      body: { setupToken: 'one-time', tournamentId: 'bcdfghjkmnpqrstvwxyz2345' },
    });
    // A claim carries no bearer: the setup token is the credential.
    expect(calls[0].bearer).toBeUndefined();
  });

  test('a refused claim becomes the relay’s own message', async () => {
    stubRelay(() => ({
      status: 403,
      body: JSON.stringify({ code: 'forbidden', message: 'This relay has already been claimed.' }),
    }));
    await expect(
      relayClaim({ baseUrl: 'https://r.example', tournamentId: 't', setupToken: 'x' }),
    ).rejects.toThrow('This relay has already been claimed.');
  });

  test('checks the fixed Scorer origin with the management credential and no browser-header escape hatch', async () => {
    const calls = stubRelay(() => ({
      status: 200,
      body: JSON.stringify({
        origin: 'https://qbsheet.com',
        canPair: true,
        state: 'ready',
        message: 'https://qbsheet.com can pair and use this relay.',
      }),
    }));

    await expect(relayCheckScorerReadiness(connection)).resolves.toMatchObject({
      origin: 'https://qbsheet.com',
      canPair: true,
      state: 'ready',
    });
    expect(calls[0]).toEqual({
      method: 'GET',
      url: 'https://qbtcp-relay-test.workers.dev/qbtcp/v1/manage/tournaments/bcdfghjkmnpqrstvwxyz2345/scorer-readiness',
      bearer: 'management-secret',
    });
    expect(JSON.stringify(calls[0])).not.toContain('*');
  });

  test('keeps a missing Scorer origin as a blocking readiness result', async () => {
    stubRelay(() => ({
      status: 200,
      body: JSON.stringify({
        origin: 'https://qbsheet.com',
        canPair: false,
        state: 'blocked',
        message: 'Add https://qbsheet.com to RELAY_ALLOWED_ORIGINS in the Cloudflare deployment.',
      }),
    }));

    await expect(relayCheckScorerReadiness(connection)).resolves.toEqual({
      origin: 'https://qbsheet.com',
      canPair: false,
      state: 'blocked',
      message: 'Add https://qbsheet.com to RELAY_ALLOWED_ORIGINS in the Cloudflare deployment.',
    });
  });

  test('results are read unacknowledged and never acknowledged', async () => {
    const calls = stubRelay(() => ({
      status: 200,
      body: JSON.stringify({
        results: [
          {
            result_id: 'res-1',
            room_id: 'room-1',
            match_id: 'qbbridge-match-1',
            fingerprint: 'abc',
            received_at: '2026-09-10T15:04:05Z',
            qbj: { version: '2.1.1', objects: [] },
          },
          // Refused: a row with no document is not a result.
          { result_id: 'res-2', room_id: 'room-2' },
        ],
      }),
    }));
    const results = await relayFetchResults(connection);
    expect(results.map((entry) => entry.resultId)).toEqual(['res-1']);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toContain('/results?state=unacked');
    expect(calls.some((call) => call.url.includes('acks'))).toBe(false);
  });

  test('an unreachable relay surfaces as a relay error rather than a silent empty page', async () => {
    stubRelay(() => ({ status: 503, body: 'gateway' }));
    await expect(relayFetchResults(connection)).rejects.toBeInstanceOf(RelayError);
  });
});

/**
 * The sequence that motivated the whole room-clearing change.
 *
 * Round 4 fills three rooms; round 5 needs only two. A publish that mentioned only the two would
 * leave Room 103 holding round 4's assignment, because the relay upserts and never deletes — and
 * the room would look entirely normal to the scorekeeper who opened it.
 */
describe('a room that is unused this round', () => {
  beforeEach(() => vi.restoreAllMocks());

  test('has its assignment cleared, keeps its pairing, and destroys no session state', async () => {
    const calls = stubRelay(() => ({ status: 200, body: '{}' }));
    const tournament = loadedFixture();
    const [cony, deering, wells, windham] = ['Cony', 'Deering', 'Wells', 'Windham A'].map(
      (name) => tournament.teams.find((team) => team.name === name)!.id,
    );

    // Three physical rooms, unchanged between the two rounds.
    const rooms: Room[] = [
      newRoom('room-1', 'Room 101', '48213906'),
      newRoom('room-2', 'Room 102', '19435077'),
      newRoom('room-3', 'Room 103', '75038112'),
    ];

    // Round 4: all three rooms playing.
    const roundFourPairings: PlannedPairing[] = [
      { roomId: 'room-1', leftTeamId: cony, rightTeamId: deering },
      { roomId: 'room-2', leftTeamId: wells, rightTeamId: windham },
      {
        roomId: 'room-3',
        leftTeamId: tournament.teams.find((team) => team.name === 'Plymouth A')!.id,
        rightTeamId: tournament.teams.find((team) => team.name === 'Plymouth B')!.id,
      },
    ];
    await publishRound(connection, {
      epoch: 1,
      lastRevision: 0,
      tournamentName: tournament.name,
      plan: planRound(tournament, tournament.rounds[3], rooms, roundFourPairings),
      rooms,
    });

    const roundFour = (calls[0].body as { rooms: Record<string, unknown>[] }).rooms;
    expect(roundFour).toHaveLength(3);
    expect(roundFour[2].assignment_qbj).toBeTruthy();

    // Round 5: the same physical rooms, but 103 sits out — round 5's plan simply has no entry
    // for it. Round 4's plan is untouched and still says 103 was playing.
    const roundFiveRooms: Room[] = rooms.map((room) => ({ ...room, assignmentRevision: 1 }));
    const roundFivePairings: PlannedPairing[] = [
      { roomId: 'room-1', leftTeamId: cony, rightTeamId: wells },
      { roomId: 'room-2', leftTeamId: deering, rightTeamId: windham },
    ];
    const outcome = await publishRound(connection, {
      epoch: 1,
      lastRevision: 1,
      tournamentName: tournament.name,
      plan: planRound(tournament, tournament.rounds[4], roundFiveRooms, roundFivePairings),
      rooms: roundFiveRooms,
    });

    // The round 4 plan is still exactly what it was: publishing round 5 read it not at all.
    expect(roundFourPairings.find((entry) => entry.roomId === 'room-3')).toBeTruthy();

    const roundFive = (calls[1].body as { rooms: Record<string, unknown>[]; sessions: unknown[] }).rooms;
    const unused = roundFive.find((room) => room.room_id === 'room-3')!;

    // Present, and explicitly holding no game.
    expect(unused).toBeTruthy();
    expect(unused.assignment_qbj).toBeUndefined();
    expect(unused.match_id).toBeUndefined();
    expect(outcome.clearedRoomIds).toEqual(['room-3']);

    // Everything that keeps the room identity valid survives.
    expect(unused.room_id).toBe('room-3');
    expect(unused.name).toBe('Room 103');
    expect(unused.pairing_code_hash).toBe(await pairingCodeHash('75038112'));

    // Round 4's game is nowhere in the round 5 payload.
    expect(JSON.stringify(roundFive)).not.toContain('Plymouth');

    // No session is named, so the relay touches none of them. A mirrored session here is how a
    // room change would abandon a game somebody is in the middle of scoring.
    expect((calls[1].body as { sessions: unknown[] }).sessions).toEqual([]);
  });
});
