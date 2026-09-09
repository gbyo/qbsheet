/**
 * The canonical reporting adapter.
 *
 * Director, Live, CSV, HTML, advancement, and SQBS must never disagree about
 * who is first, so every report surface below is derived from the canonical
 * standings engine (`@qbsheet/tournament-domain`) and serialized through the
 * shared snapshot DTO. Nothing here ranks, aggregates, or re-scores: it maps
 * engine output onto rows, applies the explicit final placement to the overall
 * scope only, and leaves unknown statistics null for honest rendering.
 */

import {
  acceptedGameRecords,
  applyFinalPlacement,
  derivePlayerStandings,
  deriveTeamStandings,
  gameDetailedCountsKnown,
  orderDayItems,
  playerPoints,
  type DirectorState,
  type GameRecord,
} from '../domain';
import type {
  GamePlayerStatsRow,
  GameStatsRow,
  GameTeamStatsRow,
  PlayerStatsRow,
  StatsSnapshot,
  TeamStatsRow,
} from '@qbsheet/tournament-formats';
import { matchObject } from '../transfers/parse';
import { classificationLabels, teamClassificationsOf } from '../standings/statsDisplay';
import { deriveRoundReportData } from './roundReportData';

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

function qbjNonNegativeInteger(game: GameRecord, field: string): number | null {
  const match = matchObject(game.rawQbj);
  const value = match?.[field];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
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

  const games: GameStatsRow[] = acceptedGameRecords(state, scoped)
    .slice()
    .sort(
      (left, right) =>
        (dayIndex.get(left.roundId) ?? Number.MAX_SAFE_INTEGER) -
          (dayIndex.get(right.roundId) ?? Number.MAX_SAFE_INTEGER) || left.id.localeCompare(right.id),
    )
    .map((game) => {
      const [left, right] = game.scores;
      const scheduled = scheduledById.get(game.scheduledGameId);
      const detailedCountsKnown = gameDetailedCountsKnown(game);
      const resolvedPacketId = game.packetId ?? scheduled?.packetId ?? undefined;
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
      return {
        gameId: game.id,
        ...(roundPhase.get(game.roundId) ? { phaseId: roundPhase.get(game.roundId) } : {}),
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
        // Exact denominators come only from the accepted result's own QBJ evidence. A legacy/manual
        // score without that field stays unknown; report generation never substitutes today's rules.
        tossupsRead: qbjNonNegativeInteger(game, 'tossups_read'),
        overtimeTossupsRead: qbjNonNegativeInteger(game, 'overtime_tossups_read'),
        teamStats,
        playerStats,
      };
    });

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
    roundReport: deriveRoundReportData(state, scope),
    extensions: {
      scopeLabel: scope.label,
      finalPlacementApplied: isOverall && state.tournament?.finalPlacement !== undefined,
      ...(isOverall && state.tournament?.finalPlacement?.reason
        ? { finalPlacementReason: state.tournament.finalPlacement.reason }
        : {}),
    },
  };
}