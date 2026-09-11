import type { GameStatsRow, StatsSnapshot } from './stats.js';
import type { GameTeamStatsRow } from './reportDetail.js';

/**
 * The per-game scoring facts a round report needs in addition to the accepted
 * result itself. These are attached by the canonical report adapter after it
 * resolves the strongest historical definition it can prove for that game.
 *
 * `source` is deliberately visible. A legacy tournament-default fallback is
 * not equivalent to a pinned historical definition, and report derivation must
 * never accidentally make that distinction disappear.
 */
export interface RoundStatDefinition {
  regulationTossups: number | null;
  /** True only when regulation has a fixed tossup count rather than a timed/open-ended limit. */
  regulationLengthFixed: boolean | null;
  overtimeEnabled: boolean | null;
  powers: boolean | null;
  superpowers: boolean | null;
  bonuses: boolean | null;
  maximumBonusScore: number | null;
  source: 'game' | 'qbj' | 'legacy-tournament' | 'unknown';
}

/**
 * One row in the printable Round Report.
 *
 * Rate fields are null when their complete denominator cannot be proved for
 * every competitively played game in the row. A null is presentation-level
 * `—`; it is never silently replaced by a statistic over the known subset.
 */
export interface RoundReportRow {
  roundId: string | null;
  roundName: string;
  phaseId: string | null;
  phaseName: string | null;
  packetName: string | null;
  packetMixed: boolean;
  /** Accepted results in the row, including a pure forfeit. */
  results: number;
  /** Competitively played games contributing to scoring statistics. */
  games: number;
  teams: number;
  /** Common regulation X for normalized metrics; null means mixed/unknown. */
  regulationTossups: number | null;
  /** Sum of exact/inferable tossups read, only when known for every included game. */
  tossupsRead: number | null;
  pointsPerTeamPerXTuh: number | null;
  superpowerRate: number | null;
  powerRate: number | null;
  tossupConversionRate: number | null;
  negRatePerXTuh: number | null;
  ppb: number | null;
  /** Bonus points divided by the maximum possible points on bonuses heard. */
  bonusConversionRate: number | null;
  /**
   * Bounceback parts heard in the row (opponents' unconverted bonus value, #748).
   * Null unless every competitively played game supplies both sides' parts.
   */
  bouncebackPartsHeard: number | null;
  /** Bounceback parts converted in the row; null under the same conditions. */
  bouncebackPartsConverted: number | null;
  /** Bounceback conversion as a fraction of parts heard; null unless parts are known and heard. */
  bouncebackConversion: number | null;
  /**
   * Total bonus conversion as a fraction (own plus bounceback converted parts over
   * own plus bounceback parts heard); null unless every part is known.
   */
  totalBonusConversion: number | null;
  /** Sum of known per-game lightning points; null when any included game lacks the breakdown. */
  lightningPoints: number | null;
  /** Lightning points per team per game; null unless the total is known and games exist. */
  lightningRate: number | null;
  /** Games whose detailed tossup/bonus counts are complete enough for ratio work. */
  detailGames: number;
  /** Pure forfeits retained as results but excluded from scoring denominators. */
  excludedForfeits: number;
  /** True when at least one normally applicable aggregate is unavailable. */
  partial: boolean;
}

export interface RoundStatsReport {
  rows: RoundReportRow[];
  /** Re-derived from all included games, never averaged from the rows above. */
  total: RoundReportRow;
  showPhase: boolean;
  showSuperpowers: boolean;
  showPowers: boolean;
  showBonuses: boolean;
  showBonusConversion: boolean;
  /** True when some row computes bounceback parts (own plus opponent detail present). */
  showBouncebacks: boolean;
  /** True when some row carries known lightning points. */
  showLightning: boolean;
  hasMixedRegulation: boolean;
}

declare module './stats.js' {
  interface GameStatsRow {
    /** Human-readable phase name for static reports. */
    phaseName?: string;
    /** Historical per-game reporting definition resolved by the canonical adapter. */
    roundStatDefinition?: RoundStatDefinition;
  }

  interface StatsSnapshot {
    /** Canonical round aggregates, derived before any HTML serialization. */
    roundStats?: RoundStatsReport;
  }
}

interface RoundGroup {
  roundId: string | null;
  roundName: string;
  games: GameStatsRow[];
}

interface AggregateFacts {
  row: RoundReportRow;
  hasSuperpowers: boolean;
  hasPowers: boolean;
  hasBonuses: boolean;
  bonusConversionApplicable: boolean;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function nonnegative(value: unknown): value is number {
  return finite(value) && value >= 0;
}

function uniqueGames(games: readonly GameStatsRow[]): GameStatsRow[] {
  const byId = new Map<string, GameStatsRow>();
  for (const game of games) {
    if (!byId.has(game.gameId)) byId.set(game.gameId, game);
  }
  return [...byId.values()];
}

function groupByRound(games: readonly GameStatsRow[]): RoundGroup[] {
  const groups = new Map<string, RoundGroup>();
  for (const game of uniqueGames(games)) {
    const key = game.roundId ?? `game:${game.gameId}`;
    const existing = groups.get(key);
    if (existing) {
      existing.games.push(game);
      continue;
    }
    groups.set(key, {
      roundId: game.roundId ?? null,
      roundName: game.roundName ?? game.roundId ?? 'Unassigned round',
      games: [game],
    });
  }
  return [...groups.values()];
}

function allKnownTeamStats(game: GameStatsRow): GameTeamStatsRow[] | null {
  if (!Array.isArray(game.teamStats) || game.teamStats.length !== 2) return null;
  return game.teamStats;
}

/**
 * A forfeit is a result for standings but is not evidence that a game was
 * competitively played. It enters scoring denominators only when real played
 * detail exists (for example, a game forfeited after play began).
 *
 * Legacy score records often carry a structurally complete line of zeroes for
 * a scoreless forfeit. Zero-valued fields alone are therefore not evidence of
 * play; an exact positive tossup count or at least one non-zero recorded stat is.
 */
function contributesScoringStats(game: GameStatsRow): boolean {
  if (!game.forfeitedTeamId && game.status !== 'forfeit') return true;
  if (nonnegative(game.tossupsRead) && game.tossupsRead > 0) return true;
  const teams = allKnownTeamStats(game);
  return (
    teams !== null &&
    teams.some((team) =>
      [team.superpowers, team.powers, team.gets, team.negs, team.bonusesHeard, team.bonusPoints].some(
        (value) => finite(value) && value > 0,
      ),
    )
  );
}

/**
 * Exact tossups-read wins. Otherwise regulation X is safe only for a fixed
 * non-overtime game. We intentionally decline to assume that an overtime-
 * capable game stopped at regulation when the accepted result did not say so.
 */
/**
 * Regulation tossups heard for one game: measured total minus measured overtime, or the
 * definition count when the game provably had no overtime period. Anything else leaves
 * the regulation denominator unknown rather than smuggling overtime into Pts/team/X.
 */
function regulationTuhForGame(game: GameStatsRow): number | null {
  if (
    finite(game.tossupsRead) &&
    game.tossupsRead > 0 &&
    finite(game.overtimeTossupsRead) &&
    game.overtimeTossupsRead >= 0
  ) {
    const regulation = game.tossupsRead - game.overtimeTossupsRead;
    return regulation > 0 ? regulation : null;
  }
  const definition = game.roundStatDefinition;
  if (
    definition?.regulationLengthFixed === true &&
    definition.overtimeEnabled === false &&
    nonnegative(definition.regulationTossups) &&
    definition.regulationTossups > 0
  ) {
    return definition.regulationTossups;
  }
  return null;
}

/**
 * Overtime points for one side: the team breakdown when present, else a known zero
 * when the game provably had no overtime. Unknown splits fail closed.
 */
function overtimePointsForTeam(game: GameStatsRow, side: 0 | 1): number | null {
  const rows = allKnownTeamStats(game);
  const row = rows?.[side];
  if (row && finite(row.overtimePoints)) return row.overtimePoints;
  if (finite(game.overtimeTossupsRead) && game.overtimeTossupsRead === 0) return 0;
  if (game.roundStatDefinition?.overtimeEnabled === false) return 0;
  return null;
}

/**
 * Regulation points for one side: final minus overtime, failing closed when the
 * split is unknown or contradicts the total.
 */
function regulationPointsForTeam(
  game: GameStatsRow,
  teamPoints: number | null | undefined,
  side: 0 | 1,
): number | null {
  if (!finite(teamPoints)) return null;
  const overtime = overtimePointsForTeam(game, side);
  if (overtime === null || overtime < 0 || overtime > teamPoints) return null;
  return teamPoints - overtime;
}

function tossupsReadForGame(game: GameStatsRow): number | null {
  if (nonnegative(game.tossupsRead) && game.tossupsRead > 0) return game.tossupsRead;
  const definition = game.roundStatDefinition;
  if (
    definition?.regulationLengthFixed === true &&
    definition.overtimeEnabled === false &&
    nonnegative(definition.regulationTossups) &&
    definition.regulationTossups > 0
  ) {
    return definition.regulationTossups;
  }
  return null;
}

function commonPositiveInteger(values: readonly (number | null | undefined)[]): number | null {
  const known = values.filter((value): value is number => nonnegative(value) && value > 0);
  if (known.length !== values.length || known.length === 0) return null;
  const first = known[0]!;
  return known.every((value) => value === first) ? first : null;
}

function phaseContext(games: readonly GameStatsRow[]): { phaseId: string | null; phaseName: string | null } {
  const ids = new Set(games.map((game) => game.phaseId).filter((value): value is string => Boolean(value)));
  const names = new Set(
    games.map((game) => game.phaseName).filter((value): value is string => Boolean(value)),
  );
  if (ids.size > 1 || names.size > 1) return { phaseId: null, phaseName: 'Mixed' };
  return {
    phaseId: ids.values().next().value ?? null,
    phaseName: names.values().next().value ?? null,
  };
}

function packetContext(games: readonly GameStatsRow[]): { packetName: string | null; packetMixed: boolean } {
  const names = games.map((game) => game.packetName?.trim() || null);
  const known = new Set(names.filter((name): name is string => name !== null));
  if (known.size === 0) return { packetName: null, packetMixed: false };
  if (known.size === 1 && names.every((name) => name !== null)) {
    return { packetName: known.values().next().value ?? null, packetMixed: false };
  }
  return { packetName: 'Mixed', packetMixed: true };
}

function sumKnown(
  games: readonly GameStatsRow[],
  select: (team: GameTeamStatsRow) => number | null,
): number | null {
  let sum = 0;
  for (const game of games) {
    const teams = allKnownTeamStats(game);
    if (!teams) return null;
    for (const team of teams) {
      const value = select(team);
      if (!finite(value)) return null;
      sum += value;
    }
  }
  return sum;
}

function metricEnabled(games: readonly GameStatsRow[], key: 'superpowers' | 'powers' | 'bonuses'): boolean {
  return games.some((game) => game.roundStatDefinition?.[key] === true);
}

function completeApplicability(
  games: readonly GameStatsRow[],
  key: 'superpowers' | 'powers' | 'bonuses',
): boolean {
  return (
    games.length > 0 &&
    games.every(
      (game) => game.roundStatDefinition?.[key] !== null && game.roundStatDefinition?.[key] !== undefined,
    )
  );
}

function everyGameUses(games: readonly GameStatsRow[], key: 'superpowers' | 'powers'): boolean {
  return games.length > 0 && games.every((game) => game.roundStatDefinition?.[key] === true);
}

function aggregate(
  roundId: string | null,
  roundName: string,
  results: readonly GameStatsRow[],
): AggregateFacts {
  const unique = uniqueGames(results);
  const played = unique.filter(contributesScoringStats);
  const excludedForfeits = unique.length - played.length;
  const phase = phaseContext(unique);
  const packet = packetContext(unique);
  const teams = new Set(unique.flatMap((game) => [game.teamOneId, game.teamTwoId].filter(Boolean))).size;
  const regulationTossups = commonPositiveInteger(
    played.map((game) => game.roundStatDefinition?.regulationTossups ?? null),
  );
  const tossupsByGame = played.map(tossupsReadForGame);
  const allTossupsKnown =
    played.length > 0 && tossupsByGame.every((value): value is number => finite(value) && value > 0);
  const totalTossupsRead = allTossupsKnown
    ? (tossupsByGame as number[]).reduce((sum, value) => sum + value, 0)
    : null;

  const superpowers = sumKnown(played, (team) => team.superpowers);
  const powers = sumKnown(played, (team) => team.powers);
  const gets = sumKnown(played, (team) => team.gets);
  const negs = sumKnown(played, (team) => team.negs);
  const positiveConversions =
    superpowers !== null && powers !== null && gets !== null ? superpowers + powers + gets : null;

  const hasSuperpowers = metricEnabled(played, 'superpowers');
  const hasPowers = metricEnabled(played, 'powers');
  const hasBonuses = metricEnabled(played, 'bonuses');
  const superpowerApplicabilityKnown = completeApplicability(played, 'superpowers');
  const powerApplicabilityKnown = completeApplicability(played, 'powers');
  const bonusApplicabilityKnown = completeApplicability(played, 'bonuses');
  const allUseSuperpowers = everyGameUses(played, 'superpowers');
  const allUsePowers = everyGameUses(played, 'powers');

  const bonusPoints = sumKnown(played, (team) => team.bonusPoints);
  const bonusesHeard = sumKnown(played, (team) => team.bonusesHeard);
  const ppb =
    hasBonuses && bonusApplicabilityKnown && bonusPoints !== null && bonusesHeard !== null && bonusesHeard > 0
      ? bonusPoints / bonusesHeard
      : null;

  const bonusConversionApplicable =
    hasBonuses &&
    played.some((game) => {
      const maximum = game.roundStatDefinition?.maximumBonusScore;
      return finite(maximum) && maximum > 0;
    });
  let maximumBonusPoints: number | null = 0;
  if (hasBonuses && bonusApplicabilityKnown && played.length > 0) {
    for (const game of played) {
      const definition = game.roundStatDefinition;
      const teamRows = allKnownTeamStats(game);
      if (
        !definition ||
        !teamRows ||
        !finite(definition.maximumBonusScore) ||
        definition.maximumBonusScore <= 0
      ) {
        maximumBonusPoints = null;
        break;
      }
      for (const team of teamRows) {
        if (!finite(team.bonusesHeard)) {
          maximumBonusPoints = null;
          break;
        }
        maximumBonusPoints += team.bonusesHeard * definition.maximumBonusScore;
      }
      if (maximumBonusPoints === null) break;
    }
  } else {
    maximumBonusPoints = null;
  }
  const bonusConversionRate =
    bonusPoints !== null && maximumBonusPoints !== null && maximumBonusPoints > 0
      ? bonusPoints / maximumBonusPoints
      : null;

  // Bounceback/total-bonus parts come precomputed per team-game from the canonical
  // adapter under each game's own definition; the aggregate only sums them (#748).
  // A single uncomputable side unknowns the whole row, never a known-subset value.
  const bouncebackPartsHeard = sumKnown(played, (team) => team.bouncebackPartsHeard);
  const bouncebackPartsConverted = sumKnown(played, (team) => team.bouncebackPartsConverted);
  const bonusPartsHeard = sumKnown(played, (team) => team.bonusPartsHeard);
  const bonusPartsConverted = sumKnown(played, (team) => team.bonusPartsConverted);
  const bouncebackConversion =
    bouncebackPartsHeard !== null && bouncebackPartsHeard > 0 && bouncebackPartsConverted !== null
      ? bouncebackPartsConverted / bouncebackPartsHeard
      : null;
  const totalBonusConversion =
    bonusPartsHeard !== null &&
    bonusPartsConverted !== null &&
    bouncebackPartsHeard !== null &&
    bouncebackPartsConverted !== null &&
    bonusPartsHeard + bouncebackPartsHeard > 0
      ? (bonusPartsConverted + bouncebackPartsConverted) / (bonusPartsHeard + bouncebackPartsHeard)
      : null;
  const partsPresent = played.some((game) => {
    const teams = allKnownTeamStats(game);
    return teams !== null && teams.every((team) => finite(team.bouncebackPartsHeard));
  });
  const lightningPoints = sumKnown(played, (team) => team.lightningPoints);
  const lightningRate =
    lightningPoints !== null && played.length > 0 ? lightningPoints / (played.length * 2) : null;
  const lightningPresent = played.some((game) => {
    const teams = allKnownTeamStats(game);
    return teams !== null && teams.every((team) => finite(team.lightningPoints));
  });

  let normalizedPointsSum: number | null = regulationTossups === null || played.length === 0 ? null : 0;
  if (normalizedPointsSum !== null && regulationTossups !== null) {
    for (let index = 0; index < played.length; index += 1) {
      const game = played[index]!;
      const regulationTuh = regulationTuhForGame(game);
      const regulationOne = regulationPointsForTeam(game, game.teamOnePoints, 0);
      const regulationTwo = regulationPointsForTeam(game, game.teamTwoPoints, 1);
      if (regulationTuh === null || regulationOne === null || regulationTwo === null) {
        normalizedPointsSum = null;
        break;
      }
      normalizedPointsSum += ((regulationOne + regulationTwo) / 2) * (regulationTossups / regulationTuh);
    }
  }
  const pointsPerTeamPerXTuh =
    normalizedPointsSum !== null && played.length > 0 ? normalizedPointsSum / played.length : null;

  const tossupConversionRate =
    positiveConversions !== null && totalTossupsRead !== null && totalTossupsRead > 0
      ? positiveConversions / totalTossupsRead
      : null;
  const powerRate =
    hasPowers &&
    powerApplicabilityKnown &&
    allUsePowers &&
    powers !== null &&
    positiveConversions !== null &&
    positiveConversions > 0
      ? powers / positiveConversions
      : null;
  const superpowerRate =
    hasSuperpowers &&
    superpowerApplicabilityKnown &&
    allUseSuperpowers &&
    superpowers !== null &&
    positiveConversions !== null &&
    positiveConversions > 0
      ? superpowers / positiveConversions
      : null;
  const negRatePerXTuh =
    regulationTossups !== null && negs !== null && totalTossupsRead !== null && totalTossupsRead > 0
      ? (negs / totalTossupsRead) * regulationTossups
      : null;

  const detailGames = played.filter((game) => {
    const teamRows = allKnownTeamStats(game);
    return (
      teamRows !== null &&
      teamRows.every((team) => [team.superpowers, team.powers, team.gets, team.negs].every(finite))
    );
  }).length;

  const normallyApplicable = [
    pointsPerTeamPerXTuh,
    tossupConversionRate,
    negRatePerXTuh,
    ...(hasPowers ? [powerRate] : []),
    ...(hasSuperpowers ? [superpowerRate] : []),
    ...(hasBonuses ? [ppb] : []),
    ...(bonusConversionApplicable ? [bonusConversionRate] : []),
    ...(partsPresent ? [bouncebackConversion, totalBonusConversion] : []),
    ...(lightningPresent ? [lightningRate] : []),
  ];
  const partial =
    excludedForfeits > 0 ||
    played.length === 0 ||
    normallyApplicable.some((value) => value === null) ||
    played.some((game) => game.detail === 'partial');

  return {
    row: {
      roundId,
      roundName,
      phaseId: phase.phaseId,
      phaseName: phase.phaseName,
      packetName: packet.packetName,
      packetMixed: packet.packetMixed,
      results: unique.length,
      games: played.length,
      teams,
      regulationTossups,
      tossupsRead: totalTossupsRead,
      pointsPerTeamPerXTuh,
      superpowerRate,
      powerRate,
      tossupConversionRate,
      negRatePerXTuh,
      ppb,
      bonusConversionRate,
      bouncebackPartsHeard,
      bouncebackPartsConverted,
      bouncebackConversion,
      totalBonusConversion,
      lightningPoints,
      lightningRate,
      detailGames,
      excludedForfeits,
      partial,
    },
    hasSuperpowers,
    hasPowers,
    hasBonuses,
    bonusConversionApplicable,
  };
}

/**
 * Derive round statistics from accepted, already-normalized report games.
 *
 * Formulas:
 * - Pts/team/X TUH: normalize each game's average team score to that round's
 *   common regulation X, then average the normalized game values.
 * - TU Conv %: (superpowers + powers + gets) / tossups read.
 * - Power %: powers / all positive tossup conversions. Superpower % is the
 *   analogous rate when a separate superpower tier exists.
 * - Negs/X: negs / tossups read * regulation X.
 * - PPB: total bonus points / total bonuses heard.
 * - Bonus Conv %: total bonus points / sum(BH * that game's max bonus score).
 * - BB %: bounceback parts converted / parts heard, summed from the adapter's
 *   per-team-game parts (#748); null unless every included side is computable.
 * - Total Bonus %: (own + bounceback converted parts) / (own + bounceback parts
 *   heard) under the same whole-row knownness.
 * - Lightning: summed known lightning points; rate is points per team per game.
 *
 * Any metric whose required denominator/detail is missing for one included game
 * is null for the whole row. The overall row runs these same formulas across
 * all games; it never averages already-rounded round percentages.
 */
export function deriveRoundStats(games: readonly GameStatsRow[]): RoundStatsReport {
  const groups = groupByRound(games);
  const aggregates = groups.map((group) => aggregate(group.roundId, group.roundName, group.games));
  const allGames = uniqueGames(games);
  const total = aggregate(null, 'Overall', allGames);
  const phaseNames = new Set(
    aggregates.map(({ row }) => row.phaseName).filter((value): value is string => Boolean(value)),
  );
  const phaseIds = new Set(
    aggregates.map(({ row }) => row.phaseId).filter((value): value is string => Boolean(value)),
  );

  const allRows = [...aggregates.map(({ row }) => row), total.row];
  return {
    rows: aggregates.map(({ row }) => row),
    total: total.row,
    showPhase: phaseNames.size > 1 || phaseIds.size > 1,
    showSuperpowers: aggregates.some((value) => value.hasSuperpowers) || total.hasSuperpowers,
    showPowers: aggregates.some((value) => value.hasPowers) || total.hasPowers,
    showBonuses: aggregates.some((value) => value.hasBonuses) || total.hasBonuses,
    showBonusConversion:
      aggregates.some((value) => value.bonusConversionApplicable) || total.bonusConversionApplicable,
    showBouncebacks: allRows.some((row) => row.bouncebackPartsHeard !== null),
    showLightning: allRows.some((row) => row.lightningPoints !== null),
    hasMixedRegulation:
      total.row.regulationTossups === null && aggregates.some(({ row }) => row.regulationTossups !== null),
  };
}

/** Attach a pure round-stat derivation to an otherwise complete snapshot. */
export function withRoundStats(snapshot: StatsSnapshot): StatsSnapshot {
  return { ...snapshot, roundStats: deriveRoundStats(snapshot.games) };
}
