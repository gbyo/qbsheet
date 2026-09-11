import { describe, expect, test } from 'vitest';
import { loadedFixture } from '../tests/fixture';
import { planRound } from './publish';
import type { Room } from './rooms';
import { buildEmergencyPack, packAuthorityWarnings } from './emergencyPacks';
import type { BridgeTournament } from './tournament';

function room(id: string, name: string): Room {
  return {
    id,
    name,
    pairingCode: 'code',
    pendingPairingCode: null,
    relayPublished: true,
    publishedMatchId: null,
    publishedRoundId: null,
    publishedAssignmentFingerprint: null,
    assignmentRevision: 1,
  };
}

function tournament(): BridgeTournament {
  return loadedFixture();
}

describe('emergency packs', () => {
  test('pack match ids equal live publication match ids for the same plan', () => {
    const loaded = tournament();
    const round = loaded.rounds[3]!;
    const rooms = [room('room-1', 'Room 101'), room('room-2', 'Room 102')];
    const plans = [
      {
        roundId: round.id,
        pairings: [
          { roomId: 'room-1', leftTeamId: loaded.teams[0]!.id, rightTeamId: loaded.teams[1]!.id },
          { roomId: 'room-2', leftTeamId: loaded.teams[2]!.id, rightTeamId: loaded.teams[3]!.id },
        ],
      },
    ];
    const built = buildEmergencyPack({
      tournament: loaded,
      rounds: loaded.rounds,
      startRoundId: round.id,
      roundCount: 1,
      rooms,
      plans,
      generatedAt: '2026-09-11T18:00:00Z',
      yftFingerprint: 'fp-1',
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    // The same plan through the live publish path must produce the same games.
    const live = planRound(loaded, round, rooms, plans[0]!.pairings, []);
    const liveByRoom = new Map(live.assignments.map((assignment) => [assignment.roomId, assignment]));
    const packFiles = built.pack.files.filter((file) => file.kind === 'assignment');
    expect(packFiles).toHaveLength(2);
    for (const file of packFiles) {
      expect(file.matchId).toBe(liveByRoom.get(file.roomId!)?.matchId);
    }

    const manifestFile = built.pack.files.find((file) => file.kind === 'manifest');
    expect(manifestFile?.fileName).toBe('PACK-MANIFEST.json');
    expect(manifestFile?.overwrite).toBe(true);
    const manifest = JSON.parse(manifestFile!.contents) as { yftFingerprint: string; rounds: unknown[] };
    expect(manifest.yftFingerprint).toBe('fp-1');
    expect(manifest.rounds).toHaveLength(1);
    const readme = built.pack.files.find((file) => file.kind === 'readme');
    expect(readme?.contents).toMatch(/TWO ACTIVE\s+WRITERS/);
  });

  test('empty rounds are skipped and listed, not packed', () => {
    const loaded = tournament();
    const first = loaded.rounds[0]!;
    const second = loaded.rounds[1]!;
    const rooms = [room('room-1', 'Room 101')];
    const plans = [
      {
        roundId: second.id,
        pairings: [{ roomId: 'room-1', leftTeamId: loaded.teams[0]!.id, rightTeamId: loaded.teams[1]!.id }],
      },
    ];
    const built = buildEmergencyPack({
      tournament: loaded,
      rounds: loaded.rounds,
      startRoundId: first.id,
      roundCount: 2,
      rooms,
      plans,
      generatedAt: '2026-09-11T18:00:00Z',
      yftFingerprint: null,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.pack.manifest.skippedRoundIds).toEqual([first.id]);
    expect(built.pack.manifest.totalAssignmentFiles).toBe(1);
  });

  test('no planned games at all is an error, not an empty pack', () => {
    const loaded = tournament();
    const built = buildEmergencyPack({
      tournament: loaded,
      rounds: loaded.rounds,
      startRoundId: loaded.rounds[0]!.id,
      roundCount: 2,
      rooms: [room('room-1', 'Room 101')],
      plans: [],
      generatedAt: '2026-09-11T18:00:00Z',
      yftFingerprint: null,
    });
    expect(built).toMatchObject({ ok: false });
  });

  test('live relay rooms raise authority warnings; quiet rooms stay quiet', () => {
    const loaded = tournament();
    const round = loaded.rounds[3]!;
    const liveRooms: Room[] = [
      { ...room('room-1', 'Room 101'), publishedMatchId: 'Match_live', publishedRoundId: round.id },
      room('room-2', 'Room 102'),
    ];
    const plans = [
      {
        roundId: round.id,
        pairings: [
          { roomId: 'room-1', leftTeamId: loaded.teams[0]!.id, rightTeamId: loaded.teams[1]!.id },
          { roomId: 'room-2', leftTeamId: loaded.teams[2]!.id, rightTeamId: loaded.teams[3]!.id },
        ],
      },
    ];
    const built = buildEmergencyPack({
      tournament: loaded,
      rounds: loaded.rounds,
      startRoundId: round.id,
      roundCount: 1,
      rooms: liveRooms,
      plans,
      generatedAt: '2026-09-11T18:00:00Z',
      yftFingerprint: 'fp-1',
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const warnings = packAuthorityWarnings({
      pack: built.pack,
      rooms: liveRooms,
      roundName: (roundId) => roundId,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Room 101.*two active writers/i);
  });
});
