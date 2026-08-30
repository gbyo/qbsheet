/**
 * The state machine under the scoring buttons.
 *
 * What is checked here is that impossible things are impossible, rather than merely hard: the UI
 * disables what cannot be pressed, but disabling happens after a render, and two clicks inside one
 * render both run against the state that was on screen when the first one started.
 */
import { describe, expect, test } from 'vitest';
import { IScorekeeperFormat } from '../src/scoring/ScorekeeperFormat';
import scoringRulesToScorekeeperFormat from './rules';
import { CommonRuleSets, ScoringRules } from './rules';
import canApplyScoreEvent, { applyScoreEvents } from '../src/scoring/canApplyScoreEvent';
import { IGameSetup } from '../src/scoring/deriveGame';
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

function typeIndex(format: IScorekeeperFormat, value: number): number {
  const found = format.answerTypes.find((answerType) => answerType.value === value);
  if (!found) throw new Error(`No answer type worth ${value}`);
  return found.index;
}

function buzz(
  questionNumber: number,
  team: 'left' | 'right',
  playerName: string,
  answerTypeIndex: number,
): ScoreEvent {
  return event({ type: 'tossup-buzz', questionNumber, team, playerName, answerTypeIndex });
}

const format = formatFor();
const context = { format, setup };

describe('one answer per team per tossup', () => {
  test('a second buzz by the same team is refused', () => {
    const events = [buzz(1, 'left', 'Sarah', typeIndex(format, -5))];

    const verdict = canApplyScoreEvent(context, events, buzz(1, 'left', 'James', typeIndex(format, 10)));

    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain('already answered');
  });

  test('a double-click cannot score the same tossup twice', () => {
    // Both presses are built from the same on-screen state, which is exactly what a fast double
    // click produces. The second one has to lose.
    const first = buzz(1, 'left', 'Sarah', typeIndex(format, 10));
    const second = buzz(1, 'left', 'Sarah', typeIndex(format, 10));

    const afterFirst = applyScoreEvents(context, [], [first]);
    expect(afterFirst.ok).toBe(true);
    const afterSecond = applyScoreEvents(context, afterFirst.ok ? afterFirst.events : [], [second]);

    expect(afterSecond.ok).toBe(false);
  });

  test('the other team may still answer', () => {
    const events = [buzz(1, 'left', 'Sarah', typeIndex(format, -5))];

    expect(canApplyScoreEvent(context, events, buzz(1, 'right', 'Emma', typeIndex(format, 10))).ok).toBe(
      true,
    );
  });
});

describe('a team that heard the whole question cannot be penalized', () => {
  test('the second team is refused a neg', () => {
    const events = [buzz(1, 'left', 'Sarah', typeIndex(format, -5))];

    const verdict = canApplyScoreEvent(context, events, buzz(1, 'right', 'Emma', typeIndex(format, -5)));

    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain('whole question');
  });

  test('the second team gets the zero-point outcome instead', () => {
    const events = [buzz(1, 'left', 'Sarah', typeIndex(format, -5))];
    const wrong = event({ type: 'tossup-no-penalty', questionNumber: 1, team: 'right', playerName: 'Emma' });

    expect(canApplyScoreEvent(context, events, wrong).ok).toBe(true);
  });

  test('the first team may still neg', () => {
    expect(canApplyScoreEvent(context, [], buzz(1, 'left', 'Sarah', typeIndex(format, -5))).ok).toBe(true);
  });

  test('an explicit reading-resumed event permits the other team to neg', () => {
    const first = buzz(1, 'left', 'Sarah', typeIndex(format, -5));
    const resumed = event({ type: 'tossup-reading-resumed', questionNumber: 1 });
    const afterResume = applyScoreEvents(context, [first], [resumed]);

    expect(afterResume.ok).toBe(true);
    if (!afterResume.ok) return;
    expect(
      canApplyScoreEvent(context, afterResume.events, buzz(1, 'right', 'Emma', typeIndex(format, -5))).ok,
    ).toBe(true);
  });

  test('a readout marker blocks a neg even when no team has answered yet', () => {
    const readout = event({ type: 'tossup-readout', questionNumber: 1 });
    const afterReadout = applyScoreEvents(context, [], [readout]);

    expect(afterReadout.ok).toBe(true);
    if (!afterReadout.ok) return;
    const verdict = canApplyScoreEvent(
      context,
      afterReadout.events,
      buzz(1, 'left', 'Sarah', typeIndex(format, -5)),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain('whole question');
    expect(
      canApplyScoreEvent(context, afterReadout.events, buzz(1, 'left', 'Sarah', typeIndex(format, 10))).ok,
    ).toBe(true);
  });
});

describe('bonuses follow conversions', () => {
  test('a bonus with no conversion behind it is refused', () => {
    const verdict = canApplyScoreEvent(
      context,
      [],
      event({ type: 'bonus', questionNumber: 1, team: 'left', controlledPoints: 20 }),
    );

    expect(verdict.ok).toBe(false);
  });

  test('a second bonus on the same tossup is refused', () => {
    const events = [
      buzz(1, 'left', 'Sarah', typeIndex(format, 10)),
      event({ type: 'bonus', questionNumber: 1, team: 'left', controlledPoints: 20 }),
    ];

    const again = event({ type: 'bonus', questionNumber: 1, team: 'left', controlledPoints: 30 });
    expect(canApplyScoreEvent(context, events, again).ok).toBe(false);
  });

  test('the team that did not convert cannot take the bonus', () => {
    const events = [buzz(1, 'left', 'Sarah', typeIndex(format, 10))];

    const verdict = canApplyScoreEvent(
      context,
      events,
      event({ type: 'bonus', questionNumber: 1, team: 'right', controlledPoints: 20 }),
    );

    expect(verdict.ok).toBe(false);
  });

  test('a tossup cannot be scored while a bonus is owed', () => {
    const events = [buzz(1, 'left', 'Sarah', typeIndex(format, 10))];

    expect(canApplyScoreEvent(context, events, buzz(2, 'right', 'Emma', typeIndex(format, 10))).ok).toBe(
      false,
    );
  });
});

describe('a dead tossup is over', () => {
  test('nothing can be scored on it afterwards', () => {
    const events = [event({ type: 'tossup-dead', questionNumber: 1 })];

    // The phase has already moved to tossup 2, so this is refused as belonging to the wrong question.
    expect(canApplyScoreEvent(context, events, buzz(1, 'left', 'Sarah', typeIndex(format, 10))).ok).toBe(
      false,
    );
  });

  test('it cannot go dead twice', () => {
    const events = [buzz(1, 'left', 'Sarah', typeIndex(format, -5))];
    const dead = event({ type: 'tossup-dead', questionNumber: 1 });
    const applied = applyScoreEvents(context, events, [dead]);
    expect(applied.ok).toBe(true);

    const again = event({ type: 'tossup-dead', questionNumber: 1 });
    expect(canApplyScoreEvent(context, applied.ok ? applied.events : [], again).ok).toBe(false);
  });
});

describe('a finished game stays finished', () => {
  test('nothing more can be scored once a team has forfeited', () => {
    const events = [event({ type: 'forfeit', questionNumber: 1, teams: ['right'] })];

    expect(canApplyScoreEvent(context, events, buzz(1, 'left', 'Sarah', typeIndex(format, 10))).ok).toBe(
      false,
    );
  });
});

describe('the starting lineup comes first', () => {
  const bigRosters: IGameSetup = {
    left: { name: 'Ninety Six', players: ['Sarah', 'James', 'Alex'] },
    right: { name: 'Greenwood', players: ['Emma', 'Jordan', 'Morgan'] },
  };

  test('scoring before the starters are named is refused', () => {
    const bigContext = { format, setup: bigRosters };

    const verdict = canApplyScoreEvent(bigContext, [], buzz(1, 'left', 'Sarah', typeIndex(format, 10)));

    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain('starting');
  });

  test('naming them is allowed, and scoring follows', () => {
    const bigContext = { format, setup: bigRosters };
    const lineups: ScoreEvent[] = [
      event({ type: 'substitution', questionNumber: 1, team: 'left', activePlayers: ['Sarah', 'Alex'] }),
      event({ type: 'substitution', questionNumber: 1, team: 'right', activePlayers: ['Emma', 'Morgan'] }),
    ];
    const applied = applyScoreEvents(bigContext, [], lineups);
    expect(applied.ok).toBe(true);

    expect(
      canApplyScoreEvent(
        bigContext,
        applied.ok ? applied.events : [],
        buzz(1, 'left', 'Sarah', typeIndex(format, 10)),
      ).ok,
    ).toBe(true);
  });

  test('a future substitute cannot answer the tossup that is still in progress', () => {
    const startedSetup: IGameSetup = {
      left: {
        name: 'Ninety Six',
        players: ['Sarah', 'James', 'Alex'],
        startingLineup: ['Sarah', 'James'],
      },
      right: {
        name: 'Greenwood',
        players: ['Emma', 'Jordan', 'Morgan'],
        startingLineup: ['Emma', 'Jordan'],
      },
    };
    const startedContext = { format, setup: startedSetup };
    const events: ScoreEvent[] = [
      buzz(1, 'right', 'Emma', typeIndex(format, -5)),
      event({ type: 'substitution', questionNumber: 2, team: 'left', activePlayers: ['James', 'Alex'] }),
    ];

    const futurePlayer = canApplyScoreEvent(
      startedContext,
      events,
      buzz(1, 'left', 'Alex', typeIndex(format, 10)),
    );
    const currentPlayer = canApplyScoreEvent(
      startedContext,
      events,
      buzz(1, 'left', 'Sarah', typeIndex(format, 10)),
    );

    expect(futurePlayer.ok).toBe(false);
    expect(futurePlayer.ok === false && futurePlayer.reason).toContain('not active');
    expect(currentPlayer.ok).toBe(true);
  });

  test('a voided tossup accepts a lineup for its replacement, not the following tossup', () => {
    const startedSetup: IGameSetup = {
      left: {
        name: 'Ninety Six',
        players: ['Sarah', 'James', 'Alex'],
        startingLineup: ['Sarah', 'James'],
      },
      right: {
        name: 'Greenwood',
        players: ['Emma', 'Jordan', 'Morgan'],
        startingLineup: ['Emma', 'Jordan'],
      },
    };
    const startedContext = { format, setup: startedSetup };
    const events: ScoreEvent[] = [
      event({ type: 'tossup-no-penalty', questionNumber: 1, team: 'left', playerName: 'Sarah' }),
      event({ type: 'question-void', questionNumber: 1, scope: 'tossup', reason: 'Wrong packet' }),
    ];
    const replacementLineup = event({
      type: 'substitution',
      questionNumber: 1,
      team: 'right',
      activePlayers: ['Jordan', 'Morgan'],
    });
    const followingLineup = { ...replacementLineup, id: `${replacementLineup.id}-later`, questionNumber: 2 };

    expect(canApplyScoreEvent(startedContext, events, replacementLineup).ok).toBe(true);
    expect(canApplyScoreEvent(startedContext, events, followingLineup).ok).toBe(false);
  });
});

describe('procedure actions', () => {
  test('timeouts are refused when the tournament does not track them', () => {
    const verdict = canApplyScoreEvent(
      context,
      [],
      event({ type: 'timeout', questionNumber: 1, team: 'left' }),
    );

    expect(verdict.ok).toBe(false);
  });

  test('a team cannot take more timeouts than it has', () => {
    const withTimeouts = {
      format,
      setup,
      procedure: { version: 1, halves: true, timeoutsPerTeam: 1 },
    };
    const events = [event({ type: 'timeout', questionNumber: 1, team: 'left' })];

    expect(canApplyScoreEvent(withTimeouts, [], events[0]).ok).toBe(true);
    expect(
      canApplyScoreEvent(withTimeouts, events, event({ type: 'timeout', questionNumber: 1, team: 'left' }))
        .ok,
    ).toBe(false);
    expect(
      canApplyScoreEvent(withTimeouts, events, event({ type: 'timeout', questionNumber: 1, team: 'right' }))
        .ok,
    ).toBe(true);
  });

  test('regulation cannot be ended on a format that is not timed', () => {
    expect(canApplyScoreEvent(context, [], event({ type: 'end-regulation', questionNumber: 3 })).ok).toBe(
      false,
    );
  });

  test('nothing can be scored while a score check is open', () => {
    const events = [
      event({ type: 'tossup-dead', questionNumber: 1 }),
      event({ type: 'half-break', questionNumber: 2, lastQuestion: 1 }),
    ];

    const verdict = canApplyScoreEvent(context, events, buzz(2, 'left', 'Sarah', typeIndex(format, 10)));

    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain('Confirm the score');
  });

  test('a question with nothing on it cannot be replaced', () => {
    const verdict = canApplyScoreEvent(
      context,
      [],
      event({ type: 'question-void', questionNumber: 1, scope: 'tossup', reason: 'Wrong packet' }),
    );

    expect(verdict.ok).toBe(false);
  });
});

describe('an action lands whole or not at all', () => {
  test('a rejected second event takes the first one with it', () => {
    const good = event({ type: 'roster-add', questionNumber: 1, team: 'left', playerName: 'Taylor' });
    const bad = event({ type: 'substitution', questionNumber: 1, team: 'left', activePlayers: [] });

    const result = applyScoreEvents(context, [], [good, bad]);

    expect(result.ok).toBe(false);
  });
});

describe('malformed and out-of-phase administrative events fail closed', () => {
  function expectRefused(
    candidateContext: typeof context,
    events: ScoreEvent[],
    candidate: ScoreEvent,
    reason: string,
  ): void {
    const verdict = canApplyScoreEvent(candidateContext, events, candidate);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain(reason);
  }

  test('identity, question, player, and ruling fields are validated', () => {
    const existing = buzz(1, 'left', 'Sarah', typeIndex(format, -5));
    expectRefused(context, [existing], { ...existing }, 'already recorded');
    expectRefused(context, [], buzz(0, 'left', 'Sarah', typeIndex(format, 10)), 'no question');
    expectRefused(context, [], buzz(2, 'left', 'Sarah', typeIndex(format, 10)), 'Tossup 1');
    expectRefused(context, [], buzz(1, 'left', '', typeIndex(format, 10)), 'Choose who');
    expectRefused(context, [], buzz(1, 'left', 'Sarah', 99), 'not a ruling');
    expectRefused(context, [], event({ type: 'tossup-dead', questionNumber: 2 }), 'Tossup 1');
  });

  test('substitutions validate the complete next lineup and boundary', () => {
    expectRefused(
      context,
      [],
      event({ type: 'substitution', questionNumber: 1, team: 'left', activePlayers: [] }),
      'somebody',
    );
    expectRefused(
      context,
      [],
      event({
        type: 'substitution',
        questionNumber: 1,
        team: 'left',
        activePlayers: ['Sarah', 'James', 'Alex'],
      }),
      'at most 2',
    );
    expectRefused(
      context,
      [],
      event({ type: 'substitution', questionNumber: 1, team: 'left', activePlayers: ['Sarah', 'Sarah'] }),
      'listed twice',
    );
    expectRefused(
      context,
      [],
      event({ type: 'substitution', questionNumber: 1, team: 'left', activePlayers: ['Sarah', 'Alex'] }),
      'team roster',
    );
    expectRefused(
      context,
      [event({ type: 'tossup-dead', questionNumber: 1 })],
      event({ type: 'substitution', questionNumber: 1, team: 'left', activePlayers: ['Sarah', 'James'] }),
      'Tossup 2',
    );
  });

  test('timeouts and breaks reject impossible state transitions', () => {
    const procedureContext = {
      ...context,
      procedure: {
        version: 2 as const,
        halves: true,
        timeoutsPerTeam: 1,
        substitutionPolicy: 'any-boundary' as const,
      },
    };
    expectRefused(procedureContext, [], event({ type: 'half-resume', questionNumber: 1 }), 'no break');
    expectRefused(
      procedureContext,
      [],
      event({ type: 'timeout-start', questionNumber: 2, team: 'left', startedAt: 0 }),
      'Tossup 1',
    );
    expectRefused(
      procedureContext,
      [],
      event({ type: 'timeout-start', questionNumber: 1, team: 'left', startedAt: -1 }),
      'valid timestamp',
    );
    const activeTimeout = [event({ type: 'timeout-start', questionNumber: 1, team: 'left', startedAt: 0 })];
    expectRefused(
      procedureContext,
      activeTimeout,
      event({ type: 'adjustment', questionNumber: 1, team: 'left', points: 5, reason: 'Control ruling' }),
      'timeout is active',
    );
    expectRefused(
      procedureContext,
      activeTimeout,
      event({ type: 'timeout-resume', questionNumber: 2 }),
      'Tossup 1',
    );
  });

  test('rare record types validate the values that make them meaningful', () => {
    expectRefused(
      context,
      [],
      event({ type: 'end-game-early', questionNumber: 1, reason: ' ', tossupsRead: 0 }),
      'Say why',
    );
    expectRefused(
      context,
      [],
      event({ type: 'question-void', questionNumber: 1, scope: 'tossup', reason: ' ' }),
      'Say what went wrong',
    );
    expectRefused(
      context,
      [event({ type: 'tossup-dead', questionNumber: 1 })],
      event({ type: 'question-void', questionNumber: 1, scope: 'bonus', reason: 'Reader correction' }),
      'no bonus',
    );
    expectRefused(
      context,
      [],
      event({
        type: 'protest',
        questionNumber: 1,
        team: 'left',
        subject: 'procedure',
        description: ' ',
        status: 'open',
      }),
      'being protested',
    );
    expectRefused(context, [], event({ type: 'forfeit', questionNumber: 1, teams: [] }), 'who forfeited');
    expectRefused(
      context,
      [],
      event({ type: 'lightning', questionNumber: 1, team: 'left', points: 20 }),
      'does not play lightning',
    );
    expectRefused(
      context,
      [],
      event({ type: 'adjustment', questionNumber: 1, team: 'left', points: 0, reason: 'Control ruling' }),
      'non-zero whole number',
    );
    expectRefused(
      context,
      [],
      event({ type: 'note', questionNumber: 1, text: ' ', flagged: false }),
      'some text',
    );
  });
});
