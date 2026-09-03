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
  orderDayItems,
  playerPoints,
  type DirectorState,
} from '../domain';
import type { GameStatsRow, PlayerStatsRow, StatsSnapshot, TeamStatsRow } from '@qbsheet/tournament-formats';
import { classificationLabels, teamClassificationsOf } from '../standings/statsDisplay';

export interface CanonicalReportScope {
  phaseId?: string;
  poolId?: string;
  label: string;
}

export const overallReportScope: CanonicalReportScope = { label: 'Overall' };

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
      teamName: state.teams.find((team) => team.id === standing.teamId)?.displayName ?? standing.teamId,
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
        teamName: state.teams.find((team) => team.id === standing.teamId)?.displayName ?? standing.teamId,
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
      const teamName = (teamId: string | undefined): string =>
        state.teams.find((team) => team.id === teamId)?.displayName ?? teamId ?? '';
      return {
        gameId: game.id,
        ...(roundPhase.get(game.roundId) ? { phaseId: roundPhase.get(game.roundId) } : {}),
        roundId: game.roundId,
        ...(roundName.get(game.roundId) ? { roundName: roundName.get(game.roundId) } : {}),
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
    extensions: {
      scopeLabel: scope.label,
      finalPlacementApplied: isOverall && state.tournament?.finalPlacement !== undefined,
      ...(isOverall && state.tournament?.finalPlacement?.reason
        ? { finalPlacementReason: state.tournament.finalPlacement.reason }
        : {}),
    },
  };
}
