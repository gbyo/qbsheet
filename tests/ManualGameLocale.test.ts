import { afterEach, describe, expect, test, vi } from 'vitest';
import { defineManualGame, manualRoundOptionDefaults } from '../src/game/ManualGame';
import { basicScoringRulesDefaults } from '../src/qbj/BasicScoringRules';
import { basicRulesInput } from '../src/qbj/ScoringRulesInput';

afterEach(() => vi.restoreAllMocks());

describe('manual game team identity', () => {
  test('duplicate team names do not depend on the browser locale', () => {
    vi.spyOn(String.prototype, 'toLocaleLowerCase').mockImplementation(function () {
      return String(this).replace(/I/g, 'ı').toLowerCase();
    });

    const result = defineManualGame({
      gameLabel: '',
      left: { name: 'INDIANS', players: 'Sarah' },
      right: { name: 'indians', players: 'Emma' },
      rules: basicRulesInput(basicScoringRulesDefaults),
      options: { ...manualRoundOptionDefaults },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.map((problem) => problem.message)).toContain('Team names must be different.');
  });
});
