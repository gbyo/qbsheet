/**
 * The canonical reporting adapter.
 *
 * Director, Live, CSV, HTML, advancement, and SQBS must never disagree about
 * who is first, so report surfaces are derived from the canonical standings
 * engine (`@qbsheet/tournament-domain`) and serialized through the shared
 * snapshot DTO. Round-level competitive aggregates are likewise delegated to
 * the pure tournament-domain derivation: this adapter only resolves canonical
 * per-game facts, including historical QBJ denominators, into that input.
 */

import {
  acceptedGameRecords,
  applyFinalPlacement,
  derivePlayerStandings,
  deriveRoundStats,
  deriveTeamStandings,
  gameDetailedCountsKnown,
  orderDayItems,
  playerPoints,
  type DirectorState,
  type GameRecord,
  type RoundStatsGameFacts,
} from '../domain';
import type {
  GamePlayerStatsRow,
  GameStatsRow,
  GameTeamStatsRow,
  PlayerStatsRow,
  StatsSnapshot,
  TeamStatsRow,
} from '@qbsheet/tournament-formats';
import { classificationLabels, teamClassificationsOf } from '../standings/statsDisplay';

export interface CanonicalReportScope {
  phaseId?: string;
  poolId?: string;
  label: string;
}

export const overallReportScope: CanonicalReportScope = { label: 'Overall' };

function teamTossupsHeard(game: GameRecord, teamId: string): number | null {
  const lines = game.playerStats.filter((stat) => stat.teamId === teamId);
  if (lines.length === 0 || lines.some((stat) => stat.tossupsHeard === null)) return null;
  return lines.reduce((sum, stat) => sum + (stat.tossupsHeard ?? 0), 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function qbjObjects(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value)) return [];
  if (Array.isArray(value.objects)) return value.objects.filter(isRecord);
  return [value];
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function finitePositive(value: unknown): number | null {
  const number = finiteNonNegative(value);
  return number !== null && number > 0 ? number : null;
}

function refId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (typeof value.$ref === 'string' && value.$ref.trim()) return value.$ref;
  if (typeof value.id === 'string' && value.id.trim()) return value.id;
  return null;
}

interface HistoricalGameDefinition {
  tossupsRead: number | null;
  overtimeTossupsRead: number | null;
  regulationTossupCount: number | null;
  maximumBonusScore: number | null;
  superpowerApplicable: boolean | null;
  powerApplicable: boolean | null;
  negApplicable: boolean | null;
  bonusApplicable: boolean | null;
}

function historicalGameDefinition(game: GameRecord): HistoricalGameDefinition {
  const objects = qbjObjects(game.rawQbj);
  const matches = objects.filter((entry) => entry.type === 'Match');
  const match =
    matches.find((entry) => entry.id === game.scheduledGameId || entry.id === game.id) ??
    (matches.length === 1 ? matches[0] : undefined);
  const tournament = objects.find((entry) => entry.type === 'Tournament');
  const scoringRef = refId(tournament?.scoring_rules);
  const scoringRules =
    (scoringRef
      ? objects.find((entry) => entry.type === 'ScoringRules' && entry.id === scoringRef)
      : undefined) ??
    (objects.filter((entry) => entry.type === 'ScoringRules').length === 1
      ? objects.find((entry) => entry.type === 'ScoringRules')
      : undefined);

  const answerTypes = scoringRules && Array.isArray(scoringRules.answer_types) ? scoringRules.answer_types : null;
  const resolvedAnswerTypes =
    answerTypes?.map((entry) => {
      if (isRecord(entry) && entry.type === 'AnswerType') return entry;
      const id = refId(entry);
      return id ? objects.find((object) => object.type === 'AnswerType' && object.id === id) : undefined;
    }) ?? [];
  const answerKind = (answer: Record<string, unknown> | undefined): 'superpower' | 'power' | 'neg' | null => {
    if (!answer) return null;
    const short = typeof answer.short_label === 'string' ? answer.short_label.trim().toUpperCase() : '';
    const label = typeof answer.label === 'string' ? answer.label.trim().toLowerCase() : '';
    if (short === 'SP' || label.includes('superpower')) return 'superpower';
    if (short === 'P' || label === 'power') return 'power';
    if (short === 'N' || label === 'neg' || label.includes('interrupt')) return 'neg';
    return null;
  };
  const kinds = resolvedAnswerTypes.map(answerKind);
  const answerApplicability = (kind: 'superpower' | 'power' | 'neg'): boolean | null => {
    if (!scoringRules || answerTypes === null) return null;
    return kinds.includes(kind);
  };

  let maximumBonusScore = finitePositive(scoringRules?.maximum_bonus_score);
  if (maximumBonusScore === null) {
    const perPart = finitePositive(scoringRules?.points_per_bonus_part);
    const parts = finitePositive(scoringRules?.maximum_parts_per_bonus);
    if (perPart !== null && parts !== null) maximumBonusScore = perPart * parts;
  }
  const bonusFields = [
    'maximum_bonus_score',
    'bonus_divisor',
    'minimum_parts_per_bonus',
    'maximum_parts_per_bonus',
    'points_per_bonus_part',
    'bonuses_bounce_back',
  ];
  const bonusApplicable = scoringRules
    ? bonusFields.some((field) => Object.prototype.hasOwnProperty.call(scoringRules, field))
    : null;

  return {
    tossupsRead: finiteNonNegative(match?.tossups_read),
    overtimeTossupsRead: finiteNonNegative(match?.overtime_tossups_read),
    regulationTossupCount: finitePositive(scoringRules?.regulation_tossup_count),
    maximumBonusScore,
    superpowerApplicable: answerApplicability('superpower'),
    powerApplicable: answerApplicability('power'),
    negApplicable: answerApplicability('neg'),
    bonusApplicable,
  };
}

function forfeitHasPlayedStatistics(game: GameRecord, historical: HistoricalGameDefinition): boolean {
  if (game.status !== 'forfeit') return true;
  if ((historical.tossupsRead ?? 0) > 0 || game.playerStats.length > 0) return true;
  return game.scores.some(
    (score) =>
      score.score !== 0 ||
      score.superpowers !== 0 ||
      score.powers !== 0 ||
      score.gets !== 0 ||
      score.negs !== 0 ||
      score.bonuses !== 0 ||
      score.bonusPoints !== 0 ||
      score.bouncebacks !== 0,
  );
}

export function buildCanonicalSnapshot(
  state: DirectorState,
  scope: CanonicalReportScope = overallReportScope,
  generatedAt = new Date().toISOString(),
): StatsSnapshot {
  const scoped = {
    ...(scope.phaseId !== undefined ? { phaseId: scope.phaseId } : {}),
    ...(scope.poolId !== undefined ? { poolId: scope.poolId } : {}),
  };
  const isOverall = scope.phaseId === undefined && scope.poolId === undefined;
  const calculated = deriveTeamStandings(state, undefined, scoped);
  const calculatedRank = new Map(calculated.map((standing, index) => [standing.teamId, index + 1]));
  const ordered = isOverall ? applyFinalPlacement(calculated, state.tournament?.finalPlacement) : calculated;

  const roundName = new Map(state.rounds.map((round) => [round.id, round.name]));
  const roundPhase = new Map(state.rounds.map((round) => [round.id, round.phaseId]));
  const phaseName = new Map(state.phases.map((phase) => [phase.id, phase.name]));
  const scheduledById = new Map(state.scheduledGames.map((game) => [game.id, game]));
  const packetName = new Map(state.packets.map((packet) => [packet.id, packet.name]));
  const teamName = (teamId: string | undefined): string =>
    state.teams.find((team) => team.id === teamId)?.displayName ?? teamId ?? '';
  const playerName = (playerId: string): string =>
    state.players.find((player) => player.id === playerId)?.name ?? playerId;
  const dayIndex = new Map<string, number>();
  orderDayItems(state.rounds, state.timeline).forEach((entry, index) => {
    if (entry.kind === 'round' && entry.round) dayIndex.set(entry.round.id, index);
  });

  const teams: TeamStatsRow[] = ordered.map((standing, index) => {
    const classifications = teamClassificationsOf(state, standing.teamId).map(
      (entry) => classificationLabels[entry],
    );
    return {
      rank: index + 1,
      ...(calculatedRank.get(standing.teamId) !== index + 1
        ? { calculatedRank: calculatedRank.get(standing.teamId) }
        : {}),
      teamId: standing.teamId,
      teamName: teamName(standing.teamId),
      ...(classifications.length > 0 ? { classifications } : {}),
      gamesPlayed: standing.gamesPlayed,
      wins: standing.wins,
      losses: standing.losses,
      ties: standing.ties,
      winPercentage: standing.winPercentage,
      pointsFor: standing.pointsFor,
      pointsAgainst: standing.pointsAgainst,
      ppg: standing.gamesPlayed > 0 ? standing.pointsFor / standing.gamesPlayed : 0,
      papg: standing.gamesPlayed > 0 ? standing.pointsAgainst / standing.gamesPlayed : 0,
      margin: standing.margin,
      superpowers: standing.superpowers,
      powers: standing.powers,
      gets: standing.gets,
      negs: standing.negs,
      tossupsHeard: standing.tossupsHeard,
      tossupsHeardKnown: standing.tossupsHeardKnown,
      pptuh:
        standing.tossupsHeardKnown && standing.tossupsHeard > 0
          ? standing.pointsFor / standing.tossupsHeard
          : null,
      bonusPoints: standing.bonusPoints,
      bonusesHeard: standing.bonuses,
      ppb: standing.bonuses > 0 ? standing.bonusPoints / standing.bonuses : null,
    };
  });

  const rules = state.tournament?.rules;
  const players: PlayerStatsRow[] = derivePlayerStandings(state, scoped)
    .filter((standing) => standing.gamesPlayed > 0)
    .map((standing, index) => {
      const player = state.players.find((entry) => entry.id === standing.playerId);
      const points = playerPoints(standing, rules);
      return {
        rank: index + 1,
        playerId: standing.playerId,
        playerName: player?.name ?? standing.playerId,
        teamId: standing.teamId,
        teamName: teamName(standing.teamId),
        ...(typeof player?.schoolYear === 'number' ? { schoolYear: player.schoolYear } : {}),
        gamesPlayed: standing.gamesPlayed,
        tossupsHeard: standing.tossupsHeardKnown ? standing.tossupsHeard : null,
        superpowers: standing.superpowers,
        powers: standing.powers,
        gets: standing.gets,
        negs: standing.negs,
        points,
        ppg: standing.gamesPlayed > 0 ? points / standing.gamesPlayed : 0,
        pptuh:
          standing.tossupsHeardKnown && standing.tossupsHeard > 0 ? points / standing.tossupsHeard : null,
        // Director scoresheets record bonus points per player but not
        // bonuses heard, so individual PPB is declined (null) rather than
        // estimated. Team PPB above uses the real team-level count.
        bonusesHeard: 0,
        bonusPoints: standing.bonusPoints,
        ppb: null,
      };
    });

  const acceptedGames = acceptedGameRecords(state, scoped)
    .slice()
    .sort(
      (left, right) =>
        (dayIndex.get(left.roundId) ?? Number.MAX_SAFE_INTEGER) -
          (dayIndex.get(right.roundId) ?? Number.MAX_SAFE_INTEGER) || left.id.localeCompare(right.id),
    );
  const roundFacts: RoundStatsGameFacts[] = [];
  const games: GameStatsRow[] = acceptedGames.map((game) => {
    const [left, right] = game.scores;
    const scheduled = scheduledById.get(game.scheduledGameId);
    const detailedCountsKnown = gameDetailedCountsKnown(game);
    const detailComplete = game.detailedStats !== 'unknown' && game.detailedStats !== 'incomplete';
    const resolvedPacketId = game.packetId ?? scheduled?.packetId ?? undefined;
    const historical = historicalGameDefinition(game);
    const teamStats: GameTeamStatsRow[] = game.scores.map((score) => {
      const tossupsHeard = teamTossupsHeard(game, score.teamId);
      return {
        teamId: score.teamId,
        teamName: teamName(score.teamId),
        points: score.score,
        superpowers: detailedCountsKnown ? score.superpowers : null,
        powers: detailedCountsKnown ? score.powers : null,
        gets: detailedCountsKnown ? score.gets : null,
        negs: detailedCountsKnown ? score.negs : null,
        tossupsHeard,
        bonusesHeard: detailedCountsKnown ? score.bonuses : null,
        bonusPoints: detailedCountsKnown ? score.bonusPoints : null,
        ppb: detailedCountsKnown && score.bonuses > 0 ? score.bonusPoints / score.bonuses : null,
        bouncebacks: detailedCountsKnown ? score.bouncebacks : null,
      };
    });
    const playerStats: GamePlayerStatsRow[] = game.playerStats.map((stat) => ({
      playerId: stat.playerId,
      playerName: playerName(stat.playerId),
      teamId: stat.teamId,
      teamName: teamName(stat.teamId),
      tossupsHeard: stat.tossupsHeard,
      superpowers: detailedCountsKnown ? stat.superpowers : null,
      powers: detailedCountsKnown ? stat.powers : null,
      gets: detailedCountsKnown ? stat.gets : null,
      negs: detailedCountsKnown ? stat.negs : null,
      bonusPoints: detailedCountsKnown ? stat.bonusPoints : null,
      points: detailedCountsKnown ? playerPoints(stat, rules) : null,
    }));

    const phaseId = roundPhase.get(game.roundId);
    roundFacts.push({
      gameId: game.id,
      roundId: game.roundId,
      roundName: roundName.get(game.roundId) ?? game.roundId,
      ...(phaseId ? { phaseId, phaseName: phaseName.get(phaseId) } : {}),
      packetId: resolvedPacketId ?? null,
      packetName: resolvedPacketId ? packetName.get(resolvedPacketId) ?? null : null,
      teamIds: game.scores.map((score) => score.teamId),
      teamPoints: game.scores.map((score) => score.score),
      played: forfeitHasPlayedStatistics(game, historical),
      detailComplete,
      tossupsRead: historical.tossupsRead,
      regulationTossupCount: historical.regulationTossupCount,
      superpowers: detailComplete ? game.scores.reduce((sum, score) => sum + score.superpowers, 0) : null,
      powers: detailComplete ? game.scores.reduce((sum, score) => sum + score.powers, 0) : null,
      gets: detailComplete ? game.scores.reduce((sum, score) => sum + score.gets, 0) : null,
      negs: detailComplete ? game.scores.reduce((sum, score) => sum + score.negs, 0) : null,
      bonusesHeard: detailComplete ? game.scores.reduce((sum, score) => sum + score.bonuses, 0) : null,
      bonusPoints: detailComplete ? game.scores.reduce((sum, score) => sum + score.bonusPoints, 0) : null,
      maximumBonusScore: historical.maximumBonusScore,
      superpowerApplicable: historical.superpowerApplicable,
      powerApplicable: historical.powerApplicable,
      negApplicable: historical.negApplicable,
      bonusApplicable: historical.bonusApplicable,
    });

    return {
      gameId: game.id,
      ...(phaseId ? { phaseId } : {}),
      roundId: game.roundId,
      ...(scheduled?.poolId ? { poolId: scheduled.poolId } : {}),
      ...(roundName.get(game.roundId) ? { roundName: roundName.get(game.roundId) } : {}),
      ...(resolvedPacketId ? { packetId: resolvedPacketId } : {}),
      ...(resolvedPacketId && packetName.get(resolvedPacketId)
        ? { packetName: packetName.get(resolvedPacketId) }
        : {}),
      ...(game.forfeitedTeamId ? { forfeitedTeamId: game.forfeitedTeamId } : {}),
      teamOneId: left?.teamId ?? '',
      teamOneName: teamName(left?.teamId),
      ...(left?.score === undefined ? {} : { teamOnePoints: left.score }),
      teamTwoId: right?.teamId ?? '',
      teamTwoName: teamName(right?.teamId),
      ...(right?.score === undefined ? {} : { teamTwoPoints: right.score }),
      ...(left && right && left.score !== right.score
        ? { winnerId: left.score > right.score ? left.teamId : right.teamId }
        : {}),
      status: game.status,
      detail:
        game.detailedStats === 'incomplete' || game.detailedStats === 'unknown' ? 'partial' : 'complete',
      tossupsRead: historical.tossupsRead,
      overtimeTossupsRead: historical.overtimeTossupsRead,
      teamStats,
      playerStats,
    };
  });
  const roundReport = deriveRoundStats(roundFacts);

  return {
    format: 'qbsheet-stats' as const,
    version: 1,
    generatedAt,
    tournament: {
      id: state.tournament?.id ?? 'tournament',
      name: state.tournament?.name ?? 'Tournament',
    },
    teams,
    players,
    games,
    rounds: roundReport.rows,
    roundTotal: roundReport.total,
    extensions: {
      scopeLabel: scope.label,
      finalPlacementApplied: isOverall && state.tournament?.finalPlacement !== undefined,
      ...(isOverall && state.tournament?.finalPlacement?.reason
        ? { finalPlacementReason: state.tournament.finalPlacement.reason }
        : {}),
    },
  };
}
