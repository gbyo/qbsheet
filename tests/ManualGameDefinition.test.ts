/**
 * A game described from nothing, as a definition.
 *
 * Two claims are worth protecting here, and they pull in opposite directions.
 *
 * The first is that a manual game is an *ordinary* game: the rosters, the format and the procedure
 * that come out of this form have to be the same objects the file path produces, produced by the
 * same readers. A hand-entered format and the equivalent QBJ must be the same `IScorekeeperFormat`,
 * field for field, or the scorer is quietly running two rule engines.
 *
 * The second is that a manual game is honest about what it is not. Every identity field the package
 * type can carry — a scheduled match, a tournament key, QBJ object ids — means something to somebody
 * outside this device, and the temptation to fill one in because it exists is exactly what would
 * make a practice result look like it belongs to a schedule.
 */
import { describe, expect, test } from 'vitest';
import {
  IManualGameInput,
  defaultManualGameLabel,
  defineManualGame,
  manualRoundOptionDefaults,
  manualTournamentName,
  newManualRecordIdentity,
} from '../src/game/ManualGame';
import { IBasicScoringRulesInput, basicScoringRulesDefaults } from '../src/qbj/BasicScoringRules';
import { readQbjScoringRules } from '../src/qbj/QbjScoringRules';
import { basicScoringRulesToQbj } from '../src/qbj/BasicScoringRules';
import {
  IAdvancedScoringRulesInput,
  advancedFromBasic,
  advancedScoringRulesToQbj,
  newAdvancedAnswerType,
} from '../src/qbj/AdvancedScoringRules';
import { advancedRulesInput, basicRulesInput } from '../src/qbj/ScoringRulesInput';
import { gamePackageFormat, gamePackageProducer, gamePackageVersion } from '../src/game/GamePackage';
import { roomProcedureVersion } from '../src/scoring/RoomProcedure';

/**
 * The setup, with `rules` given as the basic form's own fields.
 *
 * The input now holds a discriminated wrapper so that an advanced format is statable, but almost every
 * test here is about a basic one and `rules: { ...basicScoringRulesDefaults, tossupValue: 0 }` is the
 * clearest way to say what is being varied. So the wrapping happens here rather than at ninety call
 * sites. `advancedRules` below is the other branch, tested on its own terms.
 */
type ManualOverrides = Omit<Partial<IManualGameInput>, 'rules'> & { rules?: IBasicScoringRulesInput };

function input(overrides: ManualOverrides = {}): IManualGameInput {
  const { rules, ...rest } = overrides;
  return {
    gameLabel: '',
    left: { name: 'Ninety Six', players: 'Sarah\nJames\nAlex' },
    right: { name: 'Greenwood', players: 'Emma\nJordan' },
    rules: basicRulesInput(rules ?? basicScoringRulesDefaults),
    options: { ...manualRoundOptionDefaults },
    ...rest,
  };
}

/** The definition, or a failure the test wants to see as one. */
function define(overrides: ManualOverrides = {}) {
  const result = defineManualGame(input(overrides));
  if (!result.ok) throw new Error(`expected a definition, got: ${result.problems.map((p) => p.message).join(' ')}`);
  return result.definition;
}

function problems(overrides: ManualOverrides = {}): string[] {
  const result = defineManualGame(input(overrides));
  return result.ok ? [] : result.problems.map((problem) => problem.message);
}

/** The setup with an advanced format in it, for the branch the basic form cannot state. */
function advancedInput(advanced: IAdvancedScoringRulesInput, overrides: ManualOverrides = {}): IManualGameInput {
  return { ...input(overrides), rules: advancedRulesInput(advanced) };
}

function advancedRules(overrides: Partial<IAdvancedScoringRulesInput> = {}): IAdvancedScoringRulesInput {
  return { ...advancedFromBasic(basicScoringRulesDefaults), ...overrides };
}

function defineAdvanced(advanced: IAdvancedScoringRulesInput) {
  const result = defineManualGame(advancedInput(advanced));
  if (!result.ok) throw new Error(`expected a definition, got: ${result.problems.map((p) => p.message).join(' ')}`);
  return result.definition;
}

function advancedProblems(advanced: IAdvancedScoringRulesInput): string[] {
  const result = defineManualGame(advancedInput(advanced));
  return result.ok ? [] : result.problems.map((problem) => problem.message);
}

function answerType(value: number, label: string, shortLabel: string, awardsBonus = value > 0) {
  return newAdvancedAnswerType({ value, label, shortLabel, awardsBonus });
}

describe('teams and players', () => {
  test('the names typed in are the names scored against', () => {
    const definition = define();
    expect(definition.left.name).toBe('Ninety Six');
    expect(definition.left.players.map((player) => player.name)).toEqual(['Sarah', 'James', 'Alex']);
    expect(definition.right.name).toBe('Greenwood');
    expect(definition.right.players.map((player) => player.name)).toEqual(['Emma', 'Jordan']);
  });

  test('blank lines and stray spacing are dropped rather than becoming players', () => {
    const definition = define({ left: { name: 'Ninety Six', players: '\n  Sarah  \n\n\nJames\n  \n' } });
    expect(definition.left.players.map((player) => player.name)).toEqual(['Sarah', 'James']);
  });

  test('the two rosters do not have to be the same size', () => {
    const definition = define({ right: { name: 'Greenwood', players: 'Emma' } });
    expect(definition.left.players).toHaveLength(3);
    expect(definition.right.players).toHaveLength(1);
  });

  test('a team with no name is refused, by side', () => {
    expect(problems({ left: { name: '   ', players: 'Sarah' } })).toContain('Enter a name for the left team.');
    expect(problems({ right: { name: '', players: 'Emma' } })).toContain('Enter a name for the right team.');
  });

  test('two teams with the same name are refused whatever the capitals', () => {
    expect(problems({ right: { name: 'ninety six', players: 'Emma' } })).toContain('Team names must be different.');
  });

  test('a side with no players is refused, and named', () => {
    expect(problems({ right: { name: 'Greenwood', players: '   \n\n' } })).toContain(
      'Greenwood needs at least one player.',
    );
  });

  test('a side with no players and no name is still refused in words', () => {
    expect(problems({ right: { name: '', players: '' } })).toContain('The right team needs at least one player.');
  });

  test('a player listed twice on one roster is refused, in the same words the file path uses', () => {
    expect(problems({ left: { name: 'Ninety Six', players: 'Sarah\nJames\nSarah' } })).toContain(
      'Ninety Six: "Sarah" is listed more than once.',
    );
  });

  test('the same name on the two rosters is two different people, and is allowed', () => {
    const definition = define({ right: { name: 'Greenwood', players: 'Sarah' } });
    expect(definition.right.players[0].name).toBe('Sarah');
  });
});

describe('the game label', () => {
  test('names the round, which is what headers and Recent Games read', () => {
    expect(define({ gameLabel: 'Tuesday scrimmage' }).round.name).toBe('Tuesday scrimmage');
  });

  test('falls back rather than leaving a game with no name', () => {
    expect(define().round.name).toBe(defaultManualGameLabel);
    expect(define({ gameLabel: '    ' }).round.name).toBe(defaultManualGameLabel);
  });
});

describe('scoring rules', () => {
  test('go through the same reader an imported ScoringRules object does', () => {
    const rules = { ...basicScoringRulesDefaults, tossupValue: 10, powerValue: 15, negValue: -5 };
    const definition = define({ rules });

    const imported = readQbjScoringRules(basicScoringRulesToQbj(rules), rules.timed);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(definition.scorekeeperFormat).toEqual(imported.format);
  });

  test('a hand-entered format and the equivalent QBJ are the same format', () => {
    // Written out by hand rather than through the builder, so this compares the manual pipeline
    // against a document rather than against itself.
    const byHand = readQbjScoringRules(
      {
        type: 'ScoringRules',
        id: 'ScoringRules_Entered',
        name: 'Scoring rules entered in the room',
        teams_per_match: 2,
        maximum_players_per_team: 3,
        regulation_tossup_count: 24,
        maximum_regulation_tossup_count: 24,
        minimum_overtime_question_count: 3,
        overtime_includes_bonuses: true,
        answer_types: [
          { type: 'AnswerType', id: 'AnswerType_15', value: 15, label: 'Power', short_label: 'P', awards_bonus: true },
          { type: 'AnswerType', id: 'AnswerType_10', value: 10, label: 'Correct', short_label: 'C', awards_bonus: true },
          { type: 'AnswerType', id: 'AnswerType_-5', value: -5, label: 'Neg', short_label: 'N', awards_bonus: false },
        ],
        maximum_bonus_score: 30,
        bonus_divisor: 10,
        minimum_parts_per_bonus: 3,
        maximum_parts_per_bonus: 3,
        points_per_bonus_part: 10,
        bonuses_bounce_back: true,
        lightning_count_per_team: 2,
        lightning_divisor: 5,
      },
      true,
    );
    expect(byHand.ok).toBe(true);
    if (!byHand.ok) return;

    const definition = define({
      rules: {
        ...basicScoringRulesDefaults,
        tossupValue: 10,
        powerValue: 15,
        negValue: -5,
        tossupCount: 24,
        maximumPlayersPerTeam: 3,
        useBonuses: true,
        pointsPerBonusPart: 10,
        partsPerBonus: 3,
        bonusesBounceBack: true,
        overtimeQuestionCount: 3,
        overtimeIncludesBonuses: true,
        useLightning: true,
        lightningCountPerTeam: 2,
        lightningDivisor: 5,
        timed: true,
      },
    });

    expect(definition.scorekeeperFormat).toEqual(byHand.format);
  });

  test('players playing at once is what the lineup workflow will read', () => {
    const definition = define({ rules: { ...basicScoringRulesDefaults, maximumPlayersPerTeam: 2 } });
    expect(definition.scorekeeperFormat.players.maximumActive).toBe(2);
  });

  test('a floor size below one is refused rather than quietly kept at four', () => {
    expect(problems({ rules: { ...basicScoringRulesDefaults, maximumPlayersPerTeam: 0 } })).toContain(
      'Players playing at once must be at least 1.',
    );
  });

  test('bouncebacks are carried, both ways', () => {
    expect(define({ rules: { ...basicScoringRulesDefaults, bonusesBounceBack: true } }).scorekeeperFormat.bonus
      .bounceBack).toBe(true);
    expect(define().scorekeeperFormat.bonus.bounceBack).toBe(false);
  });

  test('bonuses can be turned off entirely', () => {
    const format = define({ rules: { ...basicScoringRulesDefaults, useBonuses: false } }).scorekeeperFormat;
    expect(format.bonus.enabled).toBe(false);
  });

  test('overtime is what was entered, and one tossup still means sudden death', () => {
    const sudden = define().scorekeeperFormat.overtime;
    expect(sudden.minimumQuestionCount).toBe(1);
    expect(sudden.suddenDeath).toBe(true);
    expect(sudden.includesBonuses).toBe(false);

    const longer = define({
      rules: { ...basicScoringRulesDefaults, overtimeQuestionCount: 3, overtimeIncludesBonuses: true },
    }).scorekeeperFormat.overtime;
    expect(longer.minimumQuestionCount).toBe(3);
    expect(longer.suddenDeath).toBe(false);
    expect(longer.includesBonuses).toBe(true);
  });

  test('an overtime period with no tossups in it is refused', () => {
    expect(problems({ rules: { ...basicScoringRulesDefaults, overtimeQuestionCount: 0 } })).toContain(
      'This tournament has an overtime period with no tossups in it.',
    );
  });

  test('lightning is off unless it is asked for', () => {
    expect(define().scorekeeperFormat.lightning).toEqual({ enabled: false, countPerTeam: 0, divisor: 10 });
  });

  test('lightning maps onto the shape the format already models', () => {
    const lightning = define({
      rules: {
        ...basicScoringRulesDefaults,
        useLightning: true,
        lightningCountPerTeam: 2,
        lightningDivisor: 5,
      },
    }).scorekeeperFormat.lightning;
    expect(lightning).toEqual({ enabled: true, countPerTeam: 2, divisor: 5 });
  });

  test('the detailed complaint is what comes back, not a generic refusal', () => {
    const found = problems({ rules: { ...basicScoringRulesDefaults, tossupValue: 0, negValue: -5 } });
    expect(found).toContain('These scoring rules have no way to score points on a tossup.');
    expect(found.join(' ')).not.toContain('Invalid rules');
  });

  test('no rule set is named anywhere in what it produces', () => {
    const serialized = JSON.stringify(define({ rules: { ...basicScoringRulesDefaults, powerValue: 15 } }));
    expect(serialized).not.toContain('NAQT');
    expect(serialized).not.toContain('ACF');
  });
});

/**
 * The formats the basic form could never state.
 *
 * The claim under test is the same one the basic form has to satisfy — a hand-entered format and the
 * equivalent QBJ document are the same `IScorekeeperFormat`, field for field — applied to the cases
 * that used to have to arrive as a document or not at all.
 */
describe('advanced scoring rules', () => {
  test('two power tiers survive as three positive answer types', () => {
    const format = defineAdvanced(
      advancedRules({
        answerTypes: [
          answerType(20, 'Superpower', 'S'),
          answerType(15, 'Power', 'P'),
          answerType(10, 'Correct', 'C'),
          answerType(-5, 'Neg', 'N'),
        ],
      }),
    ).scorekeeperFormat;

    expect(format.answerTypes.map((type) => type.value)).toEqual([20, 15, 10, -5]);
    // Descending by value, powers first and negs last, exactly as an imported document is sorted.
    expect(format.answerTypes.map((type) => type.index)).toEqual([0, 1, 2, 3]);
    expect(format.answerTypes.filter((type) => type.isPower).map((type) => type.value)).toEqual([20, 15]);
    expect(format.answerTypes.filter((type) => type.isNeg).map((type) => type.value)).toEqual([-5]);
  });

  test('two different negs are both kept', () => {
    const format = defineAdvanced(
      advancedRules({
        answerTypes: [answerType(10, 'Correct', 'C'), answerType(-5, 'Neg', 'N'), answerType(-10, 'Bad neg', 'B')],
      }),
    ).scorekeeperFormat;

    expect(format.answerTypes.map((type) => type.value)).toEqual([10, -5, -10]);
    expect(format.totalDivisor).toBe(5);
  });

  test('a zero-point answer type is a real answer type, and earns no bonus by default', () => {
    const format = defineAdvanced(
      advancedRules({
        answerTypes: [answerType(10, 'Correct', 'C'), answerType(0, 'Wrong after readout', 'W')],
      }),
    ).scorekeeperFormat;

    const zero = format.answerTypes.find((type) => type.value === 0);
    expect(zero?.awardsBonus).toBe(false);
    expect(zero?.isPower).toBe(false);
    expect(zero?.isNeg).toBe(false);
  });

  test('an irregular bonus is irregular, and states no points per part', () => {
    const bonus = defineAdvanced(
      advancedRules({
        bonusStructure: 'irregular',
        maximumBonusScore: 40,
        bonusDivisor: 10,
        minimumPartsPerBonus: 2,
        maximumPartsPerBonus: 3,
      }),
    ).scorekeeperFormat.bonus;

    expect(bonus.enabled).toBe(true);
    expect(bonus.regular).toBe(false);
    // What makes it irregular, and what tells the scorer to take a typed total rather than buttons.
    expect(bonus.pointsPerPart).toBeUndefined();
    expect(bonus).toMatchObject({ divisor: 10, minimumParts: 2, maximumParts: 3, maximumScore: 40 });
  });

  test('a regular bonus stated through the advanced form is still regular', () => {
    const bonus = defineAdvanced(advancedRules()).scorekeeperFormat.bonus;

    expect(bonus.regular).toBe(true);
    expect(bonus.pointsPerPart).toBe(10);
  });

  test('a hand-entered advanced format and the equivalent QBJ are the same format', () => {
    // Written out by hand rather than through the builder, so this compares the advanced pipeline
    // against a document rather than against itself.
    const byHand = readQbjScoringRules(
      {
        type: 'ScoringRules',
        id: 'ScoringRules_Entered',
        name: 'Scoring rules entered in the room',
        teams_per_match: 2,
        maximum_players_per_team: 4,
        regulation_tossup_count: 20,
        maximum_regulation_tossup_count: 20,
        minimum_overtime_question_count: 1,
        overtime_includes_bonuses: false,
        answer_types: [
          { type: 'AnswerType', id: 'AnswerType_20', value: 20, label: 'Superpower', short_label: 'S', awards_bonus: true },
          { type: 'AnswerType', id: 'AnswerType_15', value: 15, label: 'Power', short_label: 'P', awards_bonus: true },
          { type: 'AnswerType', id: 'AnswerType_10', value: 10, label: 'Correct', short_label: 'C', awards_bonus: true },
          { type: 'AnswerType', id: 'AnswerType_-5', value: -5, label: 'Neg', short_label: 'N', awards_bonus: false },
        ],
        maximum_bonus_score: 40,
        bonus_divisor: 10,
        minimum_parts_per_bonus: 2,
        maximum_parts_per_bonus: 3,
        bonuses_bounce_back: false,
      },
      false,
    );
    expect(byHand.ok).toBe(true);
    if (!byHand.ok) return;

    const definition = defineAdvanced(
      advancedRules({
        answerTypes: [
          answerType(20, 'Superpower', 'S'),
          answerType(15, 'Power', 'P'),
          answerType(10, 'Correct', 'C'),
          answerType(-5, 'Neg', 'N'),
        ],
        bonusStructure: 'irregular',
        maximumBonusScore: 40,
        bonusDivisor: 10,
        minimumPartsPerBonus: 2,
        maximumPartsPerBonus: 3,
      }),
    );

    expect(definition.scorekeeperFormat).toEqual(byHand.format);
  });

  test('the QBJ object it builds carries no points per part for an irregular bonus', () => {
    const qbj = advancedScoringRulesToQbj(
      advancedRules({ bonusStructure: 'irregular', maximumBonusScore: 40, bonusDivisor: 10, minimumPartsPerBonus: 2, maximumPartsPerBonus: 3 }),
    );

    expect(qbj.points_per_bonus_part).toBeUndefined();
    expect(qbj.maximum_bonus_score).toBe(40);
  });

  test('a row with no value typed in it is refused rather than scored as zero', () => {
    const found = advancedProblems(
      advancedRules({ answerTypes: [answerType(10, 'Correct', 'C'), newAdvancedAnswerType({ label: 'Power' })] }),
    );

    expect(found).toContain('"Power" needs a point value.');
  });

  test('two answer types worth the same are refused, because the scorer would show two of them', () => {
    const found = advancedProblems(
      advancedRules({ answerTypes: [answerType(10, 'Correct', 'C'), answerType(10, 'Also correct', 'A')] }),
    );

    expect(found).toContain('Two answer types are worth 10 points.');
  });

  test('a format with no answer types at all is refused', () => {
    expect(advancedProblems(advancedRules({ answerTypes: [] }))).toContain('Add at least one way to answer a tossup.');
  });

  test('bonuses nothing earns are refused, because no buzz could ever open one', () => {
    const found = advancedProblems(
      advancedRules({ answerTypes: [answerType(10, 'Correct', 'C', false)], useBonuses: true }),
    );

    expect(found).toContain('This format uses bonuses but no answer type earns one.');
  });

  test('an irregular bonus whose maximum is not a multiple of its increment is refused', () => {
    const found = advancedProblems(
      advancedRules({
        bonusStructure: 'irregular',
        maximumBonusScore: 35,
        bonusDivisor: 10,
        minimumPartsPerBonus: 2,
        maximumPartsPerBonus: 3,
      }),
    );

    expect(found).toContain('The maximum bonus score must be a multiple of the bonus score increment.');
  });

  test('a part range the wrong way round is refused', () => {
    const found = advancedProblems(
      advancedRules({
        bonusStructure: 'irregular',
        maximumBonusScore: 40,
        bonusDivisor: 10,
        minimumPartsPerBonus: 4,
        maximumPartsPerBonus: 2,
      }),
    );

    expect(found).toContain('The fewest parts per bonus cannot exceed the most parts per bonus.');
  });

  test('the engine still gets the last word on a format nobody could play', () => {
    // Nothing positive to score. The complaint comes from the shared playability judgement rather
        // than from a check written twice.
    expect(advancedProblems(advancedRules({ answerTypes: [answerType(-5, 'Neg', 'N')] }))).toContain(
      'These scoring rules have no way to score points on a tossup.',
    );
  });

  test('no rule set is named anywhere in what it produces', () => {
    const serialized = JSON.stringify(
      defineAdvanced(advancedRules({ answerTypes: [answerType(20, 'Superpower', 'S'), answerType(10, 'Correct', 'C')] })),
    );

    expect(serialized).not.toContain('NAQT');
    expect(serialized).not.toContain('ACF');
  });
});

describe('round options', () => {
  test('nothing configured attaches no procedure at all', () => {
    expect(define().procedure).toBeUndefined();
  });

  test('halves and timeouts become an ordinary room procedure', () => {
    const definition = define({
      options: {
        halves: true,
        halfLengthMinutes: 10,
        timeoutsPerTeam: 1,
        timeoutDurationSeconds: 60,
        substitutionPolicy: 'breaks-timeouts-overtime',
      },
    });
    expect(definition.procedure).toEqual({
      version: roomProcedureVersion,
      halves: true,
      halfLengthMinutes: 10,
      timeoutsPerTeam: 1,
      timeoutDurationSeconds: 60,
      substitutionPolicy: 'breaks-timeouts-overtime',
    });
  });

  test('halves with no length asks the room to break without inventing a clock', () => {
    const procedure = define({ options: { ...manualRoundOptionDefaults, halves: true } }).procedure;
    expect(procedure?.halves).toBe(true);
    expect(procedure?.halfLengthMinutes).toBeUndefined();
  });

  test('timeouts with no length are recorded but not counted down', () => {
    const procedure = define({ options: { ...manualRoundOptionDefaults, timeoutsPerTeam: 2 } }).procedure;
    expect(procedure?.timeoutsPerTeam).toBe(2);
    expect(procedure?.timeoutDurationSeconds).toBeUndefined();
  });

  test('the permissive substitution default is not written down as a rule', () => {
    const procedure = define({ options: { ...manualRoundOptionDefaults, halves: true } }).procedure;
    expect(procedure?.substitutionPolicy).toBeUndefined();
  });

  test('out-of-range values are reported rather than clamped', () => {
    expect(problems({ options: { ...manualRoundOptionDefaults, timeoutsPerTeam: 40 } })).toContain(
      'Timeouts per team must be between 0 and 9.',
    );
    expect(
      problems({ options: { ...manualRoundOptionDefaults, halves: true, halfLengthMinutes: 900 } }),
    ).toContain('Half length must be between 1 and 240 minutes.');
    expect(
      problems({
        options: { ...manualRoundOptionDefaults, timeoutsPerTeam: 1, timeoutDurationSeconds: 5000 },
      }),
    ).toContain('Timeout length must be between 1 and 600 seconds.');
  });

  test('protest checkpoints are not something this form asks about', () => {
    const definition = define({ options: { ...manualRoundOptionDefaults, halves: true } });
    expect(definition.procedure?.protestCheckpoints).toBeUndefined();
  });
});

describe('what a manual definition deliberately does not claim', () => {
  test('it says where it came from', () => {
    expect(define().origin).toBe('manual');
  });

  test('its public metadata is modest and true', () => {
    const definition = define({ gameLabel: 'Tuesday scrimmage' });
    expect(definition.tournament).toEqual({ name: manualTournamentName });
    expect(definition.round).toEqual({ number: 1, name: 'Tuesday scrimmage', revision: 1 });
    expect(definition.format).toBe(gamePackageFormat);
    expect(definition.version).toBe(gamePackageVersion);
    expect(definition.producer).toBe(gamePackageProducer);
  });

  test('no assignment identity is invented because the type could carry one', () => {
    const definition = define();
    expect(definition.scheduledMatchId).toBeUndefined();
    expect(definition.tournament.key).toBeUndefined();
    expect(definition.qbjIdentity).toBeUndefined();
    expect(definition.room).toBeUndefined();
    expect(definition.handoffInstruction).toBeUndefined();
    expect(definition.assumptions).toBeUndefined();
  });
});

describe('the device-local identity', () => {
  test('two identical practices are two identities', () => {
    expect(newManualRecordIdentity()).not.toBe(newManualRecordIdentity());
  });

  test('it says what it is', () => {
    expect(newManualRecordIdentity().startsWith('manual:')).toBe(true);
  });

  test('a thousand of them collide with none of the others', () => {
    const seen = new Set(Array.from({ length: 1000 }, () => newManualRecordIdentity()));
    expect(seen.size).toBe(1000);
  });

  test('it is not part of the definition, so it cannot reach a QBJ through one', () => {
    const identity = newManualRecordIdentity();
    expect(JSON.stringify(define())).not.toContain(identity);
    expect(JSON.stringify(define())).not.toContain('manual:');
  });
});
