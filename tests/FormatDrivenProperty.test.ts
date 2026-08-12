import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import { applyScoreEvents, IScoreEventContext } from '../src/scoring/canApplyScoreEvent';
import deriveGame, { IGameSetup } from '../src/scoring/deriveGame';
import { readQbjScoringRules, writeQbjScoringRules } from '../src/qbj/QbjScoringRules';
import { scorekeeperFormatProblems, IScorekeeperFormat } from '../src/scoring/ScorekeeperFormat';
import { ScoreEvent } from '../src/scoring/ScoreEvents';
import validateScoresheet from '../src/scoring/validateScoresheet';
import toQbjMatch from '../src/scoring/toQbjMatch';
import { EventInput } from './events';

interface GeneratedBonus {
  enabled: boolean;
  bounceBack: boolean;
  regular: boolean;
  divisor: number;
  minimumParts: number;
  maximumParts: number;
  pointsPerPart?: number;
  maximumScore: number;
}

const bonusArbitrary: fc.Arbitrary<GeneratedBonus> = fc.boolean().chain((enabled) => {
  if (!enabled) {
    return fc.constant({
      enabled: false,
      bounceBack: false,
      regular: false,
      divisor: 1,
      minimumParts: 1,
      maximumParts: 1,
      maximumScore: 0,
    });
  }
  return fc.oneof(
    fc
      .record({
        parts: fc.integer({ min: 1, max: 4 }),
        pointsPerPart: fc.integer({ min: 1, max: 12 }),
        bounceBack: fc.boolean(),
      })
      .map(({ parts, pointsPerPart, bounceBack }) => ({
        enabled: true,
        bounceBack,
        regular: true,
        divisor: pointsPerPart,
        minimumParts: parts,
        maximumParts: parts,
        pointsPerPart,
        maximumScore: parts * pointsPerPart,
      })),
    fc
      .record({
        partRange: fc
          .tuple(fc.integer({ min: 1, max: 3 }), fc.integer({ min: 1, max: 4 }))
          .map(([first, second]) => ({ minimumParts: Math.min(first, second), maximumParts: Math.max(first, second) })),
        divisor: fc.integer({ min: 1, max: 12 }),
        bounceBack: fc.boolean(),
      })
      .map(({ partRange, divisor, bounceBack }) => ({
        enabled: true,
        bounceBack,
        regular: false,
        divisor,
        minimumParts: partRange.minimumParts,
        maximumParts: partRange.maximumParts,
        maximumScore: divisor * partRange.maximumParts,
      })),
  );
});

const formatArbitrary: fc.Arbitrary<IScorekeeperFormat> = fc
  .record({
    values: fc.array(fc.integer({ min: -20, max: 40 }), { minLength: 1, maxLength: 6 }).filter((values) => values.some((value) => value > 0)),
    timed: fc.boolean(),
    tossupCount: fc.integer({ min: 1, max: 5 }),
    maximumExtra: fc.integer({ min: 0, max: 2 }),
    bonus: bonusArbitrary,
    overtimeQuestionCount: fc.integer({ min: 1, max: 3 }),
    overtimeIncludesBonuses: fc.boolean(),
    lightning: fc.boolean(),
    lightningCount: fc.integer({ min: 1, max: 3 }),
    lightningDivisor: fc.integer({ min: 1, max: 12 }),
    maximumActive: fc.integer({ min: 1, max: 3 }),
  })
  .map((input) => {
    const answerTypes = input.values
      .map((value, originalIndex) => ({
        index: originalIndex,
        value,
        label: `Ruling ${originalIndex + 1}`,
        shortLabel: `R${originalIndex + 1}`,
        isPower: value > 10,
        isNeg: value < 0,
        awardsBonus: input.bonus.enabled && value > 0,
        qbjId: `generated-${originalIndex}`,
      }))
      .sort((left, right) => right.value - left.value)
      .map((answerType, index) => ({ ...answerType, index }));
    const lightningEnabled = input.lightning;
    return {
      version: 1,
      name: 'Generated format',
      answerTypes,
      regulation: {
        timed: input.timed,
        tossupCount: input.tossupCount,
        maximumTossupCount: input.tossupCount + input.maximumExtra,
      },
      bonus: input.bonus,
      overtime: {
        minimumQuestionCount: input.overtimeQuestionCount,
        suddenDeath: input.overtimeQuestionCount === 1,
        includesBonuses: input.bonus.enabled && input.overtimeIncludesBonuses,
      },
      lightning: {
        enabled: lightningEnabled,
        countPerTeam: lightningEnabled ? input.lightningCount : 0,
        divisor: lightningEnabled ? input.lightningDivisor : 10,
      },
      players: { maximumActive: input.maximumActive },
      totalDivisor: 1,
    } satisfies IScorekeeperFormat;
  });

const setup: IGameSetup = {
  left: { name: 'Generated left', players: ['L1', 'L2', 'L3'], startingLineup: ['L1', 'L2', 'L3'] },
  right: { name: 'Generated right', players: ['R1', 'R2', 'R3'], startingLineup: ['R1', 'R2', 'R3'] },
};

function append(context: IScoreEventContext, events: ScoreEvent[], candidate: ScoreEvent): ScoreEvent[] {
  const result = applyScoreEvents(context, events, [candidate]);
  expect(result.ok).toBe(true);
  return result.ok ? result.events : events;
}

function completeGeneratedQuestions(format: IScorekeeperFormat, choices: number[]): ScoreEvent[] {
  const context = { format, setup };
  let events: ScoreEvent[] = [];
  let nextId = 0;
  const makeEvent = (candidate: EventInput): ScoreEvent => {
    nextId += 1;
    return { ...candidate, id: `generated-event-${nextId}` } as ScoreEvent;
  };

  for (let index = 0; index < Math.max(1, choices.length); index += 1) {
    const game = deriveGame(format, setup, events);
    if (game.phase.kind !== 'tossup') break;
    const choice = choices[index] ?? 0;
    const questionNumber = game.phase.questionNumber;
    if (choice % 4 === 0) {
      events = append(context, events, makeEvent({ type: 'tossup-dead', questionNumber }));
      continue;
    }

    const team = game.phase.eligibleTeams[choice % game.phase.eligibleTeams.length];
    const otherTeam = (['left', 'right'] as const).find((side) => side !== team);
    const players = game[team].activePlayers;
    const playerName = players[choice % players.length];
    if (choice % 4 === 1) {
      events = append(context, events, makeEvent({ type: 'tossup-no-penalty', questionNumber, team, playerName }));
      if (otherTeam) {
        events = append(context, events, makeEvent({ type: 'tossup-no-penalty', questionNumber, team: otherTeam }));
      }
      continue;
    }

    const answerType = format.answerTypes[choice % format.answerTypes.length];
    events = append(
      context,
      events,
      makeEvent({ type: 'tossup-buzz', questionNumber, team, playerName, answerTypeIndex: answerType.index }),
    );
    if (answerType.value > 0) {
      const afterBuzz = deriveGame(format, setup, events);
      if (afterBuzz.phase.kind === 'bonus') {
        events = append(
          context,
          events,
          makeEvent({
            type: 'bonus',
            questionNumber,
            team,
            controlledPoints: format.bonus.maximumScore,
            bouncebackPoints: 0,
          }),
        );
      }
      continue;
    }

    if (!otherTeam) continue;
    if (choice % 2 === 0) {
      events = append(context, events, makeEvent({ type: 'tossup-reading-resumed', questionNumber }));
      const otherPlayers = game[otherTeam].activePlayers;
      events = append(
        context,
        events,
        makeEvent({
          type: 'tossup-buzz',
          questionNumber,
          team: otherTeam,
          playerName: otherPlayers[choice % otherPlayers.length],
          answerTypeIndex: answerType.index,
        }),
      );
    } else {
      events = append(context, events, makeEvent({ type: 'tossup-no-penalty', questionNumber, team: otherTeam }));
    }
  }
  return events;
}

describe('generated valid formats and legal event sequences', () => {
  test('arbitrary answer values, bonus shapes, player caps, and event order remain derivable', () => {
    fc.assert(
      fc.property(formatArbitrary, fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 1, maxLength: 8 }), (format, choices) => {
        expect(scorekeeperFormatProblems(format)).toEqual([]);
        const reread = readQbjScoringRules(writeQbjScoringRules(format), format.regulation.timed);
        expect(reread.ok).toBe(true);
        if (reread.ok) expect(reread.format).toEqual(format);
        const events = completeGeneratedQuestions(format, choices);
        const game = deriveGame(format, setup, events);

        expect(game.integrityProblems).toEqual([]);
        expect(game.personnelProblems).toEqual([]);
        expect(Number.isFinite(game.left.points)).toBe(true);
        expect(Number.isFinite(game.right.points)).toBe(true);
        const match = toQbjMatch(format, game) as { match_teams: { points: number }[] };
        expect(match.match_teams.map((team) => team.points)).toEqual([game.left.points, game.right.points]);
        expect(validateScoresheet(format, setup, events).blockers.filter((problem) => problem.code !== 'game-not-complete')).toEqual(
          [],
        );
      }),
      { numRuns: 120, verbose: true },
    );
  }, 20_000);
});
