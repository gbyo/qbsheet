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
import { exportArchiveBytes, exportQbj, importArchiveBytes, importQbjText } from './interchange';
import { directorFixture } from '../transfers/testFixtures';

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
