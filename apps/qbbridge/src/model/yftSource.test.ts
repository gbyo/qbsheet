/**
 * YellowFruit stays the authority by proof, not by trust.
 *
 * Every claim below is something a tired operator must be able to rely on at midnight:
 * a verified result is really in the file, a superseded one really has a newer final, and
 * anything ambiguous reads as "cannot prove" rather than a guess.
 */

import { describe, expect, test } from 'vitest';
import {
  extractYftGames,
  groupResultsByMatch,
  sha256Hex,
  verificationForResult,
  verifyGameInIndex,
  type CorrectionGroup,
  type YftGame,
} from './yftSource';

type QbjObject = Record<string, unknown>;

function matchObject(
  id: string,
  left: [string, number],
  right: [string, number],
  tossupsRead: number,
): QbjObject {
  return {
    type: 'Match',
    id,
    tossups_read: tossupsRead,
    match_teams: [
      { team: { $ref: left[0] }, points: left[1] },
      { team: { $ref: right[0] }, points: right[1] },
    ],
  };
}

function documentWithMatches(roundName: string, matches: (QbjObject | { $ref: string })[]): QbjObject[] {
  const objects: QbjObject[] = [
    {
      type: 'Tournament',
      id: 'Tournament_YellowFruit',
      phases: [{ id: 'Phase_1', rounds: [{ id: 'Round_1', name: roundName, matches }] }],
    },
  ];
  for (const match of matches) {
    if (!('$ref' in match)) objects.push(match as QbjObject);
  }
  return objects;
}

const teams = new Set(['Team_A', 'Team_B', 'Team_C']);

describe('sha256Hex', () => {
  test('matches the NIST vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  test('is stable and sensitive to a single bit', () => {
    expect(sha256Hex('yellowfruit')).toBe(sha256Hex('yellowfruit'));
    expect(sha256Hex('yellowfruit')).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex('yellowfruit!')).not.toBe(sha256Hex('yellowfruit?'));
  });
});

describe('extractYftGames', () => {
  test('reads inline and referenced matches off the nested spine', () => {
    const objects = documentWithMatches('4', [
      matchObject('Match_1', ['Team_A', 30], ['Team_B', 40], 20),
      { $ref: 'Match_2' },
    ]);
    objects.push(matchObject('Match_2', ['Team_A', 10], ['Team_C', 50], 20));
    const games = extractYftGames(objects);
    expect(games).toHaveLength(2);
    expect(games[0]).toMatchObject({
      roundNumber: 4,
      matchId: 'Match_1',
      leftTeamId: 'Team_A',
      rightTeamId: 'Team_B',
      leftPoints: 30,
      rightPoints: 40,
      tossupsRead: 20,
    });
    expect(games[1].matchId).toBe('Match_2');
  });

  test('skips entries that cannot be a scored game', () => {
    const objects = documentWithMatches('4', [
      { type: 'Match', id: 'Match_solo', match_teams: [{ team: { $ref: 'Team_A' }, points: 10 }] },
      { type: 'NotAMatch', id: 'Match_nope' },
    ]);
    expect(extractYftGames(objects)).toEqual([]);
    expect(extractYftGames([{ type: 'SomethingElse' }])).toEqual([]);
  });
});

const game: YftGame = {
  roundNumber: 4,
  roundName: '4',
  matchId: 'Match_1',
  leftTeamId: 'Team_A',
  rightTeamId: 'Team_B',
  leftPoints: 30,
  rightPoints: 40,
  tossupsRead: 20,
};

describe('verifyGameInIndex', () => {
  test('verifies exactly one identical game', () => {
    expect(verifyGameInIndex(game, [game], teams)).toBe('verified');
  });

  test('a score change is unverified, not verified', () => {
    const corrected = { ...game, leftPoints: 35 };
    expect(verifyGameInIndex(corrected, [game], teams)).toBe('unverified');
  });

  test('duplicate games in the file are the file’s own ambiguity', () => {
    expect(verifyGameInIndex(game, [game, { ...game }], teams)).toBe('conflict');
  });

  test('a renamed or deleted team cannot be proven', () => {
    expect(verifyGameInIndex({ ...game, leftTeamId: 'Team_Renamed' }, [game], teams)).toBe('conflict');
    expect(verifyGameInIndex(game, [game], new Set(['Team_A']))).toBe('conflict');
  });

  test('a game with no resolvable round cannot be proven', () => {
    expect(verifyGameInIndex({ ...game, roundNumber: null }, [game], teams)).toBe('conflict');
  });
});

function resultDocument(id: string): { objects: QbjObject[] } {
  return {
    objects: documentWithMatches('4', [matchObject(id, ['Team_A', 30], ['Team_B', 40], 20)]),
  };
}

describe('correction groups and verification', () => {
  const original = { resultId: 'res-1', receivedAt: '2026-09-11T15:00:00Z', qbj: resultDocument('Match_1') };
  const correction = {
    resultId: 'res-2',
    receivedAt: '2026-09-11T15:20:00Z',
    qbj: resultDocument('Match_1'),
  };
  const otherGame = {
    resultId: 'res-3',
    receivedAt: '2026-09-11T15:10:00Z',
    qbj: resultDocument('Match_9'),
  };
  const groups: CorrectionGroup[] = groupResultsByMatch([original, correction, otherGame]);

  test('an original and its correction share one group with one latest', () => {
    expect(groups).toHaveLength(2);
    const group = groups.find((entry) => entry.resultIds.includes('res-1'))!;
    expect(group.resultIds).toEqual(['res-1', 'res-2']);
    expect(group.latestResultId).toBe('res-2');
  });

  test('a superseded original stays superseded even when it verified', () => {
    const games = extractYftGames(resultDocument('Match_1').objects);
    expect(verificationForResult(original, groups, games, teams)).toBe('superseded');
    expect(verificationForResult(correction, groups, games, teams)).toBe('verified');
  });

  test('an unimported result with no match in the file needs import', () => {
    expect(verificationForResult(otherGame, groups, [], teams)).toBe('needs-import');
  });

  test('an import marker no game can account for is a conflict, not proof', () => {
    expect(verificationForResult({ ...otherGame, importStatus: 'imported' }, groups, [], teams)).toBe(
      'conflict',
    );
  });

  test('with no authoritative games loaded there is no opinion', () => {
    expect(verificationForResult(correction, groups, null, teams)).toBe('unknown');
  });

  test('results without a match id never collapse into a false correction pair', () => {
    // Two distinct games sharing round number and team ids with no stable match id: the
    // playoff rematch the old round-plus-teams fallback key merged into one group.
    const idless = (leftPoints: number): { objects: QbjObject[] } => ({
      objects: documentWithMatches('4', [
        {
          type: 'Match',
          tossups_read: 20,
          match_teams: [
            { team: { $ref: 'Team_A' }, points: leftPoints },
            { team: { $ref: 'Team_B' }, points: 40 },
          ],
        },
      ]),
    });
    const first = { resultId: 'res-a', receivedAt: '2026-09-11T15:00:00Z', qbj: idless(30) };
    const second = { resultId: 'res-b', receivedAt: '2026-09-11T16:00:00Z', qbj: idless(35) };
    const idlessGroups = groupResultsByMatch([first, second]);
    expect(idlessGroups).toHaveLength(2);

    const games = extractYftGames(resultDocument('Match_1').objects);
    // Each stands on its own proof: neither is automatically the other's correction.
    expect(verificationForResult(first, idlessGroups, games, teams)).toBe('verified');
    expect(verificationForResult(second, idlessGroups, games, teams)).toBe('needs-import');
  });
});
