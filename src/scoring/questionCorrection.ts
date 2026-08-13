import { IScorekeeperFormat } from './ScorekeeperFormat';
import { bonusFollows, GamePeriod, IDerivedGame } from './deriveGame';
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
  /** Preserve the explicit interruption/resume state when a question is corrected. */
  readingResumed?: boolean;
  /** Preserve the moderator's readout marker when a question is corrected. */
  readout?: boolean;
  /** A readout recorded before either team answered, rather than after the first attempt. */
  readoutBeforeAttempt?: boolean;
  dead: boolean;
  bonus?: IEditableBonus;
}

function isCycleEvent(event: ScoreEvent): boolean {
  return (
    event.type === 'tossup-buzz' ||
    event.type === 'tossup-no-penalty' ||
    event.type === 'tossup-reading-resumed' ||
    event.type === 'tossup-readout' ||
    event.type === 'tossup-dead' ||
    event.type === 'bonus'
  );
}

export function editableQuestionFromEvents(events: readonly ScoreEvent[], questionNumber: number): IEditableQuestion {
  const cycleEvents = effectiveQuestionEvents(events, questionNumber);
  const attempts: IEditableAttempt[] = [];
  let dead = false;
  let readingResumed = false;
  let readout = false;
  let readoutBeforeAttempt = false;
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
    } else if (event.type === 'tossup-reading-resumed') readingResumed = true;
    else if (event.type === 'tossup-readout') {
      readout = true;
      readoutBeforeAttempt = attempts.length === 0;
    }
    else if (event.type === 'tossup-dead') dead = true;
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
  return {
    questionNumber,
    attempts,
    readingResumed,
    readout,
    ...(readoutBeforeAttempt ? { readoutBeforeAttempt: true } : {}),
    dead,
    bonus,
  };
}

export function conversion(model: IEditableQuestion, format: IScorekeeperFormat): IEditableAttempt | undefined {
  return model.attempts.find(
    (attempt) =>
      attempt.kind === 'buzz' &&
      attempt.answerTypeIndex !== undefined &&
      (format.answerTypes[attempt.answerTypeIndex]?.value ?? 0) > 0,
  );
}

/** Which period the cycle being edited belongs to. Unknown reads as regulation. */
function editedPeriod(game: IDerivedGame, model: IEditableQuestion): GamePeriod {
  return game.questions.find((candidate) => candidate.questionNumber === model.questionNumber)?.period ?? 'regulation';
}

/**
 * Whether this proposed cycle owes a bonus.
 *
 * The engine's `bonusFollows`, asked of an edit in progress rather than of a recorded question, so
 * the correction dialog and the validator cannot disagree about it. That disagreement was a real
 * defect and not a theoretical one: the dialog offered Add bonus whenever the format used bonuses at
 * all, so a scorekeeper could be invited to add a bonus to an answer type with `awardsBonus: false`,
 * or to an overtime tossup in a format whose overtime excludes bonuses, and only find out at Save.
 */
export function expectsBonus(
  format: IScorekeeperFormat,
  game: IDerivedGame,
  model: IEditableQuestion,
): boolean {
  const converted = conversion(model, format);
  const answerType =
    converted?.answerTypeIndex === undefined ? undefined : format.answerTypes[converted.answerTypeIndex];
  if (!answerType) return false;
  return bonusFollows(format, answerType, editedPeriod(game, model));
}

/**
 * Make the bonus follow the tossup it depends on, at the moment of the edit.
 *
 * A bonus belongs to whoever converted and exists only while that conversion earns one. Both of
 * those used to be checked only by `validateEditableQuestion` at Save, so changing the converting
 * team left the bonus owned by a team that no longer converted anything, and changing to a ruling
 * that awards no bonus left the old bonus sitting in the dialog — in both cases silently, until Save
 * refused the whole correction. Applying the rule to the model instead means the screen can never
 * show a combination the validator would reject.
 */
export function settleBonus(
  model: IEditableQuestion,
  format: IScorekeeperFormat,
  game: IDerivedGame,
): IEditableQuestion {
  if (!model.bonus) return model;
  if (!expectsBonus(format, game, model)) return { ...model, bonus: undefined };
  const converted = conversion(model, format);
  if (converted && model.bonus.team !== converted.team) {
    return { ...model, bonus: { ...model.bonus, team: converted.team } };
  }
  return model;
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
  if (model.readingResumed === true && model.attempts.length === 0) {
    errors.push(`Question ${model.questionNumber} cannot resume reading before an answer.`);
  }
  if (model.readoutBeforeAttempt === true && model.readout !== true) {
    errors.push(`Question ${model.questionNumber} cannot place a missing readout before an answer.`);
  }
  if (model.readoutBeforeAttempt === true && model.readingResumed === true) {
    errors.push(`Question ${model.questionNumber} cannot resume reading after a pre-answer readout.`);
  }

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
      else if (
        answerType.isNeg &&
        (model.readoutBeforeAttempt === true ||
          (model.readout === true && previousAttempt) ||
          (previousAttempt && model.readingResumed !== true))
      )
        errors.push(`Question ${model.questionNumber} cannot have a second-team neg.`);
    } else if (attempt.playerName !== undefined && !activePlayers[attempt.team].includes(attempt.playerName)) {
      errors.push(`${attempt.playerName} was not active for Question ${model.questionNumber}.`);
    }
    previousAttempt = true;
  }

  const converted = conversion(model, format);
  if (model.dead && converted)
    errors.push(`Question ${model.questionNumber} cannot have both a correct answer and no conversion.`);
  const firstAttemptType =
    model.attempts[0]?.kind === 'buzz' && model.attempts[0].answerTypeIndex !== undefined
      ? format.answerTypes[model.attempts[0].answerTypeIndex]
      : undefined;
  if (model.readingResumed === true && firstAttemptType !== undefined && firstAttemptType.value > 0) {
    errors.push(`Question ${model.questionNumber} cannot resume reading after a conversion.`);
  }
  const owesBonus = expectsBonus(format, game, model);
  const isCurrentQuestion =
    (game.phase.kind === 'tossup' || game.phase.kind === 'bonus' || game.phase.kind === 'timeout') &&
    game.phase.questionNumber === model.questionNumber;
  if (owesBonus && !model.bonus && !isCurrentQuestion)
    errors.push(`Question ${model.questionNumber} needs a bonus for this conversion.`);
  if (!owesBonus && model.bonus)
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
  const attempts = model.attempts.map((attempt) => {
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
  const result: ScoreEvent[] = [];
  if (model.readoutBeforeAttempt === true) {
    result.push({ id: idFactory(), type: 'tossup-readout', questionNumber: model.questionNumber });
  }
  attempts.forEach((attempt, index) => {
    result.push(attempt);
    if (index === 0 && model.readingResumed === true) {
      result.push({ id: idFactory(), type: 'tossup-reading-resumed', questionNumber: model.questionNumber });
    }
    if (index === 0 && model.readout === true && model.readoutBeforeAttempt !== true) {
      result.push({ id: idFactory(), type: 'tossup-readout', questionNumber: model.questionNumber });
    }
  });
  if (attempts.length === 0) {
    if (model.readingResumed === true) {
      result.push({ id: idFactory(), type: 'tossup-reading-resumed', questionNumber: model.questionNumber });
    }
    if (model.readout === true && model.readoutBeforeAttempt !== true) {
      result.push({ id: idFactory(), type: 'tossup-readout', questionNumber: model.questionNumber });
    }
  }
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
