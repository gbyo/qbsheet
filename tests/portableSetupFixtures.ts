import { IManualGameInput, manualRoundOptionDefaults } from '../src/game/ManualGame';
import { advancedFromBasic } from '../src/qbj/AdvancedScoringRules';
import { basicScoringRulesDefaults } from '../src/qbj/BasicScoringRules';
import { scoringRulesInputDefaults } from '../src/qbj/ScoringRulesInput';

export function portableInput(advanced = false): IManualGameInput {
  return {
    gameLabel: 'Friday scrimmage',
    left: { name: 'École 東京', players: 'Zoë\nSmith, John\r\n李雷\nAna-María\nBench player' },
    right: { name: 'Κόσμος', players: 'Renée\nO’Connor\nعلي\nSam' },
    rules: advanced
      ? {
          mode: 'advanced',
          advanced: {
            ...advancedFromBasic(basicScoringRulesDefaults),
            answerTypes: [
              { key: 'super', value: 20, label: 'Superpower', shortLabel: 'SP', awardsBonus: true },
              { key: 'power', value: 15, label: 'Power', shortLabel: 'P', awardsBonus: true },
              { key: 'correct', value: 10, label: 'Correct', shortLabel: 'C', awardsBonus: true },
              { key: 'neg', value: -5, label: 'Neg', shortLabel: 'N', awardsBonus: false },
            ],
            timed: true,
            maximumTossupCount: 24,
            bonusStructure: 'irregular',
            maximumBonusScore: 40,
            bonusDivisor: 10,
            minimumPartsPerBonus: 2,
            maximumPartsPerBonus: 4,
            overtimeQuestionCount: 3,
            overtimeIncludesBonuses: true,
            useLightning: true,
            lightningCountPerTeam: 1,
            lightningDivisor: 10,
          },
        }
      : scoringRulesInputDefaults(),
    options: {
      ...manualRoundOptionDefaults,
      halves: true,
      halfLengthMinutes: 9,
      timeoutsPerTeam: 2,
      timeoutDurationSeconds: 45,
      substitutionPolicy: 'breaks-timeouts-overtime',
      breaks: [{ key: 'half', afterTossup: 10, label: 'Halftime' }],
    },
  };
}

/** Repeatable, poorly compressible roster data for exercising the density ceiling. */
export function largePortableInput(players = 40): IManualGameInput {
  let seed = 17;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  const input = portableInput();
  input.left.players = Array.from(
    { length: players },
    (_, i) => `${i} ` + Array.from({ length: 90 }, () => String.fromCharCode(33 + (next() % 90))).join(''),
  ).join('\n');
  return input;
}
