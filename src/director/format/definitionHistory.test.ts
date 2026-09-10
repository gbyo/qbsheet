/**
 * Per-game definition history across export and import (#671).
 *
 * An export must carry the snapshots a tournament issued, and an import must restore them
 * exactly — refs included — so every game stays pinned to the truth it was issued under.
 * Entries that cannot be validated are dropped: a half-snapshot that silently adopted live
 * rules would misread the history it claims to preserve.
 */
import { describe, expect, test } from 'vitest';
import { pinIssuedDefinitions, reissueGameDefinition } from '../domain/gameDefinitions';
import type { DirectorState } from '../domain/model';
import { isoNow } from '../domain/model';
import { digestText } from '../transfers/canonical';
import { assessIncomingDocument, stageIncomingDocument, type IncomingDocument } from '../transfers/ingest';
import { assignmentFor, directorFixture, scoreAssignment } from '../transfers/testFixtures';
import { exportQbjReport, importDirectorTournament, toInterchange } from './interchange';

function stageAcceptedResult(
  state: DirectorState,
  scheduledGameId: string,
  transform: (qbj: Record<string, unknown>) => Record<string, unknown> = (qbj) => qbj,
): void {
  const qbj = transform(
    scoreAssignment(assignmentFor(state, scheduledGameId).document) as Record<string, unknown>,
  );
  const text = JSON.stringify(qbj);
  const document: IncomingDocument = {
    sourceKind: 'removable-drive',
    sourceLabel: 'SanDisk Ultra',
    fileName: 'result.qbj',
    byteLength: text.length,
    digest: digestText(text),
    qbj,
  };
  const assessment = assessIncomingDocument(state, document);
  expect(assessment.classification).toBe('ready');
  const outcome = stageIncomingDocument(state, document, assessment);
  const submission = state.submissions.find((entry) => entry.id === outcome.submissionId);
  if (!submission) throw new Error('definition-history: no submission staged');
  submission.status = 'accepted';
  submission.acceptedAt = isoNow();
  const game = state.games.find((entry) => entry.id === submission.gameId);
  if (!game) throw new Error('definition-history: no game staged');
  game.status = 'accepted';
  game.acceptedAt = submission.acceptedAt;
}

describe('per-game definition history across export and import', () => {
  test('pins, snapshots, and refs survive the round trip', () => {
    const state = directorFixture();
    pinIssuedDefinitions(state, ['game-5-1']);
    const snapshot = state.gameDefinitions.find((entry) => entry.scheduledGameId === 'game-5-1');
    expect(snapshot).toBeDefined();

    const restored = importDirectorTournament(toInterchange(state));

    expect(restored.gameDefinitions).toEqual(state.gameDefinitions);
    const game = restored.scheduledGames.find((entry) => entry.id === 'game-5-1');
    expect(game?.definitionRevision).toBe(snapshot?.revision);
    expect(game?.definitionSnapshotId).toBe(snapshot?.id);
  });

  test('malformed snapshots are dropped instead of adopted', () => {
    const state = directorFixture();
    pinIssuedDefinitions(state, ['game-5-1']);
    const exported = toInterchange(state);
    const extensions = exported.tournament.extensions as Record<string, unknown>;
    const snapshots = [...(extensions.gameDefinitions as Array<unknown>)];
    const validCount = snapshots.length;
    expect(validCount).toBeGreaterThan(0);
    snapshots.push(
      { id: 'half-snapshot' },
      null,
      'digest-only',
      { ...(snapshots[0] as Record<string, unknown>), digest: '' },
      { ...(snapshots[0] as Record<string, unknown>), revision: 0 },
    );
    extensions.gameDefinitions = snapshots;

    const restored = importDirectorTournament(exported);

    expect(restored.gameDefinitions).toEqual(state.gameDefinitions);
  });

  test('an export with no issued games carries no history', () => {
    const state = directorFixture();

    const restored = importDirectorTournament(toInterchange(state));

    expect(restored.gameDefinitions).toEqual([]);
  });
});

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

describe('QBJ export honesty about multiple definitions', () => {
  test('a single-definition tournament exports without a compatibility warning', () => {
    const state = directorFixture({ games: 2 });
    pinIssuedDefinitions(state, ['game-5-1', 'game-5-2']);
    stageAcceptedResult(state, 'game-5-1');

    const exported = exportQbjReport(state);

    expect(exported.warnings).toEqual([]);
  });

  test('a multi-definition tournament warns and keeps per-game provenance', () => {
    const state = directorFixture({ games: 2 });
    pinIssuedDefinitions(state, ['game-5-1', 'game-5-2']);
    stageAcceptedResult(state, 'game-5-1');

    state.tournament!.rules.powerValue = 20;
    expect(reissueGameDefinition(state, 'game-5-2', 'Director').ok).toBe(true);
    // The room scores under its reissued assignment, so its powers are worth 20.
    stageAcceptedResult(state, 'game-5-2', repricePowersToTwenty);

    const exported = exportQbjReport(state);

    expect(exported.warnings.length).toBeGreaterThan(0);
    expect(exported.warnings.join(' ')).toMatch(/different scoring definitions/i);
    // Per-game truth rides in the Match objects, not just the warning text.
    const document = JSON.parse(exported.text) as {
      objects: Array<Record<string, unknown>>;
    };
    const digests = new Set(
      document.objects
        .filter((object) => object.type === 'Match')
        .map((object) => object.definitionDigest)
        .filter((digest): digest is string => typeof digest === 'string'),
    );
    expect(digests.size).toBe(2);
  });
});
