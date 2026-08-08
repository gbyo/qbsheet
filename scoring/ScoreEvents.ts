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

/**
 * A team used its tossup opportunity, scored nothing, and was not penalized.
 *
 * # Why this isn't an answer type
 *
 * NAQT's tossups have three configured values — 15, 10 and −5 — and a fourth outcome that has no
 * value at all: an incorrect answer given after the tossup has been read in full is worth zero, and
 * so is the second team's incorrect answer, because a team that has heard the whole question cannot
 * be penalized for missing it. That outcome is not `No buzz` — the team is out of the question
 * either way, but somebody did answer, and on a tied tossup that difference decides who may still
 * speak.
 *
 * Modelling it as a 0-point `AnswerType` would be worse than modelling it not at all: YellowFruit
 * counts a player's tossups per answer type, and a fabricated zero type would show up in every
 * player's P/TU/I line as a buzz they never got credit or blame for. So this is an event about the
 * *team's opportunity*, and it deliberately carries no answer type. `playerName` is recorded when
 * the scorekeeper knows it, for the scoresheet and for QBJ's question-level layer, and is never
 * counted in anyone's answer counts.
 *
 * Generic, not NAQT-specific: any zero-point procedural outcome that consumes a team's chance at a
 * tossup — an answer ruled inadmissible, a team that answers out of turn — is this.
 */
export interface ITossupNoPenaltyEvent extends IScoreEventBase {
  type: 'tossup-no-penalty';
  team: LeftOrRight;
  /** Who answered, when it is known. Never part of any statistic. */
  playerName?: string;
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

/**
 * The moderator called time. Only meaningful for a timed format.
 *
 * # Why the boundary is its own field
 *
 * The obvious thing to do is treat the question on screen when time was called as the first overtime
 * question. That is wrong by one whenever it matters: question 18 finishes, question 19 appears, and
 * the horn goes before anybody starts reading it. Recording 19 makes 19 a regulation question, so
 * the first tossup actually played in a tied game's overtime gets classified as regulation and the
 * game can be declared over on a score that came from an overtime buzz.
 *
 * `lastRegulationQuestion` is therefore the last tossup that was *played* in regulation, not the one
 * being displayed. Everything after it is overtime. `questionNumber` keeps its usual meaning for a
 * game-level event — where in the log it happened — and is only used as a fallback for events
 * recorded before this field existed.
 */
export interface IEndRegulationEvent extends IScoreEventBase {
  type: 'end-regulation';
  /** The last tossup that counts as regulation. Anything numbered above it is overtime. */
  lastRegulationQuestion?: number;
}

/**
 * The end of a half.
 *
 * Operational, not statistical. YellowFruit's `Match` has no concept of a half and gains none here:
 * this exists so a room playing timed halves has somewhere to stop, check the score against the
 * moderator, and substitute — which is what NAQT's rules provide for and what a paper scoresheet
 * has a line for. Nothing about scoring changes across it.
 */
export interface IHalfBreakEvent extends IScoreEventBase {
  type: 'half-break';
  /** The last tossup played in the half that just ended. */
  lastQuestion: number;
}

/** The score check at a half break was completed and play resumes. */
export interface IHalfResumeEvent extends IScoreEventBase {
  type: 'half-resume';
}

/** The scorekeeper explicitly opened the initial overtime period at the regulation tie checkpoint. */
export interface IBeginOvertimeEvent extends IScoreEventBase {
  type: 'begin-overtime';
}

/** The configured initial overtime period ended tied and sudden death was explicitly opened. */
export interface IBeginSuddenDeathEvent extends IScoreEventBase {
  type: 'begin-sudden-death';
}

/**
 * A team took a timeout.
 *
 * Tracked because NAQT-style scoresheets track it — one 30-second timeout per team, and a room that
 * has lost count of them cannot answer the question a coach is about to ask. How many a team gets is
 * a procedure setting, not a scoring rule, so nothing here knows the number.
 */
export interface ITimeoutEvent extends IScoreEventBase {
  type: 'timeout';
  team: LeftOrRight;
}

/** A timeout has started and play is paused until a matching resume event. */
export interface ITimeoutStartEvent extends IScoreEventBase {
  type: 'timeout-start';
  team: LeftOrRight;
  /** Wall-clock time used only for the optional procedural countdown. */
  startedAt?: number;
}

/** The active timeout ended and normal play may resume. */
export interface ITimeoutResumeEvent extends IScoreEventBase {
  type: 'timeout-resume';
}

/** What a protest is about. Broad on purpose: the detail is in the description. */
export type ProtestSubject = 'tossup-answer' | 'bonus-answer' | 'question' | 'procedure' | 'other';

/** Where a protest has got to. A game can be submitted with one still `open`. */
export type ProtestStatus = 'open' | 'upheld' | 'declined' | 'withdrawn';

/**
 * A protest, as a thing with a state rather than a note that happens to be flagged.
 *
 * A flagged note tells tournament control that something happened. It does not say what was
 * protested, by whom, or whether anybody has decided it — and those are exactly what control needs
 * to route the thing and what a room needs in order to know whether it is still outstanding. The
 * scorekeeper records it and keeps playing; resolving it is control's job, and an upheld one goes
 * back into the question editor so the event history is recalculated rather than patched.
 */
export interface IProtestEvent extends IScoreEventBase {
  type: 'protest';
  /** Who is protesting. */
  team: LeftOrRight;
  subject: ProtestSubject;
  description: string;
  status: ProtestStatus;
  /** What was decided, once somebody decided it. */
  resolution?: string;
}

/**
 * A question was spoiled and is being replaced.
 *
 * QBJ and YellowFruit both recognize replacement, backup and tiebreaker question roles, and a
 * moderator who reads question 12 out of the wrong packet needs a way to say so that does not
 * involve a scorekeeper deleting four events by hand and hoping the tossups-heard count survives.
 *
 * Everything recorded for this cycle *before* this event is discarded; everything after it belongs
 * to the replacement. A `bonus` scope leaves the tossup and its conversion alone, because a spoiled
 * bonus does not un-answer the tossup that earned it.
 */
export interface IQuestionVoidEvent extends IScoreEventBase {
  type: 'question-void';
  scope: 'tossup' | 'bonus';
  reason: string;
}

/**
 * The game was deliberately stopped short of its regulation length.
 *
 * YellowFruit treats a game with fewer tossups than standard as a warning rather than an error, and
 * real rounds get shortened: a director calls a round early, a packet runs out, a tiebreaker is
 * played to whatever length it needs. Without this the room has no honest way to end an untimed
 * game, and the alternative — inventing dead tossups until the count is reached — puts questions on
 * the scoresheet that nobody read.
 */
export interface IEndGameEarlyEvent extends IScoreEventBase {
  type: 'end-game-early';
  reason: string;
  /** Tossups actually played, as the scorekeeper confirmed them. Derived too; recorded for the audit. */
  tossupsRead: number;
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
  | ITossupNoPenaltyEvent
  | ITossupDeadEvent
  | IBonusEvent
  | ILightningEvent
  | ISubstitutionEvent
  | IRosterAddEvent
  | IEndRegulationEvent
  | IHalfBreakEvent
  | IHalfResumeEvent
  | IBeginOvertimeEvent
  | IBeginSuddenDeathEvent
  | ITimeoutEvent
  | ITimeoutStartEvent
  | ITimeoutResumeEvent
  | IProtestEvent
  | IQuestionVoidEvent
  | IEndGameEarlyEvent
  | IAdjustmentEvent
  | IForfeitEvent
  | INoteEvent;

/** Events that belong to a tossup cycle rather than to the game as a whole. */
export type CycleScoreEvent = ITossupBuzzEvent | ITossupNoPenaltyEvent | ITossupDeadEvent | IBonusEvent;

/** Did this event use up a team's chance at the tossup it belongs to? */
export function usesTossupOpportunity(event: ScoreEvent): event is ITossupBuzzEvent | ITossupNoPenaltyEvent {
  return event.type === 'tossup-buzz' || event.type === 'tossup-no-penalty';
}

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
      // Recovery and correction inputs are validated before export, but derivation is also used as
      // the backstop for data that arrived from an older or hand-edited file. Ignore a malformed
      // part here so validation can report it instead of crashing the room.
      if (typeof part !== 'object' || part === null) continue;
      if (typeof part.controlledPoints === 'number' && Number.isFinite(part.controlledPoints))
        controlled += part.controlledPoints;
      if (typeof part.bouncebackPoints === 'number' && Number.isFinite(part.bouncebackPoints))
        bounceback += part.bouncebackPoints;
    }
    return [controlled, bounceback];
  }
  return [event.controlledPoints ?? 0, event.bouncebackPoints ?? 0];
}

/** The other team. */
export function otherTeam(team: LeftOrRight): LeftOrRight {
  return team === 'left' ? 'right' : 'left';
}
