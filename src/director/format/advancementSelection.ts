import type { AdvancementPreview, DirectorId } from '../domain';

export type AdvancementCutoffChoices = Record<string, DirectorId[]>;

export interface AdvancementCutoffDecision {
  key: string;
  teamIds: DirectorId[];
  berthCount: number;
  selectedTeamIds: DirectorId[];
  reason: string;
}

export function advancementCutoffDecisions(
  preview: AdvancementPreview,
  choices: AdvancementCutoffChoices,
): AdvancementCutoffDecision[] {
  const previewQualifierIds = new Set(preview.qualifiers.map((team) => team.id));
  return preview.unresolved.map((group, index) => {
    const key = `${index}:${group.teamIds.join('|')}`;
    const defaults = group.teamIds.filter((teamId) => previewQualifierIds.has(teamId));
    return {
      key,
      teamIds: group.teamIds,
      berthCount: defaults.length,
      selectedTeamIds: choices[key] ?? defaults,
      reason: group.reason,
    };
  });
}

export function selectedAdvancementTeamIds(
  preview: AdvancementPreview,
  decisions: readonly AdvancementCutoffDecision[],
): DirectorId[] {
  const selected = new Set(preview.qualifiers.map((team) => team.id));
  for (const decision of decisions) {
    decision.teamIds.forEach((teamId) => selected.delete(teamId));
    decision.selectedTeamIds.forEach((teamId) => selected.add(teamId));
  }
  const orderedCandidates = [
    ...preview.qualifiers.map((team) => team.id),
    ...preview.unresolved.flatMap((group) => group.teamIds),
  ];
  return [...new Set(orderedCandidates)].filter((teamId) => selected.has(teamId));
}

export function cutoffDecisionsAreValid(decisions: readonly AdvancementCutoffDecision[]): boolean {
  return decisions.every(
    (decision) =>
      decision.berthCount > 0 &&
      decision.selectedTeamIds.length === decision.berthCount &&
      new Set(decision.selectedTeamIds).size === decision.selectedTeamIds.length &&
      decision.selectedTeamIds.every((teamId) => decision.teamIds.includes(teamId)),
  );
}
