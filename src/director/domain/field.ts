import type { DirectorState, Team } from './model';

/** Teams currently eligible for automatic tournament competition. */
export function activeTournamentTeams(state: DirectorState): Team[] {
  return state.teams.filter((team) => team.status === 'confirmed');
}

export type PhaseFieldSource = 'tournament-field' | 'pools' | 'advancement' | 'explicit';

export interface PhaseCompetitiveField {
  phaseId: string;
  teams: Team[];
  source: PhaseFieldSource | null;
  issues: string[];
}

/**
 * Resolve the authoritative competitive field for a phase.
 *
 * A phase with pools owns the union of its active pool memberships. A non-pool phase may carry an
 * explicit field written by advancement. Only the first active phase is allowed to inherit the
 * tournament registration field; later phases must be assigned deliberately.
 */
export function phaseCompetitiveField(state: DirectorState, phaseId: string): PhaseCompetitiveField {
  const phase = state.phases.find((entry) => entry.id === phaseId);
  if (!phase) return { phaseId, teams: [], source: null, issues: ['The selected phase does not exist.'] };

  const teamsById = new Map(state.teams.map((team) => [team.id, team]));
  const issues: string[] = [];
  let source: PhaseFieldSource;
  let teamIds: string[];

  if (phase.poolIds.length > 0) {
    source = 'pools';
    const pools = phase.poolIds.map((poolId) => state.pools.find((pool) => pool.id === poolId));
    if (pools.some((pool) => !pool || pool.phaseId !== phase.id || pool.archived === true)) {
      issues.push(`Phase ${phase.name} has missing, archived, or foreign pool membership.`);
    }
    teamIds = pools.flatMap((pool) => pool?.teamIds ?? []);
  } else if (phase.teamIds !== undefined) {
    source = 'advancement';
    teamIds = [...phase.teamIds];
  } else {
    const firstPhase = state.phases
      .filter((entry) => entry.archived !== true)
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))[0];
    if (firstPhase?.id === phase.id) {
      source = 'tournament-field';
      teamIds = activeTournamentTeams(state).map((team) => team.id);
    } else {
      source = 'explicit';
      teamIds = [];
      issues.push(`Phase ${phase.name} has no committed competitive field.`);
    }
  }

  const duplicateIds = [...new Set(teamIds.filter((teamId, index) => teamIds.indexOf(teamId) !== index))];
  if (duplicateIds.length > 0) {
    issues.push(`Phase ${phase.name} assigns a team more than once: ${duplicateIds.join(', ')}.`);
  }
  const missingIds = [...new Set(teamIds.filter((teamId) => !teamsById.has(teamId)))];
  if (missingIds.length > 0) {
    issues.push(
      `Phase ${phase.name} contains teams that are not in the tournament: ${missingIds.join(', ')}.`,
    );
  }
  const ineligibleIds = [
    ...new Set(
      teamIds.filter((teamId) => {
        const status = teamsById.get(teamId)?.status;
        return status !== undefined && status !== 'confirmed' && status !== 'dropped';
      }),
    ),
  ];
  if (ineligibleIds.length > 0) {
    issues.push(`Phase ${phase.name} contains teams that are not confirmed: ${ineligibleIds.join(', ')}.`);
  }

  return {
    phaseId,
    teams: [...new Set(teamIds)]
      .map((teamId) => teamsById.get(teamId))
      .filter((team): team is Team => team?.status === 'confirmed'),
    source,
    issues,
  };
}

/** Return only currently active teams in the selected phase's authoritative field. */
export function activePhaseTeams(state: DirectorState, phaseId: string): Team[] {
  return phaseCompetitiveField(state, phaseId).teams;
}
