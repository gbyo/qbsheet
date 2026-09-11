/**
 * Loading a stock YellowFruit file.
 *
 * The things checked here are the things an assignment is built out of, and the identifiers are
 * checked literally: a team or player id that QBBridge invented instead of preserving is a result
 * YellowFruit cannot match back to its own roster.
 */

import { describe, expect, test } from 'vitest';
import { loadedFixture, timedFixtureText, unplayedGamesFixtureText, yftFixtureText } from '../tests/fixture';
import { bridgeRelevantWarnings, formatSummary, loadYellowFruitTournament } from './tournament';

describe('loading a YellowFruit file', () => {
  test('reads the tournament, its teams, its rosters and its rounds', () => {
    const report = loadYellowFruitTournament(yftFixtureText());
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const tournament = report.tournament;

    expect(tournament.name).toBe('2025 MEQBA Season Opener - Revised');
    expect(tournament.id).toBe('Tournament_YellowFruit');
    expect(tournament.teams).toHaveLength(12);
    expect(tournament.playerCount).toBe(48);

    // Identifiers come from the file, not from this application.
    const cony = tournament.teams.find((team) => team.name === 'Cony');
    expect(cony?.id).toBe('Team_Cony');
    expect(cony?.players.map((player) => player.id)).toContain('Player_Jacoby Grotton_1000');
    // School registrations are preserved, including the school that entered three teams.
    expect(cony?.registrationId).toBe('Registration_cony-1');
    const gouldTeams = tournament.teams.filter((team) => team.name.startsWith('Gould Academy'));
    expect(gouldTeams).toHaveLength(3);
    expect(new Set(gouldTeams.map((team) => team.registrationId)).size).toBe(1);

    // Five prelim rounds and three playoff rounds, each keeping YellowFruit's own round name.
    expect(tournament.rounds).toHaveLength(8);
    expect(tournament.rounds.map((round) => round.qbjName)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    expect(tournament.rounds[0]).toMatchObject({
      id: 'Phase_Prelims__round_1',
      number: 1,
      phaseId: 'Phase_Prelims',
      phaseName: 'Prelims',
    });
    expect(tournament.rounds[7].phaseName).toBe('Playoffs');

    // Pools are display context only.
    expect(cony?.poolNames).toEqual(['Prelim A', '7th Place']);

    // The schedule template is available as read-only context, without executing advancement.
    expect(
      tournament.schedule.phases.map((phase) => [phase.name, phase.firstRound, phase.lastRound]),
    ).toEqual([
      ['Prelims', 1, 5],
      ['Playoffs', 6, 8],
    ]);
    expect(tournament.schedule.phases[0]?.pools.map((pool) => pool.tier)).toEqual([1, 1]);
    expect(tournament.schedule.phases[1]?.pools.map((pool) => pool.hasCarryover)).toEqual([true, true]);
  });

  test('the structural scoring configuration arrives complete', () => {
    const tournament = loadedFixture();
    expect(tournament.timed).toBe(false);
    expect(tournament.rules).toMatchObject({
      type: 'ScoringRules',
      teams_per_match: 2,
      maximum_players_per_team: 4,
      regulation_tossup_count: 20,
      maximum_regulation_tossup_count: 20,
      minimum_overtime_question_count: 3,
      overtime_includes_bonuses: false,
      maximum_bonus_score: 30,
      bonus_divisor: 10,
      minimum_parts_per_bonus: 3,
      maximum_parts_per_bonus: 3,
      points_per_bonus_part: 10,
      bonuses_bounce_back: false,
      total_divisor: 5,
      lightning_count_per_team: 0,
    });
  });

  test('a timed file reports timed and keeps its own maximum', () => {
    const report = loadYellowFruitTournament(timedFixtureText());
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.tournament.timed).toBe(true);
    expect(report.tournament.rules.maximum_regulation_tossup_count).toBe(24);
    expect(formatSummary(report.tournament)).toContain('Timed');
  });

  test('offers only concrete unplayed two-team Matches as suggestions', () => {
    const report = loadYellowFruitTournament(unplayedGamesFixtureText());
    expect(report.ok).toBe(true);
    if (!report.ok) return;

    expect(report.tournament.suggestedGames).toHaveLength(2);
    expect(report.tournament.suggestedGames[0]).toMatchObject({
      roundId: report.tournament.rounds[0]?.id,
      phaseId: 'Phase_Prelims',
      location: 'Room 1',
    });
    expect(report.tournament.suggestedGames.every((game) => game.teamIds.every(Boolean))).toBe(true);
    expect(report.tournament.suggestedGames.some((game) => game.location === undefined)).toBe(true);
  });

  test('surfaces Bridge-relevant identity/scoring warnings, not Director migration noise', () => {
    const report = loadYellowFruitTournament(yftFixtureText());
    expect(report.ok).toBe(true);
    if (!report.ok) return;

    const warnings = report.warnings.join(' ');
    expect(warnings).not.toMatch(/Director|standings|advancement|schedule template|not interpreted/i);

    const retained = bridgeRelevantWarnings([
      {
        code: 'unsupported-field-preserved',
        path: 'objects[0].phases[0].YfData',
        message: 'The YfData field is not interpreted by this adapter; it was preserved in extensions.',
      },
      {
        code: 'unsupported-field-preserved',
        path: 'objects[0].scoring_rules.customAnswerValue',
        message: 'The custom scoring field was preserved for review.',
      },
      {
        code: 'ambiguous-team-name',
        path: 'games[0].match_teams[1].team',
        message: 'The team identity could not be resolved safely.',
      },
      {
        code: 'missing-tossups-heard',
        path: 'games[0].match_teams[0]',
        message: 'Tossups heard was not available for every player; the team total remains unknown.',
      },
      {
        code: 'yft-schedule-metadata',
        path: 'phases[0].YfData',
        message: 'The YellowFruit schedule template was not carried over.',
      },
      {
        code: 'yft-not-carried-over',
        path: '',
        message: 'Final rankings are not stored; Director uses calculated standings.',
      },
      {
        code: 'unsupported-field-preserved',
        path: 'objects[0].rankings[0].position',
        message: 'The position field is not interpreted by this adapter; it was preserved.',
      },
    ]);
    expect(retained).toEqual([
      'The custom scoring field was preserved for review.',
      'The team identity could not be resolved safely.',
      'Tossups heard was not available for every player; the team total remains unknown.',
    ]);
  });

  test('something that is not a YellowFruit file is refused with a reason', () => {
    const report = loadYellowFruitTournament('{"version":"2.1.1","objects":[]}');
    expect(report.ok).toBe(false);
    if (report.ok) return;
    expect(report.errors.join(' ')).toMatch(/YellowFruit/);
  });
});
