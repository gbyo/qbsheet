/**
 * Publishing a round.
 *
 * The relay-facing facts this pins are the ones that would break a room rather than a screen: a
 * plaintext pairing code must never reach the mirror, its hash must, the assignment must land in
 * the right room, the revision must advance, and a room that is being given a new round must not
 * lose the state that keeps it paired.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { pairingCodeHash } from './pairing';
import { planRound, publishRound } from './publish';
import { relayClaim, relayFetchResults, RelayError, type RelayConnection } from './relay';
import { newRoom, type Room } from './rooms';
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

function roomsFor(): Room[] {
  const tournament = loadedFixture();
  const cony = tournament.teams.find((team) => team.name === 'Cony')!;
  const deering = tournament.teams.find((team) => team.name === 'Deering')!;
  const wells = tournament.teams.find((team) => team.name === 'Wells')!;
  const windham = tournament.teams.find((team) => team.name === 'Windham A')!;
  return [
    { ...newRoom('room-1', 'Room 101', '48213906'), leftTeamId: cony.id, rightTeamId: deering.id },
    { ...newRoom('room-2', 'Room 102', '19435077'), leftTeamId: wells.id, rightTeamId: windham.id },
    // No matchup chosen: this room is simply not in the publication.
    newRoom('room-3', 'Room 103', '75038112'),
  ];
}

describe('planning a round', () => {
  test('builds one assignment per room with a matchup, and skips nothing silently', () => {
    const tournament = loadedFixture();
    const plan = planRound(tournament, tournament.rounds[3], roomsFor());
    expect(plan.assignments.map((entry) => entry.roomId)).toEqual(['room-1', 'room-2']);
    expect(plan.skipped).toEqual([]);
    // Each room's first publication is issue 1.
    expect(plan.assignments.map((entry) => entry.assignmentRevision)).toEqual([1, 1]);
    // Two rooms, two different games.
    expect(new Set(plan.assignments.map((entry) => entry.matchId)).size).toBe(2);
  });

  test('a team that is no longer in the file is reported rather than dropped', () => {
    const tournament = loadedFixture();
    const rooms = roomsFor();
    rooms[0] = { ...rooms[0], rightTeamId: 'Team_Deleted' };
    const plan = planRound(tournament, tournament.rounds[0], rooms);
    expect(plan.assignments.map((entry) => entry.roomId)).toEqual(['room-2']);
    expect(plan.skipped).toEqual([
      {
        roomId: 'room-1',
        roomName: 'Room 101',
        reason: 'A team in this room is not in the loaded YellowFruit file. Reload the file.',
      },
    ]);
  });
});

describe('the mirror body', () => {
  beforeEach(() => vi.restoreAllMocks());

  test('carries hashed pairing codes, the right assignment per room, and the next revision', async () => {
    const calls = stubRelay(() => ({ status: 200, body: '{}' }));
    const tournament = loadedFixture();
    const rooms = roomsFor();
    const plan = planRound(tournament, tournament.rounds[3], rooms);

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
    expect(body.rooms.map((room) => room.room_id)).toEqual(['room-1', 'room-2']);

    // The plaintext code is nowhere in the bytes; its hash is on its own room.
    const text = JSON.stringify(body);
    expect(text).not.toContain('48213906');
    expect(text).not.toContain('19435077');
    expect(body.rooms[0].pairing_code_hash).toBe(await pairingCodeHash('48213906'));
    expect(body.rooms[1].pairing_code_hash).toBe(await pairingCodeHash('19435077'));
    expect(String(body.rooms[0].pairing_code_hash)).toMatch(/^[0-9a-f]{64}$/);

    // The assignment in each room is that room's own game.
    for (const [index, room] of body.rooms.entries()) {
      expect(room.match_id).toBe(plan.assignments[index].matchId);
      expect(room.assignment_revision).toBe(1);
      expect(JSON.stringify(room.assignment_qbj)).toContain(String(plan.assignments[index].matchId));
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
      plan: planRound(tournament, tournament.rounds[3], rooms),
      rooms,
    });
    // Round five, same rooms, same codes, and each room keeps its identity.
    const nextRooms = rooms.map((room) => ({ ...room, assignmentRevision: 1 }));
    await publishRound(connection, {
      epoch: 1,
      lastRevision: 1,
      tournamentName: tournament.name,
      plan: planRound(tournament, tournament.rounds[4], nextRooms),
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
    expect(second.map((room) => room.assignment_revision)).toEqual([2, 2]);
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
        plan: planRound(tournament, tournament.rounds[0], rooms),
        rooms,
      }),
    ).rejects.toThrow(/revision 12.*Nothing was sent to the rooms/);
  });

  test('a round with no matchups is refused before anything is sent', async () => {
    const calls = stubRelay(() => ({ status: 200, body: '{}' }));
    const tournament = loadedFixture();
    await expect(
      publishRound(connection, {
        epoch: 1,
        lastRevision: 0,
        tournamentName: tournament.name,
        plan: { assignments: [], skipped: [] },
        rooms: [],
      }),
    ).rejects.toThrow(/no room/i);
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
