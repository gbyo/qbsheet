/**
 * What may be recorded next, and why not.
 *
 * # Why a guard exists at all when the UI already disables the buttons
 *
 * Because the UI's disabling is a rendering, and a rendering happens after the click that caused it.
 * A scorekeeper double-tapping a +10 — which is a thing tired people with trackpads do, and a thing
 * touchscreens do on their own — fires both handlers against the same `phase`, and both append. The
 * second buzz has no representation in `MatchQuestion` (`getPoints` finds a team's buzz with `find`)
 * so it is silently unrepresentable on export, but it is very much not silent in the room's own
 * total, which gains ten points nobody scored.
 *
 * Fixing that by making the button faster to disable is chasing the symptom. The fix is that the
 * event list stops accepting events that could not have happened, in a function with no React in it
 * and no dependence on when anything rendered. The UI makes mistakes difficult; this makes them
 * impossible.
 *
 * # Deliberately not a validator
 *
 * This says whether a transition is *possible*, not whether it is *sensible*. It refuses a second
 * buzz by a team that already answered; it does not refuse a fifteen on a tossup the scorekeeper
 * meant to give ten. Corrections go through `replace`/`remove` in the scoresheet review, which are
 * explicitly editing history and are not routed through here — a guard that made a correction
 * impossible would be worse than the mistake it prevented.
 */
import { LeftOrRight } from './types';
import { IScorekeeperFormat } from './ScorekeeperFormat';
import {
  IRoomProcedure,
  lineupChangeAllowedAtPhase,
  protestBlocksCheckpoint,
  protestBlocksSuddenDeathTossup,
  protestCheckpointPolicy,
  roomBreakUpcoming,
  roomMayBreakNow,
  roomTakesBreaks,
  substitutionOpportunityPhrase,
} from './RoomProcedure';
import {
  allowanceNeedsTeam,
  breaksSkipped,
  extraBreakAvailable,
  extraTimeoutsGranted,
  procedureAllowances,
  substitutionAllowed,
} from './ProcedureExceptions';
import deriveGame, {
  IGameSetup,
  IDerivedGame,
  lastPlayedQuestion,
  lineupChangeEffectiveQuestion,
} from './deriveGame';
import { ProcedureAuthority, ScoreEvent, usesTossupOpportunity } from './ScoreEvents';

/**
 * A configured rule the room may have got wrong, named so the refusal can offer a way out.
 *
 * Only ever set on a refusal that a *setting* caused. "Central A has already used its timeout" is
 * one of these, because the number of timeouts is something a director states and a room can be told
 * wrong. "Central A has already answered this tossup" is not, and never will be: there is no
 * configuration under which it is false, and offering to reconsider the procedure there would be
 * offering a way around the guard rather than a way out of a mismatch.
 *
 * The scorer turns this into one quiet secondary action beside the refusal. Nothing renders when it
 * is absent, which is every ordinary refusal.
 */
export type ScoreEventEscape =
  /** How many timeouts this team gets. */
  | 'timeout-allowance'
  /** When this room may change its lineup. */
  | 'substitution-opportunity'
  /** Where this room's breaks fall. */
  | 'break-schedule'
  /** How long regulation is. */
  | 'regulation-length';

export type ScoreEventVerdict = { ok: true } | { ok: false; reason: string; escape?: ScoreEventEscape };

const allowed: ScoreEventVerdict = { ok: true };
const refuse = (reason: string, escape?: ScoreEventEscape): ScoreEventVerdict => ({
  ok: false,
  reason,
  ...(escape === undefined ? {} : { escape }),
});

export interface IScoreEventContext {
  format: IScorekeeperFormat;
  setup: IGameSetup;
  /** Optional; only the timeout ceiling depends on it. */
  procedure?: IRoomProcedure;
}

/**
 * May this be recorded against the game these events describe?
 *
 * @param game pass the already-derived game when the caller has one; it is recomputed otherwise.
 */
export default function canApplyScoreEvent(
  context: IScoreEventContext,
  events: ScoreEvent[],
  candidate: ScoreEvent,
  game: IDerivedGame = deriveGame(context.format, context.setup, events),
): ScoreEventVerdict {
  const { format, procedure } = context;
  const { phase } = game;
  const openProtestStopsSuddenDeath =
    phase.kind === 'tossup' &&
    phase.period === 'overtime' &&
    protestBlocksSuddenDeathTossup(
      protestCheckpointPolicy(procedure),
      game.suddenDeathStarted,
      game.protests.some((protest) => protest.status === 'open'),
    );

  if (events.some((event) => event.id === candidate.id)) {
    return refuse('That action was already recorded.');
  }
  if (!Number.isInteger(candidate.questionNumber) || candidate.questionNumber < 1) {
    return refuse('That action has no question to attach to.');
  }

  const complete = phase.kind === 'complete';

  if (
    game.activeTimeout &&
    candidate.type !== 'timeout-resume' &&
    candidate.type !== 'substitution' &&
    // Writing down what a director just said is never the thing to make a room wait for.
    candidate.type !== 'procedure-exception'
  ) {
    return refuse('A timeout is active. Resume play before scoring or changing the game.');
  }

  switch (candidate.type) {
    // #region tossup

    case 'tossup-reading-resumed':
    case 'tossup-readout': {
      if (openProtestStopsSuddenDeath)
        return refuse('Resolve the open protest before the next sudden-death tossup.');
      if (phase.kind === 'lineup') return refuse('Choose who is starting before scoring the first tossup.');
      if (phase.kind === 'score-check')
        return refuse('Confirm the score with the moderator before scoring again.');
      if (phase.kind === 'bonus') return refuse('Score the bonus before the next tossup.');
      if (phase.kind !== 'tossup') return refuse('Wait for the next tossup checkpoint.');
      if (candidate.questionNumber !== phase.questionNumber) {
        return refuse(`That action belongs to Tossup ${phase.questionNumber}.`);
      }
      const recordedQuestion = game.questions.find(
        (question) => question.questionNumber === candidate.questionNumber,
      );
      const answered = new Set<LeftOrRight>([
        ...(recordedQuestion?.buzzes.map((buzz) => buzz.team) ?? []),
        ...(recordedQuestion?.noPenalty.map((missed) => missed.team) ?? []),
      ]);
      if (candidate.type === 'tossup-reading-resumed') {
        if (recordedQuestion?.readout) return refuse('The question has already been read out.');
        if (answered.size === 0) return refuse('Reading can resume only after a team has answered.');
        if (recordedQuestion?.resolved || answered.size >= 2)
          return refuse('This tossup is already resolved.');
        if (recordedQuestion?.readingResumed) return refuse('Reading has already resumed on this tossup.');
        return allowed;
      }
      if (recordedQuestion?.readout) return refuse('This question has already been read out.');
      if (recordedQuestion?.resolved) return refuse('This tossup is already resolved.');
      return allowed;
    }

    case 'tossup-buzz':
    case 'tossup-no-penalty': {
      if (openProtestStopsSuddenDeath)
        return refuse('Resolve the open protest before the next sudden-death tossup.');
      if (phase.kind === 'lineup') return refuse('Choose who is starting before scoring the first tossup.');
      if (phase.kind === 'score-check')
        return refuse('Confirm the score with the moderator before scoring again.');
      if (phase.kind === 'bonus') return refuse('Score the bonus before the next tossup.');
      // Ahead of the generic phase refusal, because "this game is over" is a different sentence from
      // "wait for the next checkpoint" and it is the one with a way out beside it.
      if (complete) {
        return refuse(
          'This game is over. Reopen it from the scoresheet review to change it.',
          'regulation-length',
        );
      }
      if (phase.kind !== 'tossup') return refuse('Wait for the next tossup checkpoint.');
      if (candidate.questionNumber !== phase.questionNumber) {
        return refuse(`That answer belongs to Tossup ${phase.questionNumber}.`);
      }

      const recordedQuestion = game.questions.find(
        (question) => question.questionNumber === candidate.questionNumber,
      );
      const activePlayers =
        recordedQuestion?.activePlayers[candidate.team] ?? game[candidate.team].activePlayers;
      if (candidate.playerName !== undefined) {
        if (candidate.playerName.trim() === '') return refuse('Choose who answered the tossup.');
        if (!activePlayers.includes(candidate.playerName)) {
          return refuse(`${candidate.playerName} was not active for Tossup ${candidate.questionNumber}.`);
        }
      }

      const answered = new Set<LeftOrRight>([
        ...(recordedQuestion?.buzzes.map((buzz) => buzz.team) ?? []),
        ...(recordedQuestion?.noPenalty.map((missed) => missed.team) ?? []),
      ]);
      if (answered.has(candidate.team)) {
        return refuse(`${game[candidate.team].name} has already answered this tossup.`);
      }
      if (
        events.some(
          (event) => event.type === 'tossup-dead' && event.questionNumber === candidate.questionNumber,
        )
      ) {
        return refuse('This tossup has already gone dead.');
      }

      if (candidate.type === 'tossup-no-penalty') return allowed;

      const answerType = format.answerTypes[candidate.answerTypeIndex];
      if (!answerType) return refuse('That is not a ruling this tournament uses.');
      /*
       * A negative ruling belongs only to the first tossup opportunity. Both a scored buzz and a
       * zero-point/no-penalty answer spend that opportunity. Legacy reading markers describe old
       * history, but they never change this legality rule or reopen a neg for the other team.
       */
      if (answerType.isNeg && answered.size > 0) {
        return refuse(
          `${game[candidate.team].name} cannot receive a neg after another team has attempted this tossup.`,
        );
      }
      return allowed;
    }

    case 'tossup-dead': {
      if (openProtestStopsSuddenDeath)
        return refuse('Resolve the open protest before the next sudden-death tossup.');
      if (phase.kind === 'lineup') return refuse('Choose who is starting before scoring the first tossup.');
      if (phase.kind === 'score-check')
        return refuse('Confirm the score with the moderator before scoring again.');
      if (phase.kind === 'bonus') return refuse('Score the bonus before the next tossup.');
      if (complete) {
        return refuse(
          'This game is over. Reopen it from the scoresheet review to change it.',
          'regulation-length',
        );
      }
      if (phase.kind !== 'tossup') return refuse('Wait for the next tossup checkpoint.');
      if (candidate.questionNumber !== phase.questionNumber) {
        return refuse(`That belongs to Tossup ${phase.questionNumber}.`);
      }
      if (
        events.some(
          (event) => event.type === 'tossup-dead' && event.questionNumber === candidate.questionNumber,
        )
      ) {
        return refuse('This tossup has already gone dead.');
      }
      return allowed;
    }

    // #endregion
    // #region bonus

    case 'bonus': {
      if (phase.kind !== 'bonus') {
        return refuse('There is no bonus to score right now.');
      }
      if (candidate.questionNumber !== phase.questionNumber) {
        return refuse(`That bonus belongs to Tossup ${phase.questionNumber}.`);
      }
      if (candidate.team !== phase.team) {
        return refuse(`${game[phase.team].name} converted this tossup, so this is their bonus.`);
      }
      return allowed;
    }

    // #endregion
    // #region personnel

    case 'substitution': {
      if (candidate.activePlayers.length === 0) return refuse('A team must have somebody on the floor.');
      if (candidate.activePlayers.length > format.players.maximumActive) {
        return refuse(`A team may have at most ${format.players.maximumActive} players active.`);
      }
      if (new Set(candidate.activePlayers).size !== candidate.activePlayers.length) {
        return refuse('The same player is listed twice.');
      }
      const roster = new Set(game[candidate.team].players.map((player) => player.name));
      if (candidate.activePlayers.some((name) => !roster.has(name))) {
        return refuse('Every active player must be on the team roster.');
      }
      if (complete) return refuse('This game is over.');
      if (candidate.questionNumber !== lineupChangeEffectiveQuestion(game, events)) {
        return refuse(
          `The next safe lineup boundary is Tossup ${lineupChangeEffectiveQuestion(game, events)}.`,
        );
      }
      if (
        !lineupChangeAllowedAtPhase(procedure?.substitutionPolicy ?? 'any-boundary', phase.kind) &&
        // One authorized change, spent by this event. A director who allowed a late player on has
        // not thereby allowed every substitution for the rest of the round.
        !substitutionAllowed(events, candidate.team)
      ) {
        // Said from the configured breaks rather than from the usual case: a room whose breaks are
        // after tossups 5 and 10 and which is told to substitute "at halftime" has been told about a
        // break its tournament does not have.
        return refuse(
          `Lineup changes are available ${substitutionOpportunityPhrase(procedure)}.`,
          'substitution-opportunity',
        );
      }
      return allowed;
    }

    case 'roster-add': {
      if (candidate.playerName.trim() === '') return refuse('A player needs a name.');
      if (complete) return refuse('This game is over.');
      return allowed;
    }

    // #endregion
    // #region procedure

    case 'end-regulation': {
      if (!format.regulation.timed)
        return refuse('This format ends regulation on a tossup count, not a clock.');
      if (game.regulationComplete) return refuse('Regulation has already ended.');
      if (complete) return refuse('This game is over.');
      return allowed;
    }

    case 'begin-overtime':
    case 'begin-sudden-death': {
      const expected = candidate.type === 'begin-overtime' ? 'overtime' : 'sudden-death';
      if (phase.kind !== 'checkpoint' || phase.checkpoint !== expected) {
        return refuse(`The game is not at the ${expected} checkpoint.`);
      }
      const checkpointQuestion = Math.max(1, phase.afterQuestion);
      if (candidate.questionNumber !== checkpointQuestion) {
        return refuse(
          phase.afterQuestion === 0
            ? 'That checkpoint belongs before Tossup 1.'
            : `That checkpoint belongs after Tossup ${phase.afterQuestion}.`,
        );
      }
      const openProtests = game.protests.filter((protest) => protest.status === 'open');
      const policy = protestCheckpointPolicy(procedure);
      if (openProtests.length > 0 && protestBlocksCheckpoint(policy, expected)) {
        return refuse('Resolve the open protest before continuing at this checkpoint.');
      }
      return allowed;
    }

    /**
     * A break, scheduled or not.
     *
     * The event type still says `half-break` because that is what is already written into every saved
     * game and every wire message; what it means is "the room stopped here". Where a room may stop is
     * the procedure's business, and under scheduled breaks that is a narrower question than it used
     * to be: a room allowed to substitute only after tossups 5 and 10 must not be able to open a
     * break after tossup 7 and substitute there instead.
     */
    case 'half-break': {
      if (game.awaitingScoreCheck) return refuse('The score check for this break is still open.');
      if (complete) return refuse('This game is over.');
      // An authorized extra break is one break, wherever the schedule says the room should be.
      if (extraBreakAvailable(events)) return allowed;
      if (!roomTakesBreaks(procedure)) return refuse('This room does not take breaks.', 'break-schedule');
      const skipped = breaksSkipped(events);
      if (!roomMayBreakNow(procedure, game.halfBreaks, lastPlayedQuestion(game), skipped)) {
        const upcoming = roomBreakUpcoming(procedure, game.halfBreaks, skipped);
        return refuse(
          upcoming === undefined
            ? 'This room has taken every break its procedure allows.'
            : `The next break is after Tossup ${upcoming.afterTossup}.`,
          'break-schedule',
        );
      }
      return allowed;
    }

    case 'half-resume': {
      if (!game.awaitingScoreCheck) return refuse('There is no break to come back from.');
      return allowed;
    }

    case 'timeout': {
      if (complete) return refuse('This game is over.');
      // Configured plus authorized. A ceiling rather than a bypass: the second one still has to have
      // been allowed, and the third one still has to be allowed separately.
      const configured = procedure?.timeoutsPerTeam ?? 0;
      const permitted = configured + extraTimeoutsGranted(events, candidate.team);
      if (permitted <= 0) return refuse('This tournament does not track timeouts.', 'timeout-allowance');
      if (game.timeouts[candidate.team] >= permitted) {
        return refuse(
          `${game[candidate.team].name} has already used ${permitted === 1 ? 'its timeout' : 'all its timeouts'}.`,
          'timeout-allowance',
        );
      }
      return allowed;
    }

    case 'timeout-start': {
      if (complete) return refuse('This game is over.');
      const permitted = (procedure?.timeoutsPerTeam ?? 0) + extraTimeoutsGranted(events, candidate.team);
      if (permitted <= 0) return refuse('This tournament does not track timeouts.', 'timeout-allowance');
      if (game.activeTimeout) return refuse('A timeout is already active.');
      if (phase.kind !== 'tossup')
        return refuse('A timeout is available only before the current tossup begins.');
      if (candidate.questionNumber !== phase.questionNumber) {
        return refuse(`That timeout belongs to Tossup ${phase.questionNumber}.`);
      }
      if (
        events.some(
          (event) =>
            event.questionNumber === phase.questionNumber &&
            (event.type === 'tossup-dead' || usesTossupOpportunity(event)),
        )
      ) {
        return refuse('A timeout is only available before the current tossup begins.');
      }
      if (game.timeouts[candidate.team] >= permitted) {
        return refuse(`${game[candidate.team].name} has no timeouts remaining.`, 'timeout-allowance');
      }
      if (
        candidate.startedAt !== undefined &&
        (!Number.isFinite(candidate.startedAt) || candidate.startedAt < 0)
      ) {
        return refuse('A timeout start needs a valid timestamp.');
      }
      return allowed;
    }

    case 'timeout-resume':
      if (!game.activeTimeout) return refuse('There is no active timeout to resume.');
      if (candidate.questionNumber !== game.activeTimeout.questionNumber) {
        return refuse(`That timeout belongs to Tossup ${game.activeTimeout.questionNumber}.`);
      }
      return allowed;

    case 'end-game-early': {
      if (complete) return refuse('This game is already over.');
      if (candidate.reason.trim() === '') return refuse('Say why the game is ending early.');
      return allowed;
    }

    // #endregion
    // #region corrections and records

    case 'question-void': {
      if (candidate.reason.trim() === '') return refuse('Say what went wrong with the question.');
      const cycle = game.questions.find((question) => question.questionNumber === candidate.questionNumber);
      if (candidate.scope === 'bonus') {
        if (!cycle || (!cycle.bonus && !cycle.awaitingBonus))
          return refuse('There is no bonus on that question.');
        return allowed;
      }
      if (!cycle) return refuse('Nothing has been recorded on that question yet.');
      return allowed;
    }

    case 'protest': {
      if (candidate.description.trim() === '') return refuse('Say what is being protested.');
      return allowed;
    }

    /**
     * Recording that somebody with the standing to do so allowed a departure from procedure.
     *
     * Checked as strictly as anything else here, because an exception is a grant and a grant that
     * could not have been made is worth no more than an event that could not have happened. What is
     * deliberately *not* checked is whether the departure is one the configured procedure would
     * permit — that is the entire point of the event.
     */
    case 'procedure-exception': {
      if (!procedureAllowances.includes(candidate.allowance)) {
        return refuse('That is not something this scoresheet knows how to allow.');
      }
      const authorities: ProcedureAuthority[] = ['tournament-director', 'moderator', 'other'];
      if (!authorities.includes(candidate.authority)) return refuse('Say who allowed this.');
      if (candidate.reason.trim() === '') return refuse('Say why this was allowed.');
      if (allowanceNeedsTeam(candidate.allowance) && candidate.team === undefined) {
        return refuse('Say which team this was allowed for.');
      }
      if (candidate.allowance === 'extra-tossup') {
        /*
         * Regulation is lengthened by moving its boundary, and a boundary that moves past a tossup
         * already played in overtime would silently reclassify that tossup as regulation. That is a
         * correction to what happened rather than permission to do something, and it belongs in the
         * scoresheet review where the consequence can be shown.
         */
        if (game.overtimeTossupsRead > 0 || game.overtimeStarted) {
          return refuse(
            'Overtime has already begun, so regulation cannot be lengthened now. Correct the questions in the scoresheet review instead.',
          );
        }
        if (format.regulation.timed && !game.regulationComplete) {
          return refuse('End regulation first; then an extra tossup can be added to it.');
        }
      }
      if (candidate.allowance === 'overtime-continuation' && !game.regulationComplete) {
        return refuse('Overtime has not been reached yet.');
      }
      // The allowances that permit a later act mean nothing once there are no later acts. An extra
      // tossup or an overtime continuation is precisely what a room reaches for on a game the
      // scoresheet has already called over, so those two are exempt.
      if (
        complete &&
        (candidate.allowance === 'extra-timeout' ||
          candidate.allowance === 'substitution' ||
          candidate.allowance === 'extra-break' ||
          candidate.allowance === 'skip-break')
      ) {
        return refuse('This game is over.');
      }
      return allowed;
    }

    case 'forfeit': {
      if (candidate.teams.length === 0) return refuse('Say who forfeited.');
      if (complete) return refuse('This game is already over.');
      return allowed;
    }

    case 'lightning': {
      if (!format.lightning.enabled) return refuse('This tournament does not play lightning rounds.');
      if (!Number.isFinite(candidate.points)) return refuse('Enter a lightning total.');
      return allowed;
    }

    case 'adjustment': {
      if (!Number.isInteger(candidate.points) || candidate.points === 0) {
        return refuse('An adjustment needs a non-zero whole number of points.');
      }
      return allowed;
    }

    case 'note':
      return candidate.text.trim() === '' ? refuse('A note needs some text.') : allowed;

    // #endregion

    default:
      // Exhaustive over ScoreEvent; a new event type that forgets to state its rule lands here.
      return refuse('That action is not one this game understands.');
  }
}

/**
 * Apply a whole action, all of it or none of it.
 *
 * A scorekeeper's single act can be more than one event — adding a player is a roster addition and a
 * lineup change — and half of one landing is worse than none of it: the lineup would name somebody
 * the roster does not have. Each event is checked against the list as it would stand with the ones
 * before it already applied, so an action is judged the way it will actually be replayed.
 */
export function applyScoreEvents(
  context: IScoreEventContext,
  events: ScoreEvent[],
  added: ScoreEvent[],
): { ok: true; events: ScoreEvent[] } | { ok: false; reason: string; escape?: ScoreEventEscape } {
  let working = events;
  for (const candidate of added) {
    const verdict = canApplyScoreEvent(context, working, candidate);
    if (!verdict.ok) return verdict;
    working = working.concat(candidate);
  }
  return { ok: true, events: working };
}
