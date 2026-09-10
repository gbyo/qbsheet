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

  describe('historical post-validation backstop', () => {
    /** A dead tossup, the quickest route to a played-out game. */
    function dead(questionNumber: number): ScoreEvent {
      return event({ type: 'tossup-dead', questionNumber });
    }

    function deadTossups(count: number, from = 1): ScoreEvent[] {
      return Array.from({ length: count }, (_, index) => dead(from + index));
    }

    function timedFormat(): IScorekeeperFormat {
      const rules = new ScoringRules(CommonRuleSets.NaqtTimed);
      rules.maximumPlayersPerTeam = 2;
      return scoringRulesToScorekeeperFormat(rules);
    }

    test('a benign repricing still applies with a setup present', () => {
      const format = powersFormat();
      const correction = correctFormat(format, repricedPower(format, 20), onePower(format), setup);
      expect(correction.ok).toBe(true);
    });

    test('a completed regulation game survives a benign repricing', () => {
      const format = powersFormat();
      const events: ScoreEvent[] = [...onePower(format), ...deadTossups(19, 2)];
      expect(deriveGame(format, setup, events).phase).toEqual({
        kind: 'complete',
        reason: 'regulation',
      });
      const correction = correctFormat(format, repricedPower(format, 20), events, setup);
      expect(correction.ok).toBe(true);
    });

    test.each([
      ['on', true],
      ['off', false],
    ])('bouncebacks cannot be switched %s after a bonus', (_direction, bounceBack) => {
      const from: IScorekeeperFormat = {
        ...powersFormat(),
        bonus: { ...powersFormat().bonus, bounceBack: !bounceBack },
      };
      const to: IScorekeeperFormat = {
        ...from,
        bonus: { ...from.bonus, bounceBack },
      };
      const correction = correctFormat(from, to, onePower(from), setup);
      expect(correction.ok).toBe(false);
      if (correction.ok) return;
      expect(correction.problems.join(' ')).toMatch(/bounceback/i);
    });

    test('bouncebacks switch freely before any bonus exists', () => {
      const from: IScorekeeperFormat = {
        ...powersFormat(),
        bonus: { ...powersFormat().bonus, bounceBack: false },
      };
      const to: IScorekeeperFormat = {
        ...from,
        bonus: { ...from.bonus, bounceBack: true },
      };
      const buzzOnly: ScoreEvent[] = [
        event({
          type: 'tossup-buzz',
          questionNumber: 1,
          team: 'left',
          playerName: 'Sarah Mitchell',
          answerTypeIndex: typeIndex(from, 15),
        }),
      ];
      const correction = correctFormat(from, to, buzzOnly, setup);
      expect(correction.ok).toBe(true);
    });

    test('repricing bonus parts below a recorded total is refused', () => {
      const format = powersFormat();
      const events: ScoreEvent[] = [
        event({
          type: 'tossup-buzz',
          questionNumber: 1,
          team: 'left',
          playerName: 'Sarah Mitchell',
          answerTypeIndex: typeIndex(format, 10),
        }),
        event({ type: 'bonus', questionNumber: 1, team: 'left', controlledPoints: 20 }),
      ];
      expect(format.bonus.divisor).toBe(10);
      // Bonus parts go from 10 to 15 points each (three parts, 45 max); the recorded 20
      // can never have happened.
      const to: IScorekeeperFormat = {
        ...format,
        bonus: { ...format.bonus, divisor: 15, pointsPerPart: 15, maximumScore: 45 },
      };
      const correction = correctFormat(format, to, events, setup);
      expect(correction.ok).toBe(false);
      if (correction.ok) return;
      expect(correction.problems.join(' ')).toMatch(/divisible by 15/i);
    });

    test('timed-to-untimed with an end-regulation marker is refused', () => {
      const format = timedFormat();
      const events: ScoreEvent[] = [
        ...onePower(format),
        dead(2),
        event({ type: 'end-regulation', questionNumber: 2 }),
      ];
      expect(deriveGame(format, setup, events).phase).toEqual({
        kind: 'complete',
        reason: 'regulation',
      });
      const to: IScorekeeperFormat = {
        ...format,
        regulation: { ...format.regulation, timed: false, tossupCount: 20 },
      };
      const correction = correctFormat(format, to, events, setup);
      expect(correction.ok).toBe(false);
      if (correction.ok) return;
      expect(correction.problems.join(' ')).toMatch(/finished|in progress|invalid|regulation/i);
    });

    test('an overtime finish cannot be reclassified as regulation', () => {
      const format: IScorekeeperFormat = {
        ...powersFormat(),
        overtime: { ...powersFormat().overtime, minimumQuestionCount: 1 },
      };
      const events: ScoreEvent[] = [
        ...deadTossups(20),
        event({
          type: 'tossup-buzz',
          questionNumber: 21,
          team: 'left',
          playerName: 'Sarah Mitchell',
          answerTypeIndex: typeIndex(format, 10),
        }),
      ];
      expect(deriveGame(format, setup, events).phase).toEqual({
        kind: 'complete',
        reason: 'overtime',
      });
      // Lengthening regulation past the overtime questions is allowed by the matrix, but it
      // would un-play overtime: question 21 becomes a regulation tossup of a game that never ends.
      const to: IScorekeeperFormat = {
        ...format,
        regulation: { ...format.regulation, tossupCount: 24, maximumTossupCount: 24 },
      };
      const correction = correctFormat(format, to, events, setup);
      expect(correction.ok).toBe(false);
      if (correction.ok) return;
      expect(correction.problems.join(' ')).toMatch(/already finished|still be in progress/i);
    });

    test('post-validation never throws on hostile input', () => {
      const format = powersFormat();
      const hostile: ScoreEvent[][] = [
        [],
        [{ type: 'tossup-buzz', questionNumber: 1 } as unknown as ScoreEvent],
        [event({ type: 'bonus', questionNumber: 99, team: 'left', controlledPoints: -5 })],
        deadTossups(40),
      ];
      for (const events of hostile) {
        let settled = false;
        try {
          const correction = correctFormat(format, repricedPower(format, 20), events, setup);
          settled = correction.ok || !correction.ok;
        } catch {
          settled = false;
        }
        expect(settled).toBe(true);
      }
    });

    test('a sudden-death checkpoint cannot be un-reached', () => {
      const format: IScorekeeperFormat = {
        ...powersFormat(),
        overtime: { ...powersFormat().overtime, minimumQuestionCount: 3, suddenDeath: false },
      };
      const events: ScoreEvent[] = deadTossups(23);
      expect(deriveGame(format, setup, events).phase).toEqual({
        kind: 'checkpoint',
        checkpoint: 'sudden-death',
        afterQuestion: 23,
      });
      const to: IScorekeeperFormat = {
        ...format,
        regulation: { ...format.regulation, tossupCount: 24, maximumTossupCount: 24 },
      };
      const correction = correctFormat(format, to, events, setup);
      expect(correction.ok).toBe(false);
      if (correction.ok) return;
      expect(correction.problems.join(' ')).toMatch(/sudden death/i);
    });
  });
});
