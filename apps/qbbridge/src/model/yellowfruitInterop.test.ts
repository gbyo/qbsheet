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
