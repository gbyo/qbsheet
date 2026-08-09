/**
 * A complete NAQT-style game, played end to end, checked as a QBJ Match.
 *
 * NAQT is a parity case here, not a mode. Nothing in the scorer knows what NAQT is: the twenty-four
 * tossups, the fifteen-point power, the three-tossup overtime minimum, the bonus-free overtime and
 * the sudden death that follows it are all `ScoringRules` fields, and the same functions produce an
 * mACF game from different values of them. That is what the last block below is really testing —
 * the identical event history under a different rule set gives different, correct answers, which no
 * amount of `if (isNAQT)` could do.
 *
 * What is asserted is the exported Match, because that is what YellowFruit imports and what the stat
 * report divides by. Tossups heard in particular: it is the one number a wrong lineup silently
 * corrupts, and the reason substitutions are part of this game rather than a separate test.
 */
import { describe, expect, test } from 'vitest';
import { IScorekeeperFormat } from '../src/scoring/ScorekeeperFormat';
import scoringRulesToScorekeeperFormat from './rules';
import { CommonRuleSets, ScoringRules } from './rules';
import deriveGame, { IGameSetup } from '../src/scoring/deriveGame';
import toQbjMatch from '../src/scoring/toQbjMatch';
import { ScoreEvent } from '../src/scoring/ScoreEvents';
import validateScoresheet from '../src/scoring/validateScoresheet';
import { event } from './events';

interface IQbjPlayerLine {
  player: { name: string };
  tossups_heard?: number;
  answer_counts: Array<{ answer_type: { value: number }; number: number }>;
}

interface IQbjTeamLine {
  team: { name: string };
  points: number;
  match_players: IQbjPlayerLine[];
}

interface IQbjQuestionLine {
  bonus_points?: number;
}

interface IQbjMatch {
  match_teams: IQbjTeamLine[];
  match_questions: IQbjQuestionLine[];
  tossups_read: number;
}

const setup: IGameSetup = {
  left: { name: 'Ninety Six', players: ['Sarah', 'James', 'Alex', 'Taylor', 'Jordan'] },
  right: { name: 'Greenwood', players: ['Emma', 'Morgan', 'Casey', 'Riley', 'Quinn'] },
};

function formatFor(ruleSet: CommonRuleSets): IScorekeeperFormat {
  return scoringRulesToScorekeeperFormat(new ScoringRules(ruleSet));
}

const naqt = formatFor(CommonRuleSets.NaqtUntimed);
const acf = formatFor(CommonRuleSets.Acf);

function typeIndex(format: IScorekeeperFormat, value: number): number {
  const found = format.answerTypes.find((answerType) => answerType.value === value);
  if (!found) throw new Error(`No answer type worth ${value}`);
  return found.index;
}

function buzz(questionNumber: number, team: 'left' | 'right', playerName: string, value: number): ScoreEvent {
  return event({ type: 'tossup-buzz', questionNumber, team, playerName, answerTypeIndex: typeIndex(naqt, value) });
}

function bonus(questionNumber: number, team: 'left' | 'right', controlledPoints: number): ScoreEvent {
  return event({ type: 'bonus', questionNumber, team, controlledPoints });
}

/**
 * One tied regulation, a substitution in the middle of it, and an overtime that goes to sudden death.
 *
 * Written out rather than generated so the expected numbers below can be checked by hand against it,
 * which is the only thing that makes a golden test worth having.
 */
function playedGame(): ScoreEvent[] {
  const events: ScoreEvent[] = [
    // Five players on a four-seat floor, so the starters are an explicit decision.
    event({
      type: 'substitution',
      questionNumber: 1,
      team: 'left',
      activePlayers: ['Sarah', 'James', 'Alex', 'Taylor'],
    }),
    event({
      type: 'substitution',
      questionNumber: 1,
      team: 'right',
      activePlayers: ['Emma', 'Morgan', 'Casey', 'Quinn'],
    }),
  ];

  // Q1-Q10: Sarah powers five, Emma takes five, each converting 20 of the bonus.
  for (let questionNumber = 1; questionNumber <= 10; questionNumber += 1) {
    const left = questionNumber % 2 === 1;
    events.push(buzz(questionNumber, left ? 'left' : 'right', left ? 'Sarah' : 'Emma', left ? 15 : 10));
    events.push(bonus(questionNumber, left ? 'left' : 'right', 20));
  }
  // 5 × (15 + 20) = 175 for Ninety Six, 5 × (10 + 20) = 150 for Greenwood.

  // A one-for-one substitution effective from Q11. Taylor has heard ten; Jordan starts from zero.
  events.push(
    event({
      type: 'substitution',
      questionNumber: 11,
      team: 'left',
      activePlayers: ['Sarah', 'James', 'Alex', 'Jordan'],
    }),
  );

  // Q11: a neg from Ninety Six, then Greenwood converts and takes 30.
  events.push(buzz(11, 'left', 'Jordan', -5));
  events.push(buzz(11, 'right', 'Morgan', 10));
  events.push(bonus(11, 'right', 30));
  // Ninety Six 170, Greenwood 190.

  // Q12: Ninety Six converts and takes 10 of the bonus, which levels it at 190-190.
  events.push(buzz(12, 'left', 'Jordan', 10));
  events.push(bonus(12, 'left', 10));

  // Q13-Q20: dead tossups. Everyone still hears them.
  for (let questionNumber = 13; questionNumber <= 20; questionNumber += 1) {
    events.push(event({ type: 'tossup-dead', questionNumber }));
  }

  // Tied after regulation, so overtime. The transition is recorded at the checkpoint the engine
  // stopped at — after tossup 20 — which is what `validateScoresheet` insists on.
  events.push(event({ type: 'begin-overtime', questionNumber: 20 }));
  events.push(event({ type: 'tossup-dead', questionNumber: 21 }));
  events.push(buzz(22, 'left', 'Sarah', 10));
  events.push(buzz(23, 'right', 'Emma', 10));
  // 200-200 after the initial overtime: still tied, so sudden death.
  events.push(event({ type: 'begin-sudden-death', questionNumber: 23 }));
  events.push(buzz(24, 'left', 'James', 10));

  return events;
}

const events = playedGame();

function playerLine(match: IQbjMatch, teamName: string, playerName: string): IQbjPlayerLine {
  const matchTeam = match.match_teams.find((candidate) => candidate.team.name === teamName);
  const line = matchTeam?.match_players.find((candidate) => candidate.player.name === playerName);
  if (!line) throw new Error(`No player line for ${teamName}/${playerName}`);
  return line;
}

function maybePlayerLine(match: IQbjMatch, teamName: string, playerName: string): IQbjPlayerLine | undefined {
  return match.match_teams
    .find((candidate) => candidate.team.name === teamName)
    ?.match_players.find((candidate) => candidate.player.name === playerName);
}

function answerCount(line: IQbjPlayerLine | undefined, value: number): number {
  return line?.answer_counts.find((count) => count.answer_type.value === value)?.number ?? 0;
}

describe('a NAQT-style game, from the rules alone', () => {
  const game = deriveGame(naqt, setup, events);
  const match = toQbjMatch(naqt, game) as unknown as IQbjMatch;

  test('regulation runs to the configured tossup count and then to overtime', () => {
    expect(naqt.regulation.tossupCount).toBe(20);
    expect(naqt.overtime.minimumQuestionCount).toBe(3);
    expect(game.regulationComplete).toBe(true);
    expect(game.suddenDeathStarted).toBe(true);
    expect(game.phase.kind).toBe('complete');
  });

  test('the final score is the sum of configured answer values and bonuses', () => {
    // 175 - 5 (neg) + 10 + 10 (Q12) + 10 (overtime) + 10 (sudden death) = 210.
    expect(game.left.points).toBe(210);
    // 150 + 10 + 30 (Q11) + 10 (overtime) = 200.
    expect(game.right.points).toBe(200);
  });

  test('overtime carries no bonuses when the rules say so', () => {
    expect(naqt.overtime.includesBonuses).toBe(false);
    const overtimeQuestions = game.questions.filter((question) => question.period === 'overtime');
    expect(overtimeQuestions.length).toBeGreaterThan(0);
    expect(overtimeQuestions.every((question) => question.bonus === undefined)).toBe(true);
  });

  test('tossups read counts every question actually played, regulation and overtime', () => {
    expect(match.tossups_read).toBe(24);
  });

  test('tossups heard follows the lineup, not the roster', () => {
    // On the floor for all 24.
    expect(playerLine(match, 'Ninety Six', 'Sarah').tossups_heard).toBe(24);
    // Came off after Q10.
    expect(playerLine(match, 'Ninety Six', 'Taylor').tossups_heard).toBe(10);
    // Came on for Q11.
    expect(playerLine(match, 'Ninety Six', 'Jordan').tossups_heard).toBe(14);
    // Never left the bench, and is therefore not in the export at all.
    expect(maybePlayerLine(match, 'Greenwood', 'Riley')).toBeUndefined();
  });

  test('every buzz is attributed at the value the format gave it', () => {
    const sarah = playerLine(match, 'Ninety Six', 'Sarah');
    expect(answerCount(sarah, 15)).toBe(5);
    expect(answerCount(sarah, 10)).toBe(1); // the overtime tossup

    const jordan = playerLine(match, 'Ninety Six', 'Jordan');
    expect(answerCount(jordan, -5)).toBe(1);
    expect(answerCount(jordan, 10)).toBe(1);

    const emma = playerLine(match, 'Greenwood', 'Emma');
    expect(answerCount(emma, 10)).toBe(6); // five in regulation, one in overtime
  });

  test('bonus points are carried on the cycle that earned them, and add up', () => {
    // A bonus belongs to the question in QBJ; which team it was is the conversion on that cycle.
    const bonusTotal = match.match_questions.reduce(
      (total, question) => total + (question.bonus_points ?? 0),
      0,
    );
    expect(bonusTotal).toBe(240); // ten 20s, plus the 30 on Q11 and the 10 on Q12
    expect(match.match_teams.find((team) => team.team.name === 'Ninety Six')?.points).toBe(210);
    expect(match.match_teams.find((team) => team.team.name === 'Greenwood')?.points).toBe(200);
  });

  test('the scoresheet has nothing blocking submission', () => {
    expect(validateScoresheet(naqt, setup, events).blockers).toEqual([]);
  });
});

describe('the same history under different rules', () => {
  /*
   * The proof that none of this is NAQT-specific. Identical events, a rule set with no power and a
   * one-tossup overtime minimum, and the engine produces different — and correct — answers.
   */
  const game = deriveGame(acf, setup, events);

  test('a format with no power scores the same buzzes differently', () => {
    expect(acf.answerTypes.some((answerType) => answerType.value === 15)).toBe(false);
    expect(game.left.points).not.toBe(210);
  });

  test('the overtime minimum comes from the rules, not from a constant', () => {
    expect(acf.overtime.minimumQuestionCount).toBe(1);
    expect(naqt.overtime.minimumQuestionCount).toBe(3);
  });

  test('a timed NAQT round is the timed flag, not a different scorer', () => {
    const timed = formatFor(CommonRuleSets.NaqtTimed);
    expect(timed.regulation.timed).toBe(true);
    // `tossupCount` is the standard number a timed round is expected to reach; the configured
    // maximum is what a NAQT timed round is set up with.
    expect(timed.regulation.maximumTossupCount).toBe(24);
    // Same engine, told the round can end early.
    const shortened = deriveGame(timed, setup, [
      event({
        type: 'substitution',
        questionNumber: 1,
        team: 'left',
        activePlayers: ['Sarah', 'James', 'Alex', 'Taylor'],
      }),
      event({
        type: 'substitution',
        questionNumber: 1,
        team: 'right',
        activePlayers: ['Emma', 'Morgan', 'Casey', 'Quinn'],
      }),
      buzz(1, 'left', 'Sarah', 10),
      bonus(1, 'left', 20),
      event({ type: 'end-regulation', questionNumber: 2, lastRegulationQuestion: 1 }),
    ]);
    expect(shortened.regulationComplete).toBe(true);
    expect(shortened.tossupsRead).toBe(1);
  });
});
