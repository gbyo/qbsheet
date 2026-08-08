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
import { LeftOrRight } from '../../renderer/Utils/UtilTypes';
import { IScorekeeperFormat } from '../../renderer/Services/ScorekeeperFormat';
import { IRoomProcedure } from '../../renderer/Services/RoomProcedure';
import deriveGame, { IGameSetup, IDerivedGame } from './deriveGame';
import { ScoreEvent, usesTossupOpportunity } from './ScoreEvents';

export type ScoreEventVerdict = { ok: true } | { ok: false; reason: string };

const allowed: ScoreEventVerdict = { ok: true };
const refuse = (reason: string): ScoreEventVerdict => ({ ok: false, reason });

export interface IScoreEventContext {
  format: IScorekeeperFormat;
  setup: IGameSetup;
  /** Optional; only the timeout ceiling depends on it. */
  procedure?: IRoomProcedure;
}

/**
 * Answers a team has already given on this tossup, whatever their value.
 *
 * A zero-point wrong answer spends a team's chance exactly as a buzz does, so both count here.
 */
function teamsThatAnswered(events: ScoreEvent[], questionNumber: number): Set<LeftOrRight> {
  const answered = new Set<LeftOrRight>();
  for (const event of events) {
    if (event.questionNumber !== questionNumber) continue;
    if (usesTossupOpportunity(event)) answered.add(event.team);
  }
  return answered;
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

  if (events.some((event) => event.id === candidate.id)) {
    return refuse('That action was already recorded.');
  }
  if (!Number.isInteger(candidate.questionNumber) || candidate.questionNumber < 1) {
    return refuse('That action has no question to attach to.');
  }

  const complete = phase.kind === 'complete';

  switch (candidate.type) {
    // #region tossup

    case 'tossup-buzz':
    case 'tossup-no-penalty': {
      if (phase.kind === 'lineup') return refuse('Choose who is starting before scoring the first tossup.');
      if (phase.kind === 'score-check') return refuse('Confirm the score with the moderator before scoring again.');
      if (phase.kind === 'bonus') return refuse('Score the bonus before the next tossup.');
      if (complete) return refuse('This game is over. Reopen it from the scoresheet review to change it.');
      if (candidate.questionNumber !== phase.questionNumber) {
        return refuse(`That answer belongs to Tossup ${phase.questionNumber}.`);
      }

      const answered = teamsThatAnswered(events, candidate.questionNumber);
      if (answered.has(candidate.team)) {
        return refuse(`${game[candidate.team].name} has already answered this tossup.`);
      }
      if (events.some((event) => event.type === 'tossup-dead' && event.questionNumber === candidate.questionNumber)) {
        return refuse('This tossup has already gone dead.');
      }

      if (candidate.type === 'tossup-no-penalty') return allowed;

      const answerType = format.answerTypes[candidate.answerTypeIndex];
      if (!answerType) return refuse('That is not a ruling this tournament uses.');
      /*
       * A team answering second has heard the whole question, and a team that has heard the whole
       * question cannot be penalized for missing it — which is why the zero-point outcome exists at
       * all. This is not a rule about any one format: it is what "the question was read out" means
       * everywhere a neg is defined, and the second team's alternative is right here.
       */
      if (answerType.isNeg && answered.size > 0) {
        return refuse(`${game[candidate.team].name} heard the whole question, so this cannot be a neg.`);
      }
      return allowed;
    }

    case 'tossup-dead': {
      if (phase.kind === 'lineup') return refuse('Choose who is starting before scoring the first tossup.');
      if (phase.kind === 'score-check') return refuse('Confirm the score with the moderator before scoring again.');
      if (phase.kind === 'bonus') return refuse('Score the bonus before the next tossup.');
      if (complete) return refuse('This game is over. Reopen it from the scoresheet review to change it.');
      if (candidate.questionNumber !== phase.questionNumber) {
        return refuse(`That belongs to Tossup ${phase.questionNumber}.`);
      }
      if (events.some((event) => event.type === 'tossup-dead' && event.questionNumber === candidate.questionNumber)) {
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
      if (complete) return refuse('This game is over.');
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
      if (!format.regulation.timed) return refuse('This format ends regulation on a tossup count, not a clock.');
      if (game.regulationComplete) return refuse('Regulation has already ended.');
      if (complete) return refuse('This game is over.');
      return allowed;
    }

    case 'half-break': {
      if (game.awaitingScoreCheck) return refuse('The score check for this break is still open.');
      if (complete) return refuse('This game is over.');
      return allowed;
    }

    case 'half-resume': {
      if (!game.awaitingScoreCheck) return refuse('There is no break to come back from.');
      return allowed;
    }

    case 'timeout': {
      if (complete) return refuse('This game is over.');
      const permitted = procedure?.timeoutsPerTeam ?? 0;
      if (permitted <= 0) return refuse('This tournament does not track timeouts.');
      if (game.timeouts[candidate.team] >= permitted) {
        return refuse(
          `${game[candidate.team].name} has already used ${permitted === 1 ? 'its timeout' : 'all its timeouts'}.`,
        );
      }
      return allowed;
    }

    case 'end-game-early': {
      if (complete) return refuse('This game is already over.');
      if (candidate.reason.trim() === '') return refuse('Say why the game is ending early.');
      return allowed;
    }

    // #endregion
    // #region corrections and records

    case 'question-void': {
      if (candidate.reason.trim() === '') return refuse('Say what went wrong with the question.');
      if (complete) return refuse('This game is over.');
      const cycle = game.questions.find((question) => question.questionNumber === candidate.questionNumber);
      if (candidate.scope === 'bonus') {
        if (!cycle || (!cycle.bonus && !cycle.awaitingBonus)) return refuse('There is no bonus on that question.');
        return allowed;
      }
      if (!cycle) return refuse('Nothing has been recorded on that question yet.');
      return allowed;
    }

    case 'protest': {
      if (candidate.description.trim() === '') return refuse('Say what is being protested.');
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
): { ok: true; events: ScoreEvent[] } | { ok: false; reason: string } {
  let working = events;
  for (const candidate of added) {
    const verdict = canApplyScoreEvent(context, working, candidate);
    if (!verdict.ok) return verdict;
    working = working.concat(candidate);
  }
  return { ok: true, events: working };
}
