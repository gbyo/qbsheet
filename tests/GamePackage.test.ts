/**
 * A game file is untrusted input.
 *
 * These tests are about refusal. The property under test is not that a good package works — that is
 * covered everywhere else — but that a bad one is stopped completely, before a room is forty
 * minutes into a game scored against a roster that was silently truncated on the way in.
 */
import { describe, expect, test } from 'vitest';
import {
  maxGamePackageBytes,
  maxPlayersPerTeam,
  readGamePackageText,
  validateGamePackage,
} from '../src/game/GamePackageValidation';
import { gamePackageIdentity, gamePackageVersion } from '../src/game/GamePackage';
import { validPackage, packageText } from './packages';
import scoringRulesToScorekeeperFormat, { CommonRuleSets, ScoringRules } from './rules';

function errorsFor(value: unknown): string[] {
  const result = validateGamePackage(value);
  return result.ok ? [] : result.errors;
}

describe('a package a room can actually score', () => {
  test('a complete package is accepted', () => {
    const result = validateGamePackage(validPackage());

    expect(result.ok).toBe(true);
  });

  test('nothing beyond the schema survives validation', () => {
    const result = validateGamePackage({
      ...validPackage(),
      accessToken: 'room-token-nobody-should-have-put-here',
      standings: [{ team: 'Ninety Six A', wins: 4 }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toHaveProperty('accessToken');
    expect(result.value).not.toHaveProperty('standings');
  });

  test('an optional starting lineup is kept when it is a real lineup', () => {
    const result = validateGamePackage(
      validPackage({
        left: {
          name: 'Ninety Six A',
          players: [{ name: 'Sarah Mitchell' }, { name: 'James Okafor' }],
          startingLineup: ['Sarah Mitchell'],
        },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.left.startingLineup).toEqual(['Sarah Mitchell']);
  });
});

describe('the wrong kind of file', () => {
  test('anything without the format marker is refused as not a game file', () => {
    expect(errorsFor({ version: 1, tournament: { name: 'x' } })[0]).toContain('not a game file');
  });

  test('a future version is refused rather than guessed at', () => {
    const errors = errorsFor(validPackage({ version: gamePackageVersion + 1 }));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`version ${gamePackageVersion + 1}`);
  });

  test('text that is not JSON is refused without throwing', () => {
    const result = readGamePackageText('{ this is not json');

    expect(result.ok).toBe(false);
  });

  test('a file larger than any real package is refused before it is parsed', () => {
    const result = readGamePackageText('x'.repeat(maxGamePackageBytes + 1));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain('too large');
  });

  test('a valid package round-trips through text', () => {
    const result = readGamePackageText(packageText());

    expect(result.ok).toBe(true);
  });
});

describe('identity', () => {
  test('missing round identity is refused', () => {
    expect(errorsFor(validPackage({ round: undefined as never }))).toContain(
      'The game file does not say which round this is.',
    );
  });

  test('a round with no revision is refused, because a stale result would be undetectable', () => {
    const errors = errorsFor(validPackage({ round: { number: 7, name: 'Round 7', revision: 0 } }));

    expect(errors.some((error) => error.includes('revision'))).toBe(true);
  });

  test('a blank tournament name is refused', () => {
    expect(errorsFor(validPackage({ tournament: { name: '   ' } }))).toContain(
      'The game file does not say which tournament this is.',
    );
  });

  test('the scheduled game is the identity when there is one', () => {
    expect(gamePackageIdentity(validPackage())).toBe('match:sched-101');
  });

  test('without a scheduled game, the tournament, round and teams are the identity', () => {
    const identity = gamePackageIdentity(validPackage({ scheduledMatchId: undefined }));

    expect(identity).toContain('tourn-2026-spring');
    expect(identity).toContain('Ninety Six A');
    expect(identity).toContain('Greenwood');
  });

  test('the identity does not change when the round is re-issued', () => {
    const first = gamePackageIdentity(validPackage({ scheduledMatchId: undefined }));
    const second = gamePackageIdentity(
      validPackage({ scheduledMatchId: undefined, round: { number: 7, name: 'Round 7', revision: 4 } }),
    );

    expect(second).toBe(first);
  });
});

describe('rosters', () => {
  test('an empty roster is refused', () => {
    expect(errorsFor(validPackage({ left: { name: 'Ninety Six A', players: [] } }))).toContain(
      "The left team's roster is empty.",
    );
  });

  test('a blank player name is refused', () => {
    const errors = errorsFor(
      validPackage({ right: { name: 'Greenwood', players: [{ name: 'Emma Chen' }, { name: '  ' }] } }),
    );

    expect(errors.some((error) => error.includes('Player 2 on the right team'))).toBe(true);
  });

  test('a duplicated player name is refused', () => {
    const errors = errorsFor(
      validPackage({ left: { name: 'Ninety Six A', players: [{ name: 'Sarah' }, { name: 'Sarah' }] } }),
    );

    expect(errors.some((error) => error.includes('more than once'))).toBe(true);
  });

  test('a roster of absurd size is refused rather than walked', () => {
    const players = Array.from({ length: maxPlayersPerTeam + 1 }, (_, index) => ({ name: `Player ${index}` }));
    const errors = errorsFor(validPackage({ left: { name: 'Ninety Six A', players } }));

    expect(errors.some((error) => error.includes('implausible'))).toBe(true);
  });

  test('a team cannot play itself', () => {
    const errors = errorsFor(
      validPackage({ right: { name: 'Ninety Six A', players: [{ name: 'Emma Chen' }] } }),
    );

    expect(errors.some((error) => error.includes('cannot play itself'))).toBe(true);
  });

  test('a starting lineup naming somebody off the roster is refused', () => {
    const errors = errorsFor(
      validPackage({
        left: { name: 'Ninety Six A', players: [{ name: 'Sarah' }], startingLineup: ['Somebody Else'] },
      }),
    );

    expect(errors.some((error) => error.includes('not on the roster'))).toBe(true);
  });

  test('a starting lineup larger than the format allows on the floor is refused', () => {
    const format = scoringRulesToScorekeeperFormat(new ScoringRules(CommonRuleSets.AcfPowers));
    format.players.maximumActive = 2;
    const errors = errorsFor(
      validPackage({
        scorekeeperFormat: format,
        left: {
          name: 'Ninety Six A',
          players: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
          startingLineup: ['A', 'B', 'C'],
        },
      }),
    );

    expect(errors.some((error) => error.includes('more than 2 players'))).toBe(true);
  });
});

describe('scoring rules', () => {
  test('a missing rule set is refused', () => {
    expect(errorsFor(validPackage({ scorekeeperFormat: undefined as never }))).toContain(
      'The scoring rules are missing or are not an object.',
    );
  });

  test('a rule set from another version is refused rather than partially read', () => {
    const format = scoringRulesToScorekeeperFormat(new ScoringRules());
    const errors = errorsFor(validPackage({ scorekeeperFormat: { ...format, version: 99 } }));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('version 99');
  });

  test('a rule set with no way to score a tossup is refused', () => {
    const format = scoringRulesToScorekeeperFormat(new ScoringRules());
    format.answerTypes = format.answerTypes.filter((answerType) => answerType.value < 0);
    format.answerTypes = format.answerTypes.map((answerType, index) => ({ ...answerType, index }));
    const errors = errorsFor(validPackage({ scorekeeperFormat: format }));

    expect(errors.some((error) => error.includes('no way to score points'))).toBe(true);
  });

  test('a non-numeric point value is refused', () => {
    const format = scoringRulesToScorekeeperFormat(new ScoringRules());
    const broken = {
      ...format,
      answerTypes: [{ ...format.answerTypes[0], value: 'ten' as unknown as number }, format.answerTypes[1]],
    };

    expect(errorsFor(validPackage({ scorekeeperFormat: broken })).some((error) => error.includes('point value'))).toBe(
      true,
    );
  });

  test('answer types out of order are refused, because events reference them by index', () => {
    const format = scoringRulesToScorekeeperFormat(new ScoringRules());
    const broken = { ...format, answerTypes: [...format.answerTypes].reverse() };

    expect(errorsFor(validPackage({ scorekeeperFormat: broken })).some((error) => error.includes('index'))).toBe(true);
  });
});

describe('the procedure', () => {
  test('a procedure from an unknown version is refused', () => {
    const errors = errorsFor(validPackage({ procedure: { version: 99, halves: true, timeoutsPerTeam: 0 } }));

    expect(errors.some((error) => error.includes('room procedure'))).toBe(true);
  });

  test('a known procedure is normalized rather than trusted field by field', () => {
    const result = validateGamePackage(
      validPackage({
        procedure: { version: 2, halves: true, halfLengthMinutes: 10, timeoutsPerTeam: 99 },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Nine is the most the room will track; a hundred is a configuration error, not a rule.
    expect(result.value.procedure?.timeoutsPerTeam).toBe(9);
  });
});
