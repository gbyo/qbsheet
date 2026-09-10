/**
 * Historical statistics come from each game's own definition, never live defaults (#671).
 *
 * - A late result scored under an issued power=15 definition still buckets and values its
 *   15-point powers as powers after the tournament default moves to 20.
 * - A game reissued at power=20 values its own powers at 20 while every other game keeps 15.
 * - Mutating every future-default scoring field leaves accepted-game outputs deep-equal.
 */
import { describe, expect, test } from 'vitest';
import {
  activeDefinitionSnapshot,
  pinIssuedDefinitions,
  reissueGameDefinition,
} from '../domain/gameDefinitions';
import type { DirectorState } from '../domain/model';
import { derivePlayerStandings, deriveTeamStandings } from '../domain/stats';
import { digestText } from './canonical';
import { assessIncomingDocument, stageIncomingDocument, type IncomingDocument } from './ingest';
import { assignmentFor, directorFixture, scoreAssignment } from './testFixtures';
import { isoNow } from '../domain/model';

function documentFor(qbj: unknown, overrides: Partial<IncomingDocument> = {}): IncomingDocument {
  const text = JSON.stringify(qbj);
  return {
    sourceKind: 'removable-drive',
    sourceLabel: 'SanDisk Ultra',
    fileName: 'result.qbj',
    byteLength: text.length,
    digest: digestText(text),
    qbj,
    ...overrides,
  };
}

function acceptSubmission(state: DirectorState, submissionId: string | undefined): void {
  const submission = state.submissions.find((entry) => entry.id === submissionId);
  if (!submission) throw new Error('historical-stats: no such submission');
  submission.status = 'accepted';
  submission.acceptedAt = isoNow();
  const game = state.games.find((entry) => entry.id === submission.gameId);
  if (!game) throw new Error('historical-stats: no such game');
  game.status = 'accepted';
  game.acceptedAt = submission.acceptedAt;
}

function stageResult(state: DirectorState, qbj: unknown) {
  const document = documentFor(qbj);
  const assessment = assessIncomingDocument(state, document);
  const outcome = stageIncomingDocument(state, document, assessment);
  return { assessment, outcome };
}

/** Rewrite every 15-point answer type in a scored document to 20, as a repriced room would send. */
function repricePowersToTwenty(qbj: Record<string, unknown>): Record<string, unknown> {
  const document = structuredClone(qbj) as { objects: Array<Record<string, unknown>> };
  const match = document.objects.find((object) => object.type === 'Match');
  const teams = match?.match_teams as Array<Record<string, unknown>> | undefined;
  for (const team of teams ?? []) {
    const players = team.match_players as Array<Record<string, unknown>> | undefined;
    for (const player of players ?? []) {
      const counts = player.answer_counts as Array<Record<string, unknown>> | undefined;
      for (const count of counts ?? []) {
        const answerType = count.answer_type as Record<string, unknown> | undefined;
        if (answerType && answerType.value === 15) answerType.value = 20;
      }
    }
  }
  return document;
}

function captainPoints(state: DirectorState, playerId: string): number {
  const standing = derivePlayerStandings(state).find((entry) => entry.playerId === playerId);
  if (!standing) throw new Error(`historical-stats: no standing for ${playerId}`);
  return standing.points;
}

describe('statistics under per-game definitions', () => {
  test('a late result is bucketed and valued under its issued definition, not live defaults', () => {
    const state = directorFixture({ games: 2 });
    pinIssuedDefinitions(state, ['game-5-1', 'game-5-2']);
    const scored = scoreAssignment(assignmentFor(state, 'game-5-1').document);

    // The future arrives before the straggler: power is now worth 20 for new games.
    state.tournament!.rules.powerValue = 20;

    const { assessment, outcome } = stageResult(state, scored);
    expect(assessment.classification).toBe('ready');
    expect(assessment.warnings).toEqual([]);
    acceptSubmission(state, outcome.submissionId);

    // Four 15-point powers, eight 10-point gets, one neg: 60 + 80 - 5 under the issued truth.
    expect(captainPoints(state, 'team-1-player-1')).toBe(135);
    expect(state.games.find((game) => game.id === outcome.gameId)?.definitionSource).toBe('issued');
  });

  test('a repriced game values its own powers at 20 while other games keep 15', () => {
    const state = directorFixture({ games: 2 });
    pinIssuedDefinitions(state, ['game-5-1', 'game-5-2']);
    const first = stageResult(state, scoreAssignment(assignmentFor(state, 'game-5-1').document));
    acceptSubmission(state, first.outcome.submissionId);

    // Only game-5-2 moves to power=20; the tournament default still says 15.
    state.tournament!.rules.powerValue = 20;
    const reissued = reissueGameDefinition(state, 'game-5-2', 'Director');
    expect(reissued.ok).toBe(true);
    const expected = activeDefinitionSnapshot(state, 'game-5-2')!;
    expect(expected.revision).toBe(2);
    const repriced = repricePowersToTwenty(
      scoreAssignment(assignmentFor(state, 'game-5-2').document) as Record<string, unknown>,
    );
    const second = stageResult(state, repriced);
    expect(second.assessment.classification).toBe('ready');
    acceptSubmission(state, second.outcome.submissionId);

    expect(captainPoints(state, 'team-1-player-1')).toBe(135);
    // Same line shape, but this game's four powers are worth 20: 80 + 80 - 5.
    expect(captainPoints(state, 'team-3-player-1')).toBe(155);
  });

  test('mutating future defaults leaves accepted-game outputs deep-equal', () => {
    const state = directorFixture({ games: 2 });
    pinIssuedDefinitions(state, ['game-5-1', 'game-5-2']);
    const first = stageResult(state, scoreAssignment(assignmentFor(state, 'game-5-1').document));
    acceptSubmission(state, first.outcome.submissionId);

    state.tournament!.rules.powerValue = 20;
    const reissued = reissueGameDefinition(state, 'game-5-2', 'Director');
    expect(reissued.ok).toBe(true);
    const second = stageResult(
      state,
      repricePowersToTwenty(
        scoreAssignment(assignmentFor(state, 'game-5-2').document) as Record<string, unknown>,
      ),
    );
    acceptSubmission(state, second.outcome.submissionId);

    const before = JSON.stringify({
      players: derivePlayerStandings(state),
      teams: deriveTeamStandings(state),
    });

    state.tournament!.rules.powerValue = 25;
    state.tournament!.rules.tossupValue = 12;
    state.tournament!.rules.negValue = -10;
    state.tournament!.rules.superpowerValue = 30;
    state.tournament!.rules.bouncebacks = !state.tournament!.rules.bouncebacks;

    expect(
      JSON.stringify({
        players: derivePlayerStandings(state),
        teams: deriveTeamStandings(state),
      }),
    ).toBe(before);
  });
});
