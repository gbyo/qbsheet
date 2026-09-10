/**
 * Shared scoring-rules parity corpus (#783).
 *
 * Each vector is a complete Director `TournamentRules` document. The checked-in
 * golden file `apps/director/src-tauri/tests/parity/scoring-rules.json` pairs
 * every vector with the exact `ScoringRules` QBJ the canonical TypeScript
 * builder (`scoringRulesObject`) emits for it; the native Rust builder
 * (`generated_scoring_rules`) must emit a semantically identical document.
 *
 * `exercises` names the competitive fields this vector pins. The conformance
 * test requires the union to cover every competitive `TournamentRules` key so
 * a newly added field fails loudly instead of drifting one transport.
 */
import type { TournamentRules } from '@qbsheet/tournament-domain';
import { defaultRules } from '@qbsheet/tournament-domain';
import { scoringRulePresets } from '../domain/scoringPresets';

export interface ScoringRulesParityVector {
  name: string;
  exercises: string[];
  rules: TournamentRules;
}

function presetRules(id: string): TournamentRules {
  const preset = scoringRulePresets.find((entry) => entry.id === id);
  if (!preset) throw new Error(`parity corpus: unknown preset ${id}`);
  return { ...defaultRules, ...preset.rules };
}

function custom(
  name: string,
  exercises: string[],
  overrides: Partial<TournamentRules>,
): ScoringRulesParityVector {
  return { name, exercises, rules: { ...defaultRules, ...overrides } };
}

export const scoringRulesParityVectors: ScoringRulesParityVector[] = [
  {
    name: 'acf-no-powers',
    exercises: ['powerValue', 'negValue', 'useBonuses', 'bonusValue', 'bonusParts', 'tossupCount'],
    rules: presetRules('acf'),
  },
  {
    name: 'acf-with-powers',
    exercises: ['powerValue'],
    rules: presetRules('acf-powers'),
  },
  {
    name: 'naqt-untimed',
    exercises: ['overtimeTossupCount', 'overtimeBonuses'],
    rules: presetRules('naqt-untimed'),
  },
  {
    name: 'naqt-timed',
    exercises: ['timed', 'tossupCount'],
    rules: presetRules('naqt-timed'),
  },
  custom('no-negs', ['negValue'], { negValue: null }),
  custom('tossups-only', ['useBonuses', 'overtimeBonuses'], {
    useBonuses: false,
    overtimeBonuses: false,
  }),
  custom('superpowers-full', ['superpowerValue'], { superpowerValue: 20 }),
  custom('irregular-bonus', ['minimumBonusParts', 'maximumBonusScore', 'bonusDivisor'], {
    minimumBonusParts: 2,
    maximumBonusScore: 25,
    bonusDivisor: 5,
  }),
  custom('custom-max-tossups', ['maximumTossupCount'], { maximumTossupCount: 24 }),
  custom('overtime-sudden-death', ['overtimeTossupCount', 'overtimeBonuses'], {
    overtimeTossupCount: 1,
    overtimeBonuses: true,
  }),
  custom('overtime-extended-no-bonus', ['overtimeTossupCount', 'overtimeBonuses'], {
    overtimeTossupCount: 5,
    overtimeBonuses: false,
  }),
  custom('bouncebacks', ['bouncebacks'], { bouncebacks: true }),
  custom('custom-lightning', ['lightning', 'lightningCountPerTeam', 'lightningDivisor'], {
    lightning: true,
    lightningCountPerTeam: 2,
    lightningDivisor: 15,
  }),
  custom('custom-max-players', ['maximumActivePlayers'], { maximumActivePlayers: 6 }),
  custom('nonstandard-divisor', ['tossupValue', 'powerValue', 'negValue', 'bonusValue'], {
    tossupValue: 12,
    superpowerValue: null,
    powerValue: 18,
    negValue: -6,
    bonusValue: 6,
  }),
  custom('degenerate-counts', ['tossupCount', 'bonusParts', 'maximumActivePlayers', 'bonusValue'], {
    tossupCount: 0,
    bonusParts: 0,
    maximumActivePlayers: 0,
    bonusValue: 0,
  }),
];

/**
 * Competitive-field coverage contract: every key of the canonical rules must
 * either be exercised by at least one vector or be documented below as
 * intentionally non-competitive (not serialized into scorer semantics).
 */
export const nonCompetitiveRulesFields: Record<string, string> = {
  overtime: 'Represented through overtimeTossupCount/overtimeBonuses; the boolean itself is not serialized.',
  regulationMinutes: 'Clock administration, not scorer scoring semantics.',
  tiebreakers: 'Standings policy, not scorer scoring semantics.',
  tiebreakerCountsStatistically: 'Standings reporting, explicitly not part of any game definition.',
};
