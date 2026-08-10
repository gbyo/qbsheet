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
});
