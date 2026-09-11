/**
 * Results: read for the screen, written unchanged.
 *
 * The central test is the last one. Everything else in this application can be rebuilt from the
 * `.yft` and a few dropdowns; a result cannot, and a result QBBridge altered on the way to disk
 * would be a mis-scored game imported into YellowFruit with nothing to say it had been touched.
 */

import { describe, expect, test } from 'vitest';
import { scoredResultDocument } from '../tests/scoredResult';
import { resultFileContents, resultFileName, resultSummary, sameQbjDocument } from './results';

describe('reading a result for the list', () => {
  test('a real scored document reports its round, room, teams and score', () => {
    const { result } = scoredResultDocument();
    expect(resultSummary(result)).toEqual({
      roundName: '4',
      roundNumber: 4,
      location: 'Room 101',
      leftName: 'Cony',
      rightName: 'Deering',
      leftPoints: 30,
      rightPoints: 40,
    });
  });

  test('a document it cannot read produces blanks, not an exception', () => {
    expect(resultSummary(null).leftName).toBeNull();
    expect(resultSummary({ version: '2.1.1', objects: [] }).roundName).toBeNull();
    expect(resultSummary({ type: 'Match', id: 'm', match_teams: [] }).roundNumber).toBeNull();
  });
});

describe('file names', () => {
  test('are descriptive and safe', () => {
    const { result } = scoredResultDocument();
    expect(resultFileName(resultSummary(result), 'res-1')).toBe('R04_Room-101_Cony_vs_Deering.result.qbj');
  });

  test('a name that would escape the folder is flattened', () => {
    const name = resultFileName(
      {
        roundName: null,
        roundNumber: 4,
        location: '../../etc',
        leftName: 'A/B',
        rightName: 'C:D',
        leftPoints: null,
        rightPoints: null,
      },
      'res-1',
    );
    expect(name).toBe('R04_..-..-etc_A-B_vs_C-D.result.qbj');
    // No separator survives, so the name stays one path component. The native writer refuses
    // anything else outright; this is the first of the two checks, not the only one.
    expect(name).not.toContain('/');
    expect(name).not.toContain('\\');
    expect(name.split(/[/\\]/)).toHaveLength(1);
  });

  test('an unreadable result still gets a file name', () => {
    const blank = resultSummary(null);
    expect(resultFileName(blank, 'res-77')).toBe('Game_res-77.result.qbj');
  });
});

describe('the result written to disk is the result the relay returned', () => {
  test('parsing the saved bytes gives back the same document, key for key', () => {
    const { result } = scoredResultDocument();
    // What the relay hands back is a parsed JSON value; this is that value written out.
    const relayPayload = JSON.parse(JSON.stringify(result)) as unknown;
    const written = resultFileContents(relayPayload);
    const readBack = JSON.parse(written) as unknown;

    expect(sameQbjDocument(readBack, relayPayload)).toBe(true);
    // Not merely "semantically similar": every identity and every number is the same one.
    expect(readBack).toEqual(relayPayload);
  });

  test('every identity and statistic survives the write', () => {
    const { result, matchId } = scoredResultDocument();
    const readBack = JSON.parse(resultFileContents(result)) as {
      version: string;
      objects: Record<string, unknown>[];
    };
    const objectsOf = (type: string) => readBack.objects.filter((entry) => entry.type === type);

    expect(readBack.version).toBe('2.1.1');
    expect(objectsOf('Tournament')[0].id).toBe('Tournament_YellowFruit');
    const match = objectsOf('Match')[0];
    expect(match.id).toBe(matchId);
    expect(match.tossups_read).toBe(2);
    expect(objectsOf('Team').map((team) => team.id)).toEqual(['Team_Cony', 'Team_Deering']);

    const sides = match.match_teams as Record<string, unknown>[];
    expect(sides.map((side) => side.points)).toEqual([30, 40]);
    // Per-question bonus detail, which is what YellowFruit's own per-player reports rebuild from.
    const questions = match.match_questions as Record<string, unknown>[];
    expect(questions.map((question) => question.bonus_points ?? null)).toEqual([20, 30]);
    const players = sides[0].match_players as Record<string, unknown>[];
    expect(players.map((player) => (player.player as { $ref: string }).$ref)).toEqual([
      'Player_Jacoby Grotton_1000',
      'Player_Abigail Leger_1001',
      'Player_Charlotte McGuire_1002',
      'Player_Maddisin Mercier_1003',
    ]);
    expect(players[0].answer_counts).toEqual([
      { number: 1, answer_type: { id: 'AnswerType_15', value: 15 } },
    ]);
  });

  test('a change anywhere in the document is caught by the comparison', () => {
    const { result } = scoredResultDocument();
    const tampered = JSON.parse(JSON.stringify(result)) as { objects: Record<string, unknown>[] };
    const match = tampered.objects.find((entry) => entry.type === 'Match') as Record<string, unknown>;
    (match.match_teams as Record<string, unknown>[])[0].points = 31;
    expect(sameQbjDocument(tampered, result)).toBe(false);
  });

  test('only key order and whitespace may differ', () => {
    const document = { version: '2.1.1', objects: [{ type: 'Match', id: 'm', _qbtcp: { version: 1 } }] };
    const reordered = { objects: [{ _qbtcp: { version: 1 }, id: 'm', type: 'Match' }], version: '2.1.1' };
    expect(sameQbjDocument(document, reordered)).toBe(true);
    // `_qbtcp` is compared like everything else here, unlike the fingerprint used for matching
    // two arrivals of one game: the question is whether the file is the document, not whether two
    // copies describe the same game.
    const withoutExtension = { version: '2.1.1', objects: [{ type: 'Match', id: 'm' }] };
    expect(sameQbjDocument(document, withoutExtension)).toBe(false);
  });
});
