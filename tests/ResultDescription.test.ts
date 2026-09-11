import { describe, expect, test } from 'vitest';
import { describeResult } from '../src/qbj/resultDescription';

function documentWith(match: unknown): unknown {
  return { version: '2.1.1', objects: [match] };
}

function scoredMatch(): unknown {
  return {
    type: 'Match',
    id: 'Match_1',
    location: 'Room 101',
    match_teams: [
      { team: { id: 'Team_Cony', name: 'Cony' }, points: 210 },
      { team: { id: 'Team_Deering', name: 'Deering' }, points: 180 },
    ],
  };
}

describe('describeResult', () => {
  test('an identified result reads as a headline with scores', () => {
    const description = describeResult(documentWith(scoredMatch()));
    expect(description.kind).toBe('identified');
    expect(description.headline).toBe('Cony 210–180 Deering');
    expect(description.detail).toBeNull();
    expect(description.matchId).toBe('Match_1');
    expect(description.location).toBe('Room 101');
  });

  test('an identified result without scores reads as a matchup', () => {
    const match = scoredMatch() as Record<string, unknown>;
    const sides = match.match_teams as Record<string, unknown>[];
    delete sides[0].points;
    delete sides[1].points;
    const description = describeResult(documentWith(match));
    expect(description.kind).toBe('identified');
    expect(description.headline).toBe('Cony vs Deering');
  });

  test('a one-sided result names the gap instead of printing a placeholder', () => {
    const match = scoredMatch() as Record<string, unknown>;
    (match.match_teams as Record<string, unknown>[])[1] = { points: 180 };
    const description = describeResult(documentWith(match));
    expect(description.kind).toBe('partial');
    expect(description.headline).toBe('Cony 210–180 (right side opponent not identified)');
    expect(description.headline).not.toContain('?');
    expect(description.detail).toMatch(/one team name missing/);
  });

  test('a nameless match is unidentified, never a mystery matchup', () => {
    const description = describeResult(documentWith({ type: 'Match', id: 'Match_9' }));
    expect(description.kind).toBe('unidentified');
    expect(description.headline).toBe('Result received — matchup could not be identified');
    expect(description.headline).not.toContain('?');
  });

  test('a document without a match is unreadable with the reason attached', () => {
    expect(describeResult(documentWith({ type: 'Tournament', id: 't' })).kind).toBe('unreadable');
    expect(describeResult(null).detail).toMatch(/not a QBJ object/);
    expect(describeResult('garbage').headline).toMatch(/could not be parsed/);
  });

  test('a referenced team id is evidence, not a placeholder', () => {
    const description = describeResult(
      documentWith({
        type: 'Match',
        id: 'Match_2',
        match_teams: [{ team: { $ref: 'Team_Ghost' }, points: 100 }, { points: 50 }],
      }),
    );
    expect(description.kind).toBe('partial');
    expect(description.leftName).toBe('Team_Ghost');
    expect(description.headline).toContain('Team_Ghost');
  });

  test('round names resolve through the tournament spine', () => {
    const description = describeResult({
      version: '2.1.1',
      objects: [
        {
          type: 'Tournament',
          id: 't',
          phases: [{ rounds: [{ name: '4', matches: [{ $ref: 'Match_1' }] }] }],
        },
        scoredMatch(),
      ],
    });
    expect(description.roundName).toBe('4');
    expect(description.roundNumber).toBe(4);
  });
});
