import { type DirectorId, type DirectorState, type Phase, type Team } from './model';
import { deriveTeamStandings, type TeamStanding } from './stats';

export interface AdvancementPreview {
  phaseId: DirectorId;
  qualifiers: Team[];
  unresolved: Array<{ teamIds: DirectorId[]; reason: string }>;
  explanation: string[];
}

export function previewAdvancement(state: DirectorState, phase: Phase): AdvancementPreview {
  const rule = phase.advancementRule;
  const standings = deriveTeamStandings(state).filter(
    (standing) => phase.poolIds.length === 0 || belongsToPhasePool(state, phase, standing.teamId),
  );
  const qualifiersPerPool = rule?.qualifiersPerPool ?? 0;
  const qualifiedStandings = standings.slice(0, qualifiersPerPool * Math.max(1, phase.poolIds.length));
  const unresolved: AdvancementPreview['unresolved'] = [];
  if (qualifiedStandings.length > 0 && rule && qualifiedStandings.length < standings.length) {
    const cutoff = qualifiedStandings[qualifiedStandings.length - 1];
    const tied = standings.filter(
      (standing) =>
        standing !== cutoff &&
        standing.winPercentage === cutoff.winPercentage &&
        standing.pointsFor === cutoff.pointsFor &&
        standing.margin === cutoff.margin,
    );
    if (tied.length > 0) {
      unresolved.push({
        teamIds: [cutoff.teamId, ...tied.map((standing) => standing.teamId)],
        reason: 'The qualification cutoff is tied after the configured standings tiebreakers.',
      });
    }
  }
  return {
    phaseId: phase.id,
    qualifiers: qualifiedStandings
      .map((standing) => state.teams.find((team) => team.id === standing.teamId))
      .filter((team): team is Team => team !== undefined),
    unresolved,
    explanation: [
      `Ranked ${standings.length} eligible teams using the configured record and tiebreak order.`,
      rule
        ? `Preview includes ${rule.qualifiersPerPool} qualifier(s) per pool.`
        : 'No advancement rule is configured.',
      unresolved.length === 0
        ? 'No unresolved cutoff tie was found.'
        : 'Director decision required before committing advancement.',
    ],
  };
}

function belongsToPhasePool(state: DirectorState, phase: Phase, teamId: DirectorId): boolean {
  return state.pools.some((pool) => phase.poolIds.includes(pool.id) && pool.teamIds.includes(teamId));
}

export function standingsForAdvancement(state: DirectorState, phase: Phase): TeamStanding[] {
  const standings = deriveTeamStandings(state);
  return phase.poolIds.length === 0
    ? standings
    : standings.filter((standing) => belongsToPhasePool(state, phase, standing.teamId));
}
