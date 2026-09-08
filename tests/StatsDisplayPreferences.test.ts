import { afterEach, describe, expect, it } from 'vitest';
import { loadStatsColumnPrefs } from '../src/director/standings/statsDisplay';

const prefsKey = 'qbsheet.director.statsColumns.v1';

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('Director stats column preferences', () => {
  it('deduplicates stored column ids while preserving their order', () => {
    const stored = JSON.stringify({
      tournament: {
        teams: ['record', 'pf', 'record', 'unknown', 'pf'],
        individuals: ['points', 'tuh', 'points'],
      },
    });
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => (key === prefsKey ? stored : null),
      },
    });

    expect(loadStatsColumnPrefs('tournament')).toEqual({
      teams: ['record', 'pf'],
      individuals: ['points', 'tuh'],
    });
  });
});
