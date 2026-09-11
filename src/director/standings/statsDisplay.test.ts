import { beforeEach, describe, expect, test } from 'vitest';
import { deriveTeamStandings } from '../domain';
import { playedTournament } from '../../../tests/directorFixtures';
import {
  bonusesInUse,
  bouncebacksInUse,
  buildStatsScopes,
  defaultIndividualColumnIds,
  defaultTeamColumnIds,
  formatEligibility,
  formatMargin,
  formatPpb,
  formatPptuh,
  formatRecord,
  formatWinPct,
  individualColumnsForState,
  lightningInUse,
  loadStatsColumnPrefs,
  orderByFinalPlacement,
  playerDivisionTwoInUse,
  playerRankTies,
  playerStatCell,
  playerUndergraduateInUse,
  playerYearInUse,
  presentationForStats,
  saveStatsColumnPrefs,
  scopeOptionsFor,
  superpowersInUse,
  teamColumnsForState,
  teamStatCell,
  tiedTeamIds,
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
    // Normalized Pts/X is one shared schema: both tables offer it on single-X scopes (#750).
    expect(teams).toContain('ppx');
    expect(individualColumnsForState(state).map((column) => column.id)).toContain('ppx');
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
      bouncebackPoints: 0,
      bouncebacksKnown: true,
      bouncebackPartsHeard: null,
      bouncebackPartsConverted: null,
      bouncebackConversion: null,
      totalBonusConversion: null,
      lightningPoints: 0,
      lightningKnown: true,
      lightningGames: 1,
      tossupsHeardRegulation: 40,
      tossupsHeardRegulationKnown: true,
      overtimePoints: 0,
      overtimePointsKnown: true,
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
      gamesPlayedKnown: true,
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
    // Normalized Pts/X is PPTUH × X, the shared-helper expression the
    // printable schema uses; without X it declines like every rate (#750).
    expect(playerStatCell('ppx', played, undefined, { pointsTossups: 20 })).toBe('170.00');
    expect(playerStatCell('ppx', played)).toBe('—');
    expect(
      playerStatCell('ppx', { ...played, tossupsHeardKnown: false }, undefined, { pointsTossups: 20 }),
    ).toBe('—');
  });

  test('the individual mapping renders unknown participation as unknown, not zero', () => {
    const played = {
      playerId: 'player-a',
      teamId: 'team-a',
      gamesPlayed: 0,
      gamesPlayedKnown: false,
      tossupsHeard: 20,
      superpowers: 0,
      powers: 4,
      gets: 8,
      negs: 1,
      bonusPoints: 130,
      points: 170,
      ppg: 0,
    };
    // Lined players with no game denominator keep their row; G and PPG stay unknown (#746).
    expect(playerStatCell('games', played)).toBe('—');
    expect(playerStatCell('ppg', played)).toBe('—');
    expect(playerStatCell('points', played)).toBe('170');
  });
});

describe('parity columns (#750)', () => {
  function bouncebackStanding() {
    return {
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
      tossupsHeardRegulation: 40,
      tossupsHeardRegulationKnown: true,
      overtimePoints: 30,
      overtimePointsKnown: true,
      bonuses: 12,
      bonusPoints: 130,
      bouncebackPoints: 30,
      bouncebacksKnown: true,
      bouncebackPartsHeard: 21,
      bouncebackPartsConverted: 3,
      bouncebackConversion: 3 / 21,
      totalBonusConversion: 16 / 57,
      lightningPoints: 45,
      lightningKnown: true,
      lightningGames: 1,
      gamesPlayed: 1,
      headToHead: 0,
    };
  }

  test('a bounceback format offers BB columns; a standard format does not', () => {
    const plain = playedTournament();
    expect(bouncebacksInUse(plain)).toBe(false);
    const plainIds = teamColumnsForState(plain).map((column) => column.id);
    for (const id of ['bbpoints', 'bbheard', 'bbconv', 'totalbonus']) {
      expect(plainIds).not.toContain(id);
    }

    const bounceback = playedTournament();
    bounceback.tournament!.rules.bouncebacks = true;
    expect(bouncebacksInUse(bounceback)).toBe(true);
    const ids = teamColumnsForState(bounceback).map((column) => column.id);
    for (const id of ['bbpoints', 'bbheard', 'bbconv', 'totalbonus']) {
      expect(ids).toContain(id);
    }
  });

  test('observed bounceback play keeps the columns without a configured rule', () => {
    const state = playedTournament();
    state.games[0]!.scores[0]!.bouncebacks = 30;
    expect(bouncebacksInUse(state)).toBe(true);
    expect(teamColumnsForState(state).map((column) => column.id)).toContain('bbpoints');
  });

  test('a tossup-only format drops BB and lightning columns with the bonus family', () => {
    const state = playedTournament();
    state.tournament!.rules.useBonuses = false;
    state.tournament!.rules.bouncebacks = false;
    for (const game of state.games) {
      for (const score of game.scores) {
        score.bonuses = 0;
        score.bonusPoints = 0;
        score.bouncebacks = 0;
      }
    }
    const ids = teamColumnsForState(state).map((column) => column.id);
    for (const id of ['ppb', 'bbpoints', 'bbheard', 'bbconv', 'totalbonus', 'lightning', 'lightningpg']) {
      expect(ids).not.toContain(id);
    }
    // PPTUH and Pts/X are tossup facts, not bonus facts.
    expect(ids).toContain('pptuh');
    expect(ids).toContain('ppx');
  });

  test('BB cells report parts and shared-format percents, unknown stays unknown', () => {
    const standing = bouncebackStanding();
    expect(teamStatCell('bbpoints', standing)).toBe('30');
    expect(teamStatCell('bbheard', standing)).toBe('21');
    expect(teamStatCell('bbconv', standing)).toBe('14.3%');
    expect(teamStatCell('totalbonus', standing)).toBe('28.1%');

    const unknown = { ...standing, bouncebacksKnown: false, bouncebackPoints: 12 };
    expect(teamStatCell('bbpoints', unknown)).toBe('—');
    const noParts = { ...standing, bouncebackPartsHeard: null, bouncebackConversion: null };
    expect(teamStatCell('bbheard', noParts)).toBe('—');
    expect(teamStatCell('bbconv', noParts)).toBe('—');
    expect(teamStatCell('totalbonus', { ...standing, totalBonusConversion: null })).toBe('—');
  });

  test('lightning columns gate on the lightning game and rate honestly', () => {
    const plain = playedTournament();
    expect(lightningInUse(plain)).toBe(false);
    expect(teamColumnsForState(plain).map((column) => column.id)).not.toContain('lightning');

    const lightning = playedTournament();
    lightning.tournament!.rules.lightning = true;
    const ids = teamColumnsForState(lightning).map((column) => column.id);
    expect(ids).toContain('lightning');
    expect(ids).toContain('lightningpg');

    const standing = bouncebackStanding();
    expect(teamStatCell('lightning', standing)).toBe('45');
    expect(teamStatCell('lightningpg', standing)).toBe('45.0');
    expect(teamStatCell('lightning', { ...standing, lightningKnown: false })).toBe('—');
    expect(teamStatCell('lightningpg', { ...standing, lightningKnown: false })).toBe('—');
    expect(teamStatCell('lightningpg', { ...standing, lightningGames: 0 })).toBe('—');
    // A forfeit-inflated games-played count must not dilute the rate (#755).
    expect(teamStatCell('lightningpg', { ...standing, gamesPlayed: 2 })).toBe('45.0');
  });

  test('Pts/X uses the shared normalization and drops out when counts disagree', () => {
    const state = playedTournament();
    const columns = teamColumnsForState(state);
    expect(columns.find((column) => column.id === 'ppx')?.label).toBe('Pts/20');
    // 300 final points include 30 overtime points, so regulation Pts/20 is
    // (300 − 30) / 40 × 20 = 135.00 — final-score PPTUH would wrongly give 150.00.
    expect(teamStatCell('ppx', bouncebackStanding(), { pointsTossups: 20 })).toBe('135.00');
    expect(teamStatCell('ppx', bouncebackStanding(), { pointsTossups: null })).toBe('—');
    expect(
      teamStatCell('ppx', { ...bouncebackStanding(), overtimePointsKnown: false }, { pointsTossups: 20 }),
    ).toBe('—');

    const rules = state.tournament!.rules;
    state.gameDefinitions = [
      {
        id: 'def-1',
        scheduledGameId: 'scheduled-1',
        revision: 1,
        createdAt: '2026-09-05T12:00:00.000Z',
        rules: { ...rules },
        roundId: 'round-1',
        packetId: null,
        leftTeamId: 'team-a',
        rightTeamId: 'team-b',
        leftRoster: [],
        rightRoster: [],
        assignmentRevision: 1,
        digest: 'digest-20',
      },
      {
        id: 'def-2',
        scheduledGameId: 'scheduled-1',
        revision: 2,
        createdAt: '2026-09-05T13:00:00.000Z',
        rules: { ...rules, tossupCount: 15 },
        roundId: 'round-1',
        packetId: null,
        leftTeamId: 'team-a',
        rightTeamId: 'team-b',
        leftRoster: [],
        rightRoster: [],
        assignmentRevision: 2,
        digest: 'digest-15',
      },
    ];
    const mixed = teamColumnsForState(state).map((column) => column.id);
    expect(mixed).not.toContain('ppx');
    expect(presentationForStats(state).mixedDefinitionNote).toMatch(/vary/);
  });

  test('tier labels carry configured values from the shared presentation', () => {
    const state = playedTournament();
    const labels = new Map(teamColumnsForState(state).map((column) => [column.id, column.label]));
    expect(labels.get('powers')).toBe('Powers (15)');
    expect(labels.get('gets')).toBe('Gets (10)');
    expect(labels.get('negs')).toBe('Negs (-5)');

    state.tournament!.rules.powerValue = 20;
    const relabeled = new Map(teamColumnsForState(state).map((column) => [column.id, column.label]));
    expect(relabeled.get('powers')).toBe('Powers (20)');
  });

  test('W/L/T and classification cells expose record context', () => {
    const standing = bouncebackStanding();
    expect(teamStatCell('wins', standing)).toBe('1');
    expect(teamStatCell('losses', standing)).toBe('0');
    expect(teamStatCell('ties', standing)).toBe('0');
    expect(teamStatCell('class', standing)).toBe('—');
    expect(teamStatCell('class', standing, { classifications: ['small-school'] })).toBe('Small School');

    const plain = playedTournament();
    expect(teamColumnsForState(plain).map((column) => column.id)).not.toContain('class');
    plain.teams[0]!.classifications = ['small-school'];
    expect(teamColumnsForState(plain).map((column) => column.id)).toContain('class');
  });

  test('player metadata columns gate on observed roster fields', () => {
    const plain = playedTournament();
    const plainIds = individualColumnsForState(plain).map((column) => column.id);
    expect(plainIds).not.toContain('year');
    expect(plainIds).not.toContain('ug');
    expect(plainIds).not.toContain('d2');

    const state = playedTournament();
    state.players[0]!.schoolYear = 10;
    state.players[0]!.undergraduateEligible = true;
    state.players[1]!.undergraduateEligible = false;
    state.players[0]!.divisionTwoEligible = null;
    expect(playerYearInUse(state)).toBe(true);
    expect(playerUndergraduateInUse(state)).toBe(true);
    expect(playerDivisionTwoInUse(state)).toBe(false);
    const ids = individualColumnsForState(state).map((column) => column.id);
    expect(ids).toContain('year');
    expect(ids).toContain('ug');
    expect(ids).not.toContain('d2');

    const played = {
      playerId: 'player-a',
      teamId: 'team-a',
      gamesPlayed: 1,
      gamesPlayedKnown: true,
      tossupsHeard: 20,
      superpowers: 0,
      powers: 4,
      gets: 8,
      negs: 1,
      bonusPoints: 130,
      points: 170,
      ppg: 170,
    };
    expect(playerStatCell('year', played, state.players[0])).toBe('Grade 10');
    expect(playerStatCell('year', played)).toBe('—');
    expect(playerStatCell('ug', played, state.players[0])).toBe('Yes');
    expect(playerStatCell('ug', played, state.players[1])).toBe('No');
    expect(playerStatCell('ug', played)).toBe('—');
    expect(formatEligibility(null)).toBe('—');
  });

  test('canonical rank groupings mark ties, players tie on shared rates', () => {
    expect(
      tiedTeamIds(
        new Map([
          ['a', 1],
          ['b', 1],
          ['c', 3],
        ]),
      ),
    ).toEqual(new Set(['a', 'b']));
    expect(
      tiedTeamIds(
        new Map([
          ['a', 1],
          ['b', 2],
        ]),
      ),
    ).toEqual(new Set());

    const first = {
      playerId: 'p1',
      teamId: 't',
      gamesPlayed: 1,
      gamesPlayedKnown: true,
      tossupsHeard: 20,
      superpowers: 0,
      powers: 4,
      gets: 8,
      negs: 1,
      bonusPoints: 0,
      points: 100,
      ppg: 100,
    };
    const equal = { ...first, playerId: 'p2' };
    const different = { ...first, playerId: 'p3', points: 110, ppg: 110 };
    expect(playerRankTies([first, equal])).toEqual(new Set(['p1', 'p2']));
    expect(playerRankTies([first, different])).toEqual(new Set());
  });

  test('final placement orders listed teams first and keeps the rest calculated', () => {
    const state = playedTournament();
    state.teams.push(
      { ...state.teams[0]!, id: 'team-c', displayName: 'Abbeville' },
      { ...state.teams[0]!, id: 'team-d', displayName: 'Dixie' },
    );
    const standings = deriveTeamStandings(state);
    expect(standings.map((entry) => entry.teamId)).toEqual(['team-a', 'team-b', 'team-c', 'team-d']);
    expect(orderByFinalPlacement(standings, ['team-d', 'team-a']).map((entry) => entry.teamId)).toEqual([
      'team-d',
      'team-a',
      'team-b',
      'team-c',
    ]);
  });

  test('final and carryover scopes reuse the canonical selectors', () => {
    const state = playedTournament();
    state.phases.push({
      id: 'phase-2',
      name: 'Playoffs',
      kind: 'playoff',
      order: 2,
      formatId: 'format-1',
      poolIds: ['pool-2'],
      roundIds: [],
      advancementRule: null,
      carryover: true,
      status: 'active',
    });
    state.pools.push({
      id: 'pool-2',
      phaseId: 'phase-2',
      name: 'Championship',
      teamIds: ['team-a', 'team-b'],
      order: 1,
    });
    state.tournament!.finalPlacement = {
      order: ['team-b', 'team-a'],
      actor: 'director',
      at: '2026-09-05T12:00:00.000Z',
    };

    const scopes = buildStatsScopes(state);
    expect(scopes.scopes.map((scope) => scope.id)).toEqual([
      'overall',
      'final',
      'phase:phase-1',
      'phase:phase-2',
      'carryover:phase-2:',
      'pool:pool-2',
      'carryover:phase-2:pool-2',
    ]);
    const carryover = scopes.scopes.find((scope) => scope.id === 'carryover:phase-2:pool-2')!;
    expect(carryover.label).toBe('Playoffs · Championship · including carryover');
    // Carryover and final scopes resolve game sets at the call site, not here.
    expect(scopeOptionsFor(carryover)).toEqual({});
    expect(scopeOptionsFor(scopes.scopes.find((scope) => scope.id === 'final')!)).toEqual({});
    expect(scopeOptionsFor(scopes.scopes.find((scope) => scope.id === 'phase:phase-1')!)).toEqual({
      phaseId: 'phase-1',
    });
  });
});
