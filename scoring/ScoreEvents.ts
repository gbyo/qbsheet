/**
 * What a scorekeeper did, in the order they did it.
 *
 * # Why events rather than totals
 *
 * YellowFruit's `Match` stores a game as aggregates: a team's `points`, each player's
 * `tossupsHeard` and per-answer-type counts, a lightning total, a bounceback total. Bonus points
 * aren't stored at all — `MatchTeam.getBonusPoints()` derives them as
 * `points − tossupPoints − bounceback − lightning`. That shape is right for a completed game being
 * carried around a stats package, and wrong for one being scored, because every one of those numbers
 * has to be kept consistent with every other by hand. Undo becomes "subtract the right amount from
 * four places", and an edit to question 6 becomes arithmetic the scorekeeper has to get right.
 *
 * So the room records what happened and derives the rest. Undo is dropping the last event. Editing
 * question 6 is replacing one event and recomputing. Nothing can drift, because there is only one
 * copy of the truth.
 *
 * # This is not a private format
 *
 * The QBJ match schema already has a per-question layer — `matchQuestions`, with `buzzes` carrying
 * team, player and answer type, and `bonus.parts` carrying `controlledPoints` and
 * `bouncebackPoints`. YellowFruit implements all of it in `MatchQuestion`, parses it in
 * `FileParsing`, and writes it back out in `Match.toFileObject`. These events are shaped to project
 * onto that, so what the room produces is something YellowFruit already reads rather than an
 * invention that needs its own importer.
 *
 * The one place this deliberately holds more than the `Match` model does is overtime: YellowFruit
 * records overtime buzzes as team-level answer-type counts with an explicit note that it doesn't
 * track which player made them. The room knows, so it records it, and drops the detail on the way
 * out rather than throwing it away on the way in.
 */
import { LeftOrRight } from '../../renderer/Utils/UtilTypes';

/**
 * One thing the scorekeeper recorded.
 *
 * Every event carries the cycle it belongs to rather than relying on its position in the list, so
 * that inserting a correction into an earlier question doesn't renumber everything after it.
 */
interface IScoreEventBase {
  /** Unique within a game. What undo and edit target. */
  id: string;
  /**
   * The tossup-bonus cycle, 1-based. The same number as `MatchQuestion.questionNumber`.
   *
   * Game-level events that aren't about a particular tossup — lightning, forfeits, adjustments —
   * carry the cycle that was current when they were recorded, purely so the activity log can show
   * them in the right place.
   */
  questionNumber: number;
}

/**
 * Somebody buzzed and it was ruled.
 *
 * At most one of these per team per cycle. That is not a simplification: `MatchQuestion.getPoints`
 * finds a team's buzz with `find`, so a second buzz by the same team on the same tossup has no
 * representation in the model YellowFruit and QBJ share.
 */
export interface ITossupBuzzEvent extends IScoreEventBase {
  type: 'tossup-buzz';
  team: LeftOrRight;
  /** Who buzzed. Names rather than ids, because that is what the room is given for a roster. */
  playerName: string;
  /** Position in the format's `answerTypes`. See the note on `IScorekeeperAnswerType.index`. */
  answerTypeIndex: number;
}

/** The tossup went dead: read, nobody converted it. */
export interface ITossupDeadEvent extends IScoreEventBase {
  type: 'tossup-dead';
}

/** One bonus part's outcome. Mirrors `MatchQuestionBonusPart`. */
export interface IBonusPartResult {
  controlledPoints: number;
  /** Only meaningful when the format bounces bonuses back. */
  bouncebackPoints?: number;
}

/**
 * The bonus that followed a converted tossup.
 *
 * Carries either per-part results or bare totals, exactly as `MatchQuestion` does — it has both a
 * `bonus` with parts and a flat `bonusPoints`, and `getBonusPoints()` prefers the parts and falls
 * back to the totals. A regular bonus has a known part count and can be collected part by part; an
 * irregular one cannot, and gets a total. Neither is a lossy version of the other.
 */
export interface IBonusEvent extends IScoreEventBase {
  type: 'bonus';
  /** The team that converted the tossup and therefore controls the bonus. */
  team: LeftOrRight;
  /** Per-part results, when the format made it possible to collect them. */
  parts?: IBonusPartResult[];
  /** Total earned by the controlling team, when parts weren't collected. */
  controlledPoints?: number;
  /** Total earned by the opponent on bouncebacks, when parts weren't collected. */
  bouncebackPoints?: number;
}

/**
 * A team's lightning/worksheet total.
 *
 * One number per team for the whole game, because that is all YellowFruit stores:
 * `MatchTeam.lightningPoints`, entered in the match editor as a single field stepped by the
 * configured divisor. Recording a later event for the same team replaces the earlier one rather than
 * adding to it, so a correction is just another entry.
 */
export interface ILightningEvent extends IScoreEventBase {
  type: 'lightning';
  team: LeftOrRight;
  points: number;
}

/**
 * The active roster changed.
 *
 * Absolute rather than a delta — the full list of who is now playing. A substitution expressed as
 * "Morgan for Alex" has to be replayed in order to be understood, and becomes ambiguous the moment
 * an earlier question is edited. A list of who is on the floor is true on its own.
 *
 * This is what makes tossups heard come out right: a player's TUH is the number of cycles that were
 * played while they were on this list.
 */
export interface ISubstitutionEvent extends IScoreEventBase {
  type: 'substitution';
  team: LeftOrRight;
  /** Everyone active from this cycle onwards. */
  activePlayers: string[];
}

/** A player added to the available roster in the room during this game. */
export interface IRosterAddEvent extends IScoreEventBase {
  type: 'roster-add';
  team: LeftOrRight;
  playerName: string;
}

/** The moderator called time. Only meaningful for a timed format. */
export interface IEndRegulationEvent extends IScoreEventBase {
  type: 'end-regulation';
}

/**
 * A manual correction to a team's score.
 *
 * A compatibility escape hatch, not part of ordinary scoring. It exists because a derived score is
 * only as good as the events behind it, and a room occasionally needs to match a number tournament
 * control has already accepted. Recorded explicitly so it shows up as what it is rather than
 * disappearing into a total.
 */
export interface IAdjustmentEvent extends IScoreEventBase {
  type: 'adjustment';
  team: LeftOrRight;
  points: number;
  reason?: string;
}

/** One or both teams forfeited. Both, for a double forfeit. */
export interface IForfeitEvent extends IScoreEventBase {
  type: 'forfeit';
  teams: LeftOrRight[];
}

/** A note on the game, or a question flagged for tournament control. */
export interface INoteEvent extends IScoreEventBase {
  type: 'note';
  text: string;
  /** Set when this is a protest or something else control needs to look at. */
  flagged?: boolean;
}

export type ScoreEvent =
  | ITossupBuzzEvent
  | ITossupDeadEvent
  | IBonusEvent
  | ILightningEvent
  | ISubstitutionEvent
  | IRosterAddEvent
  | IEndRegulationEvent
  | IAdjustmentEvent
  | IForfeitEvent
  | INoteEvent;

/**
 * What a bonus was worth, as [controlling team, opponent on bouncebacks].
 *
 * Prefers per-part results over the flat totals, which is what `MatchQuestion.getBonusPoints` does.
 */
export function bonusEventPoints(event: IBonusEvent): [number, number] {
  if (event.parts) {
    let controlled = 0;
    let bounceback = 0;
    for (const part of event.parts) {
      controlled += part.controlledPoints;
      bounceback += part.bouncebackPoints ?? 0;
    }
    return [controlled, bounceback];
  }
  return [event.controlledPoints ?? 0, event.bouncebackPoints ?? 0];
}

/** The other team. */
export function otherTeam(team: LeftOrRight): LeftOrRight {
  return team === 'left' ? 'right' : 'left';
}
