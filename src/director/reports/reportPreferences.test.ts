import { describe, expect, test } from 'vitest';
import { defaultReportOptions } from '@qbsheet/tournament-formats';
import { loadReportOptions, reportPreferenceKey, saveReportOptions } from './reportPreferences';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    values,
  };
}

describe('report preferences', () => {
  test('persists per tournament outside competitive state', () => {
    const storage = memoryStorage();
    const saved = saveReportOptions(
      'tournament-a',
      {
        ...defaultReportOptions,
        pages: ['standings', 'games'],
        pointsMetric: 'pointsPerX',
        showPointsForAgainstMargin: false,
        showPacket: false,
      },
      storage,
    );

    expect(saved.pages).toEqual(['standings', 'games']);
    expect(loadReportOptions('tournament-a', storage)).toEqual(saved);
    expect(loadReportOptions('tournament-b', storage)).toEqual(defaultReportOptions);
    expect(storage.values.has(reportPreferenceKey('tournament-a'))).toBe(true);
  });

  test('malformed or empty page preferences fall back to useful defaults', () => {
    const storage = memoryStorage();
    storage.setItem(reportPreferenceKey('bad-json'), '{nope');
    storage.setItem(reportPreferenceKey('empty-pages'), JSON.stringify({ pages: [] }));

    expect(loadReportOptions('bad-json', storage)).toEqual(defaultReportOptions);
    expect(loadReportOptions('empty-pages', storage).pages).toEqual(defaultReportOptions.pages);
  });
});
