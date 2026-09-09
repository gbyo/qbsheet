import type { DirectorState, Team } from './model';

/** Teams currently eligible for automatic tournament competition. */
export function activeTournamentTeams(state: DirectorState): Team[] {
  return state.teams.filter((team) => team.status === 'confirmed');
}
