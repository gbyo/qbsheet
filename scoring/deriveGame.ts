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
  IBonusPartResult,
  IEndRegulationEvent,
  IRosterAddEvent,
  ISubstitutionEvent,
  otherTeam,
  ProtestStatus,
  ProtestSubject,
  ScoreEvent,
  usesTossupOpportunity,
} from './ScoreEvents';

/** One team as the game began. */
export interface ITeamSetup {
  name: string;
  /** Everyone available, bench included. */
  players: string[];
  /**
   * Who started.
   *
   * Absent means nobody has said, which is only safe when the roster is no larger than the format
   * allows active at once — then the whole roster starts and there is nothing to choose. A bigger
   * roster with no lineup is a question the room has to answer before the first tossup; see
   * `teamsNeedingStartingLineup`.
   */
  startingLineup?: string[];
}

export interface IGameSetup {
  left: ITeamSetup;
  right: ITeamSetup;
}

/** What the interface should be asking for. Derived, never chosen by the scorekeeper. */
export type ScoringPhase =
  | { kind: 'lineup'; teams: LeftOrRight[] }
  | { kind: 'tossup'; questionNumber: number; period: GamePeriod; eligibleTeams: LeftOrRight[] }
  | { kind: 'bonus'; questionNumber: number; period: GamePeriod; team: LeftOrRight }
  | { kind: 'score-check'; afterQuestion: number }
  | { kind: 'complete'; reason: 'regulation' | 'overtime' | 'forfeit' | 'short' };

export type GamePeriod = 'regulation' | 'overtime';

export interface IDerivedBuzz {
  team: LeftOrRight;
  playerName: string;
  answerType: IScorekeeperAnswerType;
}

/** A team that answered and got nothing, without being penalized. Carries no statistic. */
export interface IDerivedNoPenalty {
  team: LeftOrRight;
  playerName?: string;
}

export interface IDerivedQuestion {
  questionNumber: number;
  period: GamePeriod;
  buzzes: IDerivedBuzz[];
  /** Teams that used their chance at this tossup for nothing, per `ITossupNoPenaltyEvent`. */
  noPenalty: IDerivedNoPenalty[];
  /** Recorded as read with nobody converting it. */
  dead: boolean;
  /**
   * Points from the bonus, as [controlling team, opponent on bouncebacks].
   *
   * `parts` is present only when the scorekeeper actually collected the bonus part by part, which
   * the fast path deliberately does not. A total is not a lossy version of parts and parts are not
   * an enriched version of a total; they are two different things the scorer was told.
   */
  bonus?: {
    team: LeftOrRight;
    controlledPoints: number;
    bouncebackPoints: number;
    parts?: IBonusPartResult[];
  };
  /**
   * The tossup is over: converted, gone dead, or refused by both teams. A cycle can be resolved and
   * still be waiting on its bonus.
   */
  resolved: boolean;
  /** Still owes a bonus before the game can move on. */
  awaitingBonus: boolean;
  /** The lineup that heard this tossup, frozen at its effective personnel boundary. */
  activePlayers: Record<LeftOrRight, string[]>;
  /** The score as it stood once this cycle was complete. What the rail shows after each question. */
  scoreAfter: Record<LeftOrRight, number>;
  /** Protests recorded against this question and not yet resolved. */
  openProtests: number;
  /** This cycle is a replacement for one that was voided. */
  replaced: boolean;
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

/** A protest as the room and tournament control both need to see it. */
export interface IDerivedProtest {
  eventId: string;
  questionNumber: number;
  team: LeftOrRight;
  teamName: string;
  subject: ProtestSubject;
  description: string;
  status: ProtestStatus;
  resolution?: string;
}

/** A question that was thrown out and replaced. */
export interface IDerivedVoid {
  eventId: string;
  questionNumber: number;
  scope: 'tossup' | 'bonus';
  reason: string;
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
  /**
   * The last tossup that counted as regulation, once that is settled.
   *
   * Infinite for a timed game whose clock has not been stopped, because there is no way to know yet.
   */
  regulationBoundary: number;
  notes: { questionNumber: number; text: string; flagged: boolean }[];
  /** Engine-level personnel invariants that must be corrected before submission. */
  personnelProblems: { eventId: string; questionNumber: number; message: string }[];
  /**
   * Events the model cannot represent, kept out of the totals and reported rather than applied.
   *
   * The guard in front of the UI is what stops these being recorded in the first place. This is the
   * backstop for an event list that arrived some other way — a recovery file, a corrected question,
   * a build of the room from before the guard existed.
   */
  integrityProblems: { eventId: string; questionNumber: number; message: string }[];
  /** Timeouts each team has taken. */
  timeouts: Record<LeftOrRight, number>;
  protests: IDerivedProtest[];
  voids: IDerivedVoid[];
  /** Half breaks, in order, by the last question of the half each one ended. */
  halfBreaks: number[];
  /** A break is on and the score has not been agreed yet. */
  awaitingScoreCheck: boolean;
  /** Set when the scorekeeper deliberately stopped the game short. */
  endedEarly?: { reason: string; tossupsRead: number };
  /** Sides that still have to name a starting lineup before anything can be scored. */
  needsStartingLineup: LeftOrRight[];
}

function emptyPlayer(name: string): IDerivedPlayer {
  return { name, tossupsHeard: 0, answerCounts: new Map(), points: 0 };
}

/**
 * Who starts.
 *
 * When the roster fits inside the format's cap there is nothing to decide and everyone plays. When
 * it doesn't, this still returns the first few — the screen has to show something — but the game is
 * simultaneously reported as needing a lineup, and the guard refuses to score until one is given.
 * Quietly starting the first four names in registration order is how a player ends up with a game's
 * worth of tossups heard that they spent on the bench.
 */
function startingLineup(team: ITeamSetup, maximumActive: number): string[] {
  if (team.startingLineup) return team.startingLineup.slice(0, maximumActive);
  return team.players.slice(0, maximumActive);
}

/**
 * Sides whose starting lineup is a guess rather than a decision.
 *
 * A roster no bigger than the cap is not a guess. Neither is one the caller supplied a lineup for,
 * nor one where the scorekeeper has already set a lineup for the first tossup.
 */
export function teamsNeedingStartingLineup(
  format: IScorekeeperFormat,
  setup: IGameSetup,
  events: ScoreEvent[],
): LeftOrRight[] {
  return (['left', 'right'] as LeftOrRight[]).filter((side) => {
    const team = setup[side];
    if (team.startingLineup && team.startingLineup.length > 0) return false;
    if (team.players.length <= format.players.maximumActive) return false;
    return !events.some((event) => event.type === 'substitution' && event.team === side && event.questionNumber <= 1);
  });
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
 * moderator calls time, so the boundary is whatever the `end-regulation` event names as the last
 * regulation question — there is no duration in the model to compute it from.
 *
 * `lastRegulationQuestion` is the authority; `questionNumber` is only consulted for events recorded
 * before that field existed, and reproduces the old off-by-one for them rather than silently moving
 * a boundary somebody already played through.
 */
function periodBoundary(format: IScorekeeperFormat, events: ScoreEvent[]): number {
  const called = events.find((event): event is IEndRegulationEvent => event.type === 'end-regulation');
  if (called) return called.lastRegulationQuestion ?? called.questionNumber;
  if (format.regulation.timed) return Number.POSITIVE_INFINITY;
  return format.regulation.tossupCount;
}

/**
 * May the game end here, given the score after this many overtime tossups?
 *
 * `minimumOvertimeQuestionCount` is a minimum, not a period length. YellowFruit's own settings call
 * it that, and NAQT — which sets it to 3 — plays all three tossups and then goes to sudden death;
 * it does not play a second block of three. Treating the field as a repeating period is the same
 * mistake as reading "at least three" as "in multiples of three", and it costs a real game: a team
 * that leads after four overtime tossups would be made to play two more.
 *
 * So: below the minimum, keep playing whatever the score. At or above it, a lead ends the game, and
 * every further tossup is therefore sudden death. A minimum of one is sudden death from the start,
 * which is exactly what a one-tossup minimum means and needs no separate flag.
 */
function overtimeCheckpointReached(format: IScorekeeperFormat, overtimeCyclesPlayed: number): boolean {
  return overtimeCyclesPlayed >= Math.max(1, format.overtime.minimumQuestionCount);
}

/**
 * Is the next overtime tossup sudden death — decided the moment it is scored?
 *
 * True once the minimum has been played out, which is what the room should be telling a scorekeeper
 * so they know the round is about to end.
 */
export function overtimeIsSuddenDeath(format: IScorekeeperFormat, overtimeCyclesPlayed: number): boolean {
  return overtimeCyclesPlayed + 1 >= Math.max(1, format.overtime.minimumQuestionCount);
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
  const integrityProblems: IDerivedGame['integrityProblems'] = [];
  const protests: IDerivedProtest[] = [];
  const voids: IDerivedVoid[] = [];
  const halfBreaks: number[] = [];
  const timeouts: Record<LeftOrRight, number> = { left: 0, right: 0 };
  const lightningByTeam = new Map<LeftOrRight, number>();
  /** Lightning and adjustments by the cycle they were recorded at, for the running score. */
  const lightningAt: { questionNumber: number; team: LeftOrRight; points: number }[] = [];
  const adjustmentAt: { questionNumber: number; team: LeftOrRight; points: number }[] = [];
  const replacedCycles = new Set<number>();
  let awaitingScoreCheck = false;
  let endedEarly: IDerivedGame['endedEarly'];

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
      lightningAt.push({ questionNumber: event.questionNumber, team: event.team, points: event.points });
      continue;
    }
    if (event.type === 'forfeit') {
      for (const side of event.teams) teams[side].forfeited = true;
      continue;
    }
    if (event.type === 'adjustment') {
      teams[event.team].adjustmentPoints += event.points;
      adjustmentAt.push({ questionNumber: event.questionNumber, team: event.team, points: event.points });
      continue;
    }
    if (event.type === 'timeout') {
      timeouts[event.team] += 1;
      continue;
    }
    if (event.type === 'protest') {
      protests.push({
        eventId: event.id,
        questionNumber: event.questionNumber,
        team: event.team,
        teamName: teams[event.team].name,
        subject: event.subject,
        description: event.description,
        status: event.status,
        resolution: event.resolution,
      });
      continue;
    }
    if (event.type === 'half-break') {
      halfBreaks.push(event.lastQuestion);
      awaitingScoreCheck = true;
      continue;
    }
    if (event.type === 'half-resume') {
      awaitingScoreCheck = false;
      continue;
    }
    if (event.type === 'end-game-early') {
      endedEarly = { reason: event.reason, tossupsRead: event.tossupsRead };
      continue;
    }
    if (event.type === 'question-void') {
      // Everything recorded for this cycle before the void is gone; everything after it belongs to
      // the replacement. Order matters, which is why this happens here rather than in a filter.
      voids.push({
        eventId: event.id,
        questionNumber: event.questionNumber,
        scope: event.scope,
        reason: event.reason,
      });
      replacedCycles.add(event.questionNumber);
      const existing = eventsByCycle.get(event.questionNumber) ?? [];
      const kept = event.scope === 'bonus' ? existing.filter((earlier) => earlier.type !== 'bonus') : [];
      eventsByCycle.set(event.questionNumber, kept);
      // A wholly voided cycle stops existing until something is scored on the replacement, so it
      // neither appears on the scoresheet nor charges anybody a second tossup heard.
      if (kept.length === 0) cycleNumbers.delete(event.questionNumber);
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
  /** Cycle-derived points so far, so each question can carry the score as it stood after it. */
  const running: Record<LeftOrRight, number> = { left: 0, right: 0 };

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
    const noPenalty: IDerivedNoPenalty[] = [];
    /**
     * Which sides have already spent their chance at this tossup.
     *
     * `MatchQuestion.getPoints` finds a team's buzz with `find`, so a second one has nowhere to go
     * in the model YellowFruit and QBJ share. Adding its points anyway — which is what a naive walk
     * over the events does — produces a score no importer can reproduce. The guard in front of the
     * UI stops it being recorded; this is what stops it counting if it gets in another way.
     */
    const spent = new Set<LeftOrRight>();
    for (const event of cycleEvents) {
      if (!usesTossupOpportunity(event)) continue;
      if (spent.has(event.team)) {
        integrityProblems.push({
          eventId: event.id,
          questionNumber,
          message: `${
            teams[event.team].name
          } has two answers recorded on Tossup ${questionNumber}. Only the first counts; remove the other.`,
        });
        continue;
      }
      spent.add(event.team);

      if (event.type === 'tossup-no-penalty') {
        noPenalty.push({ team: event.team, playerName: event.playerName });
        continue;
      }
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
    // allows one answer per team per question, so there is nobody left to ask. A zero-point wrong
    // answer spends a team's chance exactly as a buzz does, which is the whole reason it exists.
    const resolved = dead || !!converted || spent.size === 2;

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
      running[buzz.team] += buzz.answerType.value;
      if (period === 'overtime') {
        const counts = teams[buzz.team].overtimeBuzzes;
        counts.set(buzz.answerType.index, (counts.get(buzz.answerType.index) ?? 0) + 1);
      }
    }

    // A zero-point wrong answer is not a buzz in anybody's statistics. The player is named on the
    // scoresheet and nowhere else, which is the point of the event.
    for (const missed of noPenalty) {
      if (missed.playerName) playerRecord(missed.team, missed.playerName);
    }

    // Bonuses heard follows MatchTeam.getBonusesHeard: a team hears a bonus for each tossup it
    // converted, minus overtime ones when the format doesn't play bonuses there.
    if (bonusExpected && converted) teams[converted.team].bonusesHeard += 1;

    let bonus: IDerivedQuestion['bonus'];
    if (bonusEvent) {
      const [controlled, bounceback] = bonusEventPoints(bonusEvent);
      bonus = {
        team: bonusEvent.team,
        controlledPoints: controlled,
        bouncebackPoints: bounceback,
        parts: bonusEvent.parts?.map((part) => ({ ...part })),
      };
      teams[bonusEvent.team].bonusPoints += controlled;
      teams[otherTeam(bonusEvent.team)].bonusBouncebackPoints += bounceback;
      running[bonusEvent.team] += controlled;
      running[otherTeam(bonusEvent.team)] += bounceback;
    }

    // The score as it stood after this question, which is what the rail shows. Lightning and manual
    // adjustments are folded in at the cycle they were recorded against so the column always agrees
    // with the header once everything is in.
    const scoreAfter: Record<LeftOrRight, number> = { left: running.left, right: running.right };
    for (const entry of adjustmentAt) {
      if (entry.questionNumber <= questionNumber) scoreAfter[entry.team] += entry.points;
    }
    for (const side of ['left', 'right'] as LeftOrRight[]) {
      const applicable = lightningAt.filter((entry) => entry.team === side && entry.questionNumber <= questionNumber);
      if (applicable.length > 0) scoreAfter[side] += applicable[applicable.length - 1].points;
    }

    questions.push({
      questionNumber,
      period,
      buzzes,
      noPenalty,
      dead,
      bonus,
      resolved,
      awaitingBonus,
      activePlayers,
      scoreAfter,
      openProtests: protests.filter((protest) => protest.questionNumber === questionNumber && protest.status === 'open')
        .length,
      replaced: replacedCycles.has(questionNumber),
    });
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

  const needsStartingLineup = teamsNeedingStartingLineup(format, setup, events);

  const phase = derivePhase({
    format,
    questions,
    teams,
    boundary,
    regulationComplete,
    overtimeCyclesPlayed,
    awaitingScoreCheck,
    halfBreaks,
    endedEarly,
    needsStartingLineup,
  });

  // A lineup selected for the upcoming tossup should be visible immediately without inventing that
  // tossup. A bonus is still part of the current tossup, so personnel changes cannot apply until
  // the following boundary.
  let upcomingBoundary = (questions.at(-1)?.questionNumber ?? 0) + 1;
  if (phase.kind === 'tossup') {
    const begun = events.some(
      (event) =>
        event.questionNumber === phase.questionNumber &&
        (event.type === 'tossup-buzz' ||
          event.type === 'tossup-no-penalty' ||
          event.type === 'tossup-dead' ||
          event.type === 'bonus'),
    );
    upcomingBoundary = begun ? phase.questionNumber + 1 : phase.questionNumber;
  } else if (phase.kind === 'bonus') upcomingBoundary = phase.questionNumber + 1;
  applyPersonnelThrough(upcomingBoundary);

  return {
    left: teams.left,
    right: teams.right,
    questions,
    phase,
    tossupsRead,
    overtimeTossupsRead,
    regulationComplete,
    regulationBoundary: boundary,
    notes,
    personnelProblems,
    integrityProblems,
    timeouts,
    protests,
    voids,
    halfBreaks,
    awaitingScoreCheck,
    endedEarly,
    needsStartingLineup,
  };
}

/**
 * The last tossup that has actually been played.
 *
 * What "end regulation" and "end of half" both need, and the number the question currently on screen
 * is not: a displayed tossup with nothing recorded against it has not been read. A cycle that has
 * been started counts, because a tossup in progress when the horn goes is finished and belongs to
 * the period it began in.
 */
export function lastPlayedQuestion(game: IDerivedGame): number {
  return game.questions.at(-1)?.questionNumber ?? 0;
}

/**
 * The first tossup whose lineup may safely change right now.
 *
 * A displayed tossup with no scoring activity has not begun. Once either team has buzzed, or while
 * its bonus is being scored, that tossup's lineup is historical and the next boundary is used.
 */
export function lineupChangeEffectiveQuestion(game: IDerivedGame, events: ScoreEvent[]): number {
  if (game.phase.kind === 'bonus') return game.phase.questionNumber + 1;
  if (game.phase.kind === 'lineup') return 1;
  // A break is the safest boundary there is: nothing is part-scored, and it is exactly where the
  // rules that bother to say expect substitutions to happen.
  if (game.phase.kind === 'score-check' || game.phase.kind === 'complete') {
    return (game.questions.at(-1)?.questionNumber ?? 0) + 1;
  }
  const { questionNumber } = game.phase;
  const begun = events.some(
    (event) =>
      event.questionNumber === questionNumber &&
      (event.type === 'tossup-buzz' ||
        event.type === 'tossup-no-penalty' ||
        event.type === 'tossup-dead' ||
        event.type === 'bonus'),
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
  awaitingScoreCheck: boolean;
  halfBreaks: number[];
  endedEarly: IDerivedGame['endedEarly'];
  needsStartingLineup: LeftOrRight[];
}): ScoringPhase {
  const {
    format,
    questions,
    teams,
    boundary,
    regulationComplete,
    overtimeCyclesPlayed,
    awaitingScoreCheck,
    halfBreaks,
    endedEarly,
    needsStartingLineup,
  } = input;

  if (teams.left.forfeited || teams.right.forfeited) return { kind: 'complete', reason: 'forfeit' };
  if (endedEarly) return { kind: 'complete', reason: 'short' };

  const lastCycle = questions.length > 0 ? questions[questions.length - 1] : undefined;

  // Nothing can be scored against a lineup nobody chose. This outranks the score check and the
  // tossup below because it is a precondition of the game having started at all.
  if (needsStartingLineup.length > 0 && questions.length === 0) {
    return { kind: 'lineup', teams: needsStartingLineup };
  }

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
    // A wrong answer worth nothing spends a team's chance as surely as a buzz does, so both count.
    const answered = new Set<LeftOrRight>([
      ...lastCycle.buzzes.map((buzz) => buzz.team),
      ...lastCycle.noPenalty.map((missed) => missed.team),
    ]);
    return {
      kind: 'tossup',
      questionNumber: lastCycle.questionNumber,
      period: lastCycle.period,
      eligibleTeams: (['left', 'right'] as LeftOrRight[]).filter((side) => !answered.has(side)),
    };
  }

  // A bonus owed at the horn is still played, which is why this sits below the unfinished-cycle
  // cases and above everything else: once the cycle is closed, the room stops and agrees the score
  // before another question is read.
  if (awaitingScoreCheck) {
    return { kind: 'score-check', afterQuestion: halfBreaks[halfBreaks.length - 1] ?? 0 };
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
