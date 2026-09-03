import type { TeamRecord } from '@qbsheet/tournament-formats';
import type { ImportedTeamInput } from '../state/useDirectorController';

/**
 * Shared TeamRecord → roster-import mapping for every Teams import source
 * (CSV paste/file, SQBS roster files). One mapping keeps stable identity,
 * letters, seeds, and player detail identical no matter which source the
 * roster came from.
 */
export function toImportedTeamInputs(teams: readonly TeamRecord[]): ImportedTeamInput[] {
  return teams.map((team) => ({
    id: team.id,
    displayName: team.displayName ?? team.name,
    organizationId: team.organizationId,
    teamLetter: team.letter,
    seed: team.seed ?? null,
    status: importedTeamStatus(team.status),
    notes: team.notes,
    players: team.players?.map((player) => ({
      id: player.id,
      name: player.name,
      captain: player.captain,
      rosterNumber: player.rosterNumber,
      notes: player.notes,
    })),
  }));
}

export function importedTeamStatus(status: string | undefined): 'confirmed' | 'waitlist' | 'dropped' {
  const normalized = typeof status === 'string' ? status.trim().toLowerCase() : '';
  if (
    normalized === 'dropped' ||
    normalized === 'withdrawn' ||
    normalized === 'no-show' ||
    normalized === 'forfeit'
  ) {
    return 'dropped';
  }
  if (normalized === 'late' || normalized === 'waitlist') return 'waitlist';
  return 'confirmed';
}
