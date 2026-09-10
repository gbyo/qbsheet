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
import { digestText } from '../transfers/canonical';
import { assessIncomingDocument, stageIncomingDocument } from '../transfers/ingest';
import { assignmentFor, directorFixture, scoreAssignment } from '../transfers/testFixtures';

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

describe('player UG/D2 eligibility round-trip (#749)', () => {
  function eligibilityFixture() {
    const state = directorFixture();
    const [first, second, third] = state.players;
    if (!first || !second || !third) throw new Error('fixture needs three players');
    first.undergraduateEligible = true;
    first.divisionTwoEligible = false;
    second.undergraduateEligible = false;
    second.divisionTwoEligible = false;
    // The third player stays unknown: no flags at all.
    return { state, first, second, third };
  }

  it('archive interchange preserves explicit true, explicit false, and unknown', () => {
    const { state, first, second, third } = eligibilityFixture();
    const restored = importDirectorTournament(toInterchange(state));
    expect(restored.players.find((player) => player.id === first.id)).toMatchObject({
      undergraduateEligible: true,
      divisionTwoEligible: false,
    });
    expect(restored.players.find((player) => player.id === second.id)).toMatchObject({
      undergraduateEligible: false,
      divisionTwoEligible: false,
    });
    const unknown = restored.players.find((player) => player.id === third.id);
    expect(unknown?.undergraduateEligible).toBeUndefined();
    expect(unknown?.divisionTwoEligible).toBeUndefined();
  });

  it('QBJ export carries the same tri-state through player extensions', () => {
    const { state, first, third } = eligibilityFixture();
    const report = importQbjText(exportQbj(state));
    expect(report.errors).toEqual([]);
    const restored = report.state;
    if (!restored) throw new Error('qbj import produced no state');
    expect(restored.players.find((player) => player.id === first.id)).toMatchObject({
      undergraduateEligible: true,
      divisionTwoEligible: false,
    });
    const unknown = restored.players.find((player) => player.id === third.id);
    expect(unknown?.undergraduateEligible).toBeUndefined();
    expect(unknown?.divisionTwoEligible).toBeUndefined();
  });

  it('never invents player eligibility from team classifications', () => {
    const { state, third } = eligibilityFixture();
    const team = state.teams.find((entry) => entry.id === third.teamId);
    if (!team) throw new Error('fixture player has no team');
    team.classifications = ['undergraduate', 'division-2'];
    const restored = importDirectorTournament(toInterchange(state));
    const unknown = restored.players.find((player) => player.id === third.id);
    expect(unknown?.undergraduateEligible).toBeUndefined();
    expect(unknown?.divisionTwoEligible).toBeUndefined();
  });
});

describe('lightning points round-trip (#747)', () => {
  function acceptedGameWithLightning() {
    const state = directorFixture();
    const scored = scoreAssignment(assignmentFor(state, 'game-5-1').document);
    const text = JSON.stringify(scored);
    const incoming = {
      sourceKind: 'removable-drive' as const,
      sourceLabel: 'SanDisk Ultra',
      fileName: 'result.qbj',
      byteLength: text.length,
      digest: digestText(text),
      qbj: scored,
    };
    const assessment = assessIncomingDocument(state, incoming);
    const outcome = stageIncomingDocument(state, incoming, assessment);
    const submission = state.submissions.find((entry) => entry.id === outcome.submissionId);
    if (!submission) throw new Error('fixture staged no submission');
    submission.status = 'accepted';
    submission.acceptedAt = '2026-09-05T18:00:00.000Z';
    const game = state.games.find((entry) => entry.id === submission.gameId);
    if (!game) throw new Error('fixture staged no game');
    game.status = 'accepted';
    game.acceptedAt = submission.acceptedAt;
    // The left team ran a lightning round for 45 points; the right team has no breakdown.
    game.scores[0].lightningPoints = 45;
    return { state, game };
  }

  it('interchange preserves known lightning and keeps unknown lightning unknown', () => {
    const { state, game } = acceptedGameWithLightning();
    const restored = importDirectorTournament(toInterchange(state));
    const restoredGame = restored.games.find((entry) => entry.id === game.id);
    expect(restoredGame?.scores[0]?.lightningPoints).toBe(45);
    expect(restoredGame?.scores[1]?.lightningPoints).toBeNull();
  });

  it('QBJ export carries known lightning back into canonical scores', () => {
    const { state, game } = acceptedGameWithLightning();
    const report = importQbjText(exportQbj(state));
    expect(report.errors).toEqual([]);
    const restored = report.state;
    if (!restored) throw new Error('qbj import produced no state');
    // A QBJ hand-off re-keys schedule linkage, so match the game by its teams.
    const teamIds = game.scores.map((score) => score.teamId).sort();
    const restoredGame = restored.games.find(
      (entry) =>
        entry.scores
          .map((score) => score.teamId)
          .sort()
          .join() === teamIds.join() && entry.scores[0]?.score === game.scores[0]?.score,
    );
    if (!restoredGame) throw new Error('qbj import produced no matching game');
    expect(restoredGame.scores[0]?.lightningPoints).toBe(45);
  });
});
