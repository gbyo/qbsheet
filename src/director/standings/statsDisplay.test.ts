import { beforeEach, expect, test } from 'vitest';
import { loadStatsColumnPrefs, saveStatsColumnPrefs, type StatsColumnPrefs } from './statsDisplay';

const prefsKey = 'qbsheet.director.statsColumns.v1';

beforeEach(() => {
  localStorage.clear();
});

test('a valid column choice replaces corrupt stored preferences', () => {
  localStorage.setItem(prefsKey, '{not valid json');
  const prefs: StatsColumnPrefs = {
    teams: ['record', 'ppb'],
    individuals: ['points', 'pptuh'],
  };

  saveStatsColumnPrefs('tournament-1', prefs);

  expect(loadStatsColumnPrefs('tournament-1')).toEqual(prefs);
});
