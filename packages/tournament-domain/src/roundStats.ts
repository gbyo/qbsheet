import { type DirectorId, type DirectorState, type GameRecord } from './model.js';
import { gameDetailedCountsKnown } from './canonicalStats.js';
import { orderDayItems } from './dayOrder.js';
import {
  acceptedGameRecords,
  bouncebackPartsHeardForTeam,
  type DirectorStandingsOptions,
  isPureForfeitPlaceholder,
  rulesForGame,
} from './stats.js';

export interface RoundStatsRow {
  roundId: DirectorId;
  roundName: string;
  phaseId?: DirectorId;
  /** All accepted competitive results in the round, including forfeits. */
  games: number;
  /** Games eligible for scoring aggregates. Scoreless administrative forfeits are excluded. */
  playedGames: number;
  /** Played games whose detailed count fields are trustworthy. */
  detailedGames: number;
  /** Average final points scored by one team in an eligible played game. */
  pointsPerTeam: number | null;
  superpowers: number | null;
  powers: number | null;
  gets: number | null;
  negs: number | null;
  bonusesHeard: number | null;
  bonusPoints: number | null;
  ppb: number | null;
  /** Bounceback points converted in the round; null unless every eligible game known (#748). */
  bouncebacks: number | null;
  /**
   * Bounceback parts heard in the round (opponents' unconverted bonus value in parts).
   * Null unless every contributing game has the detail and regular rules the parts
   * denominator requires; pure-forfeit placeholders are skipped, never unknowning.
   */
  bouncebackPartsHeard: number | null;
  /** Bounceback parts converted in the round; null under the same conditions. */
  bouncebackPartsConverted: number | null;
  /** Bounceback conversion as a fraction of parts heard; null unless parts are known and heard. */
  bouncebackConversion: number | null;
  /**
   * Total bonus conversion as a fraction (own + bounceback converted parts over own +
   * bounceback parts heard); null unless every part of the denominator is known.
   */
  totalBonusConversion: number | null;
  /** Contributing games whose bounceback parts are uncomputable (unknown detail or irregular rules). */
  bouncebackUnknownGames: number;
  /** Exact tossups read are not yet persisted on Director GameRecord. */
  tossupsRead: number | null;
  /** Reserved for the normalized metric once exact per-game tossup denominators are canonical. */
  pointsPerTeamPerXTuh: number | null;
  powerRate: number | null;
  tossupConversionRate: number | null;
  negRatePerXTuh: number | null;
  packetIds: DirectorId[];
}

function hasRecordedPlayDetail(game: GameRecord): boolean {
  if (game.detailedStats === 'complete' || game.playerStats.length > 0) return true;
  return game.scores.some(
    (score) =>
      score.superpowers > 0 ||
      score.powers > 0 ||
      score.gets > 0 ||
      score.negs > 0 ||
      score.bonuses > 0 ||
      score.bonusPoints > 0 ||
      (score.bouncebacks ?? 0) > 0,
  );
}

function eligibleForScoringAggregates(game: GameRecord): boolean {
  // Administrative forfeits count in standings/result totals, but a documentary 0-0 score is not
  // a played scoring sample. If exact played detail exists, keep it available for round analysis.
  return game.status !== 'forfeit' || hasRecordedPlayDetail(game);
}

/**
 * Derive round-level report facts from the same accepted-game selector used by standings.
 *
 * This intentionally exposes numerator/count aggregates before inventing tossup-normalized rates.
 * Director's persisted GameRecord does not yet carry exact tossups-read/overtime counts, so metrics
 * that require those denominators remain null until the source of truth can support them honestly.
 */
export function deriveRoundStats(
  state: DirectorState,
  options: DirectorStandingsOptions = {},
): RoundStatsRow[] {
  const games = acceptedGameRecords(state, options);
  const byRound = new Map<DirectorId, GameRecord[]>();
  for (const game of games) {
    const rows = byRound.get(game.roundId) ?? [];
    rows.push(game);
    byRound.set(game.roundId, rows);
  }

  const roundById = new Map(state.rounds.map((round) => [round.id, round]));
  const dayOrder = new Map<DirectorId, number>();
  orderDayItems(state.rounds, state.timeline).forEach((entry, index) => {
    if (entry.kind === 'round' && entry.round) dayOrder.set(entry.round.id, index);
  });

  return [...byRound.entries()]
    .sort(
      ([leftId], [rightId]) =>
        (dayOrder.get(leftId) ?? Number.MAX_SAFE_INTEGER) -
          (dayOrder.get(rightId) ?? Number.MAX_SAFE_INTEGER) || leftId.localeCompare(rightId),
    )
    .map(([roundId, roundGames]) => {
      const round = roundById.get(roundId);
      const played = roundGames.filter(eligibleForScoringAggregates);
      const detailed = played.filter(gameDetailedCountsKnown);
      const detailComplete = played.length > 0 && detailed.length === played.length;
      const points = played.reduce(
        (sum, game) => sum + game.scores.reduce((gameSum, score) => gameSum + score.score, 0),
        0,
      );
      const count = <K extends 'superpowers' | 'powers' | 'gets' | 'negs' | 'bonuses' | 'bonusPoints'>(
        key: K,
      ): number | null =>
        detailComplete
          ? detailed.reduce(
              (sum, game) => sum + game.scores.reduce((gameSum, score) => gameSum + score[key], 0),
              0,
            )
          : null;
      const bonusesHeard = count('bonuses');
      const bonusPoints = count('bonusPoints');
      const bouncebacksKnown = played.every(
        (game) => isPureForfeitPlaceholder(game) || game.scores.every((score) => score.bouncebacks !== null),
      );
      const bouncebacks =
        detailComplete && bouncebacksKnown
          ? played.reduce(
              (sum, game) =>
                sum + game.scores.reduce((gameSum, score) => gameSum + (score.bouncebacks ?? 0), 0),
              0,
            )
          : null;
      // Parts scope: pure-forfeit placeholders are skipped without unknowning the round;
      // every other eligible game must supply detail, regular rules, and a breakdown.
      let bouncebackPartsHeard = 0;
      let bouncebackPartsConverted = 0;
      let ownPartsHeard = 0;
      let ownPartsConverted = 0;
      let bouncebackPartsKnown = true;
      let bouncebackUnknownGames = 0;
      for (const game of played) {
        if (isPureForfeitPlaceholder(game)) continue;
        const rules = rulesForGame(state, game);
        const [left, right] = game.scores;
        // A side with no breakdown where the stored definition defines no bouncebacks
        // is N/A rather than unknown; a game excused on both sides contributes
        // nothing at all (#755).
        const sideExcused = (bouncebacks: number | null | undefined): boolean =>
          // An omitted breakdown is the legacy zero shorthand (aggregates
          // as-entered below); only explicit null takes the N/A path, matching
          // accumulateBouncebackSide in stats.ts.
          bouncebacks === null && !!rules && !rules.bouncebacks && !!game.definitionDigest;
        if (!left || !right) {
          bouncebackPartsKnown = false;
          bouncebackUnknownGames += 1;
          continue;
        }
        if (sideExcused(left.bouncebacks) && sideExcused(right.bouncebacks)) continue;
        const leftHeard =
          rules && gameDetailedCountsKnown(game)
            ? bouncebackPartsHeardForTeam(right.bonuses, right.bonusPoints, rules)
            : null;
        const rightHeard =
          rules && gameDetailedCountsKnown(game)
            ? bouncebackPartsHeardForTeam(left.bonuses, left.bonusPoints, rules)
            : null;
        if (
          !rules ||
          leftHeard === null ||
          rightHeard === null ||
          (!sideExcused(left.bouncebacks) && left.bouncebacks === null) ||
          (!sideExcused(right.bouncebacks) && right.bouncebacks === null) ||
          !(rules.bonusValue > 0)
        ) {
          bouncebackPartsKnown = false;
          bouncebackUnknownGames += 1;
          continue;
        }
        bouncebackPartsHeard += leftHeard + rightHeard;
        bouncebackPartsConverted += ((left.bouncebacks ?? 0) + (right.bouncebacks ?? 0)) / rules.bonusValue;
        ownPartsHeard += (left.bonuses + right.bonuses) * rules.bonusParts;
        ownPartsConverted += (left.bonusPoints + right.bonusPoints) / rules.bonusValue;
      }
      const knownBbHeard = bouncebackPartsKnown ? bouncebackPartsHeard : null;
      const knownBbConverted = bouncebackPartsKnown ? bouncebackPartsConverted : null;
      const packetIds = [
        ...new Set(roundGames.map((game) => game.packetId).filter((id): id is string => id !== null)),
      ];

      return {
        roundId,
        roundName: round?.name ?? roundId,
        ...(round?.phaseId ? { phaseId: round.phaseId } : {}),
        games: roundGames.length,
        playedGames: played.length,
        detailedGames: detailed.length,
        pointsPerTeam: played.length > 0 ? points / (played.length * 2) : null,
        superpowers: count('superpowers'),
        powers: count('powers'),
        gets: count('gets'),
        negs: count('negs'),
        bonusesHeard,
        bonusPoints,
        bouncebacks,
        bouncebackPartsHeard: knownBbHeard,
        bouncebackPartsConverted: knownBbConverted,
        bouncebackConversion:
          knownBbConverted !== null && knownBbHeard !== null && knownBbHeard > 0
            ? knownBbConverted / knownBbHeard
            : null,
        totalBonusConversion:
          knownBbConverted !== null &&
          knownBbHeard !== null &&
          bouncebackPartsKnown &&
          ownPartsHeard + bouncebackPartsHeard > 0
            ? (ownPartsConverted + bouncebackPartsConverted) / (ownPartsHeard + bouncebackPartsHeard)
            : null,
        bouncebackUnknownGames,
        ppb:
          bonusesHeard !== null && bonusPoints !== null && bonusesHeard > 0
            ? bonusPoints / bonusesHeard
            : null,
        tossupsRead: null,
        pointsPerTeamPerXTuh: null,
        powerRate: null,
        tossupConversionRate: null,
        negRatePerXTuh: null,
        packetIds,
      };
    });
}
