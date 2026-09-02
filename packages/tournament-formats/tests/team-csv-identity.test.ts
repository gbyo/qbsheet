import { describe, expect, test } from 'vitest';
import { importTeamsCsv } from '../src/csv';

describe('team CSV fallback identity', () => {
  test('keeps sibling teams with the same name but different letters separate', () => {
    const imported = importTeamsCsv(
      [
        'team_name,organization_id,letter',
        'Wren,,A',
        'Wren,,B',
      ].join('\n'),
    );

    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value).toHaveLength(2);
    expect(imported.value.map((team) => ({ id: team.id, name: team.name, letter: team.letter }))).toEqual([
      { id: 'team_wren-a', name: 'Wren', letter: 'A' },
      { id: 'team_wren-b', name: 'Wren', letter: 'B' },
    ]);
  });

  test('still groups roster rows that share the same fallback identity', () => {
    const imported = importTeamsCsv(
      [
        'team_name,organization_id,letter,player_name',
        'Wren,Wren School,A,Alice',
        'Wren,Wren School,A,Bob',
      ].join('\n'),
    );

    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value).toHaveLength(1);
    expect(imported.value[0].id).toBe('team_wren-wren-school-a');
    expect(imported.value[0].players?.map((player) => player.name)).toEqual(['Alice', 'Bob']);
  });

  test('keeps the legacy generated id when no organization or letter is present', () => {
    const imported = importTeamsCsv('team_name,organization_id,letter\nAiken,,');

    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value).toHaveLength(1);
    expect(imported.value[0].id).toBe('team_aiken');
  });
});
