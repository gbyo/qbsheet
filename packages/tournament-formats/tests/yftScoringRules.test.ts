/**
 * YellowFruit scoring rules completed into assignment-grade QBJ.
 *
 * The cases that matter are the ones a `.yft` does not write down: whether a positive tossup earns
 * a bonus, whether bonuses exist at all, how many tossups regulation has, and what an answer type
 * is called. Getting one of those wrong produces a document that looks right and that a scorer
 * either refuses or, worse, scores differently from YellowFruit.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import type { JsonObject } from '../src/types';
import { readYellowFruitTournament } from '../src/yft';
import { yellowFruitScoringRules } from '../src/yftScoringRules';

function storedRules(): JsonObject {
  const report = readYellowFruitTournament(
    readFileSync(new URL('./fixtures/yft-sample.yft.json', import.meta.url), 'utf8'),
  );
  if (!report.ok) throw new Error('fixture failed to import');
  const rules = report.value.tournament.rules;
  if (!rules) throw new Error('fixture carried no scoring rules');
  return rules;
}

function answerTypes(rules: JsonObject): JsonObject[] {
  return (rules.answer_types as unknown as JsonObject[]) ?? [];
}

describe('yellowFruitScoringRules', () => {
  test('a real NAQT-untimed file completes into rules a scorer can start from', () => {
    const result = yellowFruitScoringRules(storedRules(), { id: 'rules-1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { rules, timed, usesBonuses } = result.value;

    expect(rules.type).toBe('ScoringRules');
    expect(rules.id).toBe('rules-1');
    expect(rules.teams_per_match).toBe(2);
    expect(rules.maximum_players_per_team).toBe(4);
    // The file states only the maximum; an untimed round's regulation count is that maximum.
    expect(rules.maximum_regulation_tossup_count).toBe(20);
    expect(rules.regulation_tossup_count).toBe(20);
    expect(rules.minimum_overtime_question_count).toBe(3);
    expect(rules.overtime_includes_bonuses).toBe(false);
    expect(rules.total_divisor).toBe(5);

    expect(usesBonuses).toBe(true);
    expect(rules.maximum_bonus_score).toBe(30);
    expect(rules.bonus_divisor).toBe(10);
    expect(rules.minimum_parts_per_bonus).toBe(3);
    expect(rules.maximum_parts_per_bonus).toBe(3);
    expect(rules.points_per_bonus_part).toBe(10);
    expect(rules.bonuses_bounce_back).toBe(false);
    expect(rules.lightning_count_per_team).toBe(0);
    expect(rules.lightning_divisor).toBeUndefined();

    expect(timed).toBe(false);

    // 15 / 10 / -5, with labels YellowFruit derives from the point values and an explicit
    // bonus-awarding flag the file never stores.
    expect(answerTypes(rules)).toEqual([
      {
        type: 'AnswerType',
        id: 'AnswerType_15',
        value: 15,
        label: '15',
        short_label: '15',
        awards_bonus: true,
      },
      {
        type: 'AnswerType',
        id: 'AnswerType_10',
        value: 10,
        label: '10',
        short_label: '10',
        awards_bonus: true,
      },
      {
        type: 'AnswerType',
        id: 'AnswerType_-5',
        value: -5,
        label: '-5',
        short_label: '-5',
        awards_bonus: false,
      },
    ]);
  });

  test('a timed file reports the nominal regulation count and the timed flag', () => {
    const stored: JsonObject = {
      YfData: { timed: true },
      name: 'NaqtTimed',
      maximum_players_per_team: 4,
      maximum_regulation_tossup_count: 24,
      minimum_overtime_question_count: 3,
      overtime_includes_bonuses: false,
      total_divisor: 5,
      maximum_bonus_score: 30,
      bonus_divisor: 10,
      minimum_parts_per_bonus: 3,
      maximum_parts_per_bonus: 3,
      points_per_bonus_part: 10,
      bonuses_bounce_back: false,
      lightning_count_per_team: 0,
      answer_types: [{ value: 15 }, { value: 10 }, { value: -5 }],
    };
    const result = yellowFruitScoringRules(stored);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.timed).toBe(true);
    expect(result.value.rules.maximum_regulation_tossup_count).toBe(24);
    // YellowFruit's own getter: a timed round reports its fixed default, not the maximum.
    expect(result.value.rules.regulation_tossup_count).toBe(20);
  });

  test('a no-bonus format writes no bonus structure and no answer type claiming one', () => {
    // What `ScoringRules.toFileObject` writes when `useBonuses` is false: the whole bonus block
    // is absent, which is the only signal the file carries.
    const stored: JsonObject = {
      YfData: { timed: false },
      name: '',
      maximum_players_per_team: 4,
      maximum_regulation_tossup_count: 20,
      minimum_overtime_question_count: 1,
      overtime_includes_bonuses: false,
      total_divisor: 5,
      lightning_count_per_team: 0,
      answer_types: [{ value: 10 }, { value: -5 }],
    };
    const result = yellowFruitScoringRules(stored);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.usesBonuses).toBe(false);
    expect(result.value.rules.maximum_bonus_score).toBeUndefined();
    expect(result.value.rules.bonus_divisor).toBeUndefined();
    expect(result.value.rules.bonuses_bounce_back).toBeUndefined();
    expect(answerTypes(result.value.rules).map((entry) => entry.awards_bonus)).toEqual([false, false]);
  });

  test('a custom format is carried structurally rather than snapped to a familiar one', () => {
    // Superpowers, bouncebacks, irregular bonus parts, lightning rounds and a 20-tossup overtime:
    // nothing here resembles a built-in rule set, and the name deliberately lies.
    const stored: JsonObject = {
      YfData: { timed: true },
      name: 'NAQT',
      maximum_players_per_team: 6,
      maximum_regulation_tossup_count: 26,
      minimum_overtime_question_count: 1,
      overtime_includes_bonuses: true,
      maximum_bonus_score: 30,
      bonus_divisor: 5,
      minimum_parts_per_bonus: 2,
      maximum_parts_per_bonus: 3,
      bonuses_bounce_back: true,
      lightning_count_per_team: 2,
      lightning_divisor: 5,
      answer_types: [
        { value: 20, label: 'Superpower', short_label: 'SP', id: 'AnswerType_Superpower' },
        { value: 15 },
        { value: 10 },
        { value: -5 },
      ],
    };
    const result = yellowFruitScoringRules(stored);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { rules } = result.value;
    expect(rules.name).toBe('NAQT');
    expect(rules.maximum_players_per_team).toBe(6);
    expect(rules.maximum_regulation_tossup_count).toBe(26);
    expect(rules.regulation_tossup_count).toBe(20);
    expect(rules.minimum_overtime_question_count).toBe(1);
    expect(rules.overtime_includes_bonuses).toBe(true);
    expect(rules.bonuses_bounce_back).toBe(true);
    expect(rules.minimum_parts_per_bonus).toBe(2);
    expect(rules.maximum_parts_per_bonus).toBe(3);
    // Irregular bonuses: no single per-part value, so the field stays absent.
    expect(rules.points_per_bonus_part).toBeUndefined();
    expect(rules.lightning_count_per_team).toBe(2);
    expect(rules.lightning_divisor).toBe(5);
    // `total_divisor` was not stated; it is derived from the increments actually in play.
    expect(rules.total_divisor).toBe(5);
    expect(answerTypes(rules).map((entry) => [entry.value, entry.label, entry.awards_bonus])).toEqual([
      [20, 'Superpower', true],
      [15, '15', true],
      [10, '10', true],
      [-5, '-5', false],
    ]);
  });

  test('rules that cannot describe a game are refused rather than repaired', () => {
    expect(yellowFruitScoringRules(null)).toEqual({
      ok: false,
      error: 'This YellowFruit file has no scoring rules.',
    });
    expect(yellowFruitScoringRules({ answer_types: [] }).ok).toBe(false);
    expect(yellowFruitScoringRules({ answer_types: [{ value: -5 }] }).ok).toBe(false);
    expect(yellowFruitScoringRules({ answer_types: [{ label: 'ten' }] }).ok).toBe(false);
  });
});
