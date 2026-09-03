/**
 * Shared Teams import mapping: every roster source (CSV, SQBS, QBJ) flows
 * through one mapping so identity, letters, seeds, and player detail stay
 * identical no matter where the roster came from.
 */

import { describe, expect, test } from 'vitest';
import { importedTeamStatus, toImportedTeamInputs } from './teamImport';

describe('team import mapping', () => {
  test('qbj-shaped records keep identity, letters, seeds, and players', () => {
    const inputs = toImportedTeamInputs([
      {
        id: 'Team_Wren A',
        name: 'Wren A',
        letter: 'A',
        seed: 2,
        status: 'active',
        playerIds: ['Player_Ava'],
        players: [{ id: 'Player_Ava', name: 'Ava', grade: '12' }],
      },
    ]);
    expect(inputs).toEqual([
      {
        id: 'Team_Wren A',
        displayName: 'Wren A',
        organizationId: undefined,
        teamLetter: 'A',
        seed: 2,
        status: 'confirmed',
        notes: undefined,
        players: [
          { id: 'Player_Ava', name: 'Ava', captain: undefined, rosterNumber: undefined, notes: undefined },
        ],
      },
    ]);
  });

  test('status normalization matches the legacy Teams behavior', () => {
    expect(importedTeamStatus('no-show')).toBe('dropped');
    expect(importedTeamStatus(' Late ')).toBe('waitlist');
    expect(importedTeamStatus('active')).toBe('confirmed');
    expect(importedTeamStatus(undefined)).toBe('confirmed');
  });
});
