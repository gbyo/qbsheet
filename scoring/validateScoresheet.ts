import { IScorekeeperFormat } from '../../renderer/Services/ScorekeeperFormat';
import {
  IRoomProcedure,
  protestBlocksCheckpoint,
  protestCheckpointPolicy,
} from '../../renderer/Services/RoomProcedure';
import deriveGame, { IGameSetup, IDerivedGame, IDerivedQuestion } from './deriveGame';
import { bonusEventPoints, ScoreEvent, usesTossupOpportunity } from './ScoreEvents';
import { bonusPartProblem, bonusScoreProblem } from '../scorer/bonusOptions';

export type ScoresheetProblemSeverity = 'blocker' | 'warning';

export interface IScoresheetProblem {
  severity: ScoresheetProblemSeverity;
  code: string;
  message: string;
  questionNumber?: number;
}

export interface IScoresheetValidation {
  blockers: IScoresheetProblem[];
  warnings: IScoresheetProblem[];
  game: IDerivedGame;
  valid: boolean;
}

function problem(
  severity: ScoresheetProblemSeverity,
  code: string,
  message: string,
  questionNumber?: number,
): IScoresheetProblem {
  return { severity, code, message, ...(questionNumber === undefined ? {} : { questionNumber }) };
}

function addUnique(target: IScoresheetProblem[], next: IScoresheetProblem): void {
  if (!target.some((existing) => existing.code === next.code && existing.message === next.message)) target.push(next);
}

function isCycleEvent(event: ScoreEvent): boolean {
  return (
    event.type === 'tossup-buzz' ||
    event.type === 'tossup-no-penalty' ||
    event.type === 'tossup-dead' ||
    event.type === 'bonus'
  );
}

const knownEventTypes = new Set<ScoreEvent['type']>([
  'tossup-buzz',
  'tossup-no-penalty',
  'tossup-dead',
  'bonus',
  'lightning',
  'substitution',
  'roster-add',
  'end-regulation',
  'half-break',
  'half-resume',
  'begin-overtime',
  'begin-sudden-death',
  'timeout',
  'timeout-start',
  'timeout-resume',
  'protest',
  'question-void',
  'end-game-early',
  'adjustment',
  'forfeit',
  'note',
]);

function validTeam(value: unknown): value is 'left' | 'right' {
  return value === 'left' || value === 'right';
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Keep malformed records out of derivation so validation can report them instead of crashing. */
function isDerivableEvent(value: unknown, format: IScorekeeperFormat): value is ScoreEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Record<string, unknown>;
  if (
    typeof event.type !== 'string' ||
    !knownEventTypes.has(event.type as ScoreEvent['type']) ||
    !Number.isInteger(event.questionNumber) ||
    Number(event.questionNumber) < 1
  )
    return false;

  switch (event.type) {
    case 'tossup-buzz':
      return (
        validTeam(event.team) &&
        typeof event.playerName === 'string' &&
        event.playerName.trim() !== '' &&
        Number.isInteger(event.answerTypeIndex) &&
        Number(event.answerTypeIndex) >= 0 &&
        format.answerTypes.some((answerType) => answerType.index === event.answerTypeIndex)
      );
    case 'tossup-no-penalty':
      return (
        validTeam(event.team) &&
        (event.playerName === undefined || (typeof event.playerName === 'string' && event.playerName.trim() !== ''))
      );
    case 'tossup-dead':
    case 'half-resume':
    case 'begin-overtime':
    case 'begin-sudden-death':
    case 'timeout-resume':
      return true;
    case 'bonus': {
      const { parts } = event;
      const validParts =
        parts === undefined ||
        (Array.isArray(parts) &&
          parts.length > 0 &&
          parts.every(
            (part) =>
              typeof part === 'object' &&
              part !== null &&
              finiteNumber((part as Record<string, unknown>).controlledPoints) &&
              ((part as Record<string, unknown>).bouncebackPoints === undefined ||
                finiteNumber((part as Record<string, unknown>).bouncebackPoints)),
          ));
      return (
        validTeam(event.team) &&
        validParts &&
        (event.controlledPoints !== undefined || event.parts !== undefined) &&
        (event.controlledPoints === undefined || finiteNumber(event.controlledPoints)) &&
        (event.bouncebackPoints === undefined || finiteNumber(event.bouncebackPoints))
      );
    }
    case 'lightning':
      return validTeam(event.team) && finiteNumber(event.points);
    case 'adjustment':
      return validTeam(event.team) && Number.isInteger(event.points) && event.points !== 0;
    case 'substitution':
      return (
        validTeam(event.team) &&
        Array.isArray(event.activePlayers) &&
        event.activePlayers.length > 0 &&
        new Set(event.activePlayers).size === event.activePlayers.length &&
        event.activePlayers.every((name) => typeof name === 'string' && name.trim() !== '')
      );
    case 'roster-add':
      return validTeam(event.team) && typeof event.playerName === 'string' && event.playerName.trim() !== '';
    case 'end-regulation':
      return (
        event.lastRegulationQuestion === undefined ||
        (Number.isInteger(event.lastRegulationQuestion) && Number(event.lastRegulationQuestion) >= 0)
      );
    case 'half-break':
      return Number.isInteger(event.lastQuestion) && Number(event.lastQuestion) >= 0;
    case 'timeout':
      return validTeam(event.team);
    case 'timeout-start':
      return (
        validTeam(event.team) &&
        (event.startedAt === undefined || (finiteNumber(event.startedAt) && event.startedAt >= 0))
      );
    case 'protest':
      return (
        validTeam(event.team) &&
        ['tossup-answer', 'bonus-answer', 'question', 'procedure', 'other'].includes(String(event.subject)) &&
        ['open', 'upheld', 'declined', 'withdrawn'].includes(String(event.status)) &&
        typeof event.description === 'string' &&
        event.description.trim() !== '' &&
        (event.resolution === undefined || typeof event.resolution === 'string')
      );
    case 'question-void':
      return (
        (event.scope === 'tossup' || event.scope === 'bonus') &&
        typeof event.reason === 'string' &&
        event.reason.trim() !== ''
      );
    case 'end-game-early':
      return (
        typeof event.reason === 'string' &&
        event.reason.trim() !== '' &&
        Number.isInteger(event.tossupsRead) &&
        Number(event.tossupsRead) >= 0
      );
    case 'forfeit':
      return (
        Array.isArray(event.teams) &&
        event.teams.length > 0 &&
        new Set(event.teams).size === event.teams.length &&
        event.teams.every(validTeam)
      );
    case 'note':
      return typeof event.text === 'string' && event.text.trim() !== '';
    default:
      return false;
  }
}

/**
 * Return the effective cycle after replacement-question events have discarded earlier scoring.
 * Replacement notes, protests and the void audit event itself are intentionally not included.
 */
export function effectiveQuestionEvents(events: readonly ScoreEvent[], questionNumber: number): ScoreEvent[] {
  let effective: ScoreEvent[] = [];
  for (const event of events) {
    if (event.questionNumber !== questionNumber) continue;
    if (event.type === 'question-void') {
      effective = event.scope === 'bonus' ? effective.filter((candidate) => candidate.type !== 'bonus') : [];
      continue;
    }
    if (isCycleEvent(event)) effective.push(event);
  }
  return effective;
}

function questionNumbers(events: readonly ScoreEvent[], game: IDerivedGame): number[] {
  const numbers = new Set<number>(game.questions.map((question) => question.questionNumber));
  for (const event of events) if (isCycleEvent(event)) numbers.add(event.questionNumber);
  return Array.from(numbers).sort((left, right) => left - right);
}

function questionFor(game: IDerivedGame, questionNumber: number): IDerivedQuestion | undefined {
  return game.questions.find((question) => question.questionNumber === questionNumber);
}

function validateRuntimeShape(events: readonly ScoreEvent[], format: IScorekeeperFormat): IScoresheetProblem[] {
  const problems: IScoresheetProblem[] = [];
  const ids = new Set<string>();
  for (const candidate of events as readonly unknown[]) {
    if (typeof candidate !== 'object' || candidate === null) {
      problems.push(problem('blocker', 'malformed-event', 'The scoresheet contains a malformed scoring record.'));
      continue;
    }
    const event = candidate as Partial<ScoreEvent> & { id?: unknown; type?: unknown; questionNumber?: unknown };
    const { questionNumber } = event;
    if (!isDerivableEvent(candidate, format)) {
      problems.push(problem('blocker', 'malformed-event', 'A scoring record contains invalid required data.'));
      if (event.type === 'tossup-buzz' && Number.isInteger(questionNumber)) {
        problems.push(
          problem(
            'blocker',
            'malformed-tossup',
            `Question ${questionNumber} has malformed tossup data.`,
            Number(questionNumber),
          ),
        );
      }
      if (event.type === 'bonus' && Number.isInteger(questionNumber)) {
        problems.push(
          problem(
            'blocker',
            'malformed-bonus',
            `Question ${questionNumber} has malformed bonus data.`,
            Number(questionNumber),
          ),
        );
      }
    }
    if (typeof event.id !== 'string' || event.id.trim() === '' || ids.has(event.id)) {
      problems.push(
        problem('blocker', 'malformed-event-id', 'The scoresheet contains a missing or duplicate event id.'),
      );
    } else ids.add(event.id);
    if (typeof event.type !== 'string' || !Number.isInteger(questionNumber) || Number(questionNumber) < 1) {
      problems.push(problem('blocker', 'malformed-event', 'A scoring record has missing required question data.'));
      continue;
    }
  }
  return problems;
}

function validateQuestion(
  format: IScorekeeperFormat,
  game: IDerivedGame,
  events: ScoreEvent[],
  questionNumber: number,
  blockers: IScoresheetProblem[],
): void {
  const question = questionFor(game, questionNumber);
  const cycleEvents = effectiveQuestionEvents(events, questionNumber);
  if (cycleEvents.length === 0) return;

  const attempts = cycleEvents.filter(usesTossupOpportunity);
  const deadEvents = cycleEvents.filter((event) => event.type === 'tossup-dead');
  const buzzes = cycleEvents.filter(
    (event): event is Extract<ScoreEvent, { type: 'tossup-buzz' }> => event.type === 'tossup-buzz',
  );
  const conversions = buzzes.filter((event) => format.answerTypes[event.answerTypeIndex]?.value > 0);
  const bonuses = cycleEvents.filter(
    (event): event is Extract<ScoreEvent, { type: 'bonus' }> => event.type === 'bonus',
  );

  if (attempts.length === 0 && deadEvents.length === 0) {
    addUnique(
      blockers,
      problem(
        'blocker',
        'unfinished-cycle',
        `Question ${questionNumber} has no ruling yet. Finish or correct Question ${questionNumber}.`,
        questionNumber,
      ),
    );
  }
  if (deadEvents.length > 1) {
    addUnique(
      blockers,
      problem(
        'blocker',
        'duplicate-dead',
        `Question ${questionNumber} is marked No buzz more than once.`,
        questionNumber,
      ),
    );
  }
  if (conversions.length > 1) {
    addUnique(
      blockers,
      problem(
        'blocker',
        'multiple-conversions',
        `Question ${questionNumber} has more than one correct tossup conversion.`,
        questionNumber,
      ),
    );
  }
  if (conversions.length > 0 && deadEvents.length > 0) {
    addUnique(
      blockers,
      problem(
        'blocker',
        'dead-conversion',
        `Question ${questionNumber} has both a correct answer and No buzz.`,
        questionNumber,
      ),
    );
  }
  if (deadEvents.length > 0 && attempts.length > 0) {
    addUnique(
      blockers,
      problem(
        'blocker',
        'dead-attempt',
        `Question ${questionNumber} has an answer recorded as well as No buzz.`,
        questionNumber,
      ),
    );
  }

  const usedTeams = new Set<string>();
  for (const attempt of attempts) {
    if (usedTeams.has(attempt.team)) {
      addUnique(
        blockers,
        problem(
          'blocker',
          'duplicate-opportunity',
          `Question ${questionNumber} uses ${
            attempt.team === 'left' ? game.left.name : game.right.name
          }'s tossup opportunity twice.`,
          questionNumber,
        ),
      );
    }
    usedTeams.add(attempt.team);
  }

  let priorAttempt = false;
  for (const event of cycleEvents) {
    if (event.type === 'tossup-buzz') {
      const answerType = format.answerTypes[event.answerTypeIndex];
      if (answerType?.isNeg && priorAttempt) {
        addUnique(
          blockers,
          problem(
            'blocker',
            'second-team-neg',
            `Question ${questionNumber} has a neg after the question was read out.`,
            questionNumber,
          ),
        );
      }
    }
    if (usesTossupOpportunity(event)) priorAttempt = true;
  }

  if (question) {
    for (const attempt of attempts) {
      if (attempt.type === 'tossup-buzz' && !question.activePlayers[attempt.team].includes(attempt.playerName)) {
        addUnique(
          blockers,
          problem(
            'blocker',
            'inactive-player',
            `${attempt.playerName} was not active for Question ${questionNumber}. Review Question ${questionNumber}.`,
            questionNumber,
          ),
        );
      }
      if (
        attempt.type === 'tossup-no-penalty' &&
        attempt.playerName !== undefined &&
        !question.activePlayers[attempt.team].includes(attempt.playerName)
      ) {
        addUnique(
          blockers,
          problem(
            'blocker',
            'inactive-player',
            `${attempt.playerName} was not active for Question ${questionNumber}. Review Question ${questionNumber}.`,
            questionNumber,
          ),
        );
      }
    }
  }

  if (bonuses.length > 1) {
    addUnique(
      blockers,
      problem(
        'blocker',
        'duplicate-bonus',
        `Question ${questionNumber} has more than one bonus result.`,
        questionNumber,
      ),
    );
  }
  const conversion = conversions[0];
  const answerType = conversion ? format.answerTypes[conversion.answerTypeIndex] : undefined;
  const expectedBonus =
    conversion !== undefined &&
    answerType?.awardsBonus === true &&
    format.bonus.enabled &&
    (question?.period !== 'overtime' || format.overtime.includesBonuses);
  const bonus = bonuses[0];
  if (bonus && !conversion) {
    addUnique(
      blockers,
      problem(
        'blocker',
        'orphan-bonus',
        `Question ${questionNumber} has a bonus but no correct tossup conversion. Review Question ${questionNumber}.`,
        questionNumber,
      ),
    );
  }
  if (bonus && conversion && bonus.team !== conversion.team) {
    addUnique(
      blockers,
      problem(
        'blocker',
        'wrong-bonus-team',
        `Question ${questionNumber}'s bonus belongs to the team that converted the tossup.`,
        questionNumber,
      ),
    );
  }
  if (expectedBonus && !bonus) {
    addUnique(
      blockers,
      problem(
        'blocker',
        'missing-bonus',
        `Question ${questionNumber} has a correct tossup but its required bonus is missing. Review Question ${questionNumber}.`,
        questionNumber,
      ),
    );
  }
  if (!expectedBonus && bonus && conversion) {
    addUnique(
      blockers,
      problem(
        'blocker',
        'unexpected-bonus',
        `Question ${questionNumber} has a bonus that this tossup does not earn.`,
        questionNumber,
      ),
    );
  }

  if (bonus) {
    const [controlled, bounceback] = bonusEventPoints(bonus);
    const scoreProblem = bonusScoreProblem(format.bonus, controlled, bounceback);
    if (scoreProblem) {
      addUnique(
        blockers,
        problem(
          'blocker',
          'invalid-bonus-total',
          `Question ${questionNumber} has an impossible bonus total: ${scoreProblem}`,
          questionNumber,
        ),
      );
    }
    if (bonus.parts) {
      if (bonus.parts.length < format.bonus.minimumParts || bonus.parts.length > format.bonus.maximumParts) {
        addUnique(
          blockers,
          problem(
            'blocker',
            'bonus-part-count',
            `Question ${questionNumber} has the wrong number of bonus parts.`,
            questionNumber,
          ),
        );
      }
      const partsControlled = bonus.parts.reduce((sum, part) => sum + part.controlledPoints, 0);
      const partsBounceback = bonus.parts.reduce((sum, part) => sum + (part.bouncebackPoints ?? 0), 0);
      for (const part of bonus.parts) {
        const partProblem = bonusPartProblem(format.bonus, part.controlledPoints, part.bouncebackPoints ?? 0);
        if (partProblem) {
          addUnique(
            blockers,
            problem('blocker', 'invalid-bonus-part', `Question ${questionNumber}: ${partProblem}`, questionNumber),
          );
        }
      }
      if (
        (bonus.controlledPoints !== undefined && bonus.controlledPoints !== partsControlled) ||
        (bonus.bouncebackPoints !== undefined && bonus.bouncebackPoints !== partsBounceback)
      ) {
        addUnique(
          blockers,
          problem(
            'blocker',
            'bonus-parts-total-mismatch',
            `Question ${questionNumber}'s bonus parts do not match its recorded totals.`,
            questionNumber,
          ),
        );
      }
    }
  }

  // A derived question can be present with no final ruling only in an in-progress game. Submission
  // validation treats that as a blocker below; keeping the check here makes the question actionable.
  if (question && question.resolved && question.awaitingBonus && !bonus) {
    addUnique(
      blockers,
      problem(
        'blocker',
        'missing-derived-bonus',
        `Question ${questionNumber} is waiting for a required bonus.`,
        questionNumber,
      ),
    );
  }
}

function validateProcedureTransitions(
  format: IScorekeeperFormat,
  setup: IGameSetup,
  events: ScoreEvent[],
  blockers: IScoresheetProblem[],
): void {
  const prior: ScoreEvent[] = [];
  for (const event of events) {
    if (event.type === 'begin-overtime' || event.type === 'begin-sudden-death') {
      const before = deriveGame(format, setup, prior);
      const expected = event.type === 'begin-overtime' ? 'overtime' : 'sudden-death';
      if (
        before.phase.kind !== 'checkpoint' ||
        before.phase.checkpoint !== expected ||
        event.questionNumber !== before.phase.afterQuestion
      ) {
        addUnique(
          blockers,
          problem(
            'blocker',
            'invalid-procedure-transition',
            `${
              event.type === 'begin-overtime' ? 'Begin overtime' : 'Begin sudden death'
            } must be recorded at its matching checkpoint.`,
            event.questionNumber,
          ),
        );
      }
    }
    prior.push(event);
  }
}

/**
 * Validate the complete event history before a room submits it.
 *
 * This deliberately runs after derivation: the room still has one scoring engine, while the
 * validator classifies the states that a completed result must never export.
 */
export default function validateScoresheet(
  format: IScorekeeperFormat,
  setup: IGameSetup,
  events: readonly ScoreEvent[],
  procedure?: IRoomProcedure,
): IScoresheetValidation {
  const typedEvents = events.slice() as ScoreEvent[];
  const safeEvents = typedEvents.filter((event) => isDerivableEvent(event, format));
  const game = deriveGame(format, setup, safeEvents);
  const blockers: IScoresheetProblem[] = [];
  const warnings: IScoresheetProblem[] = [];

  for (const next of validateRuntimeShape(typedEvents, format)) addUnique(blockers, next);
  for (const next of game.personnelProblems) {
    addUnique(blockers, problem('blocker', 'inactive-player', next.message, next.questionNumber));
  }
  for (const next of game.integrityProblems) {
    addUnique(blockers, problem('blocker', 'integrity', next.message, next.questionNumber));
  }
  if (game.needsStartingLineup.length > 0) {
    addUnique(
      blockers,
      problem('blocker', 'missing-lineup', 'Choose a starting lineup for every team before submitting.'),
    );
  }

  validateProcedureTransitions(format, setup, safeEvents, blockers);

  for (const questionNumber of questionNumbers(safeEvents, game)) {
    validateQuestion(format, game, safeEvents, questionNumber, blockers);
  }
  for (const question of game.questions) {
    if (!question.resolved || question.awaitingBonus) {
      addUnique(
        blockers,
        problem(
          'blocker',
          'unfinished-cycle',
          `Question ${question.questionNumber} is not finished. Review Question ${question.questionNumber}.`,
          question.questionNumber,
        ),
      );
    }
  }

  for (const event of safeEvents) {
    if (event.type === 'roster-add') {
      addUnique(
        warnings,
        problem(
          'warning',
          'local-roster-addition',
          `${event.playerName} was added locally and may need tournament-roster synchronization.`,
          event.questionNumber,
        ),
      );
    }
    if (event.type === 'adjustment') {
      addUnique(
        warnings,
        problem(
          'warning',
          'manual-adjustment',
          `A manual ${event.points > 0 ? 'addition' : 'deduction'} of ${Math.abs(event.points)} points is recorded.`,
          event.questionNumber,
        ),
      );
    }
  }
  if (game.endedEarly) {
    addUnique(
      warnings,
      problem(
        'warning',
        'ended-short',
        `The game ended early after ${game.endedEarly.tossupsRead} tossups: ${game.endedEarly.reason}`,
      ),
    );
  }
  for (const protest of game.protests.filter((entry) => entry.status === 'open')) {
    const policy = protestCheckpointPolicy(procedure);
    const strict = protestBlocksCheckpoint(policy, 'overtime') || protestBlocksCheckpoint(policy, 'sudden-death');
    addUnique(
      strict ? blockers : warnings,
      problem(
        strict ? 'blocker' : 'warning',
        'open-protest',
        strict
          ? `Question ${protest.questionNumber} has an unresolved protest. Resolve it before submitting this result.`
          : `Question ${protest.questionNumber} has an unresolved protest; tournament control will review it.`,
        protest.questionNumber,
      ),
    );
  }

  if (game.phase.kind !== 'complete') {
    addUnique(blockers, problem('blocker', 'game-not-complete', 'Finish the game before submitting the scoresheet.'));
  }
  return { blockers, warnings, game, valid: blockers.length === 0 };
}

/** The correction path uses the same structural rules but may leave the current tossup unfinished. */
export function validateCorrectedHistory(
  format: IScorekeeperFormat,
  setup: IGameSetup,
  events: readonly ScoreEvent[],
  procedure?: IRoomProcedure,
): IScoresheetValidation {
  const validation = validateScoresheet(format, setup, events, procedure);
  const { game } = validation;
  const currentQuestion =
    game.phase.kind === 'tossup' || game.phase.kind === 'bonus' || game.phase.kind === 'timeout'
      ? game.phase.questionNumber
      : undefined;
  const allowedCodes = new Set(['unfinished-cycle', 'missing-derived-bonus', 'missing-bonus', 'game-not-complete']);
  const blockers = validation.blockers.filter(
    (candidate) =>
      !(
        currentQuestion !== undefined &&
        candidate.questionNumber === currentQuestion &&
        allowedCodes.has(candidate.code)
      ) && candidate.code !== 'game-not-complete',
  );
  return { ...validation, blockers, valid: blockers.length === 0 };
}
