/**
 * What a "standings CSV" actually contains, and that one answer serves both pages.
 *
 * The regression this exists for: Publish offered a `Standings CSV` action whose implementation was
 * `exportTeamCsv` — the team-and-roster importer's format, written out under a `-standings.csv`
 * name. A director who exported it to send records to a league got `team_id,team_name,…,player_name`
 * and no record at all, and nothing on the page said so.
 */
import { describe, expect, test } from 'vitest';
import { parseCsvTable } from '@qbsheet/tournament-formats';
import { playedTournament, player, playerStat, score, team } from '../../../tests/directorFixtures';
import { acceptedGame, scheduledGame } from '../../../tests/directorFixtures';
import { playerStatsCsv, standingsFileStem, teamStandingsCsv } from './standingsCsv';

function table(csv: string) {
  const parsed = parseCsvTable(csv);
  if (!parsed.ok) throw new Error(parsed.errors.map((entry) => entry.message).join(' '));
  return parsed.value;
}

describe('the team standings CSV', () => {
  test('holds standings columns rather than the roster importer’s columns', () => {
    const parsed = table(teamStandingsCsv(playedTournament()));

    expect(parsed.headers).toContain('wins');
    expect(parsed.headers).toContain('losses');
    expect(parsed.headers).toContain('points_for');
    expect(parsed.headers).toContain('margin');
    // The shape the Publish action used to write instead.
    expect(parsed.headers).not.toContain('player_name');
    expect(parsed.headers).not.toContain('player_captain');
    expect(parsed.headers).not.toContain('organization_id');
  });

  /*
   * The screen renders this cell as "—" for a team with no games. A spreadsheet reading `0.0%` would
   * sort an unplayed team in among the winless ones, which is a different claim about the day.
   */
  test('a team that has not played has a blank win percentage, not 0.0%', () => {
    const state = playedTournament();
    state.teams.push(team('team-c', 'Abbeville'));

    const parsed = table(teamStandingsCsv(state));
    const unplayed = parsed.rows.find((cells) => cells[2] === 'Abbeville');
    const played = parsed.rows.find((cells) => cells[2] === 'Ninety Six');
    const winPercentage = parsed.headers.indexOf('win_percentage');

    expect(unplayed?.[winPercentage]).toBe('');
    expect(played?.[winPercentage]).toBe('100.0%');
  });

  test('it carries the powers, gets and negs the screen shows', () => {
    const parsed = table(teamStandingsCsv(playedTournament()));
    const row = parsed.rows.find((cells) => cells[2] === 'Ninety Six');

    expect(row).toBeDefined();
    const value = (header: string) => row?.[parsed.headers.indexOf(header)];
    expect(value('powers')).toBe('4');
    expect(value('gets')).toBe('8');
    expect(value('negs')).toBe('1');
    expect(value('bonuses_heard')).toBe('12');
    expect(value('bonus_points')).toBe('130');
  });

  test('one row per team, ranked the way the table is', () => {
    const parsed = table(teamStandingsCsv(playedTournament()));

    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0][0]).toBe('1');
    expect(parsed.rows[0][2]).toBe('Ninety Six');
    expect(parsed.rows[1][2]).toBe('Greenwood');
  });

  test('a name with a comma and a quote in it survives the round trip', () => {
    const state = playedTournament();
    state.teams[0].displayName = 'Ninety Six, "A"';

    const parsed = table(teamStandingsCsv(state));

    expect(parsed.rows[0][2]).toBe('Ninety Six, "A"');
  });
});

describe('the player statistics CSV', () => {
  test('it names the player, the team, and what they scored', () => {
    const parsed = table(playerStatsCsv(playedTournament()));

    expect(parsed.headers).toEqual([
      'rank',
      'player_id',
      'player',
      'team_id',
      'team',
      'games_played',
      'tossups_heard',
      'powers',
      'gets',
      'negs',
      'bonus_points',
      'ppg',
    ]);
    expect(parsed.rows.map((cells) => cells[2])).toEqual(['Gibson', 'Emma']);
  });

  test('nobody who has played is left out of it', () => {
    const state = playedTournament();
    for (let index = 0; index < 12; index += 1) {
      const teamId = `extra-team-${index}`;
      state.teams.push(team(teamId, `Extra ${index}`));
      state.players.push(player(`extra-player-${index}`, teamId, `Extra Player ${index}`));
      state.scheduledGames.push(scheduledGame(`extra-scheduled-${index}`, teamId, 'team-b'));
      state.games.push(
        acceptedGame(
          `extra-game-${index}`,
          `extra-scheduled-${index}`,
          [score(teamId, 100 + index), score('team-b', 50)],
          [playerStat(`extra-player-${index}`, teamId, { gets: index + 1 })],
        ),
      );
    }

    const parsed = table(playerStatsCsv(state));

    expect(parsed.rows.length).toBe(14);
    expect(parsed.rows.map((cells) => cells[2])).toContain('Extra Player 11');
  });

  test('players who have not played are not given a row of zeroes', () => {
    const state = playedTournament();
    state.players.push(player('player-bench', 'team-a', 'Nobody'));

    const parsed = table(playerStatsCsv(state));

    expect(parsed.rows.map((cells) => cells[2])).not.toContain('Nobody');
  });

  test('an unknown tossups-heard total is blank rather than a misleading number', () => {
    const state = playedTournament();
    state.games[0].playerStats[0].tossupsHeard = null;

    const parsed = table(playerStatsCsv(state));
    const row = parsed.rows.find((cells) => cells[2] === 'Gibson');

    expect(row?.[parsed.headers.indexOf('tossups_heard')]).toBe('');
  });
});

test('the file stem is the tournament, or a safe default when there is none', () => {
  expect(standingsFileStem(playedTournament())).toBe('Ninety-Six-Invitational');
  const state = playedTournament();
  state.tournament = null;
  expect(standingsFileStem(state)).toBe('tournament');
});
