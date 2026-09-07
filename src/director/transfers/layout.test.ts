import { describe, expect, test } from 'vitest';
import { parseManifest } from './layout';

function manifestWithRevisions(roundRevision: unknown, assignmentRevision: unknown) {
  return {
    manifestVersion: 1,
    tournamentId: 'tournament-1',
    tournamentName: 'Revision Test',
    preparedAt: '2026-09-07T12:00:00Z',
    directorBuild: 'test',
    assignments: [
      {
        matchId: 'match-1',
        roundId: 'round-1',
        roundName: 'Round 1',
        roundRevision,
        assignmentRevision,
        fileName: 'round-1.qbj',
        teams: ['Alpha', 'Bravo'],
      },
    ],
  };
}

describe('transfer manifest revisions', () => {
  test.each([
    [0, 0],
    [-1, -2],
    [1.5, 2.25],
    [Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 1],
  ])('falls back to revision 1 for invalid sequence values (%s, %s)', (roundRevision, assignmentRevision) => {
    const parsed = parseManifest(manifestWithRevisions(roundRevision, assignmentRevision));

    expect(parsed?.assignments[0]).toMatchObject({ roundRevision: 1, assignmentRevision: 1 });
  });

  test('preserves positive safe integer revisions', () => {
    const parsed = parseManifest(manifestWithRevisions(7, 9));

    expect(parsed?.assignments[0]).toMatchObject({ roundRevision: 7, assignmentRevision: 9 });
  });
});
