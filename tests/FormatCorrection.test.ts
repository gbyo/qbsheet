/**
 * Correcting a tournament's scoring rules in the middle of a game.
 *
 * The property under test is the one that makes the feature safe at all: a correction preserves what
 * the scorekeeper recorded and changes only what it is worth. Every case below is written as "these
 * events, under the old rules, mean X; under the corrected rules the same events mean Y" — because
 * an implementation that quietly reinterpreted a buzz as a different answer type would still produce
 * a plausible scoresheet, and nothing but a test comparing the two would notice.
 *
 * The index-shifting cases are the reason `formatCorrection` exists rather than being a call to
 * `store.update`. See the note at the top of that file.
 */
import { describe, expect, test } from 'vitest';
import correctFormat from '../src/scoring/formatCorrection';
import deriveGame, { IGameSetup } from '../src/scoring/deriveGame';
import { IScorekeeperFormat } from '../src/scoring/ScorekeeperFormat';
import { ScoreEvent } from '../src/scoring/ScoreEvents';
import scoringRulesToScorekeeperFormat, { CommonRuleSets, ScoringRules, typeIndex } from './rules';
import { event } from './events';

const setup: IGameSetup = {
  left: { name: 'Ninety Six', players: ['Sarah Mitchell', 'James Robinson'] },
  right: { name: 'Greenwood', players: ['Emma Turner', 'Jordan Lee'] },
};

function powersFormat(): IScorekeeperFormat {
  const rules = new ScoringRules(CommonRuleSets.AcfPowers);
  rules.maximumPlayersPerTeam = 2;
  return scoringRulesToScorekeeperFormat(rules);
}

/** The same rule set with the power repriced, which is the correction a director actually announces. */
function repricedPower(from: IScorekeeperFormat, value: number): IScorekeeperFormat {
  return {
    ...from,
    answerTypes: from.answerTypes.map((answerType) =>
      answerType.isPower ? { ...answerType, value } : answerType,
    ),
  };
}

/** One power for the left team on question one, and nothing else. */
function onePower(format: IScorekeeperFormat): ScoreEvent[] {
  return [
    event({
      type: 'tossup-buzz',
      questionNumber: 1,
      team: 'left',
      playerName: 'Sarah Mitchell',
      answerTypeIndex: typeIndex(format, 15),
    }),
    event({ type: 'bonus', questionNumber: 1, team: 'left', controlledPoints: 10 }),
  ];
}

describe('correcting the scoring rules of a game already in progress', () => {
  test('reprices what is already recorded without touching what was recorded', () => {
    const format = powersFormat();
    const events = onePower(format);
    expect(deriveGame(format, setup, events).left.points).toBe(25);

    const correction = correctFormat(format, repricedPower(format, 20), events);
    expect(correction.ok).toBe(true);
    if (!correction.ok) return;

    // The history is untouched: the same player, on the same question, with the same ruling.
    expect(correction.events).toEqual(events);
    // Only the value moved. 20 for the power, 10 for the bonus.
    expect(deriveGame(correction.format, setup, correction.events).left.points).toBe(30);
  });

  test('says what changed, and whether it moves points already on the board', () => {
    const format = powersFormat();
    const correction = correctFormat(format, repricedPower(format, 20), onePower(format));
    expect(correction.ok).toBe(true);
    if (!correction.ok) return;

    expect(correction.changes).toContainEqual(
      expect.objectContaining({ detail: '15 points → 20 points', affectsRecordedScoring: true }),
    );
  });

  test('a repriced button nobody has pressed does not claim to move any score', () => {
    const format = powersFormat();
    // A game with one ordinary ten-point answer in it and no power at all.
    const events = [
      event({
        type: 'tossup-buzz',
        questionNumber: 1,
        team: 'left',
        playerName: 'Sarah Mitchell',
        answerTypeIndex: typeIndex(format, 10),
      }),
    ];
    const correction = correctFormat(format, repricedPower(format, 20), events);
    expect(correction.ok).toBe(true);
    if (!correction.ok) return;
    expect(correction.changes).toContainEqual(expect.objectContaining({ affectsRecordedScoring: false }));
    expect(correction.changes.every((change) => !change.affectsRecordedScoring)).toBe(true);
  });

  /**
   * The case the whole module exists for.
   *
   * Adding a second power tier puts a new answer type at the top of a list sorted by value, so every
   * index below it moves by one. A correction that only swapped the format would leave every
   * recorded power pointing at the *new* tier and every ten-point answer pointing at the old power.
   * Nothing would throw; the game would just be wrong.
   */
  test('re-points recorded buzzes when a new answer type shifts the indices under them', () => {
    const format = powersFormat();
    const events = onePower(format);
    const powerIndex = typeIndex(format, 15);

    const withSuperpower: IScorekeeperFormat = {
      ...format,
      answerTypes: [
        {
          ...format.answerTypes[0],
          index: 0,
          value: 20,
          label: 'Superpower',
          shortLabel: 'SP',
          qbjId: 'super',
        },
        ...format.answerTypes.map((answerType, offset) => ({ ...answerType, index: offset + 1 })),
      ],
    };

    const correction = correctFormat(format, withSuperpower, events);
    expect(correction.ok).toBe(true);
    if (!correction.ok) return;

    // The buzz has moved to the position its own button now occupies, one lower than before.
    const buzz = correction.events.find((candidate) => candidate.type === 'tossup-buzz');
    expect(buzz).toMatchObject({ answerTypeIndex: powerIndex + 1 });
    // And it is still a power worth 15, not the 20-point tier that took its old index.
    expect(deriveGame(correction.format, setup, correction.events).left.points).toBe(25);
  });

  test('keeps the QBJ identity of an answer type that is still the same button', () => {
    const format = powersFormat();
    const correction = correctFormat(format, repricedPower(format, 20), onePower(format));
    expect(correction.ok).toBe(true);
    if (!correction.ok) return;
    correction.format.answerTypes.forEach((answerType, index) => {
      expect(answerType.qbjId).toBe(format.answerTypes[index].qbjId);
    });
  });

  describe('refusals, which are the corrections that cannot both be true', () => {
    test('an answer type that has been awarded cannot be removed', () => {
      const format = powersFormat();
      const withoutPowers: IScorekeeperFormat = {
        ...format,
        answerTypes: format.answerTypes
          .filter((answerType) => !answerType.isPower)
          .map((answerType, index) => ({ ...answerType, index })),
      };
      const correction = correctFormat(format, withoutPowers, onePower(format));
      expect(correction.ok).toBe(false);
      if (correction.ok) return;
      expect(correction.problems.join(' ')).toMatch(/cannot be removed/);
    });

    test('an answer type nobody has pressed can be removed', () => {
      const format = powersFormat();
      const withoutPowers: IScorekeeperFormat = {
        ...format,
        answerTypes: format.answerTypes
          .filter((answerType) => !answerType.isPower)
          .map((answerType, index) => ({ ...answerType, index })),
      };
      expect(correctFormat(format, withoutPowers, []).ok).toBe(true);
    });

    test('bonuses cannot be switched off in a game that has bonuses in it', () => {
      const format = powersFormat();
      const withoutBonuses: IScorekeeperFormat = { ...format, bonus: { ...format.bonus, enabled: false } };
      const correction = correctFormat(format, withoutBonuses, onePower(format));
      expect(correction.ok).toBe(false);
      if (correction.ok) return;
      expect(correction.problems.join(' ')).toMatch(/bonuses cannot be switched off/i);
    });

    test('regulation cannot be shortened below the questions already played', () => {
      const format = powersFormat();
      const events = [event({ type: 'tossup-dead', questionNumber: 14 })];
      const shortened: IScorekeeperFormat = {
        ...format,
        regulation: { ...format.regulation, tossupCount: 10, maximumTossupCount: 10 },
      };
      const correction = correctFormat(format, shortened, events);
      expect(correction.ok).toBe(false);
      if (correction.ok) return;
      expect(correction.problems.join(' ')).toMatch(/cannot be shortened/);
    });

    test('regulation can be lengthened at any point', () => {
      const format = powersFormat();
      const events = [event({ type: 'tossup-dead', questionNumber: 14 })];
      const longer: IScorekeeperFormat = {
        ...format,
        regulation: { ...format.regulation, tossupCount: 24, maximumTossupCount: 24 },
      };
      const correction = correctFormat(format, longer, events);
      expect(correction.ok).toBe(true);
      if (!correction.ok) return;
      expect(correction.changes).toContainEqual(
        expect.objectContaining({ subject: 'Regulation length', detail: '20 → 24 tossups' }),
      );
    });

    test('a bonus already recorded with more parts than the new rules allow', () => {
      const format = powersFormat();
      const events = [
        event({
          type: 'tossup-buzz',
          questionNumber: 1,
          team: 'left',
          playerName: 'Sarah Mitchell',
          answerTypeIndex: typeIndex(format, 15),
        }),
        event({
          type: 'bonus',
          questionNumber: 1,
          team: 'left',
          parts: [{ controlledPoints: 10 }, { controlledPoints: 10 }, { controlledPoints: 0 }],
        }),
      ];
      const twoParts: IScorekeeperFormat = {
        ...format,
        bonus: { ...format.bonus, minimumParts: 2, maximumParts: 2, maximumScore: 20 },
      };
      const correction = correctFormat(format, twoParts, events);
      expect(correction.ok).toBe(false);
      if (correction.ok) return;
      expect(correction.problems.join(' ')).toMatch(/3 parts recorded/);
    });

    test('lightning cannot be switched off once a total is recorded', () => {
      const format: IScorekeeperFormat = {
        ...powersFormat(),
        lightning: { enabled: true, countPerTeam: 1, divisor: 10 },
      };
      const events = [event({ type: 'lightning', questionNumber: 1, team: 'left', points: 20 })];
      const withoutLightning: IScorekeeperFormat = {
        ...format,
        lightning: { enabled: false, countPerTeam: 0, divisor: 10 },
      };
      const correction = correctFormat(format, withoutLightning, events);
      expect(correction.ok).toBe(false);
      if (correction.ok) return;
      expect(correction.problems.join(' ')).toMatch(/lightning cannot be switched off/i);
    });

    test('the players cap cannot drop below a lineup a substitution recorded', () => {
      const format = powersFormat();
      const events = [
        event({
          type: 'substitution',
          questionNumber: 2,
          team: 'left',
          activePlayers: ['Sarah Mitchell', 'James Robinson'],
        }),
      ];
      const oneAtATime: IScorekeeperFormat = { ...format, players: { maximumActive: 1 } };
      const correction = correctFormat(format, oneAtATime, events);
      expect(correction.ok).toBe(false);
      if (correction.ok) return;
      expect(correction.problems.join(' ')).toMatch(/lineup of 2 players/);
    });

    /**
     * The opening lineup is not a substitution event, and most games never record one — so a check
     * that looked only at substitutions accepted a cap below the lineup the game actually started
     * with, which is a game whose own first tossup its format forbids.
     */
    test('the players cap cannot drop below the opening lineup, which is not an event', () => {
      const format = powersFormat();
      const oneAtATime: IScorekeeperFormat = { ...format, players: { maximumActive: 1 } };

      // Both teams start two players, from `setup`, with nothing recorded at all.
      const correction = correctFormat(format, oneAtATime, [], setup);
      expect(correction.ok).toBe(false);
      if (correction.ok) return;
      expect(correction.problems.join(' ')).toMatch(/lineup of 2 players/);

      // And without the setup there is nothing to check it against, which is why it is passed.
      expect(correctFormat(format, oneAtATime, []).ok).toBe(true);
    });

    test('two answer types whose short labels normalize to the same button', () => {
      const format = powersFormat();
      // The fixture labels buttons by their value, so the collision has to be built: `P` and ` p `
      // are different strings and the same button as far as a scorekeeper is concerned.
      const ambiguous: IScorekeeperFormat = {
        ...format,
        answerTypes: format.answerTypes.map((answerType) => {
          if (answerType.value === 15) return { ...answerType, shortLabel: 'P' };
          if (answerType.value === 10) return { ...answerType, shortLabel: ' p ' };
          return answerType;
        }),
      };
      const correction = correctFormat(format, ambiguous, []);
      expect(correction.ok).toBe(false);
      if (correction.ok) return;
      expect(correction.problems.join(' ')).toMatch(/two answer types whose short label/i);
    });

    /**
     * A tournament can ship a QBJ whose short labels are already ambiguous. Disambiguating them is
     * part of the correction — the proposed rules are always checked — but the *old* collision only
     * blocks the correction when a recorded buzz depends on which of the two buttons it meant.
     */
    test('a collision already in the current rules blocks only the history that depends on it', () => {
      const base = powersFormat();
      const label = (format: IScorekeeperFormat, value: number, shortLabel: string): IScorekeeperFormat => ({
        ...format,
        answerTypes: format.answerTypes.map((answerType) =>
          answerType.value === value ? { ...answerType, shortLabel } : answerType,
        ),
      });
      // `P` and ` p ` read as one button. This is the format the game is already being scored under.
      const ambiguousNow = label(label(base, 15, 'P'), 10, ' p ');
      // The correction disambiguates them, which is what the refusal message asks for.
      const disambiguated = label(ambiguousNow, 10, 'C');

      // Nothing recorded against either, so which one they were is not a question anybody is asking.
      expect(correctFormat(ambiguousNow, disambiguated, []).ok).toBe(true);

      // Once a buzz is recorded against one of them, it cannot be re-pointed honestly.
      const usedIt = [
        event({
          type: 'tossup-buzz',
          questionNumber: 1,
          team: 'left',
          playerName: 'Sarah Mitchell',
          answerTypeIndex: typeIndex(base, 15),
        }),
      ];
      const correction = correctFormat(ambiguousNow, disambiguated, usedIt);
      expect(correction.ok).toBe(false);
      if (correction.ok) return;
      expect(correction.problems.join(' ')).toMatch(/current rules have two answer types/i);
    });

    test('a format that is not a playable game is refused before anything is compared to it', () => {
      const format = powersFormat();
      const empty: IScorekeeperFormat = { ...format, answerTypes: [] };
      const correction = correctFormat(format, empty, []);
      expect(correction.ok).toBe(false);
      if (correction.ok) return;
      expect(correction.problems.length).toBeGreaterThan(0);
    });
  });

  describe('changes that no sentence used to describe', () => {
    /**
     * `unchanged` was derived from the length of the human-readable `changes` list, so any field
     * without a sentence of its own reported itself as no change and the dialog refused to apply it.
     * It is now derived from the whole structure.
     */
    test.each([
      [
        'an extended regulation',
        (format: IScorekeeperFormat): IScorekeeperFormat => ({
          ...format,
          regulation: { ...format.regulation, maximumTossupCount: 24 },
        }),
      ],
      [
        'the bonus score increment',
        (format: IScorekeeperFormat): IScorekeeperFormat => ({
          ...format,
          bonus: { ...format.bonus, divisor: 5 },
        }),
      ],
      [
        'the lightning count',
        (format: IScorekeeperFormat): IScorekeeperFormat => ({
          ...format,
          lightning: { enabled: true, countPerTeam: 3, divisor: 10 },
        }),
      ],
    ])('%s is a change, and is described', (_name, mutate) => {
      const format: IScorekeeperFormat = {
        ...powersFormat(),
        lightning: { enabled: true, countPerTeam: 1, divisor: 10 },
      };
      const correction = correctFormat(format, mutate(format), onePower(format));
      expect(correction.ok).toBe(true);
      if (!correction.ok) return;
      expect(correction.unchanged).toBe(false);
      // Never an empty list under a heading that promises to say what will happen.
      expect(correction.changes.length).toBeGreaterThan(0);
    });
  });

  test('a correction does not rename the tournament’s rule set', () => {
    const format: IScorekeeperFormat = { ...powersFormat(), name: 'NAQT 2026 Rules' };
    const correction = correctFormat(format, repricedPower(format, 20), onePower(format));
    expect(correction.ok).toBe(true);
    if (!correction.ok) return;
    expect(correction.format.name).toBe('NAQT 2026 Rules');
  });

  test('recognizes a correction that corrects nothing', () => {
    const format = powersFormat();
    const correction = correctFormat(format, format, onePower(format));
    expect(correction.ok).toBe(true);
    if (!correction.ok) return;
    expect(correction.unchanged).toBe(true);
    expect(correction.changes).toEqual([]);
  });
});
