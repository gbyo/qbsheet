/**
 * The file-sourced return path, and the proof it exists.
 *
 * Stock YellowFruit's import chain ends in `Round.addMatch`, which is an unconditional
 * `matches.push` with no id check (`src/renderer/DataModel/Round.ts`), reached from the
 * import modal's `finishImport`. Importing a completed QBJ for a Match id that already sits
 * in the file as a blank therefore APPENDS a second game — it never fills the first. This
 * test replays that exact chain (spine walk resolving only the match link, then an
 * unconditional append) against a game scored through QBSheet's real result builder, and
 * then shows the fill-in-a-copy path producing the single filled game instead.
 */

import { describe, expect, test } from 'vitest';
import { completedMatchOf, fillScheduledMatches } from './yftFill';
import { readScheduledGames } from './scheduleSource';
import { validateWildcatCompatibility } from './schedule';
import { scoreCustomGame, syntheticTeams, syntheticYftText } from '../tests/helpers';
import { loadShuttleTournament } from './tournament';

type QbjObject = Record<string, unknown>;
const isRecord = (value: unknown): value is QbjObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Stock YellowFruit `FileParsing.findMatches`: inline spine, only the match link followed. */
function yellowFruitFindMatches(objects: QbjObject[]): { roundName: unknown; match: QbjObject }[] {
  const byId = new Map<string, QbjObject>();
  for (const object of objects) {
    if (object.type === 'Match' && typeof object.id === 'string') byId.set(object.id, object);
  }
  const tournament = objects.find((entry) => entry.type === 'Tournament');
  const found: { roundName: unknown; match: QbjObject }[] = [];
  if (!tournament || !Array.isArray(tournament.phases)) return found;
  for (const phase of tournament.phases.filter(isRecord)) {
    if (!Array.isArray(phase.rounds)) continue;
    for (const round of phase.rounds.filter(isRecord)) {
      if (!Array.isArray(round.matches)) continue;
      for (const entry of round.matches) {
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

function oneScheduledBlank() {
  const text = syntheticYftText({
    scheduledBlanks: [{ round: 1, leftSeed: 9, rightSeed: 12, location: '319', id: 'Match_Blank_1' }],
  });
  const report = loadShuttleTournament(text);
  if (!report.ok) throw new Error(report.errors.join(' '));
  return { text, tournament: report.tournament };
}

describe('the YellowFruit import append behavior', () => {
  test('importing a completed game for an existing blank appends instead of replacing', () => {
    const { tournament } = oneScheduledBlank();
    const compat = validateWildcatCompatibility(tournament);
    if (!compat.ok) throw new Error(compat.errors.join(' '));
    const [game] = readScheduledGames(tournament, compat.compat.prelimPhaseId, [1]);
    expect(game.matchId).toBe('Match_Blank_1');

    // Export the assignment preserving the blank's Match id, then score it for real.
    const round = compat.compat.roundsByNumber.get(1)!;
    const scored = scoreCustomGame(tournament, {
      roundId: round.id,
      roundQbjName: round.qbjName,
      roundNumber: 1,
      phaseId: round.phaseId,
      phaseName: round.phaseName,
      slotId: 'slot-yft-1',
      roomName: '319',
      leftTeamId: game.leftTeamId,
      rightTeamId: game.rightTeamId,
      existingMatchId: game.matchId,
    });
    expect(scored.matchId).toBe('Match_Blank_1');

    // The completed file resolves through the faithful import walk…
    const found = yellowFruitFindMatches(scored.resultObject.objects);
    expect(found).toHaveLength(1);
    expect(found[0].match.id).toBe('Match_Blank_1');

    // …but YellowFruit's `Round.addMatch` pushes unconditionally: blank + result = 2 games.
    const roundMatches: QbjObject[] = [{ id: 'Match_Blank_1' }];
    const addMatch = (match: QbjObject): void => {
      roundMatches.push(match);
    };
    addMatch(found[0].match);
    expect(roundMatches).toHaveLength(2);
  });
});

describe('fillScheduledMatches', () => {
  test('fills the exact blank by id and keeps every unrelated object', () => {
    const { text, tournament } = oneScheduledBlank();
    const compat = validateWildcatCompatibility(tournament);
    if (!compat.ok) throw new Error(compat.errors.join(' '));
    const [game] = readScheduledGames(tournament, compat.compat.prelimPhaseId, [1]);
    const round = compat.compat.roundsByNumber.get(1)!;
    const scored = scoreCustomGame(tournament, {
      roundId: round.id,
      roundQbjName: round.qbjName,
      roundNumber: 1,
      phaseId: round.phaseId,
      phaseName: round.phaseName,
      slotId: 'slot-yft-1',
      roomName: '319',
      leftTeamId: game.leftTeamId,
      rightTeamId: game.rightTeamId,
      existingMatchId: game.matchId,
    });
    const completed = completedMatchOf(scored.resultText);
    if (!completed.ok) throw new Error(completed.error);

    const filled = fillScheduledMatches(text, [{ matchId: game.matchId, match: completed.match }]);
    if (!filled.ok) throw new Error(filled.error);
    expect(filled.filled).toEqual(['Match_Blank_1']);

    // Exactly one match in round 1 now, and it is decided.
    const reparsed = JSON.parse(filled.text) as { objects: QbjObject[] };
    const yft = reparsed.objects.find((entry) => entry.type === 'Tournament')!;
    const matches = (
      ((yft.phases as QbjObject[])[0].rounds as QbjObject[])[0].matches as QbjObject[]
    ).filter(isRecord);
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe('Match_Blank_1');
    const points = (matches[0].match_teams as QbjObject[]).map((side) => side.points);
    expect(points.every((value) => typeof value === 'number')).toBe(true);

    // Unrelated content survives: all twelve teams, both pools, all eight rounds.
    const check = loadShuttleTournament(filled.text);
    if (!check.ok) throw new Error(check.errors.join(' '));
    expect(check.tournament.teams).toHaveLength(12);
    expect(check.tournament.rounds).toHaveLength(8);

    // The source text is untouched: still a blank, still no points.
    expect(text).not.toContain('"points"');
  });

  test('an unknown Match id is an error naming the game, not a silent skip', () => {
    const { text } = oneScheduledBlank();
    const result = fillScheduledMatches(text, [{ matchId: 'Match_Nope', match: { id: 'x' } }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Match_Nope');
  });

  test('completedMatchOf rejects multi-game and non-QBJ files', () => {
    expect(completedMatchOf('nope').ok).toBe(false);
    expect(
      completedMatchOf(JSON.stringify({ version: '2.1.1', objects: [{ type: 'Match' }, { type: 'Match' }] })).ok,
    ).toBe(false);
  });

  test('blank YfData sidecars survive the fill', () => {
    const parsed = JSON.parse(
      syntheticYftText({
        scheduledBlanks: [{ round: 1, leftSeed: 9, rightSeed: 12, location: '319', id: 'Match_Blank_1' }],
      }),
    );
    const blank = parsed.objects[0].phases[0].rounds[0].matches[0];
    blank.YfData = { kickoff: '9:00' };
    const report = loadShuttleTournament(JSON.stringify(parsed));
    if (!report.ok) throw new Error(report.errors.join(' '));
    const teams = syntheticTeams();
    const scored = scoreCustomGame(report.tournament, {
      roundId: 'round-1',
      roundQbjName: '1',
      roundNumber: 1,
      phaseId: 'phase-1',
      phaseName: 'Prelims',
      slotId: 'slot-yft-1',
      roomName: '319',
      leftTeamId: teams.find((team) => team.seed === 9)!.id,
      rightTeamId: teams.find((team) => team.seed === 12)!.id,
      existingMatchId: 'Match_Blank_1',
    });
    const completed = completedMatchOf(scored.resultText);
    if (!completed.ok) throw new Error(completed.error);
    const filled = fillScheduledMatches(JSON.stringify(parsed), [
      { matchId: 'Match_Blank_1', match: completed.match },
    ]);
    if (!filled.ok) throw new Error(filled.error);
    const reparsed = JSON.parse(filled.text) as { objects: QbjObject[] };
    const yft = reparsed.objects.find((entry) => entry.type === 'Tournament')!;
    const match = ((yft.phases as QbjObject[])[0].rounds as QbjObject[])[0].matches as QbjObject[];
    expect((match[0].YfData as QbjObject).kickoff).toBe('9:00');
  });
});
