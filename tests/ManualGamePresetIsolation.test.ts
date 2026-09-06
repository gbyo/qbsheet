/** @vitest-environment jsdom */

import { beforeEach, describe, expect, test } from 'vitest';
import { emptyInput, rememberManualGamePreset } from '../src/app/ManualGameDraft';
import { scoringRulesInputAs } from '../src/qbj/ScoringRulesInput';

beforeEach(() => {
  window.localStorage.clear();
});

describe('manual game preset isolation', () => {
  test('does not share advanced answer-type rows with the submitted setup', () => {
    const input = emptyInput();
    input.rules = scoringRulesInputAs(input.rules, 'advanced');
    if (input.rules.mode !== 'advanced') throw new Error('expected advanced rules');

    const [preset] = rememberManualGamePreset(input);
    if (!preset || preset.rules.mode !== 'advanced') throw new Error('expected an advanced preset');

    const originalLabel = preset.rules.advanced.answerTypes[0]?.label;
    expect(preset.rules.advanced.answerTypes[0]).not.toBe(input.rules.advanced.answerTypes[0]);

    input.rules.advanced.answerTypes[0].label = 'Changed after save';
    expect(preset.rules.advanced.answerTypes[0].label).toBe(originalLabel);
  });
});
