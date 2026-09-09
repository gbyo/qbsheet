import { describe, expect, test } from 'vitest';
import type { AdvancementPreview } from '../domain';
import {
  advancementCutoffDecisions,
  cutoffDecisionsAreValid,
  selectedAdvancementTeamIds,
} from './advancementSelection';

function team(id: string) {
  return { id, displayName: id } as AdvancementPreview['qualifiers'][number];
}

describe('advancement cutoff selection', () => {
  test('allows the Director to replace the deterministic team in a two-for-one tie', () => {
    const preview: AdvancementPreview = {
      phaseId: 'prelims',
      qualifiers: [team('A')],
      wildcards: [],
      unresolved: [{ teamIds: ['A', 'B'], reason: 'cutoff tied' }],
      explanation: [],
    };
    const defaults = advancementCutoffDecisions(preview, {});
    expect(defaults[0].berthCount).toBe(1);
    expect(selectedAdvancementTeamIds(preview, defaults)).toEqual(['A']);

    const choices = { [defaults[0].key]: ['B'] };
    const decided = advancementCutoffDecisions(preview, choices);
    expect(cutoffDecisionsAreValid(decided)).toBe(true);
    expect(selectedAdvancementTeamIds(preview, decided)).toEqual(['B']);
  });

  test('requires exactly the number of berths crossing an N-for-M tie', () => {
    const preview: AdvancementPreview = {
      phaseId: 'prelims',
      qualifiers: [team('A'), team('B')],
      wildcards: [],
      unresolved: [{ teamIds: ['A', 'B', 'C'], reason: 'cutoff tied' }],
      explanation: [],
    };
    const [decision] = advancementCutoffDecisions(preview, {});
    expect(decision.berthCount).toBe(2);
    expect(cutoffDecisionsAreValid([{ ...decision, selectedTeamIds: ['B', 'C'] }])).toBe(true);
    expect(cutoffDecisionsAreValid([{ ...decision, selectedTeamIds: ['C'] }])).toBe(false);
  });
});
