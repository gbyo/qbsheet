/**
 * The whole game, computed from the events that produced it.
 *
 * Nothing here is stored anywhere. Score, tossups heard, answer counts, bonuses heard, whose turn it
 * is, whether the game is over — all of it is recomputed from the event list every time. That is
 * what makes undo "drop the last event" and an edit to question 6 "replace one event", instead of
 * arithmetic somebody has to get right while a room waits.
 *
 * Pure and free of React and of YellowFruit's object graph on purpose: it runs in the room bundle,
 * and it is the thing worth testing exhaustively.
 *
 * # What decides the shape of a game
 *
 * Everything is read from `IScorekeeperFormat`, which is `ScoringRules` restated. There is no
 * mention of NAQT or ACF anywhere below, and no ten-point tossup: a format with 7-point tossups,
 * two negs, four-part bonuses and lightning rounds runs through exactly the same code as mACF.
 */
import { LeftOrRight } from '../../renderer/Utils/UtilTypes';
import { IScorekeeperAnswerType, IScorekeeperFormat } from '../../renderer/Services/ScorekeeperFormat';
import {
  bonusEventPoints,
  IBonusEvent,
  IRosterAddEvent,
  ISubstitutionEvent,
  otherTeam,
  ScoreEvent,
} from './ScoreEvents';

/** One team as the game began. */
export interface ITeamSetup {
  name: string;
  /** Everyone available, bench included. */
  players: string[];
  /** Who started. Defaults to as many of `players` as the format allows active at once. */
  startingLineup?: string[];
}

export interface IGameSetup {
  left: ITeamSetup;
  right: ITeamSetup;
}

/** What the interface should be asking for. Derived, never chosen by the scorekeeper. */
export type ScoringPhase =
  | { kind: 'tossup'; questionNumber: number; period: GamePeriod; eligibleTeams: LeftOrRight[] }
  | { kind: 'bonus'; questionNumber: number; period: GamePeriod; team: LeftOrRight }
  | { kind: 'complete'; reason: 'regulation' | 'overtime' | 'forfeit' };

export type GamePeriod = 'regulation' | 'overtime';

export interface IDerivedBuzz {
  team: LeftOrRight;
  playerName: string;
  answerType: IScorekeeperAnswerType;
}

export interface IDerivedQuestion {
  questionNumber: number;
  period: GamePeriod;
  buzzes: IDerivedBuzz[];
  /** Recorded as read with nobody converting it. */
  dead: boolean;
  /** Points from the bonus, as [controlling team, opponent on bouncebacks]. */
  bonus?: { team: LeftOrRight; controlledPoints: number; bouncebackPoints: number };
  /**
   * The tossup is over: converted, gone dead, or refused by both teams. A cycle can be resolved and
   * still be waiting on its bonus.
   */
  resolved: boolean;
  /** Still owes a bonus before the game can move on. */
  awaitingBonus: boolean;
  /** The lineup that heard this tossup, frozen at its effective personnel boundary. */
  activePlayers: Record<LeftOrRight, string[]>;
}

export interface IDerivedPlayer {
  name: string;
  tossupsHeard: number;
  /** Buzzes by answer-type index. Absent keys mean none. */
  answerCounts: Map<number, number>;
  points: number;
}

export interface IDerivedTeam {
  name: string;
  /** Everything: tossups, bonuses, bouncebacks received, lightning, adjustments. */
  points: number;
  tossupPoints: number;
  bonusPoints: number;
  bonusBouncebackPoints: number;
  lightningPoints: number;
  adjustmentPoints: number;
  /** Tossups this team converted and therefore heard a bonus on, per `MatchTeam.getBonusesHeard`. */
  bonusesHeard: number;
  players: IDerivedPlayer[];
  activePlayers: string[];
  forfeited: boolean;
  /** Overtime buzz counts by answer-type index, which is all the Match model keeps. */
  overtimeBuzzes: Map<number, number>;
}

export interface IDerivedGame {
  left: IDerivedTeam;
  right: IDerivedTeam;
  questions: IDerivedQuestion[];
  phase: ScoringPhase;
  /** Cycles that were actually read, including overtime. Becomes `Match.tossupsRead`. */
  tossupsRead: number;
  overtimeTossupsRead: number;
  /** True once regulation is behind us, whether or not overtime has been played. */
  regulationComplete: boolean;
  notes: { questionNumber: number; text: string; flagged: boolean }[];
  /** Engine-level personnel invariants that must be corrected before submission. */
  personnelProblems: { eventId: string; questionNumber: number; message: string }[];
}

function emptyPlayer(name: string): IDerivedPlayer {
  return { name, tossupsHeard: 0, answerCounts: new Map(), points: 0 };
}

/** Who starts, honouring the format's cap when a caller didn't say. */
function startingLineup(team: ITeamSetup, maximumActive: number): string[] {
  if (team.startingLineup) return team.startingLineup.slice();
  return team.players.slice(0, maximumActive);
}

/**
 * Does converting this tossup earn a bonus?
 *
 * Three things have to hold, and the last is the one that is easy to forget: a format can use
 * bonuses in regulation and not in overtime, which is what `overtimeIncludesBonuses` is for.
 */
function bonusFollows(format: IScorekeeperFormat, answerType: IScorekeeperAnswerType, period: GamePeriod): boolean {
  if (!format.bonus.enabled) return false;
  if (!answerType.awardsBonus) return false;
  if (period === 'overtime' && !format.overtime.includesBonuses) return false;
  return true;
}

/**
 * Which period a cycle belongs to.
 *
 * Regulation is the first `tossupCount` cycles for an untimed format. A timed one runs until the
 * moderator calls time, so the boundary is wherever the `end-regulation` event says it is — there is
 * no duration in the model to compute it from.
 */
function periodBoundary(format: IScorekeeperFormat, events: ScoreEvent[]): number {
  const called = events.find((event) => event.type === 'end-regulation');
  if (called) return called.questionNumber;
  if (format.regulation.timed) return Number.POSITIVE_INFINITY;
  return format.regulation.tossupCount;
}

/**
 * Is the game decided, given the score after a whole number of periods?
 *
 * Overtime is played in periods of `minimumOvertimeQuestionCount`, and the score is only examined at
 * the end of one — which is what makes a one-tossup period sudden death without needing a separate
 * flag for it. This mirrors how MODAQ's `playableCycles` walks forward looking for the first
 * checkpoint where the game isn't tied.
 */
function overtimeCheckpointReached(format: IScorekeeperFormat, overtimeCyclesPlayed: number): boolean {
  const period = Math.max(1, format.overtime.minimumQuestionCount);
  return overtimeCyclesPlayed > 0 && overtimeCyclesPlayed % period === 0;
}

/**
 * Rebuild a game from its events.
 *
 * @param format the tournament's rules, restated
 * @param setup who is playing
 * @param events everything the scorekeeper recorded, in the order they recorded it
 */
export default function deriveGame(format: IScorekeeperFormat, setup: IGameSetup, events: ScoreEvent[]): IDerivedGame {
  const { answerTypes } = format;
  const byIndex = (index: number): IScorekeeperAnswerType | undefined => answerTypes[index];

  const teams: Record<LeftOrRight, IDerivedTeam> = {
    left: {
      name: setup.left.name,
      points: 0,
      tossupPoints: 0,
      bonusPoints: 0,
      bonusBouncebackPoints: 0,
      lightningPoints: 0,
      adjustmentPoints: 0,
      bonusesHeard: 0,
      players: setup.left.players.map(emptyPlayer),
      activePlayers: startingLineup(setup.left, format.players.maximumActive),
      forfeited: false,
      overtimeBuzzes: new Map(),
    },
    right: {
      name: setup.right.name,
      points: 0,
      tossupPoints: 0,
      bonusPoints: 0,
      bonusBouncebackPoints: 0,
      lightningPoints: 0,
      adjustmentPoints: 0,
      bonusesHeard: 0,
      players: setup.right.players.map(emptyPlayer),
      activePlayers: startingLineup(setup.right, format.players.maximumActive),
      forfeited: false,
      overtimeBuzzes: new Map(),
    },
  };

  /** A player who buzzes without being on the roster is still a player; don't lose their points. */
  const playerRecord = (side: LeftOrRight, name: string): IDerivedPlayer => {
    const existing = teams[side].players.find((player) => player.name === name);
    if (existing) return existing;
    const created = emptyPlayer(name);
    teams[side].players.push(created);
    return created;
  };

  const notes: IDerivedGame['notes'] = [];
  const personnelProblems: IDerivedGame['personnelProblems'] = [];
  const lightningByTeam = new Map<LeftOrRight, number>();

  // Only scoring activity creates a tossup cycle. Personnel events can point at the next boundary,
  // but that must not make a future unresolved question appear on the scoresheet.
  const cycleNumbers = new Set<number>();
  const eventsByCycle = new Map<number, ScoreEvent[]>();
  // A type predicate rather than a bare boolean, so the branches below narrow to the two events
  // this actually holds instead of the whole union.
  const personnelEvents = events
    .filter(
      (event): event is ISubstitutionEvent | IRosterAddEvent =>
        event.type === 'substitution' || event.type === 'roster-add',
    )
    .sort((left, right) => left.questionNumber - right.questionNumber || events.indexOf(left) - events.indexOf(right));
  // A roster addition makes the player available locally immediately. Its question number is only
  // the earliest lineup boundary at which that player may become active.
  for (const event of personnelEvents) {
    if (event.type === 'roster-add') playerRecord(event.team, event.playerName);
  }
  for (const event of events) {
    if (event.type === 'note') {
      notes.push({ questionNumber: event.questionNumber, text: event.text, flagged: event.flagged === true });
      continue;
    }
    if (event.type === 'lightning') {
      // Last one wins: YellowFruit keeps a single lightning total per team, so a second entry is a
      // correction of the first rather than something to add to it.
      lightningByTeam.set(event.team, event.points);
      continue;
    }
    if (event.type === 'forfeit') {
      for (const side of event.teams) teams[side].forfeited = true;
      continue;
    }
    if (event.type === 'adjustment') {
      teams[event.team].adjustmentPoints += event.points;
      continue;
    }
    if (event.type === 'end-regulation' || event.type === 'substitution' || event.type === 'roster-add') continue;

    cycleNumbers.add(event.questionNumber);
    const list = eventsByCycle.get(event.questionNumber) ?? [];
    list.push(event);
    eventsByCycle.set(event.questionNumber, list);
  }

  const boundary = periodBoundary(format, events);
  const orderedCycles = Array.from(cycleNumbers).sort((a, b) => a - b);

  const questions: IDerivedQuestion[] = [];
  let overtimeCyclesPlayed = 0;
  const appliedPersonnel = new Set<string>();

  const applyPersonnelThrough = (questionNumber: number) => {
    for (const event of personnelEvents) {
      if (appliedPersonnel.has(event.id) || event.questionNumber > questionNumber) continue;
      appliedPersonnel.add(event.id);
      if (event.type === 'substitution') {
        teams[event.team].activePlayers = event.activePlayers.slice();
        for (const name of event.activePlayers) playerRecord(event.team, name);
      }
    }
  };

  for (const questionNumber of orderedCycles) {
    const cycleEvents = eventsByCycle.get(questionNumber) ?? [];
    const period: GamePeriod = questionNumber > boundary ? 'overtime' : 'regulation';

    applyPersonnelThrough(questionNumber);
    const activePlayers: Record<LeftOrRight, string[]> = {
      left: teams.left.activePlayers.slice(),
      right: teams.right.activePlayers.slice(),
    };

    const buzzes: IDerivedBuzz[] = [];
    for (const event of cycleEvents) {
      if (event.type !== 'tossup-buzz') continue;
      const answerType = byIndex(event.answerTypeIndex);
      // An event referencing an answer type the format no longer has is not something to guess at.
      if (!answerType) continue;
      if (!activePlayers[event.team].includes(event.playerName)) {
        personnelProblems.push({
          eventId: event.id,
          questionNumber,
          message: `${event.playerName} was not active for ${
            teams[event.team].name
          } on Tossup ${questionNumber}. Correct the lineup first.`,
        });
      }
      buzzes.push({ team: event.team, playerName: event.playerName, answerType });
    }

    const dead = cycleEvents.some((event) => event.type === 'tossup-dead');
    const converted = buzzes.find((buzz) => buzz.answerType.value > 0);
    // Both teams having had their say ends the tossup as surely as a conversion does: the model
    // allows one buzz per team per question, so there is nobody left to ask.
    const bothTeamsBuzzed = buzzes.some((b) => b.team === 'left') && buzzes.some((b) => b.team === 'right');
    const resolved = dead || !!converted || bothTeamsBuzzed;

    const bonusEvent = cycleEvents.find((event): event is IBonusEvent => event.type === 'bonus');
    const bonusExpected = !!converted && bonusFollows(format, converted.answerType, period);
    const awaitingBonus = bonusExpected && !bonusEvent;

    // Tossups heard. Every active player on both teams heard a tossup that was read, whoever got it.
    if (resolved) {
      for (const side of ['left', 'right'] as LeftOrRight[]) {
        for (const name of activePlayers[side]) playerRecord(side, name).tossupsHeard += 1;
      }
      if (period === 'overtime') overtimeCyclesPlayed += 1;
    }

    for (const buzz of buzzes) {
      const record = playerRecord(buzz.team, buzz.playerName);
      record.answerCounts.set(buzz.answerType.index, (record.answerCounts.get(buzz.answerType.index) ?? 0) + 1);
      record.points += buzz.answerType.value;
      teams[buzz.team].tossupPoints += buzz.answerType.value;
      if (period === 'overtime') {
        const counts = teams[buzz.team].overtimeBuzzes;
        counts.set(buzz.answerType.index, (counts.get(buzz.answerType.index) ?? 0) + 1);
      }
    }

    // Bonuses heard follows MatchTeam.getBonusesHeard: a team hears a bonus for each tossup it
    // converted, minus overtime ones when the format doesn't play bonuses there.
    if (bonusExpected && converted) teams[converted.team].bonusesHeard += 1;

    let bonus: IDerivedQuestion['bonus'];
    if (bonusEvent) {
      const [controlled, bounceback] = bonusEventPoints(bonusEvent);
      bonus = { team: bonusEvent.team, controlledPoints: controlled, bouncebackPoints: bounceback };
      teams[bonusEvent.team].bonusPoints += controlled;
      teams[otherTeam(bonusEvent.team)].bonusBouncebackPoints += bounceback;
    }

    questions.push({ questionNumber, period, buzzes, dead, bonus, resolved, awaitingBonus, activePlayers });
  }

  for (const [side, points] of lightningByTeam) teams[side].lightningPoints = points;

  for (const side of ['left', 'right'] as LeftOrRight[]) {
    const team = teams[side];
    team.points =
      team.tossupPoints + team.bonusPoints + team.bonusBouncebackPoints + team.lightningPoints + team.adjustmentPoints;
  }

  const heardCycles = questions.filter((question) => question.resolved);
  const tossupsRead = heardCycles.length;
  const overtimeTossupsRead = heardCycles.filter((question) => question.period === 'overtime').length;
  const regulationCyclesPlayed = heardCycles.filter((question) => question.period === 'regulation').length;

  const regulationComplete = format.regulation.timed
    ? events.some((event) => event.type === 'end-regulation')
    : regulationCyclesPlayed >= format.regulation.tossupCount;

  const phase = derivePhase({
    format,
    questions,
    teams,
    boundary,
    regulationComplete,
    overtimeCyclesPlayed,
  });

  // A lineup selected for the upcoming tossup should be visible immediately without inventing that
  // tossup. A bonus is still part of the current tossup, so personnel changes cannot apply until
  // the following boundary.
  let upcomingBoundary = (questions.at(-1)?.questionNumber ?? 0) + 1;
  if (phase.kind === 'tossup') upcomingBoundary = phase.questionNumber;
  else if (phase.kind === 'bonus') upcomingBoundary = phase.questionNumber + 1;
  applyPersonnelThrough(upcomingBoundary);

  return {
    left: teams.left,
    right: teams.right,
    questions,
    phase,
    tossupsRead,
    overtimeTossupsRead,
    regulationComplete,
    notes,
    personnelProblems,
  };
}

/**
 * The first tossup whose lineup may safely change right now.
 *
 * A displayed tossup with no scoring activity has not begun. Once either team has buzzed, or while
 * its bonus is being scored, that tossup's lineup is historical and the next boundary is used.
 */
export function lineupChangeEffectiveQuestion(game: IDerivedGame, events: ScoreEvent[]): number {
  if (game.phase.kind === 'bonus') return game.phase.questionNumber + 1;
  if (game.phase.kind === 'complete') return (game.questions.at(-1)?.questionNumber ?? 0) + 1;
  const { questionNumber } = game.phase;
  const begun = events.some(
    (event) =>
      event.questionNumber === questionNumber &&
      (event.type === 'tossup-buzz' || event.type === 'tossup-dead' || event.type === 'bonus'),
  );
  return begun ? questionNumber + 1 : questionNumber;
}

/**
 * What the scorekeeper should be looking at.
 *
 * Read in order, because the earlier cases win: a forfeit ends a game whatever else is recorded, an
 * unfinished cycle has to be finished before a decided game can be called decided, and a tie is only
 * a reason to keep playing once regulation is actually over.
 */
function derivePhase(input: {
  format: IScorekeeperFormat;
  questions: IDerivedQuestion[];
  teams: Record<LeftOrRight, IDerivedTeam>;
  boundary: number;
  regulationComplete: boolean;
  overtimeCyclesPlayed: number;
}): ScoringPhase {
  const { format, questions, teams, boundary, regulationComplete, overtimeCyclesPlayed } = input;

  if (teams.left.forfeited || teams.right.forfeited) return { kind: 'complete', reason: 'forfeit' };

  const lastCycle = questions.length > 0 ? questions[questions.length - 1] : undefined;

  // An unfinished cycle outranks everything below: a bonus still owed is still owed even if the
  // score already looks decided, and it may well be what decides it.
  if (lastCycle && lastCycle.awaitingBonus && lastCycle.bonus === undefined) {
    const controlling = lastCycle.buzzes.find((buzz) => buzz.answerType.value > 0);
    if (controlling) {
      return {
        kind: 'bonus',
        questionNumber: lastCycle.questionNumber,
        period: lastCycle.period,
        team: controlling.team,
      };
    }
  }
  if (lastCycle && !lastCycle.resolved) {
    const buzzed = new Set(lastCycle.buzzes.map((buzz) => buzz.team));
    return {
      kind: 'tossup',
      questionNumber: lastCycle.questionNumber,
      period: lastCycle.period,
      eligibleTeams: (['left', 'right'] as LeftOrRight[]).filter((side) => !buzzed.has(side)),
    };
  }

  const nextQuestion = (lastCycle?.questionNumber ?? 0) + 1;
  const tied = teams.left.points === teams.right.points;

  if (!regulationComplete) {
    return { kind: 'tossup', questionNumber: nextQuestion, period: 'regulation', eligibleTeams: ['left', 'right'] };
  }

  if (overtimeCyclesPlayed === 0) {
    if (!tied) return { kind: 'complete', reason: 'regulation' };
    return { kind: 'tossup', questionNumber: nextQuestion, period: 'overtime', eligibleTeams: ['left', 'right'] };
  }

  // Mid-period overtime always continues; the score is only consulted at a checkpoint.
  if (overtimeCheckpointReached(format, overtimeCyclesPlayed) && !tied) {
    return { kind: 'complete', reason: 'overtime' };
  }
  return {
    kind: 'tossup',
    questionNumber: nextQuestion,
    period: nextQuestion > boundary ? 'overtime' : 'regulation',
    eligibleTeams: ['left', 'right'],
  };
}
