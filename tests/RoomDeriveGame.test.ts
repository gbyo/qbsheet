/**
 * The scoring engine, exercised across the formats YellowFruit can actually represent.
 *
 * The property under test throughout is that nothing is format-specific. Every case below is the
 * same code path with different rules handed to it.
 */
import { describe, expect, test } from 'vitest';
import { IScorekeeperFormat } from '../src/scoring/ScorekeeperFormat';
import scoringRulesToScorekeeperFormat from './rules';
import { CommonRuleSets, ScoringRules } from './rules';
import AnswerType from './AnswerType';
import deriveGame, { IGameSetup, lineupChangeEffectiveQuestion } from '../src/scoring/deriveGame';
import { ScoreEvent } from '../src/scoring/ScoreEvents';
import { event } from './events';

const setup: IGameSetup = {
  left: { name: 'Ninety Six', players: ['Sarah', 'James', 'Alex', 'Taylor'] },
  right: { name: 'Greenwood', players: ['Emma', 'Jordan', 'Morgan', 'Casey'] },
};

function formatFor(mutate: (rules: ScoringRules) => void = () => {}): IScorekeeperFormat {
  const rules = new ScoringRules(CommonRuleSets.AcfPowers);
  mutate(rules);
  return scoringRulesToScorekeeperFormat(rules);
}

/** Index of the answer type worth this many points. */
function typeIndex(format: IScorekeeperFormat, value: number): number {
  const found = format.answerTypes.find((at) => at.value === value);
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
function dead(questionNumber: number): ScoreEvent {
  return event({ type: 'tossup-dead', questionNumber });
}
function bonus(
  questionNumber: number,
  team: 'left' | 'right',
  controlledPoints: number,
  bouncebackPoints?: number,
): ScoreEvent {
  return event({ type: 'bonus', questionNumber, team, controlledPoints, bouncebackPoints });
}

/** Play a straightforward converted tossup plus bonus. */
function convertedCycle(
  format: IScorekeeperFormat,
  questionNumber: number,
  team: 'left' | 'right',
  playerName: string,
  value: number,
  bonusPoints: number,
): ScoreEvent[] {
  return [
    buzz(questionNumber, team, playerName, typeIndex(format, value)),
    bonus(questionNumber, team, bonusPoints),
  ];
}

describe('a single tossup', () => {
  test('a converted tossup and its bonus produce the right score', () => {
    const format = formatFor();
    const game = deriveGame(format, setup, convertedCycle(format, 1, 'left', 'Sarah', 15, 20));

    expect(game.left.points).toBe(35);
    expect(game.left.tossupPoints).toBe(15);
    expect(game.left.bonusPoints).toBe(20);
    expect(game.right.points).toBe(0);
  });

  test('the buzzing player gets the points and the answer count', () => {
    const format = formatFor();
    const game = deriveGame(format, setup, convertedCycle(format, 1, 'left', 'Sarah', 15, 20));

    const sarah = game.left.players.find((p) => p.name === 'Sarah')!;
    expect(sarah.points).toBe(15);
    expect(sarah.answerCounts.get(typeIndex(format, 15))).toBe(1);
    expect(game.left.players.find((p) => p.name === 'James')!.points).toBe(0);
  });

  test('a dead tossup scores nothing but is still heard', () => {
    const format = formatFor();
    const game = deriveGame(format, setup, [dead(1)]);

    expect(game.left.points).toBe(0);
    expect(game.tossupsRead).toBe(1);
    expect(game.left.players.find((p) => p.name === 'Sarah')!.tossupsHeard).toBe(1);
  });

  test('every active player on both teams hears the tossup', () => {
    const format = formatFor();
    const game = deriveGame(format, setup, convertedCycle(format, 1, 'left', 'Sarah', 15, 20));

    for (const team of [game.left, game.right]) {
      for (const player of team.players) expect(player.tossupsHeard, player.name).toBe(1);
    }
  });
});

describe('multi-attempt tossups', () => {
  test('a neg does not end the tossup; the other team may still answer', () => {
    const format = formatFor();
    const events = [buzz(1, 'left', 'Sarah', typeIndex(format, -5))];

    const game = deriveGame(format, setup, events);

    expect(game.phase).toEqual({
      kind: 'tossup',
      questionNumber: 1,
      period: 'regulation',
      eligibleTeams: ['right'],
    });
    expect(game.questions[0].resolved).toBe(false);
  });

  test('a neg then a conversion by the other team scores both', () => {
    const format = formatFor();
    const game = deriveGame(format, setup, [
      buzz(1, 'left', 'Sarah', typeIndex(format, -5)),
      buzz(1, 'right', 'Emma', typeIndex(format, 10)),
      bonus(1, 'right', 20),
    ]);

    expect(game.left.points).toBe(-5);
    expect(game.right.points).toBe(30);
    expect(game.questions[0].resolved).toBe(true);
  });

  test('both teams negging ends the tossup, because nobody is left to ask', () => {
    const format = formatFor();
    const game = deriveGame(format, setup, [
      buzz(1, 'left', 'Sarah', typeIndex(format, -5)),
      buzz(1, 'right', 'Emma', typeIndex(format, -5)),
    ]);

    expect(game.questions[0].resolved).toBe(true);
    expect(game.phase.kind).toBe('tossup');
    expect(game.phase).toMatchObject({ questionNumber: 2 });
    expect(game.tossupsRead).toBe(1);
  });

  test('a format with two negs treats both as negs', () => {
    const format = formatFor((rules) => {
      rules.answerTypes = [new AnswerType(10), new AnswerType(-5), new AnswerType(-10)];
    });
    const game = deriveGame(format, setup, [
      buzz(1, 'left', 'Sarah', typeIndex(format, -10)),
      buzz(1, 'right', 'Emma', typeIndex(format, -5)),
    ]);

    expect(game.left.points).toBe(-10);
    expect(game.right.points).toBe(-5);
    expect(game.questions[0].resolved).toBe(true);
  });
});

describe('bonus phase', () => {
  test('a conversion moves straight into the bonus without being asked to', () => {
    const format = formatFor();
    const game = deriveGame(format, setup, [buzz(1, 'left', 'Sarah', typeIndex(format, 10))]);

    expect(game.phase).toEqual({ kind: 'bonus', questionNumber: 1, period: 'regulation', team: 'left' });
  });

  test('with bonuses off, a conversion goes straight to the next tossup', () => {
    const format = formatFor((rules) => rules.setUseBonuses(false));
    const game = deriveGame(format, setup, [buzz(1, 'left', 'Sarah', typeIndex(format, 10))]);

    expect(game.phase).toMatchObject({ kind: 'tossup', questionNumber: 2 });
    expect(game.left.bonusesHeard).toBe(0);
  });

  test('a neg never earns a bonus', () => {
    const format = formatFor();
    const game = deriveGame(format, setup, [
      buzz(1, 'left', 'Sarah', typeIndex(format, -5)),
      buzz(1, 'right', 'Emma', typeIndex(format, -5)),
    ]);

    expect(game.phase).toMatchObject({ kind: 'tossup' });
    expect(game.left.bonusesHeard).toBe(0);
    expect(game.right.bonusesHeard).toBe(0);
  });

  test('bonuses heard counts conversions, matching MatchTeam.getBonusesHeard', () => {
    const format = formatFor();
    const game = deriveGame(format, setup, [
      ...convertedCycle(format, 1, 'left', 'Sarah', 15, 20),
      ...convertedCycle(format, 2, 'left', 'James', 10, 30),
      ...convertedCycle(format, 3, 'right', 'Emma', 10, 10),
    ]);

    expect(game.left.bonusesHeard).toBe(2);
    expect(game.right.bonusesHeard).toBe(1);
    expect(game.left.bonusPoints).toBe(50);
  });

  test('an irregular bonus is recorded as a total', () => {
    // No pointsPerPart, so there is nothing to collect part by part.
    const format = formatFor((rules) => {
      rules.pointsPerBonusPart = undefined;
      rules.minimumPartsPerBonus = 2;
      rules.maximumPartsPerBonus = 5;
      rules.maximumBonusScore = 50;
    });
    const game = deriveGame(format, setup, convertedCycle(format, 1, 'left', 'Sarah', 10, 25));

    expect(format.bonus.regular).toBe(false);
    expect(game.left.bonusPoints).toBe(25);
    expect(game.left.points).toBe(35);
  });

  test('a bonus given per part totals the parts', () => {
    const format = formatFor();
    const game = deriveGame(format, setup, [
      buzz(1, 'left', 'Sarah', typeIndex(format, 10)),
      event({
        type: 'bonus',
        questionNumber: 1,
        team: 'left',
        parts: [{ controlledPoints: 10 }, { controlledPoints: 0 }, { controlledPoints: 10 }],
      }),
    ]);

    expect(game.left.bonusPoints).toBe(20);
  });
});

describe('bouncebacks', () => {
  test('bounceback points go to the other team', () => {
    const format = formatFor((rules) => {
      rules.bonusesBounceBack = true;
    });
    const game = deriveGame(format, setup, [
      buzz(1, 'left', 'Sarah', typeIndex(format, 10)),
      bonus(1, 'left', 20, 10),
    ]);

    expect(game.left.bonusPoints).toBe(20);
    expect(game.left.points).toBe(30);
    expect(game.right.bonusBouncebackPoints).toBe(10);
    expect(game.right.points).toBe(10);
  });

  test('per-part bouncebacks total correctly', () => {
    const format = formatFor((rules) => {
      rules.bonusesBounceBack = true;
    });
    const game = deriveGame(format, setup, [
      buzz(1, 'left', 'Sarah', typeIndex(format, 10)),
      event({
        type: 'bonus',
        questionNumber: 1,
        team: 'left',
        parts: [
          { controlledPoints: 10, bouncebackPoints: 0 },
          { controlledPoints: 0, bouncebackPoints: 10 },
          { controlledPoints: 0, bouncebackPoints: 10 },
        ],
      }),
    ]);

    expect(game.left.bonusPoints).toBe(10);
    expect(game.right.bonusBouncebackPoints).toBe(20);
  });
});

describe('lightning rounds', () => {
  test('a lightning total is added to the team score', () => {
    const format = formatFor((rules) => {
      rules.lightningCountPerTeam = 1;
    });
    const game = deriveGame(format, setup, [
      ...convertedCycle(format, 1, 'left', 'Sarah', 10, 20),
      event({ type: 'lightning', questionNumber: 1, team: 'left', points: 60 }),
    ]);

    expect(game.left.lightningPoints).toBe(60);
    expect(game.left.points).toBe(90);
  });

  test('a second lightning entry corrects the first rather than adding to it', () => {
    // YellowFruit keeps one lightning total per team, so re-entering it is a correction.
    const format = formatFor((rules) => {
      rules.lightningCountPerTeam = 1;
    });
    const game = deriveGame(format, setup, [
      event({ type: 'lightning', questionNumber: 1, team: 'left', points: 60 }),
      event({ type: 'lightning', questionNumber: 1, team: 'left', points: 40 }),
    ]);

    expect(game.left.lightningPoints).toBe(40);
  });
});

describe('substitutions', () => {
  test('a selected starting lineup applies to Tossup 1', () => {
    const format = formatFor((rules) => {
      rules.maximumPlayersPerTeam = 2;
    });
    const game = deriveGame(format, setup, [
      event({ type: 'substitution', questionNumber: 1, team: 'left', activePlayers: ['Alex'] }),
      dead(1),
    ]);

    expect(game.left.players.find((p) => p.name === 'Alex')!.tossupsHeard).toBe(1);
    expect(game.left.players.find((p) => p.name === 'Sarah')!.tossupsHeard).toBe(0);
  });

  test('only active players hear a tossup', () => {
    const format = formatFor((rules) => {
      rules.maximumPlayersPerTeam = 2;
    });
    const game = deriveGame(format, { ...setup }, [dead(1)]);

    expect(game.left.players.find((p) => p.name === 'Sarah')!.tossupsHeard).toBe(1);
    expect(game.left.players.find((p) => p.name === 'Alex')!.tossupsHeard).toBe(0);
  });

  test('a substitution moves tossups heard to the player who came on', () => {
    const format = formatFor((rules) => {
      rules.maximumPlayersPerTeam = 2;
    });
    const game = deriveGame(format, setup, [
      dead(1),
      dead(2),
      event({ type: 'substitution', questionNumber: 3, team: 'left', activePlayers: ['Sarah', 'Alex'] }),
      dead(3),
      dead(4),
    ]);

    expect(game.left.players.find((p) => p.name === 'Sarah')!.tossupsHeard).toBe(4);
    expect(game.left.players.find((p) => p.name === 'James')!.tossupsHeard).toBe(2);
    expect(game.left.players.find((p) => p.name === 'Alex')!.tossupsHeard).toBe(2);
  });

  test('the substitution applies from its own question, not the one after', () => {
    const format = formatFor((rules) => {
      rules.maximumPlayersPerTeam = 1;
    });
    const game = deriveGame(format, setup, [
      event({ type: 'substitution', questionNumber: 1, team: 'left', activePlayers: ['James'] }),
      dead(1),
    ]);

    expect(game.left.players.find((p) => p.name === 'James')!.tossupsHeard).toBe(1);
    expect(game.left.players.find((p) => p.name === 'Sarah')!.tossupsHeard).toBe(0);
  });

  test('a future personnel event updates the upcoming lineup without creating a fake question', () => {
    const format = formatFor((rules) => {
      rules.maximumPlayersPerTeam = 1;
    });
    const game = deriveGame(format, setup, [
      dead(5),
      event({ type: 'substitution', questionNumber: 6, team: 'left', activePlayers: ['Alex'] }),
    ]);

    expect(game.questions.map((question) => question.questionNumber)).toEqual([5]);
    expect(game.phase).toMatchObject({ kind: 'tossup', questionNumber: 6 });
    expect(game.left.activePlayers).toEqual(['Alex']);
  });

  test('the safe boundary moves past a tossup after its first buzz and while its bonus is being scored', () => {
    const format = formatFor();
    const before = deriveGame(format, setup, []);
    expect(lineupChangeEffectiveQuestion(before, [])).toBe(1);

    const negEvents = [buzz(1, 'left', 'Sarah', typeIndex(format, -5))];
    expect(lineupChangeEffectiveQuestion(deriveGame(format, setup, negEvents), negEvents)).toBe(2);

    const bonusEvents = [buzz(1, 'left', 'Sarah', typeIndex(format, 10))];
    expect(lineupChangeEffectiveQuestion(deriveGame(format, setup, bonusEvents), bonusEvents)).toBe(2);
  });

  test('a zero-point wrong answer also makes the lineup change apply to the next tossup', () => {
    const format = formatFor((rules) => {
      rules.maximumPlayersPerTeam = 1;
    });
    const lineupSetup: IGameSetup = {
      left: { name: 'Ninety Six', players: ['Sarah', 'Alex'], startingLineup: ['Sarah'] },
      right: { name: 'Greenwood', players: ['Emma'], startingLineup: ['Emma'] },
    };
    const events = [
      event({ type: 'tossup-no-penalty', questionNumber: 1, team: 'left', playerName: 'Sarah' }),
      event({ type: 'substitution', questionNumber: 2, team: 'left', activePlayers: ['Alex'] }),
    ];
    const game = deriveGame(format, lineupSetup, events);

    expect(lineupChangeEffectiveQuestion(game, events)).toBe(2);
    expect(game.questions[0].activePlayers.left).toEqual(['Sarah']);
    expect(game.left.activePlayers).toEqual(['Alex']);
  });

  test('voiding a started tossup moves the lineup boundary back to its replacement', () => {
    const format = formatFor((rules) => {
      rules.maximumPlayersPerTeam = 1;
    });
    const lineupSetup: IGameSetup = {
      left: { name: 'Ninety Six', players: ['Sarah', 'Alex'], startingLineup: ['Sarah'] },
      right: { name: 'Greenwood', players: ['Emma', 'Morgan'], startingLineup: ['Emma'] },
    };
    const replaced: ScoreEvent[] = [
      event({ type: 'tossup-no-penalty', questionNumber: 1, team: 'left', playerName: 'Sarah' }),
      event({ type: 'question-void', questionNumber: 1, scope: 'tossup', reason: 'Wrong packet' }),
    ];
    const futureLineup = event({
      type: 'substitution',
      questionNumber: 2,
      team: 'right',
      activePlayers: ['Morgan'],
    });
    const game = deriveGame(format, lineupSetup, replaced.concat(futureLineup));

    expect(game.phase).toMatchObject({ kind: 'tossup', questionNumber: 1 });
    expect(lineupChangeEffectiveQuestion(game, replaced)).toBe(1);
    expect(game.right.activePlayers).toEqual(['Emma']);
  });

  test('moving a lineup boundary recalculates TUH from the corrected tossup', () => {
    const format = formatFor((rules) => {
      rules.maximumPlayersPerTeam = 1;
    });
    const played = Array.from({ length: 12 }, (_, index) => dead(index + 1));
    const atEleven = event({
      type: 'substitution',
      questionNumber: 11,
      team: 'left',
      activePlayers: ['Alex'],
    });
    const corrected = { ...atEleven, questionNumber: 9 };

    expect(
      deriveGame(format, setup, [...played, atEleven]).left.players.find((p) => p.name === 'Alex')!
        .tossupsHeard,
    ).toBe(2);
    expect(
      deriveGame(format, setup, [...played, corrected]).left.players.find((p) => p.name === 'Alex')!
        .tossupsHeard,
    ).toBe(4);
  });

  test('a buzz by a benched player is surfaced as a personnel invariant violation', () => {
    const format = formatFor((rules) => {
      rules.maximumPlayersPerTeam = 1;
    });
    const game = deriveGame(format, setup, [buzz(1, 'left', 'Alex', typeIndex(format, 10))]);

    expect(game.personnelProblems[0]?.message).toContain('Alex was not active');
    expect(game.questions[0].activePlayers.left).toEqual(['Sarah']);
  });
});

describe('regulation and overtime', () => {
  /** Play `count` dead tossups, which is the quickest way to a tied game. */
  function deadTossups(count: number, from = 1): ScoreEvent[] {
    return Array.from({ length: count }, (_, i) => dead(from + i));
  }

  test('an untimed game ends when regulation is played out and somebody is ahead', () => {
    const format = formatFor();
    const game = deriveGame(format, setup, [
      ...convertedCycle(format, 1, 'left', 'Sarah', 10, 20),
      ...deadTossups(19, 2),
    ]);

    expect(game.tossupsRead).toBe(20);
    expect(game.regulationComplete).toBe(true);
    expect(game.phase).toEqual({ kind: 'complete', reason: 'regulation' });
  });

  test('a tie at the end of regulation opens an overtime checkpoint', () => {
    const format = formatFor();
    const game = deriveGame(format, setup, deadTossups(20));

    expect(game.regulationComplete).toBe(true);
    expect(game.phase).toEqual({ kind: 'checkpoint', checkpoint: 'overtime', afterQuestion: 20 });
  });

  test('sudden death ends the moment somebody scores', () => {
    const format = formatFor((rules) => {
      rules.minimumOvertimeQuestionCount = 1;
    });
    const game = deriveGame(format, setup, [
      ...deadTossups(20),
      ...convertedCycle(format, 21, 'left', 'Sarah', 10, 20),
    ]);

    expect(game.phase).toEqual({ kind: 'complete', reason: 'overtime' });
    expect(game.overtimeTossupsRead).toBe(1);
  });

  test('a three-tossup overtime period is played out even once somebody leads', () => {
    // The score is only consulted at the end of a period, which is what NAQT-style overtime does.
    const format = formatFor((rules) => {
      rules.minimumOvertimeQuestionCount = 3;
    });
    const game = deriveGame(format, setup, [
      ...deadTossups(20),
      ...convertedCycle(format, 21, 'left', 'Sarah', 10, 20),
    ]);

    expect(game.phase).toMatchObject({ kind: 'tossup', questionNumber: 22, period: 'overtime' });
  });

  test('after a full overtime period, a lead ends the game', () => {
    const format = formatFor((rules) => {
      rules.minimumOvertimeQuestionCount = 3;
    });
    const game = deriveGame(format, setup, [
      ...deadTossups(20),
      ...convertedCycle(format, 21, 'left', 'Sarah', 10, 20),
      dead(22),
      dead(23),
    ]);

    expect(game.overtimeTossupsRead).toBe(3);
    expect(game.phase).toEqual({ kind: 'complete', reason: 'overtime' });
  });

  test('still tied after the initial overtime period opens sudden death', () => {
    const format = formatFor((rules) => {
      rules.minimumOvertimeQuestionCount = 3;
    });
    const game = deriveGame(format, setup, deadTossups(23));

    expect(game.phase).toEqual({ kind: 'checkpoint', checkpoint: 'sudden-death', afterQuestion: 23 });
  });

  test('overtime excludes bonuses when the format says so', () => {
    const format = formatFor((rules) => {
      rules.minimumOvertimeQuestionCount = 1;
      rules.overtimeIncludesBonuses = false;
    });
    const game = deriveGame(format, setup, [
      ...deadTossups(20),
      buzz(21, 'left', 'Sarah', typeIndex(format, 10)),
    ]);

    // No bonus phase, and the conversion doesn't count as a bonus heard.
    expect(game.phase).toEqual({ kind: 'complete', reason: 'overtime' });
    expect(game.left.bonusesHeard).toBe(0);
  });

  test('overtime includes bonuses when the format says so', () => {
    const format = formatFor((rules) => {
      rules.minimumOvertimeQuestionCount = 1;
      rules.overtimeIncludesBonuses = true;
    });
    const game = deriveGame(format, setup, [
      ...deadTossups(20),
      buzz(21, 'left', 'Sarah', typeIndex(format, 10)),
    ]);

    expect(game.phase).toEqual({ kind: 'bonus', questionNumber: 21, period: 'overtime', team: 'left' });
    expect(game.left.bonusesHeard).toBe(1);
  });

  test('overtime buzzes are counted separately, as the Match model needs', () => {
    const format = formatFor((rules) => {
      rules.minimumOvertimeQuestionCount = 1;
    });
    const game = deriveGame(format, setup, [
      ...deadTossups(20),
      buzz(21, 'left', 'Sarah', typeIndex(format, 10)),
    ]);

    expect(game.left.overtimeBuzzes.get(typeIndex(format, 10))).toBe(1);
    expect(game.right.overtimeBuzzes.size).toBe(0);
  });
});

describe('timed formats', () => {
  test('regulation does not end on a tossup count', () => {
    const format = formatFor((rules) => {
      rules.timed = true;
    });
    const game = deriveGame(
      format,
      setup,
      Array.from({ length: 25 }, (_, i) => dead(i + 1)),
    );

    expect(game.regulationComplete).toBe(false);
    expect(game.phase).toMatchObject({ kind: 'tossup', questionNumber: 26, period: 'regulation' });
  });

  test('the moderator calling time ends regulation', () => {
    const format = formatFor((rules) => {
      rules.timed = true;
    });
    const game = deriveGame(format, setup, [
      ...convertedCycle(format, 1, 'left', 'Sarah', 10, 20),
      dead(2),
      event({ type: 'end-regulation', questionNumber: 2 }),
    ]);

    expect(game.regulationComplete).toBe(true);
    expect(game.phase).toEqual({ kind: 'complete', reason: 'regulation' });
  });

  test('time called on a tied game opens the overtime checkpoint', () => {
    const format = formatFor((rules) => {
      rules.timed = true;
      rules.minimumOvertimeQuestionCount = 1;
    });
    const game = deriveGame(format, setup, [dead(1), event({ type: 'end-regulation', questionNumber: 1 })]);

    expect(game.phase).toEqual({ kind: 'checkpoint', checkpoint: 'overtime', afterQuestion: 1 });
  });
});

describe('forfeits', () => {
  test('a single forfeit ends the game', () => {
    const format = formatFor();
    const game = deriveGame(format, setup, [event({ type: 'forfeit', questionNumber: 1, teams: ['right'] })]);

    expect(game.right.forfeited).toBe(true);
    expect(game.left.forfeited).toBe(false);
    expect(game.phase).toEqual({ kind: 'complete', reason: 'forfeit' });
  });

  test('a double forfeit marks both teams', () => {
    const format = formatFor();
    const game = deriveGame(format, setup, [
      event({ type: 'forfeit', questionNumber: 1, teams: ['left', 'right'] }),
    ]);

    expect(game.left.forfeited).toBe(true);
    expect(game.right.forfeited).toBe(true);
    expect(game.phase).toEqual({ kind: 'complete', reason: 'forfeit' });
  });

  test('a forfeit ends the game even with a bonus outstanding', () => {
    const format = formatFor();
    const game = deriveGame(format, setup, [
      buzz(1, 'left', 'Sarah', typeIndex(format, 10)),
      event({ type: 'forfeit', questionNumber: 1, teams: ['right'] }),
    ]);

    expect(game.phase).toEqual({ kind: 'complete', reason: 'forfeit' });
  });
});

describe('undo and correction', () => {
  test('dropping the last event undoes exactly that action', () => {
    const format = formatFor();
    const events = convertedCycle(format, 1, 'left', 'Sarah', 15, 20);

    const after = deriveGame(format, setup, events);
    const undone = deriveGame(format, setup, events.slice(0, -1));

    expect(after.left.points).toBe(35);
    expect(undone.left.points).toBe(15);
    expect(undone.phase).toEqual({ kind: 'bonus', questionNumber: 1, period: 'regulation', team: 'left' });
  });

  test('editing an earlier question recalculates everything downstream', () => {
    const format = formatFor();
    const events = [
      ...convertedCycle(format, 1, 'left', 'Sarah', 15, 20),
      ...convertedCycle(format, 2, 'left', 'James', 10, 30),
    ];
    expect(deriveGame(format, setup, events).left.points).toBe(75);

    // Sarah's 15 was really a 10, and the bonus was 0.
    const corrected = events.map((scoreEvent) => {
      if (scoreEvent.type === 'tossup-buzz' && scoreEvent.questionNumber === 1) {
        return { ...scoreEvent, answerTypeIndex: typeIndex(format, 10) };
      }
      if (scoreEvent.type === 'bonus' && scoreEvent.questionNumber === 1)
        return { ...scoreEvent, controlledPoints: 0 };
      return scoreEvent;
    });

    const game = deriveGame(format, setup, corrected);

    expect(game.left.points).toBe(50);
    expect(
      game.left.players.find((p) => p.name === 'Sarah')!.answerCounts.get(typeIndex(format, 15)),
    ).toBeUndefined();
  });

  test('a manual adjustment is recorded as itself and reaches the score', () => {
    const format = formatFor();
    const game = deriveGame(format, setup, [
      ...convertedCycle(format, 1, 'left', 'Sarah', 10, 20),
      event({
        type: 'adjustment',
        questionNumber: 1,
        team: 'left',
        points: 5,
        reason: 'Agreed with control',
      }),
    ]);

    expect(game.left.adjustmentPoints).toBe(5);
    expect(game.left.points).toBe(35);
  });
});

describe('notes', () => {
  test('notes and flags are collected without affecting the score', () => {
    const format = formatFor();
    const game = deriveGame(format, setup, [
      dead(1),
      event({ type: 'note', questionNumber: 12, text: 'possible protest', flagged: true }),
      event({ type: 'note', questionNumber: 1, text: 'late start' }),
    ]);

    expect(game.notes).toEqual([
      { questionNumber: 12, text: 'possible protest', flagged: true },
      { questionNumber: 1, text: 'late start', flagged: false },
    ]);
    expect(game.left.points).toBe(0);
  });
});

describe('formats MODAQ refuses', () => {
  test('7-point tossups with a -3 neg score normally', () => {
    const format = formatFor((rules) => {
      rules.answerTypes = [new AnswerType(7), new AnswerType(-3)];
      rules.setUseBonuses(false);
    });
    const game = deriveGame(format, setup, [
      buzz(1, 'left', 'Sarah', typeIndex(format, -3)),
      buzz(1, 'right', 'Emma', typeIndex(format, 7)),
    ]);

    expect(game.left.points).toBe(-3);
    expect(game.right.points).toBe(7);
  });

  test('a five-value format with two power tiers and two negs', () => {
    const format = formatFor((rules) => {
      rules.answerTypes = [
        new AnswerType(25),
        new AnswerType(20),
        new AnswerType(10),
        new AnswerType(-5),
        new AnswerType(-10),
      ];
    });
    const game = deriveGame(format, setup, [
      ...convertedCycle(format, 1, 'left', 'Sarah', 25, 30),
      buzz(2, 'right', 'Emma', typeIndex(format, -10)),
      ...convertedCycle(format, 2, 'left', 'James', 20, 10),
    ]);

    expect(game.left.points).toBe(85);
    expect(game.right.points).toBe(-10);
  });

  test('a four-part 40-point bonus with bouncebacks and lightning, all at once', () => {
    const format = formatFor((rules) => {
      rules.minimumPartsPerBonus = 4;
      rules.maximumPartsPerBonus = 4;
      rules.pointsPerBonusPart = 10;
      rules.maximumBonusScore = 40;
      rules.bonusesBounceBack = true;
      rules.lightningCountPerTeam = 1;
      rules.lightningDivisor = 5;
    });
    const game = deriveGame(format, setup, [
      buzz(1, 'left', 'Sarah', typeIndex(format, 10)),
      bonus(1, 'left', 30, 10),
      event({ type: 'lightning', questionNumber: 1, team: 'right', points: 45 }),
    ]);

    expect(game.left.points).toBe(40);
    expect(game.right.points).toBe(55);
  });
});

describe('robustness', () => {
  test('no events at all is a game about to start', () => {
    const format = formatFor();
    const game = deriveGame(format, setup, []);

    expect(game.left.points).toBe(0);
    expect(game.tossupsRead).toBe(0);
    expect(game.phase).toEqual({
      kind: 'tossup',
      questionNumber: 1,
      period: 'regulation',
      eligibleTeams: ['left', 'right'],
    });
  });

  test('a buzz referencing an answer type the format no longer has is ignored, not guessed at', () => {
    const format = formatFor();
    const game = deriveGame(format, setup, [buzz(1, 'left', 'Sarah', 99)]);

    expect(game.left.points).toBe(0);
    expect(game.questions[0].buzzes).toHaveLength(0);
  });

  test('a buzz from somebody not on the roster still counts', () => {
    // Losing points because a roster was incomplete would be worse than an unexpected name.
    const format = formatFor();
    const game = deriveGame(format, setup, [
      buzz(1, 'left', 'Substitute', typeIndex(format, 10)),
      bonus(1, 'left', 20),
    ]);

    expect(game.left.points).toBe(30);
    expect(game.left.players.find((p) => p.name === 'Substitute')!.points).toBe(10);
  });

  test('deriving twice from the same events gives the same answer', () => {
    const format = formatFor();
    const events = [
      ...convertedCycle(format, 1, 'left', 'Sarah', 15, 20),
      buzz(2, 'right', 'Emma', typeIndex(format, -5)),
      ...convertedCycle(format, 2, 'left', 'James', 10, 30),
      dead(3),
    ];

    const first = deriveGame(format, setup, events);
    const second = deriveGame(format, setup, events);

    expect(second.left.points).toBe(first.left.points);
    expect(second.right.points).toBe(first.right.points);
    expect(second.phase).toEqual(first.phase);
  });
});

describe('the overtime minimum is a minimum', () => {
  /** Play `count` dead tossups, which is the quickest way to a tied game. */
  function deadTossups(count: number, from = 1): ScoreEvent[] {
    return Array.from({ length: count }, (_, i) => dead(from + i));
  }

  /**
   * NAQT's `minimumOvertimeQuestionCount` of 3 means "at least three", not "in blocks of three".
   * Reading it as a period length makes a team that leads after four overtime tossups play two more,
   * which is a real game decided by a misread field.
   */
  test('once the minimum is played out, every further tossup is sudden death', () => {
    const format = formatFor((rules) => {
      rules.minimumOvertimeQuestionCount = 3;
    });
    const game = deriveGame(format, setup, [
      ...deadTossups(20),
      ...deadTossups(3, 21),
      ...convertedCycle(format, 24, 'left', 'Sarah', 10, 20),
    ]);

    expect(game.overtimeTossupsRead).toBe(4);
    expect(game.phase).toEqual({ kind: 'complete', reason: 'overtime' });
  });

  test('the minimum is still played out in full even once somebody leads', () => {
    const format = formatFor((rules) => {
      rules.minimumOvertimeQuestionCount = 3;
    });
    const game = deriveGame(format, setup, [
      ...deadTossups(20),
      ...convertedCycle(format, 21, 'left', 'Sarah', 10, 20),
      dead(22),
    ]);

    expect(game.phase).toMatchObject({ kind: 'tossup', questionNumber: 23, period: 'overtime' });
  });

  test('a tie after the minimum keeps the game going one tossup at a time', () => {
    const format = formatFor((rules) => {
      rules.minimumOvertimeQuestionCount = 3;
    });
    const game = deriveGame(format, setup, deadTossups(24));

    expect(game.phase).toMatchObject({ kind: 'tossup', questionNumber: 25, period: 'overtime' });
  });
});

describe('a wrong answer worth nothing', () => {
  function wrong(questionNumber: number, team: 'left' | 'right', playerName?: string): ScoreEvent {
    return event({ type: 'tossup-no-penalty', questionNumber, team, playerName });
  }

  test('it costs the team its chance without costing it points', () => {
    const format = formatFor();
    const game = deriveGame(format, setup, [wrong(1, 'left', 'Sarah')]);

    expect(game.left.points).toBe(0);
    expect(game.phase).toEqual({
      kind: 'tossup',
      questionNumber: 1,
      period: 'regulation',
      eligibleTeams: ['right'],
    });
  });

  test('it never appears in a player answer count, which is the whole reason it is not an answer type', () => {
    const format = formatFor();
    const game = deriveGame(format, setup, [wrong(1, 'left', 'Sarah'), dead(1)]);
    const sarah = game.left.players.find((player) => player.name === 'Sarah')!;

    expect(sarah.answerCounts.size).toBe(0);
    expect(sarah.points).toBe(0);
    // She was on the floor for a tossup that was read, so she heard it.
    expect(sarah.tossupsHeard).toBe(1);
  });

  test('both teams answering wrong resolves the tossup with nothing scored', () => {
    const format = formatFor();
    const game = deriveGame(format, setup, [wrong(1, 'left', 'Sarah'), wrong(1, 'right', 'Emma')]);

    expect(game.tossupsRead).toBe(1);
    expect(game.phase).toMatchObject({ kind: 'tossup', questionNumber: 2 });
  });

  test('the second team can still convert after the first answers wrong', () => {
    const format = formatFor();
    const game = deriveGame(format, setup, [
      wrong(1, 'left', 'Sarah'),
      buzz(1, 'right', 'Emma', typeIndex(format, 10)),
    ]);

    expect(game.right.points).toBe(10);
    expect(game.phase).toEqual({ kind: 'bonus', questionNumber: 1, period: 'regulation', team: 'right' });
  });
});

describe('the regulation boundary in a timed game', () => {
  test('time called on a question nobody started leaves that question in overtime', () => {
    const format = formatFor((rules) => {
      rules.timed = true;
      rules.minimumOvertimeQuestionCount = 1;
    });
    // Q1 finished and Q2 is on screen when the horn goes, so regulation ended after Q1.
    const game = deriveGame(format, setup, [
      dead(1),
      event({ type: 'end-regulation', questionNumber: 2, lastRegulationQuestion: 1 }),
      ...convertedCycle(format, 2, 'left', 'Sarah', 10, 20),
    ]);

    expect(game.questions.find((question) => question.questionNumber === 2)!.period).toBe('overtime');
    expect(game.overtimeTossupsRead).toBe(1);
    expect(game.left.overtimeBuzzes.get(typeIndex(format, 10))).toBe(1);
    expect(game.phase).toEqual({ kind: 'complete', reason: 'overtime' });
  });

  test('a tossup already in progress when time is called stays in regulation', () => {
    const format = formatFor((rules) => {
      rules.timed = true;
    });
    const game = deriveGame(format, setup, [
      dead(1),
      buzz(2, 'left', 'Sarah', typeIndex(format, -5)),
      event({ type: 'end-regulation', questionNumber: 2, lastRegulationQuestion: 2 }),
      dead(2),
    ]);

    expect(game.questions.find((question) => question.questionNumber === 2)!.period).toBe('regulation');
    expect(game.overtimeTossupsRead).toBe(0);
  });
});

describe('halves and timeouts', () => {
  test('a break stops the game until the score is confirmed', () => {
    const format = formatFor();
    const game = deriveGame(format, setup, [
      dead(1),
      event({ type: 'half-break', questionNumber: 2, lastQuestion: 1 }),
    ]);

    expect(game.awaitingScoreCheck).toBe(true);
    expect(game.phase).toEqual({ kind: 'score-check', afterQuestion: 1 });
  });

  test('confirming the score puts the game back on the next tossup', () => {
    const format = formatFor();
    const game = deriveGame(format, setup, [
      dead(1),
      event({ type: 'half-break', questionNumber: 2, lastQuestion: 1 }),
      event({ type: 'half-resume', questionNumber: 2 }),
    ]);

    expect(game.awaitingScoreCheck).toBe(false);
    expect(game.phase).toMatchObject({ kind: 'tossup', questionNumber: 2 });
  });

  test('timeouts are counted per team and change nothing about the score', () => {
    const format = formatFor();
    const game = deriveGame(format, setup, [
      dead(1),
      event({ type: 'timeout', questionNumber: 2, team: 'left' }),
    ]);

    expect(game.timeouts).toEqual({ left: 1, right: 0 });
    expect(game.left.points).toBe(0);
  });
});

describe('replacing a spoiled question', () => {
  test('the cycle is played again without charging anybody a second tossup heard', () => {
    const format = formatFor();
    const game = deriveGame(format, setup, [
      ...convertedCycle(format, 1, 'left', 'Sarah', 10, 20),
      ...convertedCycle(format, 2, 'right', 'Emma', 15, 30),
      event({ type: 'question-void', questionNumber: 2, scope: 'tossup', reason: 'Wrong packet' }),
      ...convertedCycle(format, 2, 'left', 'James', 10, 10),
    ]);

    expect(game.tossupsRead).toBe(2);
    expect(game.right.points).toBe(0);
    expect(game.left.points).toBe(50);
    expect(game.left.players.find((player) => player.name === 'Sarah')!.tossupsHeard).toBe(2);
    expect(game.questions.find((question) => question.questionNumber === 2)!.replaced).toBe(true);
  });

  test('a voided cycle with nothing recorded since is simply the next question again', () => {
    const format = formatFor();
    const game = deriveGame(format, setup, [
      dead(1),
      dead(2),
      event({ type: 'question-void', questionNumber: 2, scope: 'tossup', reason: 'Already heard' }),
    ]);

    expect(game.tossupsRead).toBe(1);
    expect(game.phase).toMatchObject({ kind: 'tossup', questionNumber: 2 });
  });

  test('replacing a bonus leaves the tossup that earned it alone', () => {
    const format = formatFor();
    const game = deriveGame(format, setup, [
      ...convertedCycle(format, 1, 'left', 'Sarah', 10, 30),
      event({ type: 'question-void', questionNumber: 1, scope: 'bonus', reason: 'Spoiled part' }),
    ]);

    expect(game.left.tossupPoints).toBe(10);
    expect(game.left.bonusPoints).toBe(0);
    expect(game.phase).toEqual({ kind: 'bonus', questionNumber: 1, period: 'regulation', team: 'left' });
  });
});

describe('ending a game short', () => {
  test('the game is over at the score it had, with the reason kept', () => {
    const format = formatFor();
    const game = deriveGame(format, setup, [
      ...convertedCycle(format, 1, 'left', 'Sarah', 10, 20),
      event({ type: 'end-game-early', questionNumber: 2, reason: 'Packet ran out', tossupsRead: 1 }),
    ]);

    expect(game.phase).toEqual({ kind: 'complete', reason: 'short' });
    expect(game.tossupsRead).toBe(1);
    expect(game.endedEarly).toEqual({ reason: 'Packet ran out', tossupsRead: 1 });
  });
});

describe('starting lineups', () => {
  const bigRosters: IGameSetup = {
    left: { name: 'Ninety Six', players: ['Sarah', 'James', 'Alex', 'Taylor', 'Riley'] },
    right: { name: 'Greenwood', players: ['Emma', 'Jordan', 'Morgan', 'Casey', 'Quinn'] },
  };

  test('a roster bigger than the floor is a question, not a guess', () => {
    const format = formatFor();
    const game = deriveGame(format, bigRosters, []);

    expect(game.needsStartingLineup).toEqual(['left', 'right']);
    expect(game.phase).toEqual({ kind: 'lineup', teams: ['left', 'right'] });
  });

  test('a roster that fits on the floor is never asked about', () => {
    const format = formatFor();
    const game = deriveGame(format, setup, []);

    expect(game.needsStartingLineup).toEqual([]);
    expect(game.phase).toMatchObject({ kind: 'tossup', questionNumber: 1 });
  });

  test('naming the starters settles it and the game begins', () => {
    const format = formatFor();
    const game = deriveGame(format, bigRosters, [
      event({ type: 'substitution', questionNumber: 1, team: 'left', activePlayers: ['Sarah', 'Riley'] }),
      event({ type: 'substitution', questionNumber: 1, team: 'right', activePlayers: ['Quinn', 'Casey'] }),
    ]);

    expect(game.phase).toMatchObject({ kind: 'tossup', questionNumber: 1 });
    expect(game.left.activePlayers).toEqual(['Sarah', 'Riley']);
    expect(game.right.activePlayers).toEqual(['Quinn', 'Casey']);
  });

  test('an explicit lineup in the setup answers the question before it is asked', () => {
    const format = formatFor();
    const game = deriveGame(
      format,
      { ...bigRosters, left: { ...bigRosters.left, startingLineup: ['Alex', 'Taylor', 'Riley', 'James'] } },
      [],
    );

    expect(game.needsStartingLineup).toEqual(['right']);
  });
});

describe('the running score on each question', () => {
  test('it is the score as it stood once that cycle closed', () => {
    const format = formatFor();
    const game = deriveGame(format, setup, [
      ...convertedCycle(format, 1, 'left', 'Sarah', 10, 20),
      ...convertedCycle(format, 2, 'right', 'Emma', 15, 30),
    ]);

    expect(game.questions[0].scoreAfter).toEqual({ left: 30, right: 0 });
    expect(game.questions[1].scoreAfter).toEqual({ left: 30, right: 45 });
  });
});

describe('events the model cannot hold', () => {
  test('a second answer by the same team on one tossup is reported, not scored', () => {
    const format = formatFor();
    const game = deriveGame(format, setup, [
      buzz(1, 'left', 'Sarah', typeIndex(format, 10)),
      buzz(1, 'left', 'James', typeIndex(format, 10)),
      bonus(1, 'left', 20),
    ]);

    // MatchQuestion.getPoints finds a team's buzz with `find`, so the second one has nowhere to go.
    expect(game.left.tossupPoints).toBe(10);
    expect(game.integrityProblems).toHaveLength(1);
    expect(game.integrityProblems[0].message).toContain('two answers');
  });
});
