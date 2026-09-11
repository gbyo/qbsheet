/**
 * SQBS team-sort setting mapping (#896).
 *
 * The settings block carries exactly one sort line (writer, parser, and the
 * reference YellowFruit-lineage writer agree line-for-line): the team-sort
 * code SQBS uses for its own reports. QBSheet always lists teams canonically,
 * so the setting is passed through verbatim and surfaced on parse instead of
 * being hard-coded and discarded — with the canonical-vs-SQBS ordering
 * difference documented rather than silently reconciled.
 */
import { describe, expect, test } from 'vitest';
import { exportSqbsTournamentFile, parseSqbsTournamentFile, type SqbsTournamentInput } from '../src/sqbs';

function input(sortMethod?: number): SqbsTournamentInput {
  return {
    tournamentName: 'Sort Event',
    pointValues: [15, 10, -5],
    useBonuses: true,
    divisions: [],
    teams: [
      { name: 'Zeta', players: ['Z1'], divisionIndex: -1 },
      { name: 'Alpha', players: ['A1'], divisionIndex: -1 },
    ],
    games: [
      {
        id: 1,
        round: 1,
        left: {
          teamIndex: 0,
          score: 100,
          bonusesHeard: 4,
          bonusPoints: 40,
          players: [{ playerIndex: 0, gamesPlayed: 1, counts: [0, 4, 0, 0], points: 60 }],
        },
        right: {
          teamIndex: 1,
          score: 200,
          bonusesHeard: 6,
          bonusPoints: 60,
          players: [{ playerIndex: 0, gamesPlayed: 1, counts: [0, 6, 0, 0], points: 140 }],
        },
        tossupsHeard: 20,
      },
    ],
    packetNames: ['Round 1'],
    ...(sortMethod === undefined ? {} : { sortMethod }),
  };
}

/** The sort line sits immediately before the tournament name line. */
function sortLine(text: string): string {
  const lines = text.split('\n');
  const nameIndex = lines.indexOf('Sort Event');
  if (nameIndex < 1) throw new Error('fixture: tournament name line missing');
  return lines[nameIndex - 1]!;
}

describe('SQBS team-sort setting (#896)', () => {
  test('default writes the reference record-then-PPG line and parses it back', () => {
    const exported = exportSqbsTournamentFile(input());
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(sortLine(exported.value.text)).toBe('1');
    const parsed = parseSqbsTournamentFile(exported.value.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.sortMethod).toBe(1);
  });

  test.each([0, 2])('explicit sort code %i travels verbatim without moving teams', (code) => {
    const exported = exportSqbsTournamentFile(input(code));
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(sortLine(exported.value.text)).toBe(String(code));
    const parsed = parseSqbsTournamentFile(exported.value.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.sortMethod).toBe(code);
    // The file's team list keeps canonical (input) order either way.
    expect(parsed.value.teams.map((entry) => entry.name)).toEqual(['Zeta', 'Alpha']);
    expect(parsed.value.games[0]!.left.score).toBe(100);
    expect(parsed.value.games[0]!.right.score).toBe(200);
  });
});
