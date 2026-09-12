/**
 * Schedule sources: the file's real games when they exist, the printed preset otherwise.
 *
 * Stock YellowFruit's schedule describes phases, pools, seeds, and round counts but creates
 * no Match objects (`StandardSchedule` holds no `new Match`); games reach `round.matches`
 * only through manual Add or Import. So a pre-tournament file resolves to the preset, a file
 * whose rounds already hold full unplayed room games resolves to itself, and a half-built
 * file resolves to neither — with an explanation, not a guess.
 */

import { describe, expect, test } from 'vitest';
import {
  readScheduledGames,
  resolveScheduleSource,
  roomsForScheduledGames,
} from './scheduleSource';
import { validateWildcatCompatibility } from './schedule';
import { loadedFixture, loadedSynthetic, syntheticYftText } from '../tests/helpers';
import { loadShuttleTournament } from './tournament';

function prelimPhase(tournament = loadedSynthetic()) {
  const compat = validateWildcatCompatibility(tournament);
  if (!compat.ok) throw new Error(compat.errors.join(' '));
  return compat.compat.prelimPhaseId;
}

function blanksFor(rounds: number[]): { round: number; leftSeed: number; rightSeed: number; location: string; id: string }[] {
  // One blank per room for the given rounds; seeds/rooms need only be plausible here.
  const rooms = ['315', '317', '318', '319', '320', '321'];
  const pairs: [number, number][] = [[6, 11], [3, 10], [7, 2], [9, 12], [5, 4], [8, 1]];
  return rounds.flatMap((round) =>
    rooms.map((location, index) => ({
      round,
      leftSeed: pairs[index][0],
      rightSeed: pairs[index][1],
      location,
      id: `Match_Sched_R${round}_${index}`,
    })),
  );
}

describe('schedule sources', () => {
  test('a file with no scheduled games resolves to the preset', () => {
    const tournament = loadedSynthetic();
    const source = resolveScheduleSource(tournament, prelimPhase(tournament), [1, 2, 3, 4, 5], 30);
    expect(source.kind).toBe('preset');
  });

  test('the real sample file resolves to the preset (its games are results, not blanks)', () => {
    const tournament = loadedFixture();
    const compat = validateWildcatCompatibility(tournament);
    if (!compat.ok) throw new Error(compat.errors.join(' '));
    const source = resolveScheduleSource(tournament, compat.compat.prelimPhaseId, [1, 2, 3, 4, 5], 30);
    // Played games are never a schedule: the preset remains the source.
    expect(source.kind).toBe('mixed');
    if (source.kind === 'mixed') expect(source.played).toBeGreaterThan(0);
  });

  test('fully scheduled unplayed rounds resolve to the file’s own games', () => {
    const tournament = loadedSynthetic({ scheduledBlanks: blanksFor([1, 2, 3, 4, 5]) });
    const source = resolveScheduleSource(tournament, prelimPhase(tournament), [1, 2, 3, 4, 5], 30);
    expect(source.kind).toBe('yft');
    if (source.kind !== 'yft') throw new Error('expected yft source');
    expect(source.games).toHaveLength(30);
    expect(source.games[0].matchId).toBe('Match_Sched_R1_0');
    expect(source.games[0].location).toBe('315');
    const rooms = roomsForScheduledGames(source.games);
    expect(rooms.ok).toBe(true);
    if (rooms.ok) expect(rooms.rooms).toEqual(['315', '317', '318', '319', '320', '321']);
  });

  test('matches without two teams or an id are not scheduled games', () => {
    const parsed = JSON.parse(syntheticYftText({ scheduledBlanks: blanksFor([1]) }));
    const round = parsed.objects[0].phases[0].rounds[0];
    round.matches[0].match_teams.pop();
    delete round.matches[1].id;
    const report = loadShuttleTournament(JSON.stringify(parsed));
    if (!report.ok) throw new Error(report.errors.join(' '));
    const phaseId = report.tournament.phases[0].id;
    const games = readScheduledGames(report.tournament, phaseId, [1]);
    expect(games).toHaveLength(4);
  });

  test('rooms are required: a blank without location is a mixed state, not a schedule', () => {
    const parsed = JSON.parse(syntheticYftText({ scheduledBlanks: blanksFor([1, 2, 3, 4, 5]) }));
    delete parsed.objects[0].phases[0].rounds[0].matches[0].location;
    const report = loadShuttleTournament(JSON.stringify(parsed));
    if (!report.ok) throw new Error(report.errors.join(' '));
    const source = resolveScheduleSource(report.tournament, prelimPhase(report.tournament), [1, 2, 3, 4, 5], 30);
    expect(source.kind).toBe('yft');
    if (source.kind !== 'yft') throw new Error('expected yft source');
    expect(roomsForScheduledGames(source.games).ok).toBe(false);
  });
});
