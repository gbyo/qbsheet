/**
 * Scenario K (SQBS team import): a representative SQBS roster with multiple
 * teams from the same organization imports through the shared Teams mapping
 * with no team disappearing or merging — stable ids, letters kept apart by
 * distinct names, players attached to the right team.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { importSqbsTeams } from '@qbsheet/tournament-formats';
import { useDirectorController } from '../src/director/state/useDirectorController';
import { MemoryDirectorRepository } from '../src/director/persistence';
import { toImportedTeamInputs } from '../src/director/teams/teamImport';

const ROSTER = [
  '3',
  '4',
  'Wren A',
  'Ava (12)',
  'Ben',
  'Cy',
  '3',
  'Wren B',
  'Dee',
  'Eli (10)',
  '2',
  'Southside',
  'Finn',
].join('\n');

describe('Scenario K: SQBS team import', () => {
  test('same-organization teams import without merging', async () => {
    const parsed = importSqbsTeams(ROSTER);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.map((team) => team.name)).toEqual(['Wren A', 'Wren B', 'Southside']);

    const repository = new MemoryDirectorRepository();
    const hook = renderHook(() => useDirectorController(repository));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    let result = { inserted: 0, skipped: 0 };
    act(() => {
      hook.result.current.createTournament({
        name: 'SQBS import',
        date: '2026-09-01',
        venue: '',
        organizer: '',
      });
      result = hook.result.current.addImportedTeams(toImportedTeamInputs(parsed.value));
    });
    expect(result).toEqual({ inserted: 3, skipped: 0 });

    const state = hook.result.current.state;
    expect(state.teams.map((team) => team.displayName).sort()).toEqual(['Southside', 'Wren A', 'Wren B']);
    const playersByTeam = new Map(
      state.teams.map((team) => [
        team.displayName,
        state.players
          .filter((player) => player.teamId === team.id)
          .map((player) => player.name)
          .sort(),
      ]),
    );
    expect(playersByTeam.get('Wren A')).toEqual(['Ava', 'Ben', 'Cy']);
    expect(playersByTeam.get('Wren B')).toEqual(['Dee', 'Eli']);
    expect(playersByTeam.get('Southside')).toEqual(['Finn']);
    // Stable SQBS-derived identities survive the import.
    expect(new Set(state.teams.map((team) => team.id)).size).toBe(3);
    expect(new Set(state.players.map((player) => player.id)).size).toBe(6);
  });
});
