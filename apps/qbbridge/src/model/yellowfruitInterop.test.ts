/**
 * The loop closes: a result scored from a QBBridge assignment is readable by stock YellowFruit.
 *
 * # What is being proved, and how honestly
 *
 * The reference importer is `ANadig/YellowFruit` on `master` — Electron, so it cannot be executed
 * here. What *can* be executed is its algorithm, and the checks below are a direct transcription
 * of the code that decides whether a `File → Import Games Only` succeeds:
 *
 * | Check | Upstream |
 * | --- | --- |
 * | serialization version | `QbjUtils2.qbjFileValidVersion` — `['2.1.1']` |
 * | reference targets | `QbjUtils2.collectRefTargets` |
 * | finding the matches | `FileParsing.FileParser.findMatches` — walks `tournament.phases[].rounds[].matches[]` literally, resolving only the match link |
 * | finding the round | `TournamentManager.importMatchesFromWholeQbj` — `getRoundObjByNumber(Number.parseInt(round.name, 10))` |
 * | finding the teams | `FileParsing.typesByIdArraysAddTeam` → `tournament.findTeamById`, else `resolveTeamIdentity`'s name match |
 * | finding the players | `typesByIdArraysAddPlayer`, else a name match within the team |
 * | finding the answer types | `resolveAnswerTypeIdentity` → id, else point value |
 * | two teams per match | `parseMatchMatchTeams` |
 *
 * Nothing here comes from the QBTCP-enabled YellowFruit fork. The supported boundary is `.yft` in,
 * `.qbj` results out, and these are the assumptions on both ends of it.
 *
 * The two structural traps are the ones worth restating, because a document that falls into either
 * looks correct and fails at the import dialog. `findMatches` does not resolve a `$ref` at the
 * phase or round link, so the schedule spine has to be nested. And the round is resolved by
 * `parseInt` over `Round.name`, so a numeric round is named `"4"` and never `"Round 4"`.
 */

import { describe, expect, test } from 'vitest';
import { scoredResultDocument } from '../tests/scoredResult';

type QbjObject = Record<string, unknown>;

function isRecord(value: unknown): value is QbjObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// --- the upstream algorithm, transcribed ------------------------------------------------------

/** `QbjUtils2.collectRefTargets`, reduced to what a result document can contain. */
function collectRefTargets(objects: QbjObject[]): Map<string, QbjObject> {
  const dict = new Map<string, QbjObject>();
  const add = (entry: unknown): void => {
    if (!isRecord(entry)) return;
    if (typeof entry.id === 'string') dict.set(entry.id, entry);
  };
  const addTeam = (team: unknown): void => {
    add(team);
    if (isRecord(team)) for (const player of Array.isArray(team.players) ? team.players : []) add(player);
  };
  for (const object of objects) {
    add(object);
    if (object.type === 'Team') addTeam(object);
    if (object.type === 'Registration') {
      for (const team of Array.isArray(object.teams) ? object.teams : []) addTeam(team);
    }
    if (object.type === 'ScoringRules') {
      for (const answer of Array.isArray(object.answer_types) ? object.answer_types : []) add(answer);
    }
    if (object.type === 'Tournament') {
      const rules = object.scoring_rules;
      if (isRecord(rules)) {
        add(rules);
        for (const answer of Array.isArray(rules.answer_types) ? rules.answer_types : []) add(answer);
      }
      for (const registration of Array.isArray(object.registrations) ? object.registrations : []) {
        add(registration);
        if (isRecord(registration)) {
          for (const team of Array.isArray(registration.teams) ? registration.teams : []) addTeam(team);
        }
      }
      for (const phase of Array.isArray(object.phases) ? object.phases : []) {
        add(phase);
        if (!isRecord(phase)) continue;
        for (const round of Array.isArray(phase.rounds) ? phase.rounds : []) {
          add(round);
          if (!isRecord(round)) continue;
          for (const match of Array.isArray(round.matches) ? round.matches : []) add(match);
        }
      }
    }
  }
  return dict;
}

/**
 * `FileParsing.FileParser.findMatches`.
 *
 * Faithful in the detail that matters: `phases` and `rounds` are read as inline objects, and only
 * the match link is followed through the top-level `Match` dictionary.
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

describe('a completed result, read the way stock YellowFruit reads one', () => {
  const { result, matchId, tournament } = scoredResultDocument();
  const objects = result.objects;
  const refTargets = collectRefTargets(objects);

  test('the serialization version is one the reference importer supports', () => {
    expect(['2.1.1']).toContain(result.version);
  });

  test('the importer finds exactly one match by walking the nested spine', () => {
    const found = findMatches(objects);
    expect(found).toHaveLength(1);
    expect(found[0].match.id).toBe(matchId);
  });

  test('the round resolves by parseInt over its name', () => {
    const [{ roundName }] = findMatches(objects);
    expect(roundName).toBe('4');
    const parsed = Number.parseInt(String(roundName), 10);
    expect(Number.isNaN(parsed)).toBe(false);
    expect(parsed).toBe(4);
    // The round is one YellowFruit's own file defines, so `getRoundObjByNumber` has it.
    expect(tournament.rounds.some((round) => round.number === parsed)).toBe(true);
  });

  test('both teams resolve to teams the YellowFruit tournament already has', () => {
    const [{ match }] = findMatches(objects);
    const sides = (Array.isArray(match.match_teams) ? match.match_teams : []).filter(isRecord);
    expect(sides).toHaveLength(2);
    const knownTeamIds = new Set(tournament.teams.map((team) => team.id));
    const knownTeamNames = new Set(tournament.teams.map((team) => team.name));
    for (const side of sides) {
      const ref = isRecord(side.team) ? side.team.$ref : null;
      expect(typeof ref).toBe('string');
      const team = refTargets.get(String(ref));
      expect(team, `the file resolves ${String(ref)} itself`).toBeTruthy();
      // `findTeamById` on the open tournament is the first attempt, and it succeeds because the
      // identifier came from that tournament's own file.
      expect(knownTeamIds.has(String(ref))).toBe(true);
      // The name fallback would also succeed, which is what makes this robust to an operator who
      // rebuilt the roster.
      expect(knownTeamNames.has(String(team?.name))).toBe(true);
    }
  });

  test('every player and answer type resolves by the identifier YellowFruit gave it', () => {
    const [{ match }] = findMatches(objects);
    const knownPlayerIds = new Set(
      tournament.teams.flatMap((team) => team.players.map((player) => player.id)),
    );
    const answerTypes = (tournament.rules.answer_types as unknown as QbjObject[]) ?? [];
    const knownAnswerIds = new Set(answerTypes.map((entry) => String(entry.id)));
    const knownAnswerValues = new Set(answerTypes.map((entry) => entry.value));
    let players = 0;
    let answerCounts = 0;
    for (const side of (Array.isArray(match.match_teams) ? match.match_teams : []).filter(isRecord)) {
      for (const entry of (Array.isArray(side.match_players) ? side.match_players : []).filter(isRecord)) {
        players += 1;
        const ref = isRecord(entry.player) ? String(entry.player.$ref) : '';
        expect(refTargets.has(ref)).toBe(true);
        expect(knownPlayerIds.has(ref)).toBe(true);
        // `parseMatchPlayer` iterates `answerCounts` without a guard, so the array has to be there.
        expect(Array.isArray(entry.answer_counts)).toBe(true);
        for (const count of (entry.answer_counts as unknown[]).filter(isRecord)) {
          answerCounts += 1;
          // `resolveAnswerTypeIdentity` reads a `$ref` or an inline object's own `id`, then falls
          // back to the point value. Both routes have to land on an answer type the tournament
          // has, and both do, because the ids and the values came out of its own file.
          const answer = count.answer_type;
          expect(isRecord(answer)).toBe(true);
          if (!isRecord(answer)) continue;
          const answerRef = typeof answer.$ref === 'string' ? answer.$ref : String(answer.id);
          expect(knownAnswerIds.has(answerRef)).toBe(true);
          if (answer.value !== undefined) expect(knownAnswerValues.has(answer.value)).toBe(true);
        }
      }
    }
    expect(players).toBeGreaterThan(0);
    expect(answerCounts).toBeGreaterThan(0);
  });

  test('the result is the assignment filled in, not a new game that resembles it', () => {
    const [{ match }] = findMatches(objects);
    const tournamentObject = objects.find((entry) => entry.type === 'Tournament');
    expect(tournamentObject?.id).toBe('Tournament_YellowFruit');
    expect(match.id).toBe(matchId);
    expect(match.location).toBe('Room 101');
    expect(match.tossups_read).toBeGreaterThan(0);
    const sides = (Array.isArray(match.match_teams) ? match.match_teams : []).filter(isRecord);
    expect(sides.map((side) => side.points)).toEqual([30, 40]);
  });
});

/**
 * Two teams from one school, all the way through.
 *
 * A school that entered an A and a B team is a single `Registration` in YellowFruit, and an
 * A-vs-B game is the case where both sides of the match resolve to it. The result writer used to
 * emit one `Registration` per side, producing two top-level objects with the same id — each
 * naming a different team and a different name, so which one a reader indexed decided what
 * `$ref: Registration_…` pointed at.
 *
 * This runs the real path rather than a hand-written document: QBBridge builds the assignment,
 * QBSheet's parser reads it, a game is scored through the scoring engine, and QBSheet's own
 * `buildResultDocument` writes the result.
 */
describe('a game between two teams of the same school', () => {
  const { result, tournament } = scoredResultDocument({
    left: 'Gould Academy A',
    right: 'Gould Academy B',
  });
  const objects = result.objects;

  test('every object in the result has a unique identity', () => {
    const ids = objects.map((entry) => `${String(entry.type)}:${String(entry.id)}`);
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
  });

  test('one Registration carries both teams, under the school’s own name and id', () => {
    const registrations = objects.filter((entry) => entry.type === 'Registration');
    expect(registrations).toHaveLength(1);

    // The identifier is YellowFruit's, not one this application minted.
    const school = tournament.teams.find((team) => team.name === 'Gould Academy A')!;
    expect(registrations[0].id).toBe(school.registrationId);
    expect(registrations[0].name).toBe('Gould Academy');
    expect(registrations[0].teams).toEqual([
      { $ref: 'Team_Gould Academy A' },
      { $ref: 'Team_Gould Academy B' },
    ]);
  });

  test('the school’s third team is not dragged in', () => {
    // Gould Academy entered A, B and C. C is not playing, so C is not in the document.
    expect(JSON.stringify(result)).not.toContain('Gould Academy C');
  });

  test('the tournament references that one registration once', () => {
    const tournamentObject = objects.find((entry) => entry.type === 'Tournament')!;
    const refs = tournamentObject.registrations as { $ref: string }[];
    expect(refs).toHaveLength(1);
    expect(new Set(refs.map((ref) => ref.$ref)).size).toBe(1);
  });

  test('every `$ref` in the result resolves to an object the result carries', () => {
    const byId = new Map<string, QbjObject>();
    const index = (entry: unknown): void => {
      if (!isRecord(entry)) return;
      if (typeof entry.id === 'string') byId.set(entry.id, entry);
      for (const value of Object.values(entry)) {
        if (Array.isArray(value)) value.forEach(index);
        else if (isRecord(value)) index(value);
      }
    };
    objects.forEach(index);

    const dangling: string[] = [];
    const check = (entry: unknown): void => {
      if (Array.isArray(entry)) return entry.forEach(check);
      if (!isRecord(entry)) return;
      if (typeof entry.$ref === 'string' && !byId.has(entry.$ref)) dangling.push(entry.$ref);
      for (const value of Object.values(entry)) check(value);
    };
    objects.forEach(check);
    expect(dangling).toEqual([]);
  });

  test('stock YellowFruit still finds the match and both of its teams', () => {
    const found = findMatches(objects);
    expect(found).toHaveLength(1);
    expect(Number.parseInt(String(found[0].roundName), 10)).toBe(4);

    const refTargets = collectRefTargets(objects);
    const knownTeamIds = new Set(tournament.teams.map((team) => team.id));
    const sides = (Array.isArray(found[0].match.match_teams) ? found[0].match.match_teams : []).filter(
      isRecord,
    );
    expect(sides).toHaveLength(2);
    for (const side of sides) {
      const ref = isRecord(side.team) ? String(side.team.$ref) : '';
      expect(refTargets.has(ref)).toBe(true);
      expect(knownTeamIds.has(ref)).toBe(true);
    }
  });
});
