import { describe, expect, test } from 'vitest';
import { IScorekeeperFormat } from '../src/scoring/ScorekeeperFormat';
import scoringRulesToScorekeeperFormat from './rules';
import { CommonRuleSets, ScoringRules } from './rules';
import deriveGame, { IGameSetup } from '../src/scoring/deriveGame';
import validateScoresheet, { validateCorrectedHistory } from '../src/scoring/validateScoresheet';
import { ScoreEvent } from '../src/scoring/ScoreEvents';
import { event } from './events';

const setup: IGameSetup = {
  left: { name: 'Ninety Six', players: ['Sarah', 'James'] },
  right: { name: 'Greenwood', players: ['Emma', 'Jordan'] },
};

function formatFor(): IScorekeeperFormat {
  const rules = new ScoringRules(CommonRuleSets.AcfPowers);
  rules.maximumPlayersPerTeam = 2;
  return scoringRulesToScorekeeperFormat(rules);
}

function completedGame(): ScoreEvent[] {
  return [
    event({ type: 'tossup-buzz', questionNumber: 1, team: 'left', playerName: 'Sarah', answerTypeIndex: 1 }),
    event({ type: 'bonus', questionNumber: 1, team: 'left', controlledPoints: 20 }),
    ...Array.from({ length: 19 }, (_, index) => event({ type: 'tossup-dead', questionNumber: index + 2 })),
  ];
}

describe('whole-scoresheet validation', () => {
  test('a complete ordinary scoresheet has no blockers', () => {
    const validation = validateScoresheet(formatFor(), setup, completedGame());

    expect(validation.valid).toBe(true);
    expect(validation.blockers).toEqual([]);
  });

  test('duplicate opportunities and a conversion marked dead are blockers', () => {
    const format = formatFor();
    const validation = validateScoresheet(format, setup, [
      event({ type: 'tossup-buzz', questionNumber: 1, team: 'left', playerName: 'Sarah', answerTypeIndex: 1 }),
      event({ type: 'tossup-no-penalty', questionNumber: 1, team: 'left', playerName: 'Sarah' }),
      event({ type: 'tossup-dead', questionNumber: 1 }),
    ]);

    expect(validation.blockers.map((problem) => problem.code)).toEqual(
      expect.arrayContaining(['integrity', 'duplicate-opportunity', 'dead-conversion']),
    );
  });

  test('a non-converting attempt may be followed by the question going dead', () => {
    const events: ScoreEvent[] = [
      event({ type: 'tossup-no-penalty', questionNumber: 1, team: 'left', playerName: 'Sarah' }),
      event({ type: 'tossup-dead', questionNumber: 1 }),
      ...Array.from({ length: 19 }, (_, index) => event({ type: 'tossup-dead', questionNumber: index + 2 })),
    ];
    const validation = validateCorrectedHistory(formatFor(), setup, events);

    expect(validation.valid).toBe(true);
    expect(validation.blockers).toEqual([]);
  });

  test('a missing bonus blocks submission but is allowed while correcting the current question', () => {
    const format = formatFor();
    const events = [
      event({ type: 'tossup-buzz', questionNumber: 1, team: 'left', playerName: 'Sarah', answerTypeIndex: 1 }),
    ];
    const validation = validateScoresheet(format, setup, events);
    const corrected = validateCorrectedHistory(format, setup, events);

    expect(validation.blockers.map((problem) => problem.code)).toEqual(
      expect.arrayContaining(['missing-bonus', 'game-not-complete']),
    );
    expect(corrected.blockers.map((problem) => problem.code)).not.toContain('missing-bonus');
    expect(deriveGame(format, setup, events).phase.kind).toBe('bonus');
  });

  test.each([
    [
      'halftime',
      [
        event({ type: 'tossup-dead', questionNumber: 1 }),
        event({ type: 'half-break', questionNumber: 1, lastQuestion: 1 }),
      ],
      { version: 2, halves: true, timeoutsPerTeam: 0 },
    ],
    [
      'overtime checkpoint',
      Array.from({ length: 20 }, (_, index) => event({ type: 'tossup-dead', questionNumber: index + 1 })),
      undefined,
    ],
    [
      'sudden-death checkpoint',
      [
        ...Array.from({ length: 20 }, (_, index) => event({ type: 'tossup-dead', questionNumber: index + 1 })),
        event({ type: 'begin-overtime', questionNumber: 20 }),
        event({ type: 'tossup-dead', questionNumber: 21 }),
      ],
      undefined,
    ],
    ['completed game', completedGame(), undefined],
  ])('corrections remain valid at the %s phase', (_name, events, procedure) => {
    const corrected = validateCorrectedHistory(formatFor(), setup, events, procedure);

    expect(corrected.blockers.map((problem) => problem.code)).not.toContain('game-not-complete');
    expect(corrected.valid).toBe(true);
  });

  test('open protests are warnings by default and blockers under strict procedure', () => {
    const events = [
      ...completedGame(),
      event({
        type: 'protest',
        questionNumber: 1,
        team: 'right',
        subject: 'tossup-answer',
        description: 'The answer was disputed.',
        status: 'open',
      }),
    ];
    const format = formatFor();
    const permissive = validateScoresheet(format, setup, events);
    const strict = validateScoresheet(format, setup, events, {
      version: 2,
      halves: false,
      timeoutsPerTeam: 0,
      protestCheckpoints: 'strict-overtime',
    });

    expect(permissive.warnings.map((problem) => problem.code)).toContain('open-protest');
    expect(permissive.blockers.map((problem) => problem.code)).not.toContain('open-protest');
    expect(strict.blockers.map((problem) => problem.code)).toContain('open-protest');
  });

  test('malformed scoring records become blockers instead of crashing validation', () => {
    const malformed = {
      id: 'malformed-bonus',
      type: 'bonus',
      questionNumber: 1,
      team: 'not-a-team',
      parts: { controlledPoints: 20 },
    } as unknown as ScoreEvent;

    expect(() => validateScoresheet(formatFor(), setup, [malformed])).not.toThrow();
    expect(validateScoresheet(formatFor(), setup, [malformed]).blockers.map((problem) => problem.code)).toContain(
      'malformed-event',
    );
  });

  test('explicit overtime transitions must match the derived checkpoint', () => {
    const validation = validateScoresheet(formatFor(), setup, [event({ type: 'begin-overtime', questionNumber: 1 })]);

    expect(validation.blockers.map((problem) => problem.code)).toContain('invalid-procedure-transition');
  });
});
