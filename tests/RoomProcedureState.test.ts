import { describe, expect, test } from 'vitest';
import { IScorekeeperFormat } from '../src/scoring/ScorekeeperFormat';
import scoringRulesToScorekeeperFormat from './rules';
import { CommonRuleSets, ScoringRules } from './rules';
import canApplyScoreEvent from '../src/scoring/canApplyScoreEvent';
import deriveGame, { IGameSetup } from '../src/scoring/deriveGame';
import { ScoreEvent } from '../src/scoring/ScoreEvents';
import { event } from './events';

const setup: IGameSetup = {
  left: { name: 'Ninety Six', players: ['Sarah', 'James'] },
  right: { name: 'Greenwood', players: ['Emma', 'Jordan'] },
};

function formatFor(mutate: (rules: ScoringRules) => void = () => {}): IScorekeeperFormat {
  const rules = new ScoringRules(CommonRuleSets.AcfPowers);
  rules.maximumPlayersPerTeam = 2;
  mutate(rules);
  return scoringRulesToScorekeeperFormat(rules);
}

function deadTossups(count: number, from = 1): ScoreEvent[] {
  return Array.from({ length: count }, (_, index) =>
    event({ type: 'tossup-dead', questionNumber: from + index }),
  );
}

describe('explicit room procedure states', () => {
  test('regulation and sudden-death transitions require their checkpoints', () => {
    const format = formatFor();
    const procedure = { version: 2, halves: false, timeoutsPerTeam: 0 };
    const regulation = deadTossups(20);
    const beginOvertime = event({ type: 'begin-overtime', questionNumber: 20 });

    expect(deriveGame(format, setup, regulation).phase).toEqual({
      kind: 'checkpoint',
      checkpoint: 'overtime',
      afterQuestion: 20,
    });
    expect(canApplyScoreEvent({ format, setup, procedure }, regulation, beginOvertime).ok).toBe(true);

    const overtime = [...regulation, beginOvertime, event({ type: 'tossup-dead', questionNumber: 21 })];
    const beginSuddenDeath = event({ type: 'begin-sudden-death', questionNumber: 21 });
    expect(deriveGame(format, setup, overtime).phase).toEqual({
      kind: 'checkpoint',
      checkpoint: 'sudden-death',
      afterQuestion: 21,
    });
    expect(canApplyScoreEvent({ format, setup, procedure }, overtime, beginSuddenDeath).ok).toBe(true);
  });

  test('an active timeout blocks scoring, permits a safe substitution, and resumes explicitly', () => {
    const format = formatFor();
    const procedure = { version: 2, halves: true, timeoutsPerTeam: 1, timeoutDurationSeconds: 30 };
    const timeout = event({ type: 'timeout-start', questionNumber: 1, team: 'left', startedAt: 1000 });
    const context = { format, setup, procedure };

    expect(canApplyScoreEvent(context, [], timeout).ok).toBe(true);
    const active = [timeout];
    expect(
      canApplyScoreEvent(
        context,
        active,
        event({
          type: 'tossup-buzz',
          questionNumber: 1,
          team: 'left',
          playerName: 'Sarah',
          answerTypeIndex: 1,
        }),
      ).ok,
    ).toBe(false);
    expect(
      canApplyScoreEvent(
        context,
        active,
        event({ type: 'substitution', questionNumber: 1, team: 'left', activePlayers: ['James'] }),
      ).ok,
    ).toBe(true);
    expect(canApplyScoreEvent(context, active, event({ type: 'timeout-resume', questionNumber: 1 })).ok).toBe(
      true,
    );
    expect(deriveGame(format, setup, active).phase).toEqual({
      kind: 'timeout',
      questionNumber: 1,
      team: 'left',
    });
  });

  test('timeouts are limited to an unstarted tossup and the active question', () => {
    const format = formatFor();
    const procedure = { version: 2, halves: false, timeoutsPerTeam: 1 };
    const context = { format, setup, procedure };
    const positive = format.answerTypes.find((answerType) => answerType.value > 0)!;
    const neg = format.answerTypes.find((answerType) => answerType.isNeg)!;

    expect(
      canApplyScoreEvent(context, [], event({ type: 'timeout-start', questionNumber: 2, team: 'left' })).ok,
    ).toBe(false);
    expect(
      canApplyScoreEvent(
        context,
        [
          event({
            type: 'tossup-buzz',
            questionNumber: 1,
            team: 'left',
            playerName: 'Sarah',
            answerTypeIndex: positive.index,
          }),
        ],
        event({ type: 'timeout-start', questionNumber: 1, team: 'left' }),
      ).ok,
    ).toBe(false);
    expect(
      canApplyScoreEvent(
        context,
        [
          event({
            type: 'tossup-buzz',
            questionNumber: 1,
            team: 'left',
            playerName: 'Sarah',
            answerTypeIndex: neg.index,
          }),
        ],
        event({ type: 'timeout-start', questionNumber: 1, team: 'left' }),
      ).ok,
    ).toBe(false);
    expect(
      canApplyScoreEvent(
        context,
        [event({ type: 'tossup-no-penalty', questionNumber: 1, team: 'left', playerName: 'Sarah' })],
        event({ type: 'timeout-start', questionNumber: 1, team: 'left' }),
      ).ok,
    ).toBe(false);

    const active = [event({ type: 'timeout-start', questionNumber: 1, team: 'left' })];
    expect(canApplyScoreEvent(context, active, event({ type: 'timeout-resume', questionNumber: 2 })).ok).toBe(
      false,
    );
  });

  test.each([
    ['none', true, true],
    ['phase-boundaries', false, false],
    ['strict-overtime', true, false],
  ] as const)('protest checkpoint policy %s matches the engine', (policy, overtime, suddenDeath) => {
    const format = formatFor();
    const procedure = { version: 2, halves: false, timeoutsPerTeam: 0, protestCheckpoints: policy };
    const base = [
      ...deadTossups(20),
      event({
        type: 'protest',
        questionNumber: 20,
        team: 'right',
        subject: 'question',
        description: 'Open',
        status: 'open' as const,
      }),
    ];
    const beginOvertime = event({ type: 'begin-overtime', questionNumber: 20 });
    const overtimeResult = canApplyScoreEvent({ format, setup, procedure }, base, beginOvertime).ok;
    expect(overtimeResult).toBe(overtime);
    if (overtime) {
      const after = [
        ...base,
        { ...beginOvertime, id: 'overtime-started' },
        event({ type: 'tossup-dead', questionNumber: 21 }),
      ];
      expect(
        canApplyScoreEvent(
          { format, setup, procedure },
          after,
          event({ type: 'begin-sudden-death', questionNumber: 21 }),
        ).ok,
      ).toBe(suddenDeath);
    }
  });

  test('strict overtime protests block both the sudden-death checkpoint and next tossup', () => {
    const format = formatFor();
    const procedure = {
      version: 2,
      halves: false,
      timeoutsPerTeam: 0,
      protestCheckpoints: 'strict-overtime' as const,
    };
    const base = [
      ...deadTossups(20),
      event({ type: 'begin-overtime', questionNumber: 20 }),
      event({ type: 'tossup-dead', questionNumber: 21 }),
      event({
        type: 'protest',
        questionNumber: 21,
        team: 'right',
        subject: 'tossup-answer',
        description: 'Please review the ruling.',
        status: 'open',
      }),
    ];
    const begin = event({ type: 'begin-sudden-death', questionNumber: 21 });
    const context = { format, setup, procedure };

    expect(canApplyScoreEvent(context, base, begin).ok).toBe(false);

    const afterBegin = [...base, { ...begin, id: 'accepted-begin' }];
    const next = event({
      type: 'tossup-buzz',
      questionNumber: 22,
      team: 'left',
      playerName: 'Sarah',
      answerTypeIndex: 1,
    });
    expect(canApplyScoreEvent(context, afterBegin, next).ok).toBe(false);
  });
});
