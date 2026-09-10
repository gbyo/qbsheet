/**
 * Reporting classifications, player school year, and final placement survive
 * the interchange round trip.
 *
 * The lossless archive path restores the embedded Director document exactly.
 * The foreign QBJ path carries the same fields through native QBJ vocabulary
 * (player grade) and safe record extensions (team classifications/tags and
 * the tournament final placement), so a .qbj hand-off to another tool does
 * not silently drop them.
 */

import { describe, expect, it } from 'vitest';
import {
  exportArchiveBytes,
  exportQbj,
  importArchiveBytes,
  importDirectorTournament,
  importQbjText,
  toInterchange,
} from './interchange';
import { directorFixture } from '../transfers/testFixtures';
import { acceptedGame } from '../../../tests/directorFixtures';

function classifiedFixture() {
  const state = directorFixture({ games: 1 });
  const first = state.teams[0];
  if (!first) throw new Error('fixture has no teams');
  first.classifications = ['small-school', 'junior-varsity'];
  first.tags = ['region-3'];
  const firstPlayer = state.players.find((player) => player.teamId === first.id);
  if (!firstPlayer) throw new Error('fixture has no players');
  firstPlayer.schoolYear = 10;
  const second = state.teams[1];
  if (!second) throw new Error('fixture needs two teams');
  if (!state.tournament) throw new Error('fixture has no tournament');
  state.tournament.finalPlacement = {
    order: [second.id, first.id],
    actor: 'Director',
    at: '2026-09-05T18:00:00.000Z',
    reason: 'Final decided on the last question.',
  };
  state.tournament.endDate = '2026-09-06';
  state.tournament.questionSet = 'ACF Fall 2025';
  return { state, first, firstPlayer, second };
}

describe('classifications, school year, and final placement round-trip', () => {
  it('archive export preserves every new field exactly', () => {
    const { state, first, firstPlayer } = classifiedFixture();
    const report = importArchiveBytes(exportArchiveBytes(state));
    expect(report.errors).toEqual([]);
    const restored = report.state;
    if (!restored) throw new Error('archive import produced no state');
    expect(restored.teams.find((team) => team.id === first.id)?.classifications).toEqual([
      'small-school',
      'junior-varsity',
    ]);
    expect(restored.teams.find((team) => team.id === first.id)?.tags).toEqual(['region-3']);
    expect(restored.players.find((player) => player.id === firstPlayer.id)?.schoolYear).toBe(10);
    expect(restored.tournament?.finalPlacement).toEqual(state.tournament?.finalPlacement);
    expect(restored.tournament?.endDate).toBe('2026-09-06');
    expect(restored.tournament?.questionSet).toBe('ACF Fall 2025');
  });

  it('foreign QBJ carries the same fields through grade and extensions', () => {
    const { first, firstPlayer, second } = classifiedFixture();
    const report = importQbjText(exportQbj(classifiedFixture().state));
    expect(report.errors).toEqual([]);
    const restored = report.state;
    if (!restored) throw new Error('qbj import produced no state');
    expect(restored.teams.find((team) => team.id === first.id)?.classifications).toEqual([
      'small-school',
      'junior-varsity',
    ]);
    expect(restored.teams.find((team) => team.id === first.id)?.tags).toEqual(['region-3']);
    expect(restored.players.find((player) => player.id === firstPlayer.id)?.schoolYear).toBe(10);
    expect(restored.tournament?.finalPlacement?.order).toEqual([second.id, first.id]);
    expect(restored.tournament?.finalPlacement?.reason).toBe('Final decided on the last question.');
    expect(restored.tournament?.endDate).toBe('2026-09-06');
    expect(restored.tournament?.questionSet).toBe('ACF Fall 2025');
  });

  it('the tiebreaker statistical-counting rule round-trips through extensions', () => {
    const { state } = classifiedFixture();
    if (!state.tournament) throw new Error('fixture has no tournament');
    state.tournament.rules.tiebreakerCountsStatistically = true;
    const report = importQbjText(exportQbj(state));
    expect(report.errors).toEqual([]);
    const restored = report.state;
    if (!restored) throw new Error('qbj import produced no state');
    expect(restored.tournament?.rules.tiebreakerCountsStatistically).toBe(true);
  });

  it('an absent tiebreaker statistical-counting rule stays absent', () => {
    const { state } = classifiedFixture();
    const report = importQbjText(exportQbj(state));
    expect(report.errors).toEqual([]);
    const restored = report.state;
    if (!restored) throw new Error('qbj import produced no state');
    expect(restored.tournament?.rules.tiebreakerCountsStatistically).toBeUndefined();
  });

  it('a free-text foreign grade never fabricates a school year', () => {
    const { state } = classifiedFixture();
    const exported = exportQbj(state).replace('"grade": "10"', '"grade": "Sophomore"');
    const report = importQbjText(exported);
    expect(report.errors).toEqual([]);
    const restored = report.state;
    if (!restored) throw new Error('qbj import produced no state');
    for (const player of restored.players) {
      expect(player.schoolYear).toBeUndefined();
    }
  });
});

describe('exact match TUH round-trip (#746)', () => {
  function tuhFixture() {
    const state = directorFixture({ games: 1 });
    state.games.push(
      acceptedGame(
        'game-tuh-1',
        'game-5-1',
        [
          {
            teamId: 'team-1',
            score: 200,
            superpowers: 0,
            powers: 0,
            gets: 0,
            negs: 0,
            bonuses: 0,
            bonusPoints: 0,
            bouncebacks: 0,
          },
          {
            teamId: 'team-2',
            score: 100,
            superpowers: 0,
            powers: 0,
            gets: 0,
            negs: 0,
            bonuses: 0,
            bonusPoints: 0,
            bouncebacks: 0,
          },
        ],
        [],
        { tossupsRead: 22, overtimeTossupsRead: 2 },
      ),
    );
    return state;
  }

  it('archive interchange preserves exact match TUH', () => {
    const restored = importDirectorTournament(toInterchange(tuhFixture()));
    const game = restored.games.find((entry) => entry.id === 'game-tuh-1');
    expect(game?.tossupsRead).toBe(22);
    expect(game?.overtimeTossupsRead).toBe(2);
  });

  it('QBJ export carries exact match TUH back onto the game record', () => {
    const report = importQbjText(exportQbj(tuhFixture()));
    expect(report.errors).toEqual([]);
    const restored = report.state;
    if (!restored) throw new Error('qbj import produced no state');
    const game = restored.games.find((entry) =>
      entry.scores.some((score) => score.teamId === 'team-1' && score.score === 200),
    );
    if (!game) throw new Error('qbj import produced no matching game');
    expect(game.tossupsRead).toBe(22);
    expect(game.overtimeTossupsRead).toBe(2);
  });
});
