import { beforeEach, describe, expect, test } from 'vitest';
import { playedTournament } from '../../../tests/directorFixtures';
import {
  bonusesInUse,
  defaultIndividualColumnIds,
  defaultTeamColumnIds,
  formatMargin,
  formatPpb,
  formatPptuh,
  formatRecord,
  formatWinPct,
  individualColumnsForState,
  loadStatsColumnPrefs,
  playerStatCell,
  saveStatsColumnPrefs,
  superpowersInUse,
  teamColumnsForState,
  teamStatCell,
  type StatsColumnPrefs,
} from './statsDisplay';

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

describe('tournament-shaped columns', () => {
  test('a standard powers format offers bonus columns but no superpower tier', () => {
    const state = playedTournament();
    expect(bonusesInUse(state)).toBe(true);
    expect(superpowersInUse(state)).toBe(false);

    const teams = teamColumnsForState(state).map((column) => column.id);
    expect(teams).toContain('ppb');
    expect(teams).toContain('bonuses');
    expect(teams).not.toContain('superpowers');
    expect(individualColumnsForState(state).map((column) => column.id)).not.toContain('superpowers');
  });

  test('a tossup-only format drops every bonus column instead of zero-filling it', () => {
    const state = playedTournament();
    state.tournament!.rules.useBonuses = false;
    for (const game of state.games) {
      for (const score of game.scores) {
        score.bonuses = 0;
        score.bonusPoints = 0;
      }
    }
    expect(bonusesInUse(state)).toBe(false);

    const teams = teamColumnsForState(state).map((column) => column.id);
    expect(teams).not.toContain('ppb');
    expect(teams).not.toContain('bonuses');
    expect(teams).not.toContain('bonuspoints');
    // Answer tiers are untouched by the bonus gate.
    expect(teams).toContain('powers');
  });

  test('enabling superpowers promotes the tier into the fresh defaults', () => {
    const state = playedTournament();
    expect(defaultTeamColumnIds(state)).not.toContain('superpowers');

    state.tournament!.rules.superpowerValue = 20;
    expect(superpowersInUse(state)).toBe(true);
    expect(defaultTeamColumnIds(state)).toContain('superpowers');
    expect(defaultIndividualColumnIds(state)).toContain('superpowers');
  });

  test('fresh team defaults stay a readable core, not a wall of columns', () => {
    expect(defaultTeamColumnIds(playedTournament())).toEqual([
      'record',
      'winpct',
      'games',
      'margin',
      'ppg',
      'tuh',
      'ppb',
    ]);
  });
});

describe('shared cell values', () => {
  test('record, margin, and rates format without formulas in React', () => {
    expect(formatRecord({ wins: 3, losses: 1, ties: 0 })).toBe('3–1');
    expect(formatRecord({ wins: 3, losses: 1, ties: 2 })).toBe('3–1–2');
    expect(formatMargin({ margin: 25 })).toBe('+25');
    expect(formatMargin({ margin: -25 })).toBe('-25');
    expect(formatWinPct({ winPercentage: 0.5, gamesPlayed: 4 })).toBe('50.0%');
    expect(formatWinPct({ winPercentage: 0, gamesPlayed: 0 })).toBe('—');
    expect(formatPpb({ bonuses: 4, bonusPoints: 50 })).toBe('12.50');
    expect(formatPpb({ bonuses: 0, bonusPoints: 0 })).toBe('—');
    expect(formatPptuh(100, { tossupsHeard: 20 })).toBe('5.00');
    expect(formatPptuh(100, { tossupsHeard: 0 })).toBe('—');
    expect(formatPptuh(100, { tossupsHeard: 20, tossupsHeardKnown: false })).toBe('—');
  });

  test('the team mapping covers the schema core and matches printable math', () => {
    const standing = {
      teamId: 'team-a',
      wins: 1,
      losses: 0,
      ties: 0,
      winPercentage: 1,
      pointsFor: 300,
      pointsAgainst: 210,
      margin: 90,
      superpowers: 0,
      powers: 4,
      powersKnown: true,
      gets: 8,
      getsKnown: true,
      negs: 1,
      tossupsHeard: 40,
      tossupsHeardKnown: true,
      bonuses: 12,
      bonusPoints: 130,
      gamesPlayed: 1,
      headToHead: 0,
    };
    expect(teamStatCell('record', standing)).toBe('1–0');
    expect(teamStatCell('games', standing)).toBe('1');
    expect(teamStatCell('ppg', standing)).toBe('300.0');
    expect(teamStatCell('tuh', standing)).toBe('40');
    expect(teamStatCell('pptuh', standing)).toBe('7.50');
    expect(teamStatCell('ppb', standing)).toBe('10.83');
    expect(teamStatCell('nope', standing)).toBe('—');
  });

  test('the individual mapping renders unknown TUH as unknown', () => {
    const played = {
      playerId: 'player-a',
      teamId: 'team-a',
      gamesPlayed: 1,
      tossupsHeard: 20,
      superpowers: 0,
      powers: 4,
      gets: 8,
      negs: 1,
      bonusPoints: 130,
      points: 170,
      ppg: 170,
    };
    expect(playerStatCell('tuh', played)).toBe('20');
    expect(playerStatCell('pptuh', played)).toBe('8.50');
    expect(playerStatCell('tuh', { ...played, tossupsHeardKnown: false })).toBe('—');
    expect(playerStatCell('pptuh', { ...played, tossupsHeardKnown: false })).toBe('—');
  });
});
