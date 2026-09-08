import { describe, expect, test } from 'vitest';
import { exportSqbsTournamentFile, parseSqbsTournamentFile, type SqbsTournamentInput } from '../src/sqbs';

function minimalTournament(): SqbsTournamentInput {
  return {
    tournamentName: 'Parser validation',
    pointValues: [10, -5],
    useBonuses: true,
    divisions: [],
    teams: [
      { name: 'Alpha', players: [], divisionIndex: -1 },
      { name: 'Beta', players: [], divisionIndex: -1 },
    ],
    games: [],
    packetNames: [],
  };
}

describe('SQBS parser validation', () => {
  test('rejects integer fields that cannot be represented exactly', () => {
    const exported = exportSqbsTournamentFile(minimalTournament());
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;

    const lines = exported.value.text.split('\n');
    lines[0] = '9007199254740993';

    const parsed = parseSqbsTournamentFile(lines.join('\n'));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'integer-out-of-range', path: 'teams.count' }),
      ]),
    );
  });
});
