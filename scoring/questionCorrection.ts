import { IScorekeeperFormat } from '../../renderer/Services/ScorekeeperFormat';
import { IDerivedGame } from './deriveGame';
import { IBonusPartResult, ScoreEvent } from './ScoreEvents';
import { effectiveQuestionEvents } from './validateScoresheet';
import { bonusPartProblem, bonusScoreProblem } from '../scorer/bonusOptions';

export type EditableAttemptKind = 'buzz' | 'no-penalty';

export interface IEditableAttempt {
  id?: string;
  kind: EditableAttemptKind;
  team: 'left' | 'right';
  playerName?: string;
  answerTypeIndex?: number;
}

export interface IEditableBonus {
  id?: string;
  team: 'left' | 'right';
  controlledPoints: number;
  bouncebackPoints: number;
  parts?: IBonusPartResult[];
}

export interface IEditableQuestion {
  questionNumber: number;
  attempts: IEditableAttempt[];
  dead: boolean;
  bonus?: IEditableBonus;
}

function isCycleEvent(event: ScoreEvent): boolean {
  return (
    event.type === 'tossup-buzz' ||
    event.type === 'tossup-no-penalty' ||
    event.type === 'tossup-dead' ||
    event.type === 'bonus'
  );
}

export function editableQuestionFromEvents(events: readonly ScoreEvent[], questionNumber: number): IEditableQuestion {
  const cycleEvents = effectiveQuestionEvents(events, questionNumber);
  const attempts: IEditableAttempt[] = [];
  let dead = false;
  let bonus: IEditableBonus | undefined;
  for (const event of cycleEvents) {
    if (event.type === 'tossup-buzz') {
      attempts.push({
        id: event.id,
        kind: 'buzz',
        team: event.team,
        playerName: event.playerName,
        answerTypeIndex: event.answerTypeIndex,
      });
    } else if (event.type === 'tossup-no-penalty') {
      attempts.push({ id: event.id, kind: 'no-penalty', team: event.team, playerName: event.playerName });
    } else if (event.type === 'tossup-dead') dead = true;
    else if (event.type === 'bonus') {
      const parts = event.parts?.map((part) => ({ ...part }));
      const controlledPoints =
        parts && parts.length > 0
          ? parts.reduce((total, part) => total + part.controlledPoints, 0)
          : event.controlledPoints ?? 0;
      const bouncebackPoints =
        parts && parts.length > 0
          ? parts.reduce((total, part) => total + (part.bouncebackPoints ?? 0), 0)
          : event.bouncebackPoints ?? 0;
      bonus = {
        id: event.id,
        team: event.team,
        controlledPoints,
        bouncebackPoints,
        ...(parts ? { parts } : {}),
      };
    }
  }
  return { questionNumber, attempts, dead, bonus };
}

export function conversion(model: IEditableQuestion, format: IScorekeeperFormat): IEditableAttempt | undefined {
  return model.attempts.find(
    (attempt) =>
      attempt.kind === 'buzz' &&
      attempt.answerTypeIndex !== undefined &&
      (format.answerTypes[attempt.answerTypeIndex]?.value ?? 0) > 0,
  );
}

/** Validate one proposed question without mutating the event history. */
export function validateEditableQuestion(
  format: IScorekeeperFormat,
  game: IDerivedGame,
  model: IEditableQuestion,
): string[] {
  const errors: string[] = [];
  const question = game.questions.find((candidate) => candidate.questionNumber === model.questionNumber);
  const activePlayers = question?.activePlayers ?? { left: [], right: [] };
  if (model.attempts.length === 0 && !model.dead) errors.push(`Question ${model.questionNumber} needs a ruling.`);
  if (model.dead && model.attempts.length > 0)
    errors.push(`Question ${model.questionNumber} cannot have an answer and No buzz.`);

  const used = new Set<'left' | 'right'>();
  let previousAttempt = false;
  for (const attempt of model.attempts) {
    if (used.has(attempt.team))
      errors.push(
        `${attempt.team === 'left' ? game.left.name : game.right.name} answers Question ${
          model.questionNumber
        } more than once.`,
      );
    used.add(attempt.team);
    if (attempt.kind === 'buzz') {
      if (attempt.playerName === undefined || !activePlayers[attempt.team].includes(attempt.playerName)) {
        errors.push(`${attempt.playerName || 'That player'} was not active for Question ${model.questionNumber}.`);
      }
      const answerType =
        attempt.answerTypeIndex === undefined ? undefined : format.answerTypes[attempt.answerTypeIndex];
      if (!answerType) errors.push(`Choose a valid ruling for Question ${model.questionNumber}.`);
      else if (answerType.isNeg && previousAttempt)
        errors.push(`Question ${model.questionNumber} cannot have a second-team neg.`);
    } else if (attempt.playerName !== undefined && !activePlayers[attempt.team].includes(attempt.playerName)) {
      errors.push(`${attempt.playerName} was not active for Question ${model.questionNumber}.`);
    }
    previousAttempt = true;
  }

  const converted = conversion(model, format);
  const convertedType =
    converted?.answerTypeIndex === undefined ? undefined : format.answerTypes[converted.answerTypeIndex];
  const expectsBonus =
    converted !== undefined &&
    convertedType?.awardsBonus === true &&
    format.bonus.enabled &&
    (question?.period !== 'overtime' || format.overtime.includesBonuses);
  const isCurrentQuestion =
    (game.phase.kind === 'tossup' || game.phase.kind === 'bonus' || game.phase.kind === 'timeout') &&
    game.phase.questionNumber === model.questionNumber;
  if (expectsBonus && !model.bonus && !isCurrentQuestion)
    errors.push(`Question ${model.questionNumber} needs a bonus for this conversion.`);
  if (!expectsBonus && model.bonus)
    errors.push(`Question ${model.questionNumber} does not have a valid bonus conversion.`);
  if (model.bonus && converted && model.bonus.team !== converted.team) {
    errors.push(`The bonus on Question ${model.questionNumber} belongs to the converting team.`);
  }
  if (model.bonus) {
    const scoreProblem = bonusScoreProblem(format.bonus, model.bonus.controlledPoints, model.bonus.bouncebackPoints);
    if (scoreProblem) errors.push(scoreProblem);
    if (model.bonus.parts) {
      if (
        model.bonus.parts.length < format.bonus.minimumParts ||
        model.bonus.parts.length > format.bonus.maximumParts
      ) {
        errors.push(`Question ${model.questionNumber} has the wrong number of bonus parts.`);
      }
      const controlled = model.bonus.parts.reduce((sum, part) => sum + part.controlledPoints, 0);
      const bounceback = model.bonus.parts.reduce((sum, part) => sum + (part.bouncebackPoints ?? 0), 0);
      for (const part of model.bonus.parts) {
        const partProblem = bonusPartProblem(format.bonus, part.controlledPoints, part.bouncebackPoints ?? 0);
        if (partProblem) errors.push(`Question ${model.questionNumber}: ${partProblem}`);
      }
      if (controlled !== model.bonus.controlledPoints || bounceback !== model.bonus.bouncebackPoints) {
        errors.push(`Question ${model.questionNumber}'s bonus parts do not match its totals.`);
      }
    }
  }
  return Array.from(new Set(errors));
}

function nextId(): string {
  return `correction-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Turn the editable representation back into only the cycle events it describes. */
export function eventsFromEditableQuestion(model: IEditableQuestion, idFactory: () => string = nextId): ScoreEvent[] {
  const result: ScoreEvent[] = model.attempts.map((attempt) => {
    if (attempt.kind === 'no-penalty') {
      return {
        id: attempt.id ?? idFactory(),
        type: 'tossup-no-penalty' as const,
        questionNumber: model.questionNumber,
        team: attempt.team,
        playerName: attempt.playerName,
      };
    }
    return {
      id: attempt.id ?? idFactory(),
      type: 'tossup-buzz' as const,
      questionNumber: model.questionNumber,
      team: attempt.team,
      playerName: attempt.playerName ?? '',
      answerTypeIndex: attempt.answerTypeIndex ?? -1,
    };
  });
  if (model.dead) result.push({ id: idFactory(), type: 'tossup-dead', questionNumber: model.questionNumber });
  if (model.bonus) {
    result.push({
      id: model.bonus.id ?? idFactory(),
      type: 'bonus',
      questionNumber: model.questionNumber,
      team: model.bonus.team,
      ...(model.bonus.parts
        ? { parts: model.bonus.parts.map((part) => ({ ...part })) }
        : {
            controlledPoints: model.bonus.controlledPoints,
            bouncebackPoints: model.bonus.bouncebackPoints,
          }),
    });
  }
  return result;
}

/** Atomically replace all effective cycle events for one question while retaining audit/record events. */
export function replaceQuestionEvents(
  events: readonly ScoreEvent[],
  questionNumber: number,
  replacement: readonly ScoreEvent[],
): ScoreEvent[] {
  const original = events.slice();
  const cycleIndexes = original
    .map((event, index) => (event.questionNumber === questionNumber && isCycleEvent(event) ? index : -1))
    .filter((index) => index >= 0);
  const voidIndexes = original
    .map((event, index) => (event.questionNumber === questionNumber && event.type === 'question-void' ? index : -1))
    .filter((index) => index >= 0);
  const firstLaterEvent = original.findIndex((event) => event.questionNumber > questionNumber);
  let insertionIndex = cycleIndexes[0];
  if (insertionIndex !== undefined && voidIndexes.length > 0) {
    insertionIndex = Math.max(insertionIndex, Math.max(...voidIndexes) + 1);
  }
  if (insertionIndex === undefined) {
    insertionIndex = voidIndexes.length > 0 ? Math.max(...voidIndexes) + 1 : original.length;
    if (voidIndexes.length === 0 && firstLaterEvent >= 0) insertionIndex = firstLaterEvent;
  }
  const kept = original.filter((event) => !(event.questionNumber === questionNumber && isCycleEvent(event)));
  const removedBefore = cycleIndexes.filter((index) => index < insertionIndex).length;
  const adjustedIndex = Math.max(0, insertionIndex - removedBefore);
  kept.splice(adjustedIndex, 0, ...replacement.map((event) => ({ ...event })));
  return kept;
}
