import { defaultRules, type TournamentRules } from '@qbsheet/tournament-domain';

/**
 * Verified convenience rule sets. Each preset is a complete scoring model —
 * applying one fills every scoring field so no stale value survives from the
 * previous format — except tiebreakers, which stay the tournament's own.
 *
 * Semantics were checked against the publishers before encoding:
 * - ACF official gameplay rules (https://acf-quizbowl.com/official-gameplay-rules.pdf):
 *   official ACF events use 10-point tossups with -5 interrupt penalties.
 *   Modern ACF sets carry 15-point power marks; the plain ACF preset predates
 *   them. Bonuses are three 10-point parts with no rebound.
 * - NAQT brief rules (https://www.naqt.com/downloads/brief-rules.pdf): 10-point
 *   tossups, 15-point powers, three 10-point bonus parts, and no bonus off a
 *   tossup answered in overtime. Standard NAQT bonuses do not bounce back;
 *   the variants that rebound say so explicitly.
 * - Overtime procedures (https://www.qbwiki.com/wiki/Overtime): ACF overtime
 *   is sudden death only; NAQT overtime is three tossups (powers and negs live,
 *   no bonuses) followed by sudden death if still tied.
 * - NAQT timed structure: two nine-minute halves reading about 24 tossups.
 */
export interface ScoringRulePreset {
  id: string;
  name: string;
  description: string;
  rules: Omit<TournamentRules, 'tiebreakers'>;
}

function preset(
  id: string,
  name: string,
  description: string,
  overrides: Partial<Omit<TournamentRules, 'tiebreakers'>>,
): ScoringRulePreset {
  const scoring: Omit<TournamentRules, 'tiebreakers'> & {
    tiebreakers?: TournamentRules['tiebreakers'];
  } = structuredClone(defaultRules);
  // Presets fill scoring, never ranking: tiebreakers stay the tournament's own.
  delete scoring.tiebreakers;
  return { id, name, description, rules: { ...scoring, ...overrides } };
}

export const scoringRulePresets: ScoringRulePreset[] = [
  preset('acf', 'ACF', '10-point tossups, no powers, -5 negs, 30-point bonuses, sudden-death overtime.', {
    superpowerValue: null,
    powerValue: null,
    negValue: -5,
    bonusValue: 10,
    tossupCount: 20,
    bonusParts: 3,
    minimumBonusParts: null,
    maximumBonusScore: null,
    bonusDivisor: null,
    bouncebacks: false,
    overtime: true,
    overtimeTossupCount: 1,
    overtimeBonuses: false,
    timed: false,
    lightning: false,
    maximumTossupCount: null,
    maximumActivePlayers: 4,
  }),
  preset(
    'acf-powers',
    'ACF with powers',
    'ACF rules with 15-point power marks. Bonuses stay 30 points with no rebound.',
    {
      superpowerValue: null,
      powerValue: 15,
      negValue: -5,
      bonusValue: 10,
      tossupCount: 20,
      bonusParts: 3,
      minimumBonusParts: null,
      maximumBonusScore: null,
      bonusDivisor: null,
      bouncebacks: false,
      overtime: true,
      overtimeTossupCount: 1,
      overtimeBonuses: false,
      timed: false,
      lightning: false,
      maximumTossupCount: null,
      maximumActivePlayers: 4,
    },
  ),
  preset(
    'naqt-untimed',
    'NAQT untimed',
    '15-point powers, -5 negs, 30-point dead bonuses, three overtime tossups with no bonuses.',
    {
      superpowerValue: null,
      powerValue: 15,
      negValue: -5,
      bonusValue: 10,
      tossupCount: 20,
      bonusParts: 3,
      minimumBonusParts: null,
      maximumBonusScore: null,
      bonusDivisor: null,
      bouncebacks: false,
      overtime: true,
      overtimeTossupCount: 3,
      overtimeBonuses: false,
      timed: false,
      lightning: false,
      maximumTossupCount: null,
      maximumActivePlayers: 4,
    },
  ),
  preset('naqt-timed', 'NAQT timed', 'NAQT rules on the clock: two timed halves reading about 24 tossups.', {
    superpowerValue: null,
    powerValue: 15,
    negValue: -5,
    bonusValue: 10,
    tossupCount: 24,
    bonusParts: 3,
    minimumBonusParts: null,
    maximumBonusScore: null,
    bonusDivisor: null,
    bouncebacks: false,
    overtime: true,
    overtimeTossupCount: 3,
    overtimeBonuses: false,
    timed: true,
    regulationMinutes: 18,
    lightning: false,
    maximumTossupCount: null,
    maximumActivePlayers: 4,
  }),
];

export function scoringRulePresetById(id: string): ScoringRulePreset | undefined {
  return scoringRulePresets.find((entry) => entry.id === id);
}
