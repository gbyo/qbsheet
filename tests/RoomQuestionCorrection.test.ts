import { describe, expect, test } from 'vitest';
import { IScorekeeperFormat } from '../src/scoring/ScorekeeperFormat';
import scoringRulesToScorekeeperFormat from './rules';
import { CommonRuleSets, ScoringRules } from './rules';
import deriveGame, { IGameSetup } from '../src/scoring/deriveGame';
import toQbjMatch from '../src/scoring/toQbjMatch';
import {
  editableQuestionFromEvents,
  eventsFromEditableQuestion,
  IEditableQuestion,
  replaceQuestionEvents,
  validateEditableQuestion,
} from '../src/scoring/questionCorrection';
import { ScoreEvent } from '../src/scoring/ScoreEvents';
import { event } from './events';

const setup: IGameSetup = {
  left: { name: 'Ninety Six', players: ['Sarah', 'James'] },
  right: { name: 'Greenwood', players: ['Emma', 'Jordan'] },
};

function formatFor(): IScorekeeperFormat {
  const rules = new ScoringRules(CommonRuleSets.AcfPowers);
  rules.maximumPlayersPerTeam = 2;
  return scoringRulesToScorekeeperFormat(rules);
}

describe('question-level corrections', () => {
  test('round-trips a complete question and keeps non-scoring audit events', () => {
    const format = formatFor();
    const events: ScoreEvent[] = [
      event({ type: 'tossup-buzz', questionNumber: 1, team: 'left', playerName: 'Sarah', answerTypeIndex: 1 }),
      event({ type: 'bonus', questionNumber: 1, team: 'left', controlledPoints: 20 }),
      event({ type: 'note', questionNumber: 1, text: 'Reader checked the ruling.', flagged: true }),
      event({
        type: 'protest',
        questionNumber: 1,
        team: 'right',
        subject: 'tossup-answer',
        description: 'Review requested',
        status: 'open',
      }),
    ];
    const model = editableQuestionFromEvents(events, 1);
    const corrected = {
      ...model,
      attempts: [{ ...model.attempts[0], answerTypeIndex: 0 }],
    };

    expect(validateEditableQuestion(format, deriveGame(format, setup, events), corrected)).toEqual([]);
    let correctionId = 0;
    const replacement = eventsFromEditableQuestion(corrected, () => `replacement-${++correctionId}`);
    const next = replaceQuestionEvents(events, 1, replacement);

    expect(next.map((candidate) => candidate.type)).toEqual(['tossup-buzz', 'bonus', 'note', 'protest']);
    expect(next.find((candidate) => candidate.type === 'tossup-buzz')).toMatchObject({ answerTypeIndex: 0 });
    expect(next.find((candidate) => candidate.type === 'note')).toMatchObject({ flagged: true });
    const correctedGame = deriveGame(format, setup, next);
    expect(correctedGame.left.points).toBe(35);
    const qbj = toQbjMatch(format, correctedGame) as {
      match_teams?: { points: number }[];
      match_questions?: { buzzes: { result: { value: number } }[] }[];
    };
    expect(qbj.match_teams?.[0].points).toBe(35);
    expect(qbj.match_questions?.[0].buzzes[0].result.value).toBe(15);
  });

  test('inserting a corrected question without existing cycle events preserves question order', () => {
    const events: ScoreEvent[] = [
      event({ type: 'tossup-dead', questionNumber: 1 }),
      event({ type: 'note', questionNumber: 1, text: 'First question' }),
      event({ type: 'tossup-dead', questionNumber: 3 }),
    ];
    let correctionId = 0;
    const replacement = eventsFromEditableQuestion(
      { questionNumber: 2, attempts: [], dead: true },
      () => `replacement-${++correctionId}`,
    );

    const next = replaceQuestionEvents(events, 2, replacement);

    expect(next.map((candidate) => candidate.questionNumber)).toEqual([1, 1, 2, 3]);
    expect(next[2].type).toBe('tossup-dead');
  });

  test('correcting a replaced question keeps the new cycle after its question-void', () => {
    const format = formatFor();
    const events: ScoreEvent[] = [
      event({ type: 'tossup-buzz', questionNumber: 7, team: 'left', playerName: 'Sarah', answerTypeIndex: 1 }),
      event({ type: 'bonus', questionNumber: 7, team: 'left', controlledPoints: 20 }),
      event({ type: 'note', questionNumber: 7, text: 'Replacement approved.' }),
      event({ type: 'question-void', questionNumber: 7, scope: 'tossup', reason: 'Bad packet' }),
      event({ type: 'tossup-buzz', questionNumber: 7, team: 'left', playerName: 'Sarah', answerTypeIndex: 1 }),
      event({ type: 'bonus', questionNumber: 7, team: 'left', controlledPoints: 10 }),
      event({
        type: 'protest',
        questionNumber: 7,
        team: 'right',
        subject: 'question',
        description: 'Replacement reviewed.',
        status: 'open',
      }),
    ];
    const model = editableQuestionFromEvents(events, 7);
    const replacement = eventsFromEditableQuestion(
      { ...model, bonus: model.bonus ? { ...model.bonus, controlledPoints: 20, bouncebackPoints: 0 } : undefined },
      (() => {
        let id = 0;
        return () => `corrected-${++id}`;
      })(),
    );
    const next = replaceQuestionEvents(events, 7, replacement);
    const voidIndex = next.findIndex((candidate) => candidate.type === 'question-void');
    const correctedIndex = next.findIndex(
      (candidate, index) => index > voidIndex && (candidate.type === 'tossup-buzz' || candidate.type === 'tossup-dead'),
    );

    expect(correctedIndex).toBeGreaterThan(voidIndex);
    expect(next.find((candidate) => candidate.type === 'note')).toBeTruthy();
    expect(next.find((candidate) => candidate.type === 'protest')).toBeTruthy();
    const correctedGame = deriveGame(format, setup, next);
    expect(correctedGame.questions.find((question) => question.questionNumber === 7)?.replaced).toBe(true);
    expect(correctedGame.left.points).toBe(30);
    const qbj = toQbjMatch(format, correctedGame) as { match_questions?: { tossup_question?: { type: string } }[] };
    expect(qbj.match_questions?.find((question) => question.tossup_question)?.tossup_question).toEqual({
      type: 'replacement',
    });
  });

  test('a question that ends without a conversion keeps its zero-point answer', () => {
    const format = formatFor();
    const events = [
      event({ type: 'tossup-no-penalty', questionNumber: 1, team: 'left', playerName: 'Sarah' }),
      event({ type: 'tossup-dead', questionNumber: 1 }),
    ];
    const game = deriveGame(format, setup, events);
    const model: IEditableQuestion = {
      questionNumber: 1,
      attempts: [{ kind: 'no-penalty', team: 'left', playerName: 'Sarah' }],
      dead: true,
    };

    expect(validateEditableQuestion(format, game, model)).toEqual([]);
    expect(eventsFromEditableQuestion(model, () => 'replacement-dead').map((candidate) => candidate.type)).toEqual([
      'tossup-no-penalty',
      'tossup-dead',
    ]);
  });

  test('correction round-trips an explicit resume and readout state', () => {
    const format = formatFor();
    const events: ScoreEvent[] = [
      event({ type: 'tossup-buzz', questionNumber: 1, team: 'left', playerName: 'Sarah', answerTypeIndex: 2 }),
      event({ type: 'tossup-reading-resumed', questionNumber: 1 }),
      event({ type: 'tossup-buzz', questionNumber: 1, team: 'right', playerName: 'Emma', answerTypeIndex: 1 }),
    ];
    const model = editableQuestionFromEvents(events, 1);

    expect(model.readingResumed).toBe(true);
    expect(model.readout).toBe(false);
    expect(validateEditableQuestion(format, deriveGame(format, setup, events), model)).toEqual([]);

    const replacement = eventsFromEditableQuestion(model, (() => {
      let next = 0;
      return () => `resume-correction-${++next}`;
    })());
    expect(replacement.map((candidate) => candidate.type)).toEqual([
      'tossup-buzz',
      'tossup-reading-resumed',
      'tossup-buzz',
    ]);
    expect(validateEditableQuestion(format, deriveGame(format, setup, replacement), editableQuestionFromEvents(replacement, 1))).toEqual(
      [],
    );

    const readoutModel = {
      ...model,
      attempts: [
        model.attempts[0],
        { ...model.attempts[1], answerTypeIndex: 2 },
      ],
      readout: true,
    };
    expect(validateEditableQuestion(format, deriveGame(format, setup, events), readoutModel).join('\n')).toContain(
      'cannot have a second-team neg',
    );
  });

  test('rejects every incompatible part of an atomic question correction', () => {
    const format = formatFor();
    const events: ScoreEvent[] = [
      event({ type: 'tossup-buzz', questionNumber: 1, team: 'left', playerName: 'Sarah', answerTypeIndex: 1 }),
      event({ type: 'bonus', questionNumber: 1, team: 'left', controlledPoints: 20 }),
      event({ type: 'tossup-dead', questionNumber: 2 }),
    ];
    const game = deriveGame(format, setup, events);
    const conversion: IEditableQuestion = {
      questionNumber: 1,
      attempts: [{ kind: 'buzz', team: 'left', playerName: 'Sarah', answerTypeIndex: 1 }],
      dead: false,
      bonus: { team: 'left', controlledPoints: 20, bouncebackPoints: 0 },
    };
    const problems = (model: IEditableQuestion) => validateEditableQuestion(format, game, model).join('\n');

    expect(problems({ questionNumber: 1, attempts: [], dead: false })).toContain('needs a ruling');
    expect(
      problems({
        questionNumber: 1,
        attempts: [
          { kind: 'buzz', team: 'left', playerName: 'Sarah', answerTypeIndex: 2 },
          { kind: 'buzz', team: 'left', playerName: 'James', answerTypeIndex: 1 },
        ],
        dead: false,
      }),
    ).toContain('more than once');
    expect(
      problems({
        questionNumber: 1,
        attempts: [{ kind: 'buzz', team: 'left', playerName: 'Not Playing', answerTypeIndex: 1 }],
        dead: false,
      }),
    ).toContain('not active');
    expect(
      problems({
        questionNumber: 1,
        attempts: [{ kind: 'buzz', team: 'left', playerName: 'Sarah', answerTypeIndex: 99 }],
        dead: false,
      }),
    ).toContain('valid ruling');
    expect(
      problems({
        questionNumber: 1,
        attempts: [
          { kind: 'buzz', team: 'left', playerName: 'Sarah', answerTypeIndex: 2 },
          { kind: 'buzz', team: 'right', playerName: 'Emma', answerTypeIndex: 2 },
        ],
        dead: false,
      }),
    ).toContain('second-team neg');
    expect(problems({ ...conversion, dead: true })).toContain('both a correct answer and no conversion');
    expect(problems({ ...conversion, bonus: undefined })).toContain('needs a bonus');
    expect(
      problems({
        questionNumber: 1,
        attempts: [],
        dead: true,
        bonus: { team: 'left', controlledPoints: 20, bouncebackPoints: 0 },
      }),
    ).toContain('does not have a valid bonus conversion');
    expect(problems({ ...conversion, bonus: { ...conversion.bonus!, team: 'right' } })).toContain(
      'belongs to the converting team',
    );
    expect(
      problems({
        ...conversion,
        bonus: {
          team: 'left',
          controlledPoints: 10,
          bouncebackPoints: 0,
          parts: [{ controlledPoints: 10 }],
        },
      }),
    ).toContain('wrong number of bonus parts');
    expect(
      problems({
        ...conversion,
        bonus: {
          team: 'left',
          controlledPoints: 30,
          bouncebackPoints: 0,
          parts: [{ controlledPoints: 10 }, { controlledPoints: 10 }, { controlledPoints: 0 }],
        },
      }),
    ).toContain("bonus parts do not match its totals");
    expect(
      problems({
        ...conversion,
        bonus: {
          team: 'left',
          controlledPoints: 20,
          bouncebackPoints: 0,
          parts: [{ controlledPoints: 7 }, { controlledPoints: 10 }, { controlledPoints: 3 }],
        },
      }),
    ).toContain('Each regular bonus part');
  });

  test('preserves existing event ids and creates ids only for new correction events', () => {
    let next = 0;
    const corrected = eventsFromEditableQuestion(
      {
        questionNumber: 4,
        attempts: [
          { id: 'kept-zero', kind: 'no-penalty', team: 'left', playerName: 'Sarah' },
          { kind: 'buzz', team: 'right', playerName: 'Emma', answerTypeIndex: 1 },
        ],
        dead: false,
        bonus: { id: 'kept-bonus', team: 'right', controlledPoints: 20, bouncebackPoints: 0 },
      },
      () => `new-${++next}`,
    );

    expect(corrected.map((candidate) => candidate.id)).toEqual(['kept-zero', 'new-1', 'kept-bonus']);
  });

  test('places a correction after the latest replacement marker and before later audit events', () => {
    const events: ScoreEvent[] = [
      event({ type: 'tossup-dead', questionNumber: 7 }),
      event({ type: 'question-void', questionNumber: 7, scope: 'tossup', reason: 'First bad question' }),
      event({ type: 'tossup-dead', questionNumber: 7 }),
      event({ type: 'question-void', questionNumber: 7, scope: 'tossup', reason: 'Second bad question' }),
      event({ type: 'note', questionNumber: 7, text: 'Use the third question.' }),
      event({ type: 'tossup-dead', questionNumber: 8 }),
    ];
    const replacement = [event({ type: 'tossup-dead', questionNumber: 7 })];
    const next = replaceQuestionEvents(events, 7, replacement);
    const voids = next
      .map((candidate, index) => (candidate.type === 'question-void' ? index : -1))
      .filter((index) => index >= 0);
    const correction = next.findIndex((candidate) => candidate.id === replacement[0].id);
    const note = next.findIndex((candidate) => candidate.type === 'note');

    expect(voids).toHaveLength(2);
    expect(correction).toBe(Math.max(...voids) + 1);
    expect(note).toBe(correction + 1);
    expect(next.at(-1)?.questionNumber).toBe(8);
  });
});
