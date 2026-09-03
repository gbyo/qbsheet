/**
 * Scenario L (full SQBS tournament export), formats level: a representative
 * tournament serializes to an SQBS data file that parses back with teams,
 * players, games, scores, and detail stats intact — including forfeits
 * (winner left, scores -1) and honest warnings for unknown statistics.
 */

import { describe, expect, test } from 'vitest';
import { exportSqbsTournamentFile, parseSqbsTournamentFile, type SqbsTournamentInput } from '../src/sqbs';

function input(): SqbsTournamentInput {
  return {
    tournamentName: 'Saturday Event',
    pointValues: [15, 10, -5],
    useBonuses: true,
    trackPowers: true,
    divisions: ['Championship', 'Consolation'],
    teams: [
      { name: 'Wren A', players: ['Ava', 'Ben'], divisionIndex: 0 },
      { name: 'Wren B', players: ['Cal', 'Dee'], divisionIndex: 1 },
      { name: 'Aiken', players: ['Eli'], divisionIndex: 0 },
      { name: 'Dorman', players: ['Fay', 'Gus', 'Hal'], divisionIndex: 1 },
    ],
    games: [
      {
        id: 1,
        round: 1,
        left: {
          teamIndex: 0,
          score: 320,
          bonusesHeard: 8,
          bonusPoints: 170,
          players: [
            { playerIndex: 0, gamesPlayed: 1, counts: [2, 6, 0, 0], points: 200 },
            { playerIndex: 1, gamesPlayed: 1, counts: [0, 4, 1, 0], points: 120 },
          ],
        },
        right: {
          teamIndex: 2,
          score: 150,
          bonusesHeard: 5,
          bonusPoints: 90,
          players: [{ playerIndex: 0, gamesPlayed: 1, counts: [0, 6, 0, 1], points: 150 }],
        },
        tossupsHeard: 20,
      },
      {
        // Forfeit won by the right-side team: the file must list the winner left.
        id: 2,
        round: 1,
        left: { teamIndex: 3, score: 0, bonusesHeard: 0, bonusPoints: 0, players: [] },
        right: { teamIndex: 1, score: 0, bonusesHeard: 0, bonusPoints: 0, players: [] },
        tossupsHeard: 0,
        forfeitWinner: 'right',
      },
      {
        // Manual final score with no detail: unknown TUH/bonuses export as 0 with warnings.
        id: 3,
        round: 2,
        left: { teamIndex: 0, score: 260, bonusesHeard: null, bonusPoints: null, players: [] },
        right: { teamIndex: 1, score: 240, bonusesHeard: null, bonusPoints: null, players: [] },
        tossupsHeard: null,
      },
    ],
    packetNames: ['Round 1', 'Round 2'],
  };
}

describe('SQBS tournament data file', () => {
  test('exported file parses back with teams, games, scores, and detail', () => {
    const exported = exportSqbsTournamentFile(input());
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.warnings.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(['unknown-tossups-heard', 'unknown-bonuses']),
    );

    const parsed = parseSqbsTournamentFile(exported.value.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const tournament = parsed.value;
    expect(tournament.tournamentName).toBe('Saturday Event');
    expect(tournament.pointValues).toEqual([15, 10, -5, 0]);
    expect(tournament.useBonuses).toBe(true);
    expect(tournament.divisions).toEqual(['Championship', 'Consolation']);
    expect(tournament.teams.map((team) => team.name)).toEqual(['Wren A', 'Wren B', 'Aiken', 'Dorman']);
    expect(tournament.teams[0]!.players.map((player) => player.name)).toEqual(['Ava', 'Ben']);
    expect(tournament.teams.map((team) => team.divisionIndex)).toEqual([0, 1, 0, 1]);
    expect(tournament.packetNames).toEqual(['Round 1', 'Round 2']);

    expect(tournament.games).toHaveLength(3);
    const [played, forfeit, manual] = tournament.games;
    expect([played!.left.score, played!.right.score]).toEqual([320, 150]);
    expect(played!.tossupsHeard).toBe(20);
    expect(played!.left.bonusesHeard).toBe(8);
    expect(played!.left.bonusPoints).toBe(170);
    expect(played!.left.players).toHaveLength(2);
    expect(played!.left.players[0]).toMatchObject({
      playerIndex: 0,
      gamesPlayed: 1,
      counts: [2, 6, 0, 0],
      points: 200,
    });

    // Forfeit: winner on the left, scores -1, flag set.
    expect(forfeit!.forfeit).toBe(true);
    expect(forfeit!.left.teamIndex).toBe(1);
    expect(forfeit!.right.teamIndex).toBe(3);
    expect([forfeit!.left.score, forfeit!.right.score]).toEqual([-1, -1]);

    // Unknown detail exports as honest zeroes.
    expect(manual!.tossupsHeard).toBe(0);
    expect(manual!.left.bonusesHeard).toBe(0);
    expect([manual!.left.score, manual!.right.score]).toEqual([260, 240]);
  });

  test('unrepresentable tournaments fail instead of misleading', () => {
    const tooManyValues = input();
    tooManyValues.pointValues = [20, 15, 10, 5, -5];
    const values = exportSqbsTournamentFile(tooManyValues);
    expect(values.ok).toBe(false);
    if (values.ok) return;
    expect(values.errors[0]!.code).toBe('too-many-point-values');

    const tooManyPlayers = input();
    tooManyPlayers.games[0]!.left.players = Array.from({ length: 9 }, (_, index) => ({
      playerIndex: 0,
      gamesPlayed: 1,
      counts: [0, 1, 0, 0] as [number, number, number, number],
      points: 10 + index,
    }));
    const players = exportSqbsTournamentFile(tooManyPlayers);
    expect(players.ok).toBe(false);
    if (players.ok) return;
    expect(players.errors[0]!.code).toBe('too-many-players');
  });

  test('double forfeits are skipped with a warning, not written', () => {
    const fixture = input();
    fixture.games[1] = {
      ...fixture.games[1]!,
      left: fixture.games[1]!.left,
      right: fixture.games[1]!.right,
      forfeitWinner: 'double',
    };
    const exported = exportSqbsTournamentFile(fixture);
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.warnings.map((entry) => entry.code)).toContain('double-forfeit-skipped');
    const parsed = parseSqbsTournamentFile(exported.value.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.games).toHaveLength(2);
  });

  test('truncated files fail with a structural error', () => {
    const exported = exportSqbsTournamentFile(input());
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const lines = exported.value.text.split('\n');
    const parsed = parseSqbsTournamentFile(lines.slice(0, Math.floor(lines.length / 2)).join('\n'));
    expect(parsed.ok).toBe(false);
  });
});
