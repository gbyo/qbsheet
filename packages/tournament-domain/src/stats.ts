import {
  type DirectorId,
  type DirectorState,
  defaultRules,
  type FinalPlacement,
  type GameRecord,
  type PlayerGameStat,
  type TournamentRules,
} from './model.js';
import { gameDetailedCountsKnown, gameOutcomeForTeam } from './canonicalStats.js';
import { resultDecisionIssue } from './results.js';

export interface TeamStanding {
  teamId: DirectorId;
  wins: number;
  losses: number;
  ties: number;
  winPercentage: number;
  pointsFor: number;
  pointsAgainst: number;
  margin: number;
  superpowers: number;
  powers: number;
  /** False when any contributing game's detailed powers are unknown. */
  powersKnown: boolean;
  gets: number;
  /** False when any contributing game's detailed gets are unknown. */
  getsKnown: boolean;
  negs: number;
  /**
   * Team tossups heard: the sum of exact game tossups-read denominators (#746).
   *
   * This is match TUH from each accepted game, not summed player exposure. Pure-forfeit games
   * contribute W/L but no TUH denominator.
   */
  tossupsHeard: number;
  /** False when any contributing non-forfeit game lacked an exact tossups-read count. */
  tossupsHeardKnown: boolean;
  /**
   * Regulation tossups heard: total TUH minus known overtime (#746).
   *
   * Known only when total TUH is known and overtime is known for every contributing game
   * (an explicit zero, or rules without overtime for that game).
   */
  tossupsHeardRegulation: number;
  /** False when regulation TUH cannot be derived exactly for some contributing game. */
  tossupsHeardRegulationKnown: boolean;
  /**
   * Overtime tossup points across contributing games (#746).
   *
   * Unknown when any contributing game's source supplied no overtime-buzz breakdown — except
   * games played under rules without overtime, which contribute a known zero.
   */
  overtimePoints: number;
  /** False when any contributing game left overtime points unknown. */
  overtimePointsKnown: boolean;
  bonuses: number;
  bonusPoints: number;
  /**
   * Bounceback points earned across contributing scoresheets, YellowFruit parity (#748).
   *
   * Unknown when any contributing scoresheet (or the opponent scoresheet its opportunities
   * come from) supplied no bounceback breakdown: manual/legacy results without
   * bounceback columns are unknown, not verified zeros.
   */
  bouncebackPoints: number;
  /** False when any contributing game lacked bounceback breakdowns. */
  bouncebacksKnown: boolean;
  /** Sum of known per-game lightning points. Games with unknown lightning contribute nothing. */
  lightningPoints: number;
  /** False when any contributing game lacked a lightning breakdown (unknown, not zero). */
  lightningKnown: boolean;
  gamesPlayed: number;
  headToHead: number;
}

export interface PlayerStanding {
  playerId: DirectorId;
  teamId: DirectorId;
  /**
   * Fractional games played: the sum over games of player TUH / game TUH (#746).
   *
   * A full game contributes 1.0; a substitute who heard half contributes 0.5. This matches
   * YellowFruit's participation denominator rather than counting result-line appearances.
   */
  gamesPlayed: number;
  /** False when some appearance cannot be expressed fractionally (unknown player or game TUH). */
  gamesPlayedKnown: boolean;
  tossupsHeard: number;
  /** False when at least one contributing scoresheet did not report TUH. */
  tossupsHeardKnown?: boolean;
  superpowers: number;
  powers: number;
  gets: number;
  negs: number;
  bonusPoints: number;
  /**
   * Total points, summed per game under each game's own scoring definition (#671). Buckets
   * cannot be valued once after aggregation: two games in one standing may price a power
   * differently, so each game's player lines are valued with that game's rules first.
   */
  points: number;
  ppg: number;
}

export interface DirectorStandingsOptions {
  /** Restrict accepted results to a particular phase. */
  phaseId?: DirectorId;
  /** Restrict accepted results to a particular pool within the phase. */
  poolId?: DirectorId | null;
  /** Further restrict accepted results to these scheduled-game identities. */
  gameIds?: readonly DirectorId[];
  /** Teams to display. Games against other teams still count in aggregation. */
  teamIds?: readonly DirectorId[];
  /** Include dropped teams in the returned rows. Their historical games count either way. */
  includeDroppedTeams?: boolean;
  /** Use this order instead of the tournament's configured order. */
  tiebreakers?: TournamentRules['tiebreakers'];
}

function compareIsoInstants(left: string, right: string): number {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime - rightTime;
  return left.localeCompare(right);
}

/**
 * Select one current accepted GameRecord per scheduled game.
 *
 * A correction intentionally keeps the old GameRecord/submission for audit. This selector is the
 * boundary that prevents those historical records from contributing to standings a second time.
 */
export function acceptedGameRecords(
  state: DirectorState,
  options: DirectorStandingsOptions = {},
): GameRecord[] {
  const submissionsByGame = new Map<DirectorId, typeof state.submissions>();
  for (const submission of state.submissions) {
    const entries = submissionsByGame.get(submission.gameId) ?? [];
    entries.push(submission);
    submissionsByGame.set(submission.gameId, entries);
  }
  const currentAcceptedSubmissionIds = new Set<DirectorId>();
  for (const entries of submissionsByGame.values()) {
    const current = entries
      .filter((submission) => submission.status === 'accepted')
      .sort(
        (left, right) =>
          compareIsoInstants(left.acceptedAt ?? left.receivedAt, right.acceptedAt ?? right.receivedAt) ||
          left.id.localeCompare(right.id),
      )
      .at(-1);
    if (current) currentAcceptedSubmissionIds.add(current.id);
  }
  const requestedGameIds = options.gameIds ? new Set(options.gameIds) : null;
  const scheduledById = new Map(state.scheduledGames.map((game) => [game.id, game]));
  const roundById = new Map(state.rounds.map((round) => [round.id, round]));
  const accepted = state.games.filter((game) => {
    // Forfeits are decided results: they count in W/L (the non-forfeiting
    // side wins) while recorded scores are aggregated as-entered.
    if (game.status !== 'accepted' && game.status !== 'forfeit') return false;
    if (requestedGameIds && !requestedGameIds.has(game.scheduledGameId)) return false;
    const scheduled = scheduledById.get(game.scheduledGameId);
    // Older imported Director documents may contain accepted records before the corresponding
    // schedule projection was persisted. Keep those records in the unscoped historical report;
    // an explicit phase/pool/game scope must reject them because their ownership is unknown.
    if (!scheduled) {
      return options.phaseId === undefined && options.poolId === undefined && options.gameIds === undefined;
    }
    if (scheduled.status === 'cancelled') return false;
    if (resultDecisionIssue(state, scheduled, game.scores, { forfeitedTeamId: game.forfeitedTeamId })) {
      // Invalid legacy/imported records remain in the document and audit history, but must not
      // feed standings or any public projection until a decisive result is accepted.
      return false;
    }
    if (scheduled.bye || scheduled.leftTeamId === scheduled.rightTeamId) return false;
    const round = roundById.get(scheduled.roundId) ?? roundById.get(game.roundId);
    if (options.phaseId && round && round.phaseId !== options.phaseId) return false;
    if (options.phaseId && !round) return false;
    if (options.poolId !== undefined) {
      const poolMatches =
        scheduled.poolId !== undefined && scheduled.poolId !== null
          ? scheduled.poolId === options.poolId
          : options.poolId === null
            ? true
            : (() => {
                const pool = state.pools.find((entry) => entry.id === options.poolId);
                return (
                  pool?.teamIds.includes(scheduled.leftTeamId) === true &&
                  pool.teamIds.includes(scheduled.rightTeamId ?? '')
                );
              })();
      if (!poolMatches) return false;
    }
    const submissions = submissionsByGame.get(game.id) ?? [];
    if (submissions.length > 0) {
      const current = submissions.find((submission) => currentAcceptedSubmissionIds.has(submission.id));
      if (!current) return false;
    }
    return true;
  });
  const byScheduledGame = new Map<DirectorId, GameRecord>();
  for (const game of accepted) {
    const previous = byScheduledGame.get(game.scheduledGameId);
    const currentSubmission = submissionsByGame
      .get(game.id)
      ?.find((submission) => currentAcceptedSubmissionIds.has(submission.id));
    const previousSubmission = previous
      ? submissionsByGame
          .get(previous.id)
          ?.find((submission) => currentAcceptedSubmissionIds.has(submission.id))
      : undefined;
    const gameHasCanonicalSubmission = currentSubmission !== undefined;
    const previousHasCanonicalSubmission = previousSubmission !== undefined;
    const currentAt = currentSubmission?.acceptedAt ?? currentSubmission?.receivedAt ?? game.acceptedAt ?? '';
    const previousAt =
      previousSubmission?.acceptedAt ?? previousSubmission?.receivedAt ?? previous?.acceptedAt ?? '';
    const timeOrder = compareIsoInstants(currentAt, previousAt);
    if (
      !previous ||
      (gameHasCanonicalSubmission && !previousHasCanonicalSubmission) ||
      (gameHasCanonicalSubmission === previousHasCanonicalSubmission && timeOrder > 0) ||
      (gameHasCanonicalSubmission === previousHasCanonicalSubmission &&
        timeOrder === 0 &&
        game.id.localeCompare(previous.id) > 0)
    ) {
      byScheduledGame.set(game.scheduledGameId, game);
    }
  }
  return [...byScheduledGame.values()];
}

export function deriveTeamStandings(
  state: DirectorState,
  games: GameRecord[] = acceptedGameRecords(state),
  options: DirectorStandingsOptions = {},
): TeamStanding[] {
  // The optional games argument is retained for existing Director callers. When a scope is
  // supplied, derive the canonical current results again so callers cannot accidentally pass
  // results from another phase into an advancement calculation.
  const scopedGames =
    options.phaseId !== undefined || options.poolId !== undefined || options.gameIds !== undefined
      ? acceptedGameRecords(state, options)
      : games;
  const byTeam = new Map<DirectorId, TeamStanding>();
  const gameTeamIds = scopedGames.flatMap((game) => game.scores.map((score) => score.teamId));
  const requestedTeamIds = options.teamIds ? [...options.teamIds] : [];
  const calculationTeamIds = new Set(
    options.teamIds || options.phaseId || options.poolId !== undefined
      ? [...requestedTeamIds, ...gameTeamIds]
      : state.teams.map((team) => team.id),
  );
  for (const team of state.teams) {
    if (!calculationTeamIds.has(team.id)) continue;
    byTeam.set(team.id, {
      teamId: team.id,
      wins: 0,
      losses: 0,
      ties: 0,
      winPercentage: 0,
      pointsFor: 0,
      pointsAgainst: 0,
      margin: 0,
      superpowers: 0,
      powers: 0,
      powersKnown: true,
      gets: 0,
      getsKnown: true,
      negs: 0,
      tossupsHeard: 0,
      tossupsHeardKnown: true,
      tossupsHeardRegulation: 0,
      tossupsHeardRegulationKnown: true,
      overtimePoints: 0,
      overtimePointsKnown: true,
      bonuses: 0,
      bonusPoints: 0,
      bouncebackPoints: 0,
      bouncebacksKnown: true,
      lightningPoints: 0,
      lightningKnown: true,
      gamesPlayed: 0,
      headToHead: 0,
    });
  }

  for (const game of scopedGames) {
    if (game.scores.length < 2) continue;
    const [left, right] = game.scores;
    const leftStanding = byTeam.get(left.teamId);
    const rightStanding = byTeam.get(right.teamId);
    if (!leftStanding || !rightStanding) continue;
    leftStanding.gamesPlayed += 1;
    rightStanding.gamesPlayed += 1;
    leftStanding.pointsFor += left.score;
    leftStanding.pointsAgainst += right.score;
    rightStanding.pointsFor += right.score;
    rightStanding.pointsAgainst += left.score;
    leftStanding.margin += left.score - right.score;
    rightStanding.margin += right.score - left.score;
    leftStanding.superpowers += left.superpowers;
    rightStanding.superpowers += right.superpowers;
    if (!gameDetailedCountsKnown(game)) {
      leftStanding.powersKnown = false;
      rightStanding.powersKnown = false;
      leftStanding.getsKnown = false;
      rightStanding.getsKnown = false;
    }
    addTeamGameTuh(state, leftStanding, game);
    addTeamGameTuh(state, rightStanding, game);
    addTeamGameOvertimePoints(state, leftStanding, left.teamId, game);
    addTeamGameOvertimePoints(state, rightStanding, right.teamId, game);
    leftStanding.powers += left.powers;
    leftStanding.gets += left.gets;
    leftStanding.negs += left.negs;
    leftStanding.bonuses += left.bonuses;
    leftStanding.bonusPoints += left.bonusPoints;
    // A pure-forfeit placeholder carries no bounceback breakdown and must not unknown the
    // scope (#748): skip it the way YellowFruit skips forfeit matches. A forfeit that kept
    // entered bounceback detail aggregates as-entered.
    if (left.bouncebacks === null) {
      if (game.status !== 'forfeit') leftStanding.bouncebacksKnown = false;
    } else {
      // An omitted breakdown is the legacy zero shorthand; only explicit null is unknown.
      leftStanding.bouncebackPoints += left.bouncebacks ?? 0;
    }
    addTeamLightning(leftStanding, left.lightningPoints);
    rightStanding.powers += right.powers;
    rightStanding.gets += right.gets;
    rightStanding.negs += right.negs;
    rightStanding.bonuses += right.bonuses;
    rightStanding.bonusPoints += right.bonusPoints;
    if (right.bouncebacks === null) {
      if (game.status !== 'forfeit') rightStanding.bouncebacksKnown = false;
    } else {
      rightStanding.bouncebackPoints += right.bouncebacks ?? 0;
    }
    const leftOutcome = gameOutcomeForTeam(game, left.teamId);
    const rightOutcome = gameOutcomeForTeam(game, right.teamId);
    if (leftOutcome === 'win') leftStanding.wins += 1;
    else if (leftOutcome === 'loss') leftStanding.losses += 1;
    else if (leftOutcome === 'tie') leftStanding.ties += 1;
    if (rightOutcome === 'win') rightStanding.wins += 1;
    else if (rightOutcome === 'loss') rightStanding.losses += 1;
    else if (rightOutcome === 'tie') rightStanding.ties += 1;
    addTeamLightning(rightStanding, right.lightningPoints);
  }

  for (const standing of byTeam.values()) {
    standing.winPercentage =
      standing.gamesPlayed === 0 ? 0 : (standing.wins + standing.ties * 0.5) / standing.gamesPlayed;
  }

  const allStandings = [...byTeam.values()];
  for (const standing of allStandings) {
    standing.headToHead = headToHeadValue(standing.teamId, allStandings, scopedGames);
  }
  const visibleStandings = allStandings.filter((standing) => {
    if (options.teamIds && !options.teamIds.includes(standing.teamId)) return false;
    if (options.includeDroppedTeams) return true;
    return state.teams.find((team) => team.id === standing.teamId)?.status !== 'dropped';
  });
  const rules = options.tiebreakers
    ? { ...(state.tournament?.rules ?? ({} as TournamentRules)), tiebreakers: options.tiebreakers }
    : state.tournament?.rules;
  return rankStandings(visibleStandings, scopedGames, rules);
}

function rankStandings(
  standings: TeamStanding[],
  games: GameRecord[],
  rules?: TournamentRules,
): TeamStanding[] {
  return rankTeamStandings(standings, games, rules?.tiebreakers);
}

/**
 * Rank an arbitrary candidate subset with the canonical progressive tie-break cascade.
 *
 * This is also used by cross-pool advancement: every later criterion receives only the group
 * that remained tied after the earlier criteria, just as ordinary standings do.
 */
export function rankTeamStandings(
  standings: readonly TeamStanding[],
  games: readonly GameRecord[],
  tiebreakers?: TournamentRules['tiebreakers'],
): TeamStanding[] {
  const order = tiebreakers ?? ['record', 'points', 'margin', 'powers', 'gets'];
  let groups: TeamStanding[][] = [[...standings]];
  for (const key of order) {
    groups = groups.flatMap((group) => {
      if (group.length < 2) return [group];
      // A detailed criterion cannot turn data availability into a competitive result. When one
      // team in the currently tied group is unknown, leave the whole group tied for this key and
      // let a later comparable criterion decide it.
      if (!tiebreakerIsComparable(key, group, games)) return [group];
      const ordered = [...group].sort(
        (left, right) => comparisonValue(right, key, group, games) - comparisonValue(left, key, group, games),
      );
      const partitions: TeamStanding[][] = [];
      for (const standing of ordered) {
        const previous = partitions.at(-1);
        if (
          previous &&
          comparisonValue(previous[0], key, group, games) === comparisonValue(standing, key, group, games)
        ) {
          previous.push(standing);
        } else {
          partitions.push([standing]);
        }
      }
      return partitions;
    });
  }
  return groups.flatMap((group) => [...group].sort((left, right) => left.teamId.localeCompare(right.teamId)));
}

function comparisonValue(
  standing: TeamStanding,
  key: TournamentRules['tiebreakers'][number],
  group: readonly TeamStanding[],
  games: readonly GameRecord[],
): number {
  return teamTiebreakerValue(standing, key, group, games) ?? 0;
}

export function teamTiebreakerValue(
  standing: TeamStanding,
  key: TournamentRules['tiebreakers'][number],
  group: readonly TeamStanding[],
  games: readonly GameRecord[],
): number | null {
  if (key === 'powers' && !standing.powersKnown) return null;
  if (key === 'gets' && !standing.getsKnown) return null;
  if (key === 'record') return standing.winPercentage;
  if (key === 'points') return standing.pointsFor;
  if (key === 'margin') return standing.margin;
  if (key === 'powers') return standing.powers;
  if (key === 'gets') return standing.gets;
  if (key === 'head-to-head') return headToHeadValue(standing.teamId, group, games);
  return 0;
}

export function tiebreakerIsComparable(
  key: TournamentRules['tiebreakers'][number],
  group: readonly TeamStanding[],
  games: readonly GameRecord[],
): boolean {
  return group.every((standing) => teamTiebreakerValue(standing, key, group, games) !== null);
}

/**
 * Bonuses are regular when every bonus has the same part count at the same per-part
 * value, so opponent bonus detail converts exactly into bounceback parts. This mirrors
 * YellowFruit's `bonusesAreRegular` gate (`pointsPerBonusPart` set and minimum parts
 * equal to maximum parts): irregular bonuses make parts heard uncomputable, never zero.
 */
export function bonusPartsAreRegular(rules: TournamentRules): boolean {
  return (
    rules.useBonuses && (rules.minimumBonusParts === null || rules.minimumBonusParts === rules.bonusParts)
  );
}

function maximumBonusScoreOf(rules: TournamentRules): number {
  return rules.maximumBonusScore ?? rules.bonusValue * rules.bonusParts;
}

/**
 * Bounceback parts heard for one side of a game, YellowFruit `Match` arithmetic in
 * QBSheet-native form: the opponent's unconverted bonus value expressed in parts,
 * `(opponentBonusesHeard * maximumBonusScore - opponentBonusPoints) / pointsPerBonusPart`.
 * Null when the game's rules make parts uncomputable (irregular bonuses or no usable
 * per-part value), never a fabricated zero.
 */
export function bouncebackPartsHeardForTeam(
  opponentBonuses: number,
  opponentBonusPoints: number,
  rules: TournamentRules,
): number | null {
  if (!bonusPartsAreRegular(rules)) return null;
  if (!(rules.bonusValue > 0)) return null;
  return (opponentBonuses * maximumBonusScoreOf(rules) - opponentBonusPoints) / rules.bonusValue;
}

export interface TeamBouncebackDerivation {
  /**
   * Bounceback points earned, or null when any contributing game supplied no bounceback
   * breakdown (unknown, never a verified zero).
   */
  bouncebackPoints: number | null;
  /**
   * Bounceback parts heard: opponents' unconverted bonus value in parts, summed across
   * contributing games under each game's own historical rules. Null when any
   * contributing game lacks the opponent bonus detail or the regular rules the
   * denominator requires — scoped to the other side's scoresheet, never inferred
   * from point deltas or the converting team's own lines (#748).
   */
  bouncebackPartsHeard: number | null;
  /**
   * Bounceback parts converted: bounceback points divided by each game's per-part
   * value. Null when any contributing game's bounceback breakdown is unknown.
   */
  bouncebackPartsConverted: number | null;
  /**
   * Bounceback conversion as a fraction of parts heard. Null unless both parts are
   * fully known and at least one part was heard; a heard-zero scope reports zero
   * parts with a null rate, never NaN.
   */
  bouncebackConversion: number | null;
  /**
   * Total bonus conversion as a fraction: own converted parts plus bounceback
   * converted parts over own parts heard plus bounceback parts heard. Null unless
   * every part of the denominator is known and positive.
   */
  totalBonusConversion: number | null;
  /**
   * Points per bonus on the team's own bonuses only. Team bonusPoints never include
   * bounceback points (the scorer and every ingest path keep the buckets separate), so
   * PPB is inherently bounceback-free; it is null when no bonuses were heard.
   */
  ppbWithoutBouncebacks: number | null;
}

/**
 * Derive a team's bounceback facts with opponent-scoped parts denominators (#748).
 *
 * Only games in which the team appears contribute. Pure-forfeit placeholders are
 * skipped without unknowning the scope; a forfeit that kept entered bounceback detail
 * aggregates as-entered. A single contributing game with an unknown bounceback
 * breakdown, missing detail, or irregular bonus rules unknowns the parts facts it
 * touches rather than contributing a zero.
 */
export function bouncebackDerivationForTeam(
  teamId: DirectorId,
  games: readonly GameRecord[],
  state?: DirectorState,
): TeamBouncebackDerivation {
  const empty: TeamBouncebackDerivation = {
    bouncebackPoints: 0,
    bouncebackPartsHeard: 0,
    bouncebackPartsConverted: 0,
    bouncebackConversion: null,
    totalBonusConversion: null,
    ppbWithoutBouncebacks: null,
  };
  let bouncebackPoints = 0;
  let bouncebacksKnown = true;
  let partsHeard = 0;
  let partsConverted = 0;
  let partsKnown = true;
  let ownPartsHeard = 0;
  let ownPartsConverted = 0;
  let bonuses = 0;
  let bonusPoints = 0;
  let contributingGames = 0;
  for (const game of games) {
    const own = game.scores.find((score) => score.teamId === teamId);
    if (!own) continue;
    const opponent = game.scores.find((score) => score.teamId !== teamId);
    if (!opponent) continue;
    if (game.status === 'forfeit' && own.bouncebacks === null) continue;
    contributingGames += 1;
    if (own.bouncebacks === null) {
      bouncebacksKnown = false;
      partsKnown = false;
    } else {
      // An omitted breakdown is the legacy zero shorthand; only explicit null is unknown.
      bouncebackPoints += own.bouncebacks ?? 0;
    }
    const rules = state ? (rulesForGame(state, game) ?? defaultRules) : defaultRules;
    const heard = gameDetailedCountsKnown(game)
      ? bouncebackPartsHeardForTeam(opponent.bonuses, opponent.bonusPoints, rules)
      : null;
    if (heard === null || own.bouncebacks === null) {
      partsKnown = false;
    } else {
      partsHeard += heard;
      partsConverted += (own.bouncebacks ?? 0) / rules.bonusValue;
      ownPartsHeard += own.bonuses * rules.bonusParts;
      ownPartsConverted += own.bonusPoints / rules.bonusValue;
    }
    bonuses += own.bonuses;
    bonusPoints += own.bonusPoints;
  }
  if (contributingGames === 0) return empty;
  const knownPoints = bouncebacksKnown ? bouncebackPoints : null;
  const knownPartsHeard = partsKnown ? partsHeard : null;
  const knownPartsConverted = partsKnown ? partsConverted : null;
  const knownOwnHeard = partsKnown ? ownPartsHeard : null;
  const knownOwnConverted = partsKnown ? ownPartsConverted : null;
  return {
    bouncebackPoints: knownPoints,
    bouncebackPartsHeard: knownPartsHeard,
    bouncebackPartsConverted: knownPartsConverted,
    bouncebackConversion:
      knownPartsConverted !== null && knownPartsHeard !== null && knownPartsHeard > 0
        ? knownPartsConverted / knownPartsHeard
        : null,
    totalBonusConversion:
      knownPartsConverted !== null &&
      knownPartsHeard !== null &&
      knownOwnConverted !== null &&
      knownOwnHeard !== null &&
      knownOwnHeard + knownPartsHeard > 0
        ? (knownOwnConverted + knownPartsConverted) / (knownOwnHeard + knownPartsHeard)
        : null,
    ppbWithoutBouncebacks: bonuses > 0 ? bonusPoints / bonuses : null,
  };
}

function headToHeadValue(
  teamId: DirectorId,
  group: readonly TeamStanding[],
  games: readonly GameRecord[],
): number {
  const groupIds = new Set(group.map((standing) => standing.teamId));
  let wins = 0;
  let gamesPlayed = 0;
  for (const game of games) {
    const own = game.scores.find((score) => score.teamId === teamId);
    if (!own) continue;
    const opponent = game.scores.find((score) => score.teamId !== teamId && groupIds.has(score.teamId));
    if (!opponent) continue;
    gamesPlayed += 1;
    const outcome = gameOutcomeForTeam(game, teamId);
    if (outcome === 'win') wins += 1;
    else if (outcome === 'tie') wins += 0.5;
  }
  return gamesPlayed === 0 ? 0 : wins / gamesPlayed;
}

/**
 * Answer-type values from a stored game's own embedded ScoringRules (#671 source 3).
 *
 * Mirrors the ingest-side extractor at bucket granularity: the first ScoringRules object
 * carrying values wins. Buckets are all aggregates need, so no full QBJ-to-rules conversion
 * is attempted here — or anywhere; none exists.
 */
function embeddedAnswerValues(rawQbj: unknown): number[] | undefined {
  if (!rawQbj || typeof rawQbj !== 'object') return undefined;
  const objects = (rawQbj as { objects?: unknown }).objects;
  if (!Array.isArray(objects)) return undefined;
  for (const object of objects) {
    if (!object || typeof object !== 'object') continue;
    const record = object as Record<string, unknown>;
    if (record.type !== 'ScoringRules' || !Array.isArray(record.answer_types)) continue;
    const values = record.answer_types
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return undefined;
        const value = (entry as Record<string, unknown>).value;
        return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
      })
      .filter((value): value is number => value !== undefined);
    if (values.length > 0) return values;
  }
  return undefined;
}

/**
 * Tier mapping for embedded answer-type values (#671 source 3).
 *
 * Standard formats tier distinct positive values tallest-first. Mirrors the ingest-side
 * mapping so classification and valuation can never disagree about which tier a value is.
 */
function bucketValuesFromAnswerTypes(values: readonly number[]): ScoringValues {
  const positive = [...new Set(values.filter((value) => Number.isFinite(value) && value > 0))].sort(
    (left, right) => right - left,
  );
  if (positive.length >= 3) {
    return { superpowerValue: positive[0], powerValue: positive[1]!, tossupValue: positive[2]! };
  }
  if (positive.length === 2) return { powerValue: positive[0]!, tossupValue: positive[1]! };
  if (positive.length === 1) return { powerValue: positive[0]!, tossupValue: positive[0]! };
  return { powerValue: 15, tossupValue: 10 };
}

/** Answer values at the granularity aggregates need; every tier is optional downstream. */
interface ScoringValues {
  superpowerValue?: number | null;
  powerValue?: number | null;
  tossupValue?: number | null;
  negValue?: number | null;
}

/**
 * The answer values one stored game's player lines must be valued with (#671).
 *
 * Precedence: the snapshot the game's digest names, the game's own embedded ScoringRules,
 * live tournament rules. The embedded tier is what keeps a legacy game — scored before pins
 * existed, carrying its rules in its raw QBJ — stable in standings after defaults move on.
 * Only a game with neither a snapshot nor embedded rules is valued with live defaults, and
 * the migration pins even those as explicitly marked inferences.
 */
function scoringValuesForGame(state: DirectorState, game: GameRecord): ScoringValues | undefined {
  if (game.definitionDigest) {
    const snapshot = state.gameDefinitions.find(
      (entry) => entry.scheduledGameId === game.scheduledGameId && entry.digest === game.definitionDigest,
    );
    if (snapshot) return snapshot.rules;
  }
  const embedded = embeddedAnswerValues(game.rawQbj);
  if (embedded) return bucketValuesFromAnswerTypes(embedded);
  return state.tournament?.rules;
}

export function derivePlayerStandings(
  state: DirectorState,
  options: DirectorStandingsOptions = {},
): PlayerStanding[] {
  const byPlayer = new Map<DirectorId, PlayerStanding>();
  for (const player of state.players) {
    if (options.teamIds && !options.teamIds.includes(player.teamId)) continue;
    if (
      !options.includeDroppedTeams &&
      state.teams.find((team) => team.id === player.teamId)?.status === 'dropped'
    ) {
      continue;
    }
    byPlayer.set(player.id, {
      playerId: player.id,
      teamId: player.teamId,
      gamesPlayed: 0,
      gamesPlayedKnown: true,
      tossupsHeard: 0,
      tossupsHeardKnown: true,
      superpowers: 0,
      powers: 0,
      gets: 0,
      negs: 0,
      bonusPoints: 0,
      points: 0,
      ppg: 0,
    });
  }
  const games = acceptedGameRecords(state, options);
  for (const game of games) {
    const values = scoringValuesForGame(state, game);
    // Fractional GP uses the same game-TUH convention YellowFruit uses; a forfeit supplies no
    // denominator, so any line it carries keeps GP unknown rather than inventing participation.
    const gameTuh = gameTotalTuh(game);
    for (const stat of game.playerStats) {
      const standing = byPlayer.get(stat.playerId);
      if (!standing) continue;
      addPlayerGame(standing, stat, gameTuh);
      standing.points += playerPoints(stat, values);
    }
  }
  for (const standing of byPlayer.values()) {
    standing.ppg = standing.gamesPlayed === 0 ? 0 : standing.points / standing.gamesPlayed;
  }
  return [...byPlayer.values()].sort(
    (a, b) => b.ppg - a.ppg || b.powers - a.powers || a.playerId.localeCompare(b.playerId),
  );
}

/**
 * Lightning points are known only when the result supplies the breakdown.
 * A missing value marks the aggregate unknown rather than contributing zero.
 */
function addTeamLightning(standing: TeamStanding, lightningPoints: number | null | undefined): void {
  if (lightningPoints === null || lightningPoints === undefined) {
    standing.lightningKnown = false;
    return;
  }
  standing.lightningPoints += lightningPoints;
}

/**
 * Full scoring rules applicable to one stored game: its pinned definition snapshot when the
 * record names one, else live tournament rules (#671 precedence, full-rules granularity).
 *
 * Team tossups-heard comes from the team's own scoresheet lines. A game with
 * no lines for the team, or any line without a count, makes the team's total
 * unknown rather than a fabricated partial sum.
 */
export function rulesForGame(state: DirectorState, game: GameRecord): TournamentRules | undefined {
  if (game.definitionDigest) {
    const snapshot = state.gameDefinitions.find(
      (entry) => entry.scheduledGameId === game.scheduledGameId && entry.digest === game.definitionDigest,
    );
    if (snapshot) return snapshot.rules;
  }
  return state.tournament?.rules;
}

function validTuh(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value) && value >= 0;
}

/**
 * Exact total TUH for a game, or null when unknown (#746).
 *
 * Forfeit games never supply a denominator: they count in W/L and record games but must not
 * fabricate tossups heard, PPX denominators, or conversion rates.
 */
function gameTotalTuh(game: GameRecord): number | null {
  if (game.status === 'forfeit') return null;
  return validTuh(game.tossupsRead) ? game.tossupsRead : null;
}

/**
 * Exact overtime TUH for a game, or null when unknown (#746).
 *
 * An absent overtime count is a known zero only when that game's own rules have no overtime
 * period; otherwise the game may simply predate overtime tracking.
 */
function gameOvertimeTuh(state: DirectorState, game: GameRecord): number | null {
  if (game.status === 'forfeit') return null;
  if (validTuh(game.overtimeTossupsRead)) return game.overtimeTossupsRead;
  if (rulesForGame(state, game)?.overtime === false) return 0;
  return null;
}

/**
 * Team TUH comes from exact match tossups-read denominators, never summed player exposure.
 *
 * Several players hear the same tossup and substitutions change summed exposure, so player
 * lines cannot stand in for the match count. A non-forfeit game without an exact count marks
 * the aggregate unknown rather than contributing a partial-subset sum.
 */
function addTeamGameTuh(state: DirectorState, standing: TeamStanding, game: GameRecord): void {
  if (game.status === 'forfeit') return;
  const total = gameTotalTuh(game);
  if (total === null) {
    standing.tossupsHeardKnown = false;
    standing.tossupsHeardRegulationKnown = false;
    return;
  }
  standing.tossupsHeard += total;
  const overtime = gameOvertimeTuh(state, game);
  if (overtime === null || overtime > total) {
    standing.tossupsHeardRegulationKnown = false;
    return;
  }
  standing.tossupsHeardRegulation += total - overtime;
}

/**
 * Exact overtime tossup points for one team in a game, or null when unknown (#746).
 *
 * An absent breakdown is a known zero only when that game's own rules have no overtime
 * period — mirroring gameOvertimeTuh: otherwise the game may simply predate overtime
 * tracking. A forfeit played no overtime, so it contributes a known zero.
 */
function gameOvertimePointsForTeam(
  state: DirectorState,
  game: GameRecord,
  teamId: DirectorId,
): number | null {
  if (game.status === 'forfeit') return 0;
  const score = game.scores.find((entry) => entry.teamId === teamId);
  if (typeof score?.overtimePoints === 'number' && Number.isFinite(score.overtimePoints)) {
    return score.overtimePoints;
  }
  if (rulesForGame(state, game)?.overtime === false) return 0;
  return null;
}

function addTeamGameOvertimePoints(
  state: DirectorState,
  standing: TeamStanding,
  teamId: DirectorId,
  game: GameRecord,
): void {
  const overtime = gameOvertimePointsForTeam(state, game, teamId);
  if (overtime === null) {
    standing.overtimePointsKnown = false;
    return;
  }
  standing.overtimePoints += overtime;
}

export interface TeamRegulationDerivation {
  /**
   * Overtime tossup points, or null when any contributing game left them unknown (never a
   * verified zero).
   */
  overtimePoints: number | null;
  /**
   * Regulation points: total points minus known overtime points. Null when overtime is
   * unknown, or when the split contradicts the total (overtime exceeding points means the
   * source data disagrees with itself — fail closed, never a negative).
   */
  regulationPoints: number | null;
  /**
   * Points per regulation tossup heard. Null unless regulation points and regulation TUH are
   * both fully known and at least one regulation tossup was heard.
   */
  pointsPerRegulationTossup: number | null;
}

/**
 * Per-team regulation/overtime points splits with the normalized denominator facts (#746).
 *
 * Regulation points are a residual (total minus overtime), so adjustments and other
 * period-less scoring stay in the regulation bucket by construction.
 */
export function regulationDerivationForTeam(
  standing: Pick<
    TeamStanding,
    | 'pointsFor'
    | 'overtimePoints'
    | 'overtimePointsKnown'
    | 'tossupsHeardRegulation'
    | 'tossupsHeardRegulationKnown'
  >,
): TeamRegulationDerivation {
  const overtime = standing.overtimePointsKnown ? standing.overtimePoints : null;
  const regulationPoints =
    overtime !== null && overtime <= standing.pointsFor ? standing.pointsFor - overtime : null;
  const regulationTuh = standing.tossupsHeardRegulationKnown ? standing.tossupsHeardRegulation : null;
  return {
    overtimePoints: overtime,
    regulationPoints,
    pointsPerRegulationTossup:
      regulationPoints !== null && regulationTuh !== null && regulationTuh > 0
        ? regulationPoints / regulationTuh
        : null,
  };
}

/**
 * A player's total tossup/bonus points from aggregate counts, scored with the
 * tournament's own answer values. This is the one place that arithmetic lives:
 * Director tables, Live projection, CSV, HTML, and SQBS adapters all share it
 * so they cannot disagree about who scored what.
 */
export function playerPoints(
  standing: Pick<PlayerStanding, 'superpowers' | 'powers' | 'gets' | 'negs' | 'bonusPoints'>,
  rules?: ScoringValues | null,
): number {
  return (
    standing.superpowers * (rules?.superpowerValue ?? rules?.powerValue ?? 15) +
    standing.powers * (rules?.powerValue ?? 15) +
    standing.gets * (rules?.tossupValue ?? 10) +
    standing.negs * (rules?.negValue ?? -5) +
    standing.bonusPoints
  );
}

/**
 * One player result line: fractional participation plus exposure and buckets (#746).
 *
 * GP accrues player TUH / game TUH, so a half game is 0.5 GP. Either side unknown (or a
 * degenerate zero game denominator) keeps GP unknown rather than counting an appearance.
 * A bench player with no line gains nothing.
 */
function addPlayerGame(standing: PlayerStanding, stat: PlayerGameStat, gameTuh: number | null): void {
  if (stat.tossupsHeard !== null && gameTuh !== null && gameTuh > 0) {
    standing.gamesPlayed += stat.tossupsHeard / gameTuh;
  } else {
    standing.gamesPlayedKnown = false;
  }
  if (stat.tossupsHeard !== null) standing.tossupsHeard += stat.tossupsHeard;
  else standing.tossupsHeardKnown = false;
  standing.superpowers += stat.superpowers;
  standing.powers += stat.powers;
  standing.gets += stat.gets;
  standing.negs += stat.negs;
  standing.bonusPoints += stat.bonusPoints;
}

export function totalAcceptedResults(state: DirectorState): number {
  return acceptedGameRecords(state).length;
}

/**
 * Individual tables list anyone with any appearance (#746).
 *
 * Positive fractional GP always qualifies; a zero GP with unknown participation also qualifies
 * because the player does have result lines — only a bench player (known zero, no lines)
 * stays out. Filtering on bare `gamesPlayed > 0` would silently drop real scorers whose game
 * TUH is unknown.
 */
export function playerHasAppearance(
  standing: Pick<PlayerStanding, 'gamesPlayed' | 'gamesPlayedKnown'>,
): boolean {
  return standing.gamesPlayed > 0 || standing.gamesPlayedKnown === false;
}

/**
 * Reorder calculated standings rows by an explicit final placement.
 *
 * Rows whose team appears in `placement.order` move to the front in that
 * order; every other row keeps its relative calculated order. Duplicates are
 * impossible by construction: the first occurrence wins. Unknown ids are
 * ignored. Raw scores, W/L records, and the input order are never rewritten —
 * the calculated order stays recoverable by ignoring the returned array.
 */
export function applyFinalPlacement<T extends { teamId: DirectorId }>(
  calculated: readonly T[],
  placement: FinalPlacement | undefined,
): T[] {
  if (!placement || placement.order.length === 0) return [...calculated];
  const rows = new Map(calculated.map((row) => [row.teamId, row]));
  const seen = new Set<DirectorId>();
  const ordered: T[] = [];
  for (const teamId of placement.order) {
    if (seen.has(teamId)) continue;
    seen.add(teamId);
    const row = rows.get(teamId);
    if (row) {
      ordered.push(row);
      rows.delete(teamId);
    }
  }
  for (const row of calculated) {
    if (rows.has(row.teamId)) ordered.push(row);
  }
  return ordered;
}
