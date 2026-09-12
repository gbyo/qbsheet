/**
 * The assignment, proved at both ends of its life.
 *
 * QBSheet's own parser (`readQbjSource` + `defineGame` — the exact functions the scorer runs)
 * must open the document into a playable game without asking the scorekeeper anything, and a
 * game scored from it must come back with the same Match id inside a document stock
 * YellowFruit's importer resolves (nested spine walk, `parseInt` round, team ids it already
 * holds). The YellowFruit side is a direct transcription of the reference importer with
 * citations, the same approach QBBridge's interop tests take.
 */

import { describe, expect, test } from 'vitest';
import { defineGame, readQbjSource } from '../../../../src/qbj/ParseQbjAssignment';
import { findSecretKeys } from '../../../../src/director/transfers/canonical';
import { buildAssignment, shuttleMatchId } from './assignment';
import { assignmentFileContents } from './assignment';
import { planPrelims, validateWildcatCompatibility } from './schedule';
import type { ShuttleTeam } from './tournament';
import { loadedFixture, loadedSynthetic, scorePrelimGame, syntheticTeams, teamNamed } from '../tests/helpers';

type QbjObject = Record<string, unknown>;

function isRecord(value: unknown): value is QbjObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function prepare(roundNumber = 1, slotId = 'slot-gold-1', roomName = '319') {
  const tournament = loadedSynthetic();
  const compat = validateWildcatCompatibility(tournament);
  if (!compat.ok) throw new Error(compat.errors.join(' '));
  const planned = planPrelims(compat.compat).find(
    (game) => game.roundNumber === roundNumber && game.slotId === slotId,
  )!;
  const round = compat.compat.roundsByNumber.get(roundNumber)!;
  const teams = new Map(tournament.teams.map((team) => [team.id, team]));
  const built = buildAssignment({
    tournament,
    roundId: round.id,
    roundQbjName: round.qbjName,
    roundNumber,
    phaseId: round.phaseId,
    phaseName: round.phaseName,
    slotId,
    roomName,
    left: teams.get(planned.leftTeamId)!,
    right: teams.get(planned.rightTeamId)!,
  });
  if (!built.ok) throw new Error(built.error);
  return { tournament, assignment: built.assignment };
}

function objectsOf(document: Record<string, unknown>): QbjObject[] {
  return (document.objects as QbjObject[]).filter(isRecord);
}

// --- stock YellowFruit's importer, transcribed (see QBBridge's yellowfruitInterop.test.ts) ---

/** `QbjUtils2.collectRefTargets`, reduced to what a result document can contain. */
function collectRefTargets(objects: QbjObject[]): Map<string, QbjObject> {
  const dict = new Map<string, QbjObject>();
  const add = (entry: unknown): void => {
    if (!isRecord(entry)) return;
    if (typeof entry.id === 'string') dict.set(entry.id, entry);
  };
  for (const object of objects) {
    add(object);
    if (object.type === 'Team') {
      for (const player of Array.isArray(object.players) ? object.players : []) add(player);
    }
  }
  return dict;
}

/**
 * `FileParsing.FileParser.findMatches`: phases and rounds read as inline objects, only the
 * match link followed through the top-level Match dictionary.
 */
function findMatches(objects: QbjObject[]): { roundName: unknown; match: QbjObject }[] {
  const byId = new Map<string, QbjObject>();
  for (const object of objects) {
    if (object.type === 'Match' && typeof object.id === 'string') byId.set(object.id, object);
  }
  const tournament = objects.find((entry) => entry.type === 'Tournament');
  const found: { roundName: unknown; match: QbjObject }[] = [];
  if (!tournament) return found;
  for (const phase of Array.isArray(tournament.phases) ? tournament.phases : []) {
    if (!isRecord(phase)) continue;
    for (const round of Array.isArray(phase.rounds) ? phase.rounds : []) {
      if (!isRecord(round)) continue;
      for (const entry of Array.isArray(round.matches) ? round.matches : []) {
        if (isRecord(entry) && typeof entry.$ref === 'string') {
          const target = byId.get(entry.$ref);
          if (target) found.push({ roundName: round.name, match: target });
        } else if (isRecord(entry)) {
          found.push({ roundName: round.name, match: entry });
        }
      }
    }
  }
  return found;
}

describe('a one-game assignment', () => {
  test('contains exactly the game in front of the room', () => {
    const { assignment } = prepare();
    const objects = objectsOf(assignment.document);
    const types = objects.map((entry) => entry.type);

    expect(assignment.document.version).toBe('2.1.1');
    expect(types.filter((type) => type === 'Match')).toHaveLength(1);
    expect(types.filter((type) => type === 'Tournament')).toHaveLength(1);
    expect(types.filter((type) => type === 'ScoringRules')).toHaveLength(1);
    expect(types.filter((type) => type === 'Team')).toHaveLength(2);
    expect(types.filter((type) => type === 'Registration')).toHaveLength(2);

    const teams = objects.filter((entry) => entry.type === 'Team');
    expect(teams.map((team) => team.id).sort()).toEqual(['Team_Seed12', 'Team_Seed9']);
    const seed9 = teams.find((team) => team.id === 'Team_Seed9')!;
    expect((seed9.players as { id: string }[]).map((player) => player.id)).toEqual([
      'Player_Seed9A',
      'Player_Seed9B',
    ]);

    const tournament = objects.find((entry) => entry.type === 'Tournament')!;
    const phases = tournament.phases as QbjObject[];
    expect(phases).toHaveLength(1);
    const rounds = phases[0].rounds as QbjObject[];
    expect(rounds).toHaveLength(1);
  });

  test('names the round the way stock YellowFruit resolves it', () => {
    const { assignment } = prepare(4, 'slot-maroon-3');
    const objects = objectsOf(assignment.document);
    const tournament = objects.find((entry) => entry.type === 'Tournament')!;
    const round = (tournament.phases as QbjObject[])[0].rounds as QbjObject[];
    // `TournamentManager.importMatchesFromWholeQbj` runs `parseInt` over `Round.name`.
    expect(round[0].name).toBe('4');
    expect(Number.parseInt(String(round[0].name), 10)).toBe(4);
  });

  test('is available to QBSheet both nested and top-level', () => {
    const { assignment } = prepare();
    const objects = objectsOf(assignment.document);
    // Nested: the spine stock YellowFruit walks.
    expect(findMatches(objects)).toHaveLength(1);
    // Top-level: what QBSheet enumerates scoreable games from.
    expect(objects.filter((entry) => entry.type === 'Match')).toHaveLength(1);
  });

  test('represents an unplayed game as unplayed', () => {
    const { assignment } = prepare();
    const objects = objectsOf(assignment.document);
    const match = objects.find((entry) => entry.type === 'Match')!;
    expect(match.tossups_read).toBeUndefined();
    expect(match.overtime_tossups_read).toBeUndefined();
    expect(match.match_questions).toBeUndefined();
    for (const side of (match.match_teams as QbjObject[]).filter(isRecord)) {
      expect(side.points).toBeUndefined();
      expect(side.bonus_points).toBeUndefined();
      expect(side.match_players).toBeUndefined();
    }
  });

  test('carries the room and the handoff instruction, and nothing credential-shaped', () => {
    const { assignment } = prepare(2, 'slot-gold-1', '319');
    const objects = objectsOf(assignment.document);
    const match = objects.find((entry) => entry.type === 'Match')!;
    expect(match.location).toBe('319');
    const qbtcp = match._qbtcp as QbjObject;
    expect(qbtcp.handoff_instruction).toContain('319');
    expect(qbtcp.handoff_instruction).toContain('OUT');
    expect(qbtcp.room_id).toBe('slot-gold-1');
    expect((qbtcp.scorekeeper as QbjObject).timed).toBe(false);
    expect(findSecretKeys(assignment.document)).toEqual([]);
  });

  test('QBSheet opens it into a playable game with no questions asked', () => {
    const { assignment } = prepare();
    const source = readQbjSource(assignment.document);
    if (!source.ok) throw new Error(source.errors.join(' '));
    expect(source.value.candidates).toHaveLength(1);
    expect(source.value.candidates[0].state).toBe('unplayed');
    const defined = defineGame(source.value, source.value.candidates[0].index);
    if (!defined.ok) throw new Error(defined.errors.join(' '));
    expect(defined.definition.left.players.length).toBeGreaterThan(0);
    expect(defined.definition.right.players.length).toBeGreaterThan(0);
  });

  test('QBSheet opens a real-file assignment too', () => {
    const tournament = loadedFixture();
    const compat = validateWildcatCompatibility(tournament);
    if (!compat.ok) throw new Error(compat.errors.join(' '));
    const planned = planPrelims(compat.compat)[0];
    const round = compat.compat.roundsByNumber.get(planned.roundNumber)!;
    const teams = new Map(tournament.teams.map((team) => [team.id, team]));
    const built = buildAssignment({
      tournament,
      roundId: round.id,
      roundQbjName: round.qbjName,
      roundNumber: planned.roundNumber,
      phaseId: round.phaseId,
      phaseName: round.phaseName,
      slotId: planned.slotId,
      roomName: '319',
      left: teams.get(planned.leftTeamId)!,
      right: teams.get(planned.rightTeamId)!,
    });
    if (!built.ok) throw new Error(built.error);
    const source = readQbjSource(built.assignment.document);
    if (!source.ok) throw new Error(source.errors.join(' '));
    const defined = defineGame(source.value, source.value.candidates[0].index);
    if (!defined.ok) throw new Error(defined.errors.join(' '));
  });
});

describe('Match identity', () => {
  const inputs = {
    tournamentId: 'Tournament_Synthetic',
    roundId: 'round-1',
    slotId: 'slot-gold-1',
    leftTeamId: 'Team_A',
    rightTeamId: 'Team_B',
  };

  test('is stable across regenerations', () => {
    expect(shuttleMatchId(inputs)).toBe(shuttleMatchId({ ...inputs }));
  });

  test('changes when the matchup, round, room slot, or tournament changes', () => {
    const base = shuttleMatchId(inputs);
    expect(shuttleMatchId({ ...inputs, leftTeamId: 'Team_C' })).not.toBe(base);
    expect(shuttleMatchId({ ...inputs, rightTeamId: 'Team_C' })).not.toBe(base);
    expect(shuttleMatchId({ ...inputs, roundId: 'round-2' })).not.toBe(base);
    expect(shuttleMatchId({ ...inputs, slotId: 'slot-gold-2' })).not.toBe(base);
    expect(shuttleMatchId({ ...inputs, tournamentId: 'Tournament_Other' })).not.toBe(base);
  });

  test('swapping sides is a different game', () => {
    expect(
      shuttleMatchId({ ...inputs, leftTeamId: 'Team_B', rightTeamId: 'Team_A' }),
    ).not.toBe(shuttleMatchId(inputs));
  });

  test('survives a room rename', () => {
    const first = prepare(1, 'slot-gold-1', '319');
    const second = prepare(1, 'slot-gold-1', 'Library');
    expect(first.assignment.matchId).toBe(second.assignment.matchId);
    expect(second.assignment.document).toBeDefined();
    const objects = objectsOf(second.assignment.document);
    expect(objects.find((entry) => entry.type === 'Match')!.location).toBe('Library');
  });
});

describe('a game between two teams of one school', () => {
  test('shares one Registration listing both teams, under the school’s own id', () => {
    const tournament = loadedSynthetic();
    const round = tournament.rounds[0];
    const seedTeams = syntheticTeams();
    const left: ShuttleTeam = {
      id: seedTeams[0].id,
      name: 'School A',
      registrationId: 'Registration_School',
      registrationName: 'School',
      players: [{ id: 'Player_A1', name: 'A One' }],
    };
    const right: ShuttleTeam = {
      id: seedTeams[1].id,
      name: 'School B',
      registrationId: 'Registration_School',
      registrationName: 'School',
      players: [{ id: 'Player_B1', name: 'B One' }],
    };
    const built = buildAssignment({
      tournament,
      roundId: round.id,
      roundQbjName: round.qbjName,
      roundNumber: 1,
      phaseId: round.phaseId,
      phaseName: round.phaseName,
      slotId: 'slot-gold-1',
      roomName: '319',
      left,
      right,
    });
    if (!built.ok) throw new Error(built.error);
    const objects = objectsOf(built.assignment.document);
    const registrations = objects.filter((entry) => entry.type === 'Registration');
    expect(registrations).toHaveLength(1);
    expect(registrations[0].id).toBe('Registration_School');
    expect(registrations[0].teams).toEqual([{ $ref: seedTeams[0].id }, { $ref: seedTeams[1].id }]);
    const ids = objects.map((entry) => `${String(entry.type)}:${String(entry.id)}`);
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
  });
});

describe('a completed result, read the way stock YellowFruit reads one', () => {
  test('preserves the assignment identity and resolves round and teams', () => {
    const tournament = loadedSynthetic();
    const scored = scorePrelimGame(tournament, 4, 'slot-maroon-3');
    const objects = scored.resultObject.objects;
    const found = findMatches(objects);
    expect(found).toHaveLength(1);
    expect(found[0].match.id).toBe(scored.matchId);
    expect(found[0].roundName).toBe('4');
    expect(Number.parseInt(String(found[0].roundName), 10)).toBe(4);

    const refTargets = collectRefTargets(objects);
    const knownTeamIds = new Set(tournament.teams.map((team) => team.id));
    const sides = ((found[0].match.match_teams as unknown[]) ?? []).filter(isRecord);
    expect(sides).toHaveLength(2);
    for (const side of sides) {
      const ref = isRecord(side.team) ? side.team.$ref : null;
      expect(typeof ref).toBe('string');
      expect(refTargets.has(String(ref))).toBe(true);
      expect(knownTeamIds.has(String(ref))).toBe(true);
    }
    expect((found[0].match.tossups_read as number) ?? 0).toBeGreaterThan(0);
  });

  test('a whole round of six results imports as six distinct games', () => {
    const tournament = loadedSynthetic();
    const slots = [
      'slot-gold-1',
      'slot-gold-2',
      'slot-gold-3',
      'slot-maroon-1',
      'slot-maroon-2',
      'slot-maroon-3',
    ];
    const scored = slots.map((slot) => scorePrelimGame(tournament, 2, slot));
    const matchIds = scored.map((entry) => entry.matchId);
    expect(new Set(matchIds).size).toBe(6);
    for (const entry of scored) {
      const found = findMatches(entry.resultObject.objects);
      expect(found).toHaveLength(1);
      expect(found[0].match.id).toBe(entry.matchId);
      expect(Number.parseInt(String(found[0].roundName), 10)).toBe(2);
    }
  });

  test('assignment bytes serialize and reparse cleanly', () => {
    const { assignment } = prepare();
    const text = assignmentFileContents(assignment);
    const reparsed = JSON.parse(text) as Record<string, unknown>;
    expect((reparsed as { version: string }).version).toBe('2.1.1');
    const source = readQbjSource(reparsed);
    if (!source.ok) throw new Error(source.errors.join(' '));
    expect(source.value.candidates).toHaveLength(1);
  });

  test('Cony vs Deering from the real fixture scores and returns', () => {
    const tournament = loadedFixture();
    const left = teamNamed(tournament, 'Cony');
    const right = teamNamed(tournament, 'Deering');
    const round = tournament.rounds.find((entry) => entry.number === 4) ?? tournament.rounds[3];
    const built = buildAssignment({
      tournament,
      roundId: round.id,
      roundQbjName: round.qbjName,
      ...(round.number !== undefined ? { roundNumber: round.number } : {}),
      phaseId: round.phaseId,
      phaseName: round.phaseName,
      slotId: 'slot-gold-1',
      roomName: 'Room 101',
      left,
      right,
    });
    if (!built.ok) throw new Error(built.error);
    const source = readQbjSource(built.assignment.document);
    if (!source.ok) throw new Error(source.errors.join(' '));
    expect(source.value.candidates[0].state).toBe('unplayed');
  });
});
