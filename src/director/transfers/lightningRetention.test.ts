/**
 * Lightning points survive Director ingest into the canonical game model (#747, epic #755).
 *
 * The scorer already exports `lightning_points`; ingest used to read that value only to keep
 * inferred bonus points honest and then discarded it. These assertions stop that regression:
 * a supplied breakdown is retained on the canonical score, a missing breakdown stays unknown
 * (null, never a fabricated zero), and the canonical standings aggregate only known values.
 */
import { describe, expect, test } from 'vitest';
import { isoNow, type DirectorState } from '../domain/model';
import { deriveTeamStandings } from '../domain/stats';
import { buildCanonicalSnapshot } from '../reports/canonicalReports';
import { digestText } from './canonical';
import { assessIncomingDocument, stageIncomingDocument, type IncomingDocument } from './ingest';
import { assignmentFor, directorFixture, scoreAssignment } from './testFixtures';

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
  if (!submission) throw new Error('lightning: no such submission');
  submission.status = 'accepted';
  submission.acceptedAt = isoNow();
  const game = state.games.find((entry) => entry.id === submission.gameId);
  if (!game) throw new Error('lightning: no such game');
  game.status = 'accepted';
  game.acceptedAt = submission.acceptedAt;
}

/** A scored result whose left team earned 30 lightning points; the right team has no breakdown. */
function lightningResult(state: DirectorState): Record<string, unknown> {
  const document = scoreAssignment(assignmentFor(state, 'game-5-1').document) as unknown as {
    objects: Array<Record<string, unknown>>;
  };
  const match = document.objects.find((object) => object.type === 'Match');
  if (!match) throw new Error('lightning: the assignment has no match');
  const teams = match.match_teams as Array<Record<string, unknown>>;
  teams[0].lightning_points = 30;
  return document as unknown as Record<string, unknown>;
}

describe('lightning-round retention', () => {
  test('ingest retains a supplied breakdown and keeps a missing one unknown', () => {
    const state = directorFixture();
    const assessment = assessIncomingDocument(state, documentFor(lightningResult(state)));
    expect(assessment.scores).toHaveLength(2);
    expect(assessment.scores[0]?.lightningPoints).toBe(30);
    expect(assessment.scores[1]?.lightningPoints).toBeNull();
  });

  test('canonical standings aggregate known lightning and mark unknown teams', () => {
    const state = directorFixture();
    const document = documentFor(lightningResult(state));
    const assessment = assessIncomingDocument(state, document);
    const outcome = stageIncomingDocument(state, document, assessment);
    acceptSubmission(state, outcome.submissionId);

    const standings = deriveTeamStandings(state);
    const left = standings.find((entry) => entry.teamId === assessment.scores[0]?.teamId);
    const right = standings.find((entry) => entry.teamId === assessment.scores[1]?.teamId);
    expect(left?.lightningPoints).toBe(30);
    expect(left?.lightningKnown).toBe(true);
    expect(right?.lightningKnown).toBe(false);

    const snapshot = buildCanonicalSnapshot(state);
    expect(snapshot.teams.find((row) => row.teamId === left?.teamId)?.lightningPoints).toBe(30);
    expect(snapshot.teams.find((row) => row.teamId === right?.teamId)?.lightningPoints).toBeNull();
  });
});
