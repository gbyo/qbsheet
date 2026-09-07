/** @vitest-environment jsdom */

import { beforeEach, describe, expect, test } from 'vitest';
import { emptyInput, rememberManualGamePreset } from '../src/app/ManualGameDraft';
import { newManualBreak } from '../src/game/ManualGame';

beforeEach(() => {
  window.localStorage.clear();
});

describe('manual game preset round-option isolation', () => {
  test('does not share break rows with the submitted setup', () => {
    const input = emptyInput();
    input.left = { name: 'Alpha', players: 'A' };
    input.right = { name: 'Beta', players: 'B' };
    input.options.breaks = [newManualBreak(10)];
    input.options.breaks[0].label = 'Halftime';

    const [preset] = rememberManualGamePreset(input);
    if (!preset?.options.breaks?.[0]) throw new Error('expected a preset break');

    expect(preset.options.breaks).not.toBe(input.options.breaks);
    expect(preset.options.breaks[0]).not.toBe(input.options.breaks[0]);

    input.options.breaks[0].afterTossup = 12;
    input.options.breaks[0].label = 'Changed after save';

    expect(preset.options.breaks[0].afterTossup).toBe(10);
    expect(preset.options.breaks[0].label).toBe('Halftime');
  });
});
