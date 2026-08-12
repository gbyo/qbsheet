import { describe, expect, test } from 'vitest';
import { readQbjScoringRules, writeQbjScoringRules } from '../src/qbj/QbjScoringRules';
import toQbjMatch from '../src/scoring/toQbjMatch';
import deriveGame, { IGameSetup } from '../src/scoring/deriveGame';
import { scorekeeperFormatProblems } from '../src/scoring/ScorekeeperFormat';
import { ScoreEvent } from '../src/scoring/ScoreEvents';
import { event } from './events';
import { acfPowersScoringRules } from './qbjDocuments';
import { QbjObject } from '../src/qbj/QbjSerialization';

const setup: IGameSetup = {
  left: { name: 'Ninety Six', players: ['Sarah'] },
  right: { name: 'Greenwood', players: ['Emma'] },
};

function read(rules: QbjObject) {
  return readQbjScoringRules(rules, false);
}

function withoutBonusFields(): QbjObject {
  const rules = acfPowersScoringRules();
  for (const field of [
    'maximum_bonus_score',
    'bonus_divisor',
    'minimum_parts_per_bonus',
    'maximum_parts_per_bonus',
    'points_per_bonus_part',
    'bonuses_bounce_back',
  ]) {
    delete rules[field];
  }
  return rules;
}

describe('QBJ scoring-rule shape is validated without familiar-format guesses', () => {
  test('missing timing, players, regulation length, or overtime length is a blocker', () => {
    expect(readQbjScoringRules(acfPowersScoringRules()).ok).toBe(false);

    const missingPlayers = acfPowersScoringRules();
    delete missingPlayers.maximum_players_per_team;
    expect(read(missingPlayers).ok).toBe(false);

    const missingRegulationMaximum = acfPowersScoringRules();
    delete missingRegulationMaximum.maximum_regulation_tossup_count;
    expect(read(missingRegulationMaximum).ok).toBe(false);

    const missingOvertime = acfPowersScoringRules();
    delete missingOvertime.minimum_overtime_question_count;
    expect(read(missingOvertime).ok).toBe(false);
  });

  test('bonus shape is never filled with three parts, ten points, or a derived maximum', () => {
    const missingParts = acfPowersScoringRules();
    delete missingParts.minimum_parts_per_bonus;
    const result = read(missingParts);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join(' ')).toContain('minimum bonus part count');
    expect(result.problems.join(' ')).not.toContain('assumed');
  });

  test('bonus toggles that change scoring must be stated when bonuses are enabled', () => {
    const missingBounceback = acfPowersScoringRules();
    delete missingBounceback.bonuses_bounce_back;
    const bouncebackResult = read(missingBounceback);
    expect(bouncebackResult.ok).toBe(false);
    if (!bouncebackResult.ok) expect(bouncebackResult.problems.join(' ')).toContain('bounce back');

    const missingOvertimeBonuses = acfPowersScoringRules();
    delete missingOvertimeBonuses.overtime_includes_bonuses;
    const overtimeResult = read(missingOvertimeBonuses);
    expect(overtimeResult.ok).toBe(false);
    if (!overtimeResult.ok) expect(overtimeResult.problems.join(' ')).toContain('overtime includes bonuses');
  });

  test('a lightning divisor without a lightning count is not treated as a hidden lightning format', () => {
    const malformed = acfPowersScoringRules({ lightning_divisor: 5 });
    const result = read(malformed);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join(' ')).toContain('lightning count per team');
  });

  test('fractional answer values and duplicate explicit identities fail closed', () => {
    const fractional = acfPowersScoringRules({
      answer_types: [
        { type: 'AnswerType', id: 'ten', value: 10.5, label: 'Correct', awards_bonus: true },
        { type: 'AnswerType', id: 'neg', value: -5, label: 'Neg', awards_bonus: false },
      ],
    });
    expect(read(fractional).ok).toBe(false);

    const duplicateIds = acfPowersScoringRules({
      answer_types: [
        { type: 'AnswerType', id: 'same', value: 15, label: 'Power', awards_bonus: true },
        { type: 'AnswerType', id: 'same', value: 10, label: 'Correct', awards_bonus: true },
        { type: 'AnswerType', id: 'neg', value: -5, label: 'Neg', awards_bonus: false },
      ],
    });
    expect(read(duplicateIds).ok).toBe(false);

    const invalidDivisor = acfPowersScoringRules({ total_divisor: Number.NaN });
    expect(read(invalidDivisor).ok).toBe(false);

    const invalidPartValue = acfPowersScoringRules({ points_per_bonus_part: Number.NaN });
    expect(read(invalidPartValue).ok).toBe(false);
  });

  test('generated identities avoid explicit ids that appear later in the document', () => {
    const rules = withoutBonusFields();
    rules.total_divisor = 1;
    rules.answer_types = [
      { type: 'AnswerType', value: 10, label: 'Correct' },
      { type: 'AnswerType', id: 'AnswerType_Correct', value: 5, label: 'Other correct' },
      { type: 'AnswerType', id: 'neg', value: -5, label: 'Neg', awards_bonus: false },
    ];
    const result = read(rules);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.format.answerTypes.map((answerType) => answerType.qbjId)).toEqual([
      'AnswerType_Correct_2',
      'AnswerType_Correct',
      'neg',
    ]);
    expect(result.format.answerTypes[0].qbjId).not.toBe('AnswerType_Correct');
    expect(scorekeeperFormatProblems(result.format)).toEqual([]);
  });

  test('bonus eligibility comes from each answer type, not a root-level flag', () => {
    const noBonus = withoutBonusFields();
    noBonus.awards_bonus = true;
    noBonus.answer_types = (noBonus.answer_types as QbjObject[]).map((answerType) => ({
      ...answerType,
      awards_bonus: false,
    }));
    const disabled = read(noBonus);
    expect(disabled.ok).toBe(true);
    if (!disabled.ok) return;
    expect(disabled.format.bonus.enabled).toBe(false);

    const perTypeOnly = withoutBonusFields();
    perTypeOnly.answer_types = (perTypeOnly.answer_types as QbjObject[]).map((answerType) => ({
      ...answerType,
      awards_bonus: typeof answerType.value === 'number' && answerType.value > 0,
    }));
    const incomplete = read(perTypeOnly);
    expect(incomplete.ok).toBe(false);
    if (!incomplete.ok) expect(incomplete.problems.join(' ')).toContain('use bonuses');

    const missingPerTypeFlag = acfPowersScoringRules();
    const firstAnswerType = (missingPerTypeFlag.answer_types as QbjObject[])[0];
    delete firstAnswerType.awards_bonus;
    const rejected = read(missingPerTypeFlag);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.problems.join(' ')).toContain('does not say whether it awards a bonus');
  });

  test('a no-bonus format survives QBJ writer/readback without creating a phantom bonus', () => {
    const source = withoutBonusFields();
    source.awards_bonus = true;
    source.answer_types = (source.answer_types as QbjObject[]).map((answerType) => ({
      ...answerType,
      awards_bonus: false,
    }));
    const parsed = read(source);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const written = writeQbjScoringRules(parsed.format);
    const reread = read(written);
    expect(reread.ok).toBe(true);
    if (!reread.ok) return;
    expect(reread.format).toEqual(parsed.format);
    expect(reread.format.bonus.enabled).toBe(false);
  });

  test('custom order, zero answers, multiple negatives, and custom labels survive normalization', () => {
    const rules = withoutBonusFields();
    rules.total_divisor = 1;
    rules.answer_types = [
      { type: 'AnswerType', id: 'neg-seven', value: -7, label: 'Penalty seven', awards_bonus: false },
      { type: 'AnswerType', id: 'zero', value: 0, label: 'Inadmissible', awards_bonus: false },
      { type: 'AnswerType', id: 'ten-b', value: 10, label: 'Correct B', awards_bonus: false },
      { type: 'AnswerType', id: 'ten-a', value: 10, label: 'Correct A', awards_bonus: false },
      { type: 'AnswerType', id: 'neg-two', value: -2, label: 'Penalty two', awards_bonus: false },
    ];
    const result = read(rules);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.format.answerTypes.map((answerType) => answerType.value)).toEqual([10, 10, 0, -2, -7]);
    expect(result.format.answerTypes.map((answerType) => answerType.qbjId)).toEqual([
      'ten-b',
      'ten-a',
      'zero',
      'neg-two',
      'neg-seven',
    ]);
    expect(scorekeeperFormatProblems(result.format)).toEqual([]);
  });
});

describe('QBJ export retains answer-type identity when point values collide', () => {
  test('aggregate counts and question results carry the distinct ids', () => {
    const rules = withoutBonusFields();
    rules.answer_types = [
      { type: 'AnswerType', id: 'ten-a', value: 10, label: 'Ten A', awards_bonus: false },
      { type: 'AnswerType', id: 'ten-b', value: 10, label: 'Ten B', awards_bonus: false },
      { type: 'AnswerType', id: 'zero', value: 0, label: 'Zero', awards_bonus: false },
    ];
    const parsed = read(rules);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const first = parsed.format.answerTypes.find((answerType) => answerType.qbjId === 'ten-a');
    expect(first).toBeDefined();
    if (!first) return;
    const events: ScoreEvent[] = [
      event({ type: 'tossup-buzz', questionNumber: 1, team: 'left', playerName: 'Sarah', answerTypeIndex: first.index }),
    ];
    const game = deriveGame(parsed.format, setup, events);
    const match = toQbjMatch(parsed.format, game) as QbjObject;
    const team = match.match_teams as QbjObject[];
    const players = team[0].match_players as QbjObject[];
    expect(players[0].answer_counts).toEqual([{ number: 1, answer_type: { id: 'ten-a', value: 10 } }]);
    expect((match.match_questions as QbjObject[])[0].buzzes).toEqual([
      { team: { name: 'Ninety Six' }, player: { name: 'Sarah' }, result: { id: 'ten-a', value: 10 } },
    ]);
  });
});
