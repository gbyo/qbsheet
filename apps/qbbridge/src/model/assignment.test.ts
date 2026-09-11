/**
 * The assignment, and the only proof that matters for it: QBSheet's own parser opens the document
 * and produces a playable game without asking the scorekeeper anything.
 *
 * `readQbjSource` + `defineGame` are the exact functions the scorer runs on a QBTCP assignment.
 * Calling them here means a change that would make a room ask "which format is this?" fails in
 * CI rather than in a room.
 */

import { describe, expect, test } from 'vitest';
import { defineGame, readQbjSource } from '../../../../src/qbj/ParseQbjAssignment';
import { findSecretKeys } from '../../../../src/director/transfers/canonical';
import { loadedFixture, nonnumericRoundFixtureText, timedFixtureText } from '../tests/fixture';
import {
  assignmentFingerprint,
  buildAssignment,
  plannedAssignmentFingerprint,
  type PreparedAssignment,
} from './assignment';
import { loadYellowFruitTournament, type BridgeTournament } from './tournament';

function teamNamed(tournament: BridgeTournament, name: string) {
  const team = tournament.teams.find((entry) => entry.name === name);
  if (!team) throw new Error(`no team named ${name}`);
  return team;
}

function prepare(
  tournament = loadedFixture(),
  options: { roomId?: string; roomName?: string; left?: string; right?: string; roundIndex?: number } = {},
): PreparedAssignment {
  const round = tournament.rounds[options.roundIndex ?? 3];
  const built = buildAssignment({
    tournament,
    round,
    roomId: options.roomId ?? 'room-1',
    roomName: options.roomName ?? 'Room 101',
    left: teamNamed(tournament, options.left ?? 'Cony'),
    right: teamNamed(tournament, options.right ?? 'Deering'),
    assignmentRevision: 1,
  });
  if (!built.ok) throw new Error(built.error);
  return built.assignment;
}

function objectsOf(assignment: PreparedAssignment): Record<string, unknown>[] {
  return assignment.document.objects as Record<string, unknown>[];
}

describe('a one-game assignment', () => {
  test('contains exactly the game in front of the room', () => {
    const assignment = prepare();
    const objects = objectsOf(assignment);
    const types = objects.map((entry) => entry.type);

    expect(assignment.document.version).toBe('2.1.1');
    expect(types.filter((type) => type === 'Match')).toHaveLength(1);
    expect(types.filter((type) => type === 'Tournament')).toHaveLength(1);
    expect(types.filter((type) => type === 'ScoringRules')).toHaveLength(1);
    expect(types.filter((type) => type === 'Team')).toHaveLength(2);
    expect(types.filter((type) => type === 'Registration')).toHaveLength(2);

    // Only the two teams playing, with their own rosters and their own identifiers.
    const teams = objects.filter((entry) => entry.type === 'Team');
    expect(teams.map((team) => team.id).sort()).toEqual(['Team_Cony', 'Team_Deering']);
    const cony = teams.find((team) => team.id === 'Team_Cony') as Record<string, unknown>;
    expect((cony.players as { id: string }[]).map((player) => player.id)).toEqual([
      'Player_Jacoby Grotton_1000',
      'Player_Abigail Leger_1001',
      'Player_Charlotte McGuire_1002',
      'Player_Maddisin Mercier_1003',
      'Player_Cheyenne Trask_1004',
    ]);

    // One phase, one round, one match, and the round is the one from the file.
    const tournament = objects.find((entry) => entry.type === 'Tournament') as Record<string, unknown>;
    const phases = tournament.phases as Record<string, unknown>[];
    expect(phases).toHaveLength(1);
    const rounds = phases[0].rounds as Record<string, unknown>[];
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({ id: 'Phase_Prelims__round_4', name: '4', number: 4 });
    expect(rounds[0].matches).toEqual([{ $ref: assignment.matchId }]);

    // No other room's name appears anywhere in the bytes.
    const text = JSON.stringify(assignment.document);
    for (const other of ['Wells', 'Windham', 'Plymouth', 'Hebron']) {
      expect(text).not.toContain(other);
    }
  });

  test('is unplayed, and does not fake a zero result', () => {
    const objects = objectsOf(prepare());
    const match = objects.find((entry) => entry.type === 'Match') as Record<string, unknown>;
    expect(match.tossups_read).toBeUndefined();
    expect(match.match_questions).toBeUndefined();
    for (const side of match.match_teams as Record<string, unknown>[]) {
      expect(side.points).toBeUndefined();
      expect(Object.keys(side)).toEqual(['team']);
    }
  });

  test('carries no standings, no schedule and nothing credential-shaped', () => {
    const assignment = prepare();
    expect(findSecretKeys(assignment.document)).toEqual([]);
    const text = JSON.stringify(assignment.document);
    for (const forbidden of ['pairing', 'token', 'Authorization', 'workers.dev', 'standings', 'rank']) {
      expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  test('states the timed flag in the `_qbtcp` extension and invents no duration', () => {
    const untimed = objectsOf(prepare()).find((entry) => entry.type === 'Match') as Record<string, unknown>;
    expect(untimed._qbtcp).toMatchObject({
      version: 1,
      room_id: 'room-1',
      assignment_revision: 1,
      scorekeeper: { timed: false },
    });
    expect(JSON.stringify(untimed._qbtcp)).not.toMatch(/minute|duration|seconds/i);

    const timedReport = loadYellowFruitTournament(timedFixtureText());
    if (!timedReport.ok) throw new Error('timed fixture failed');
    const timed = objectsOf(prepare(timedReport.tournament)).find(
      (entry) => entry.type === 'Match',
    ) as Record<string, unknown>;
    expect((timed._qbtcp as { scorekeeper: { timed: boolean } }).scorekeeper.timed).toBe(true);
  });

  test('two teams from one school share their single registration', () => {
    const tournament = loadedFixture();
    const assignment = prepare(tournament, { left: 'Gould Academy A', right: 'Gould Academy B' });
    const registrations = objectsOf(assignment).filter((entry) => entry.type === 'Registration');
    expect(registrations).toHaveLength(1);
    expect(registrations[0].teams).toEqual([
      { $ref: 'Team_Gould Academy A' },
      { $ref: 'Team_Gould Academy B' },
    ]);
    // A third sibling team is not in this game and is not referenced by the registration.
    expect(JSON.stringify(assignment.document)).not.toContain('Gould Academy C');
  });

  test('a file that does not state timed produces no assignment rather than a guess', () => {
    const tournament = loadedFixture();
    const built = buildAssignment({
      tournament: { ...tournament, timed: null },
      round: tournament.rounds[0],
      roomId: 'room-1',
      roomName: 'Room 101',
      left: teamNamed(tournament, 'Cony'),
      right: teamNamed(tournament, 'Deering'),
      assignmentRevision: 1,
    });
    expect(built.ok).toBe(false);
  });

  test('uses YellowFruit numeric round identity when the display name is nonnumeric', () => {
    const report = loadYellowFruitTournament(nonnumericRoundFixtureText());
    if (!report.ok) throw new Error(`nonnumeric fixture failed: ${report.errors.join(' ')}`);
    const round = report.tournament.rounds[0];
    expect(round).toMatchObject({ displayName: 'Finals', number: 9, qbjName: '9' });

    const assignment = prepare(report.tournament, { roundIndex: 0 });
    expect(assignment.roundQbjName).toBe('9');
    const objects = objectsOf(assignment);
    const assignmentRound = (objects.find((entry) => entry.type === 'Tournament') as Record<string, unknown>)
      .phases as Record<string, unknown>[];
    const serializedRound = (assignmentRound[0]?.rounds as Record<string, unknown>[])[0];
    expect(serializedRound).toMatchObject({ name: '9', number: 9 });

    const source = readQbjSource(assignment.document);
    expect(source.ok).toBe(true);
    if (!source.ok) return;
    expect(source.value.candidates[0]).toMatchObject({ roundName: '9', roundNumber: 9 });
  });
});

describe('the scorer opens it without being asked anything', () => {
  test('QBSheet parses the assignment into a playable game', () => {
    const assignment = prepare();
    const source = readQbjSource(assignment.document);
    expect(source.ok).toBe(true);
    if (!source.ok) return;

    expect(source.value.candidates).toHaveLength(1);
    expect(source.value.candidates[0]).toMatchObject({
      matchId: assignment.matchId,
      roundName: '4',
      roundNumber: 4,
      location: 'Room 101',
      leftName: 'Cony',
      rightName: 'Deering',
      state: 'unplayed',
    });

    // No overrides: nothing is supplied that the document did not carry. A format the scorekeeper
    // would have had to choose makes this fail with `needsScoringRules`.
    const defined = defineGame(source.value, source.value.candidates[0].index);
    expect(defined.ok).toBe(true);
    if (!defined.ok) return;
    const definition = defined.definition;

    expect(definition.scorekeeperFormat.regulation).toEqual({
      timed: false,
      tossupCount: 20,
      maximumTossupCount: 20,
    });
    expect(definition.scorekeeperFormat.players.maximumActive).toBe(4);
    expect(definition.scorekeeperFormat.bonus).toMatchObject({
      enabled: true,
      regular: true,
      bounceBack: false,
      minimumParts: 3,
      maximumParts: 3,
      pointsPerPart: 10,
      maximumScore: 30,
      divisor: 10,
    });
    expect(definition.scorekeeperFormat.overtime).toMatchObject({
      minimumQuestionCount: 3,
      suddenDeath: false,
      includesBonuses: false,
    });
    expect(definition.scorekeeperFormat.lightning.enabled).toBe(false);
    expect(definition.scorekeeperFormat.totalDivisor).toBe(5);
    expect(
      definition.scorekeeperFormat.answerTypes.map((type) => [
        type.value,
        type.isPower,
        type.isNeg,
        type.awardsBonus,
      ]),
    ).toEqual([
      [15, true, false, true],
      [10, false, false, true],
      [-5, false, true, false],
    ]);

    // The rosters arrived, so nobody types names in the room.
    expect(definition.left.name).toBe('Cony');
    expect(definition.left.players.map((player) => player.name)).toContain('Jacoby Grotton');
    expect(definition.right.players).toHaveLength(3);

    // The identities the result will carry back.
    expect(definition.qbjIdentity).toMatchObject({
      tournamentId: 'Tournament_YellowFruit',
      matchId: assignment.matchId,
      phaseId: 'Phase_Prelims',
      roundId: 'Phase_Prelims__round_4',
      roundQbjName: '4',
      teamIds: { left: 'Team_Cony', right: 'Team_Deering' },
    });
    // The one thing the scorer had to fill in, and it is not a scoring value: stock YellowFruit
    // stores no room procedure, so none is sent and the scorer says it will enforce none. Nothing
    // about the format was assumed, which is the property this test exists for.
    expect(definition.assumptions ?? []).toEqual([
      'This QBJ does not include tournament procedure. Scoring works normally; the scoresheet will not enforce substitution, timeout or clock rules it has not been given.',
    ]);
  });

  test('a timed tournament reaches the scorer as timed', () => {
    const report = loadYellowFruitTournament(timedFixtureText());
    if (!report.ok) throw new Error('timed fixture failed');
    const source = readQbjSource(prepare(report.tournament).document);
    expect(source.ok).toBe(true);
    if (!source.ok) return;
    const defined = defineGame(source.value, source.value.candidates[0].index);
    expect(defined.ok).toBe(true);
    if (!defined.ok) return;
    expect(defined.definition.scorekeeperFormat.regulation).toEqual({
      timed: true,
      // YellowFruit's own getter: a timed round's regulation is its fixed default, and 24 is the
      // point at which regulation may not run longer.
      tossupCount: 20,
      maximumTossupCount: 24,
    });
  });
});

describe('the published-content fingerprint', () => {
  const fingerprintOf = (assignment: PreparedAssignment): string =>
    assignmentFingerprint(assignment.document);

  test('is stable for the same game and ignores the issue number', () => {
    const tournament = loadedFixture();
    const first = prepare(tournament);
    expect(fingerprintOf(prepare(tournament))).toBe(fingerprintOf(first));

    // Republishing the unchanged game moves only the revision, which is normalized away.
    const reissued = buildAssignment({
      tournament,
      round: tournament.rounds[3],
      roomId: 'room-1',
      roomName: 'Room 101',
      left: teamNamed(tournament, 'Cony'),
      right: teamNamed(tournament, 'Deering'),
      assignmentRevision: 4,
    });
    if (!reissued.ok) throw new Error(reissued.error);
    expect(fingerprintOf(reissued.assignment)).toBe(fingerprintOf(first));
  });

  test('moves with the room location', () => {
    const tournament = loadedFixture();
    expect(fingerprintOf(prepare(tournament, { roomName: 'Auditorium' }))).not.toBe(
      fingerprintOf(prepare(tournament)),
    );
  });

  test('moves with team, registration, and roster names', () => {
    const tournament = loadedFixture();
    const renamed = structuredClone(tournament);
    const cony = renamed.teams.find((team) => team.name === 'Cony')!;
    cony.name = 'Cony Renamed';
    cony.registrationName = 'Cony School Renamed';
    cony.players[0].name = 'Renamed Player';
    expect(fingerprintOf(prepare(renamed, { left: 'Cony Renamed' }))).not.toBe(
      fingerprintOf(prepare(tournament)),
    );
  });

  test('moves with scoring rules, tournament name, phase, and the timed flag', () => {
    const tournament = loadedFixture();
    const base = fingerprintOf(prepare(tournament));
    const rescored = prepare({
      ...tournament,
      rules: { ...tournament.rules, maximum_regulation_tossup_count: 24 },
    });
    expect(fingerprintOf(rescored)).not.toBe(base);
    expect(fingerprintOf(prepare({ ...tournament, name: 'A Different Tournament' }))).not.toBe(base);
    const round = tournament.rounds[3];
    const moved = structuredClone(tournament);
    moved.rounds[3] = { ...round, phaseName: 'Finals' };
    expect(fingerprintOf(prepare(moved))).not.toBe(base);
    expect(fingerprintOf(prepare({ ...tournament, timed: true }))).not.toBe(base);
  });

  test('moves when the matchup changes', () => {
    const tournament = loadedFixture();
    expect(fingerprintOf(prepare(tournament, { right: 'Wells' }))).not.toBe(
      fingerprintOf(prepare(tournament)),
    );
  });

  test('the planned fingerprint matches a fresh build and is null when unbuildable', () => {
    const tournament = loadedFixture();
    const round = tournament.rounds[3];
    const cony = teamNamed(tournament, 'Cony').id;
    const deering = teamNamed(tournament, 'Deering').id;
    expect(
      plannedAssignmentFingerprint({
        tournament,
        round,
        roomId: 'room-1',
        roomName: 'Room 101',
        pairing: { roomId: 'room-1', leftTeamId: cony, rightTeamId: deering },
      }),
    ).toBe(fingerprintOf(prepare(tournament)));

    const base = {
      tournament,
      round,
      roomId: 'room-1',
      roomName: 'Room 101',
    } as const;
    // Incomplete, mirrored, unknown-team, and unbuildable plans can never read as live.
    expect(
      plannedAssignmentFingerprint({
        ...base,
        pairing: { roomId: 'room-1', leftTeamId: cony, rightTeamId: null },
      }),
    ).toBeNull();
    expect(plannedAssignmentFingerprint({ ...base, pairing: undefined })).toBeNull();
    expect(
      plannedAssignmentFingerprint({
        ...base,
        pairing: { roomId: 'room-1', leftTeamId: cony, rightTeamId: cony },
      }),
    ).toBeNull();
    expect(
      plannedAssignmentFingerprint({
        ...base,
        pairing: { roomId: 'room-1', leftTeamId: cony, rightTeamId: 'Team_Deleted' },
      }),
    ).toBeNull();
    expect(
      plannedAssignmentFingerprint({
        ...base,
        tournament: { ...tournament, timed: null },
        pairing: { roomId: 'room-1', leftTeamId: cony, rightTeamId: deering },
      }),
    ).toBeNull();
  });
});

describe('match identity', () => {
  test('the same pairing keeps its identity; a different one does not get it', () => {
    const tournament = loadedFixture();
    const first = prepare(tournament);
    const again = prepare(tournament);
    expect(again.matchId).toBe(first.matchId);

    // Only the issue number moves when a round is republished unchanged.
    const reissued = buildAssignment({
      tournament,
      round: tournament.rounds[3],
      roomId: 'room-1',
      roomName: 'Room 101',
      left: teamNamed(tournament, 'Cony'),
      right: teamNamed(tournament, 'Deering'),
      assignmentRevision: 4,
    });
    expect(reissued.ok).toBe(true);
    if (!reissued.ok) return;
    expect(reissued.assignment.matchId).toBe(first.matchId);
    expect(reissued.assignment.assignmentRevision).toBe(4);

    const changes = [
      prepare(tournament, { right: 'Wells' }),
      prepare(tournament, { left: 'Deering', right: 'Cony' }),
      prepare(tournament, { roomId: 'room-2' }),
      prepare(tournament, { roundIndex: 4 }),
    ];
    for (const changed of changes) expect(changed.matchId).not.toBe(first.matchId);
    expect(new Set(changes.map((entry) => entry.matchId)).size).toBe(changes.length);
  });
});
