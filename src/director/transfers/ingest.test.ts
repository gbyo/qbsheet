/**
 * Classification: what Director decides a returned file is, and why.
 *
 * These are the assertions that stop the two failures this feature could cause that a tournament
 * could not undo: an unplayed assignment imported as a 0-0 final, and a result scored against a
 * bracket that has since been redrawn silently overwriting the current one.
 */
import { describe, expect, it } from 'vitest';
import { digestText } from './canonical';
import {
  assessIncomingDocument,
  ingestWarnings,
  stageIncomingDocument,
  type IncomingDocument,
} from './ingest';
import { parseTransferJson, hasScoringContent, maxJsonDepth } from './parse';
import { importTransferDocuments, type ImportInput } from './state';
import { assignmentFor, directorFixture, scoreAssignment } from './testFixtures';
import type { DirectorState } from '../domain/model';

function documentFor(qbj: unknown, overrides: Partial<IncomingDocument> = {}): IncomingDocument {
  const text = JSON.stringify(qbj);
  return {
    sourceKind: 'removable-drive',
    sourceLabel: 'SanDisk Ultra',
    fileName: 'result.qbj',
    originalPath: '/Volumes/SANDISK/QBSheet/Results/result.qbj',
    byteLength: text.length,
    digest: digestText(text),
    qbj,
    ...overrides,
  };
}

function stage(state: DirectorState, qbj: unknown, overrides: Partial<IncomingDocument> = {}) {
  const document = documentFor(qbj, overrides);
  const assessment = assessIncomingDocument(state, document);
  const outcome = stageIncomingDocument(state, document, assessment);
  return { assessment, outcome };
}

describe('a completed result', () => {
  it('matches its scheduled game and stages a submission for review', () => {
    const state = directorFixture();
    const result = scoreAssignment(assignmentFor(state, 'game-5-1').document);
    const { assessment, outcome } = stage(state, result);

    expect(assessment.classification).toBe('ready');
    expect(assessment.warnings).toEqual([]);
    expect(assessment.detail).toBe('Matched current assignment.');
    expect(assessment.scheduledGameId).toBe('game-5-1');
    expect(assessment.scores.map((score) => score.score)).toEqual([325, 210]);

    // Staged, not accepted. Nothing about arriving on a drive changes the tournament.
    const submission = state.submissions.find((entry) => entry.id === outcome.submissionId);
    expect(submission?.status).toBe('received');
    expect(state.games.find((game) => game.id === outcome.gameId)?.status).toBe('submitted');
    expect(state.scheduledGames[0].status).toBe('submitted');
  });

  it('reads player statistics through the same extractor QBTCP uses', () => {
    const state = directorFixture();
    const result = scoreAssignment(assignmentFor(state, 'game-5-1').document);
    const { assessment } = stage(state, result);
    const captain = assessment.playerStats.find((player) => player.playerId === 'team-1-player-1');
    expect(captain).toMatchObject({ powers: 4, gets: 8, negs: 1, tossupsHeard: 20 });
  });
});

describe('an unplayed assignment that came back', () => {
  it('is recognised as an assignment and never imported as a final game', () => {
    const state = directorFixture();
    const assignment = assignmentFor(state, 'game-5-1');
    expect(hasScoringContent(assignment.document)).toBe(false);

    const { assessment } = stage(state, assignment.document, { fileName: 'Round 5 - Room 101.qbj' });
    expect(assessment.classification).toBe('assignment');
    expect(assessment.detail).toContain('not a result');
    // No game record and no submission: the results inbox is unchanged.
    expect(state.games).toHaveLength(0);
    expect(state.submissions).toHaveLength(0);
    expect(state.scheduledGames[0].status).toBe('released');
  });

  it('is not fooled by a fabricated zero, which is scoring content', () => {
    const state = directorFixture();
    const assignment = assignmentFor(state, 'game-5-1').document as {
      objects: Array<Record<string, unknown>>;
    };
    const match = assignment.objects.find((object) => object.type === 'Match');
    (match?.match_teams as Array<Record<string, unknown>>)[0].points = 0;
    expect(hasScoringContent(assignment)).toBe(true);
  });
});

describe('revisions', () => {
  it('stages a result from an older round revision for review rather than accepting it', () => {
    const state = directorFixture({ roundRevision: 3 });
    const assignment = assignmentFor(state, 'game-5-1');
    // A file cut from revision 2 and returned after the bracket was redrawn to revision 3.
    const stale = scoreAssignment(assignment.document, { roundRevision: 2 });

    const { assessment } = stage(state, stale);
    expect(assessment.classification).toBe('needs-review');
    expect(assessment.warnings).toContain(ingestWarnings.staleRoundRevision);
    expect(assessment.detail).toContain('older revision of this round');
    expect(state.submissions[0].status).toBe('review');
    // The scheduled game is marked submitted so it shows as needing attention, never accepted.
    expect(state.scheduledGames[0].status).toBe('submitted');
  });

  it('flags a stale assignment revision separately from a stale round', () => {
    const state = directorFixture();
    state.scheduledGames[0].assignmentRevision = 4;
    const assignment = assignmentFor(state, 'game-5-1');
    const stale = scoreAssignment(assignment.document, { assignmentRevision: 2 });
    const { assessment } = stage(state, stale);
    expect(assessment.warnings).toContain(ingestWarnings.staleAssignmentRevision);
    expect(assessment.warnings).not.toContain(ingestWarnings.staleRoundRevision);
  });

  it('accepts a newer revision without complaint', () => {
    const state = directorFixture({ roundRevision: 1 });
    const result = scoreAssignment(assignmentFor(state, 'game-5-1').document, { roundRevision: 2 });
    expect(assessIncomingDocument(state, documentFor(result)).classification).toBe('ready');
  });
});

describe('identity that does not line up', () => {
  it('flags a result from another tournament', () => {
    const state = directorFixture();
    const foreign = scoreAssignment(assignmentFor(state, 'game-5-1').document, {
      tournamentId: 'tournament-somewhere-else',
    });
    const { assessment } = stage(state, foreign);
    expect(assessment.classification).toBe('needs-review');
    expect(assessment.warnings).toContain(ingestWarnings.tournamentMismatch);
  });

  it('falls back to the two teams when the match id is unknown, and says that it did', () => {
    const state = directorFixture();
    const result = scoreAssignment(assignmentFor(state, 'game-5-1').document) as {
      objects: Array<Record<string, unknown>>;
    };
    // A document from a tool that assigned its own match id.
    const match = result.objects.find((object) => object.type === 'Match');
    if (match) match.id = 'some-other-tools-id';

    const { assessment } = stage(state, result);
    expect(assessment.scheduledGameId).toBe('game-5-1');
    expect(assessment.classification).toBe('needs-review');
    expect(assessment.warnings).toContain(ingestWarnings.matchedByTeams);
  });

  it('does not invent a match when nothing lines up', () => {
    const state = directorFixture();
    const result = scoreAssignment(assignmentFor(state, 'game-5-1').document) as {
      objects: Array<Record<string, unknown>>;
    };
    const match = result.objects.find((object) => object.type === 'Match');
    if (match) {
      match.id = 'unknown-match';
      match.match_teams = [
        { team: { $ref: 'nobody-a' }, points: 10 },
        { team: { $ref: 'nobody-b' }, points: 5 },
      ];
    }
    const { assessment } = stage(state, result);
    expect(assessment.scheduledGameId).toBeUndefined();
    expect(assessment.warnings).toContain(ingestWarnings.unknownMatch);
    expect(assessment.classification).toBe('needs-review');
  });

  it('flags a cancelled game', () => {
    const state = directorFixture();
    const result = scoreAssignment(assignmentFor(state, 'game-5-1').document);
    state.scheduledGames[0].status = 'cancelled';
    const { assessment } = stage(state, result);
    expect(assessment.warnings).toContain(ingestWarnings.cancelledGame);
    // A cancelled game's status is not moved to submitted by a file arriving.
    expect(state.scheduledGames[0].status).toBe('cancelled');
  });

  it('never uses the filename as identity', () => {
    const state = directorFixture();
    const result = scoreAssignment(assignmentFor(state, 'game-5-1').document);
    // The file claims, by name, to be a different room's game entirely.
    const { assessment } = stage(state, result, {
      fileName: 'Round 5 - Room 102 - Emerald A vs Clinton A.qbj',
    });
    expect(assessment.scheduledGameId).toBe('game-5-1');
    expect(assessment.classification).toBe('ready');
  });

  it('treats an empty explicit scheduled-game identity as absent', () => {
    const state = directorFixture();
    const result = scoreAssignment(assignmentFor(state, 'game-5-1').document);
    const { assessment } = stage(state, result, { scheduledGameId: '   ' });
    expect(assessment.scheduledGameId).toBe('game-5-1');
    expect(assessment.classification).toBe('ready');
  });

  it('uses stable warning codes for ambiguous teams and unresolved players', () => {
    const state = directorFixture();
    state.teams.push({ ...state.teams[0]!, id: 'team-duplicate' });
    const result = scoreAssignment(assignmentFor(state, 'game-5-1').document) as {
      objects: Array<Record<string, unknown>>;
    };
    const match = result.objects.find((object) => object.type === 'Match');
    const teams = match?.match_teams as Array<Record<string, unknown>> | undefined;
    const firstTeam = teams?.[0];
    if (!firstTeam) throw new Error('test setup did not produce team statistics');
    firstTeam.team = { name: state.teams[0]!.displayName };
    const secondTeam = teams?.[1];
    const players = secondTeam?.match_players as Array<Record<string, unknown>> | undefined;
    const firstPlayer = players?.[0];
    if (!firstPlayer) throw new Error('test setup did not produce player statistics');
    firstPlayer.player = { name: 'Not on this roster' };

    const { assessment } = stage(state, result);
    expect(assessment.warnings).toContain(ingestWarnings.ambiguousTeamIdentity);
    expect(assessment.warnings).toContain(ingestWarnings.unresolvedPlayerIdentity);
    expect(assessment.detail).toContain('more than one roster entry');
  });
});

describe('a batch', () => {
  it('imports the good files when one of them is malformed', () => {
    const state = directorFixture({ games: 3 });
    const inputs: ImportInput[] = [
      ...[1, 2, 3].map((index) => {
        const qbj = scoreAssignment(assignmentFor(state, `game-5-${index}`).document);
        return { ok: true as const, document: documentFor(qbj, { fileName: `room-${index}.qbj` }) };
      }),
    ];
    // A file that is not JSON at all, dropped into the middle of the batch.
    const broken = parseTransferJson('{"version": "2.1.1", "objects": [');
    expect(broken.ok).toBe(false);
    inputs.splice(1, 0, {
      ok: false,
      sourceKind: 'removable-drive',
      sourceLabel: 'SanDisk Ultra',
      fileName: 'broken.qbj',
      byteLength: 30,
      digest: 'broken',
      reason: broken.ok ? '' : broken.reason,
    });

    const summary = importTransferDocuments(state, inputs);
    expect(summary.imported).toBe(3);
    expect(summary.invalid).toBe(1);
    expect(state.submissions).toHaveLength(3);
    expect(
      state.transfers.artifacts.filter((artifact) => artifact.classification === 'invalid'),
    ).toHaveLength(1);
    expect(summary.messages.join(' ')).toContain('broken.qbj');
  });

  it('skips a file it has already read from the same path', () => {
    const state = directorFixture();
    const qbj = scoreAssignment(assignmentFor(state, 'game-5-1').document);
    const input: ImportInput = { ok: true, document: documentFor(qbj) };
    expect(importTransferDocuments(state, [input]).imported).toBe(1);
    // The same drive scanned again five seconds later.
    const second = importTransferDocuments(state, [input]);
    expect(second.skipped).toBe(1);
    expect(state.submissions).toHaveLength(1);
  });
});

describe('bounds on untrusted input', () => {
  it('refuses a document nested past the limit', () => {
    let nested = '1';
    for (let index = 0; index < maxJsonDepth + 5; index += 1) nested = `[${nested}]`;
    const parsed = parseTransferJson(nested);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.reason).toContain('nested');
  });

  it('refuses a prototype-pollution shape rather than parsing around it', () => {
    const parsed = parseTransferJson('{"objects": [{"__proto__": {"polluted": true}}]}');
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.reason).toContain('reserved JavaScript key');
  });

  it('refuses a non-finite number and an empty file with a sentence each', () => {
    // JSON.parse itself rejects bare NaN, which is the first line of defence.
    expect(parseTransferJson('{"points": NaN}').ok).toBe(false);
    expect(parseTransferJson('   ').ok).toBe(false);
  });

  it('reads a document that is merely unexpected without calling it a result', () => {
    const state = directorFixture();
    const { assessment } = stage(state, { version: '2.1.1', objects: [{ type: 'Tournament', id: 'x' }] });
    expect(assessment.classification).toBe('not-a-result');
    expect(state.submissions).toHaveLength(0);
  });
});
