import {
  type DirectorId,
  type DirectorState,
  type GameRecord,
  type PlayerGameStat,
  type TournamentRules,
} from './model';

export interface TeamStanding {
  teamId: DirectorId;
  wins: number;
  losses: number;
  ties: number;
  winPercentage: number;
  pointsFor: number;
  pointsAgainst: number;
  margin: number;
  powers: number;
  gets: number;
  negs: number;
  bonuses: number;
  bonusPoints: number;
  gamesPlayed: number;
  headToHead: number;
}

export interface PlayerStanding {
  playerId: DirectorId;
  teamId: DirectorId;
  gamesPlayed: number;
  tossupsHeard: number;
  /** False when at least one contributing scoresheet did not report TUH. */
  tossupsHeardKnown?: boolean;
  powers: number;
  gets: number;
  negs: number;
  bonusPoints: number;
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
          (left.acceptedAt ?? left.receivedAt).localeCompare(right.acceptedAt ?? right.receivedAt) ||
          left.id.localeCompare(right.id),
      )
      .at(-1);
    if (current) currentAcceptedSubmissionIds.add(current.id);
  }
  const requestedGameIds = options.gameIds ? new Set(options.gameIds) : null;
  const scheduledById = new Map(state.scheduledGames.map((game) => [game.id, game]));
  const roundById = new Map(state.rounds.map((round) => [round.id, round]));
  const accepted = state.games.filter((game) => {
    if (game.status !== 'accepted') return false;
    if (requestedGameIds && !requestedGameIds.has(game.scheduledGameId)) return false;
    const scheduled = scheduledById.get(game.scheduledGameId);
    // Older imported Director documents may contain accepted records before the corresponding
    // schedule projection was persisted. Keep those records in the unscoped historical report;
    // an explicit phase/pool/game scope must reject them because their ownership is unknown.
    if (!scheduled) {
      return options.phaseId === undefined && options.poolId === undefined && options.gameIds === undefined;
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
    if (
      !previous ||
      (gameHasCanonicalSubmission && !previousHasCanonicalSubmission) ||
      (gameHasCanonicalSubmission === previousHasCanonicalSubmission &&
        currentAt.localeCompare(previousAt) > 0) ||
      (gameHasCanonicalSubmission === previousHasCanonicalSubmission &&
        currentAt === previousAt &&
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
      powers: 0,
      gets: 0,
      negs: 0,
      bonuses: 0,
      bonusPoints: 0,
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
    leftStanding.powers += left.powers;
    leftStanding.gets += left.gets;
    leftStanding.negs += left.negs;
    leftStanding.bonuses += left.bonuses;
    leftStanding.bonusPoints += left.bonusPoints;
    rightStanding.powers += right.powers;
    rightStanding.gets += right.gets;
    rightStanding.negs += right.negs;
    rightStanding.bonuses += right.bonuses;
    rightStanding.bonusPoints += right.bonusPoints;
    if (left.score > right.score) {
      leftStanding.wins += 1;
      rightStanding.losses += 1;
    } else if (right.score > left.score) {
      rightStanding.wins += 1;
      leftStanding.losses += 1;
    } else {
      leftStanding.ties += 1;
      rightStanding.ties += 1;
    }
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
  const order = rules?.tiebreakers ?? ['record', 'points', 'margin', 'powers', 'gets'];
  let groups: TeamStanding[][] = [standings];
  for (const key of order) {
    groups = groups.flatMap((group) => {
      if (group.length < 2) return [group];
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
  switch (key) {
    case 'head-to-head':
      return headToHeadValue(standing.teamId, group, games);
    case 'record':
      return standing.winPercentage;
    case 'points':
      return standing.pointsFor;
    case 'margin':
      return standing.margin;
    case 'powers':
      return standing.powers;
    case 'gets':
      return standing.gets;
    default:
      return 0;
  }
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
    if (own.score > opponent.score) wins += 1;
    else if (own.score === opponent.score) wins += 0.5;
  }
  return gamesPlayed === 0 ? 0 : wins / gamesPlayed;
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
      tossupsHeard: 0,
      powers: 0,
      gets: 0,
      negs: 0,
      bonusPoints: 0,
      ppg: 0,
    });
  }
  const games = acceptedGameRecords(state, options);
  for (const game of games) {
    for (const stat of game.playerStats) {
      const standing = byPlayer.get(stat.playerId);
      if (!standing) continue;
      addPlayerGame(standing, stat);
    }
  }
  for (const standing of byPlayer.values()) {
    standing.ppg =
      standing.gamesPlayed === 0
        ? 0
        : (standing.powers * (state.tournament?.rules.powerValue ?? 15) +
            standing.gets * (state.tournament?.rules.tossupValue ?? 10) +
            standing.negs * (state.tournament?.rules.negValue ?? -5) +
            standing.bonusPoints) /
          standing.gamesPlayed;
  }
  return [...byPlayer.values()].sort(
    (a, b) => b.ppg - a.ppg || b.powers - a.powers || a.playerId.localeCompare(b.playerId),
  );
}

function addPlayerGame(standing: PlayerStanding, stat: PlayerGameStat): void {
  standing.gamesPlayed += 1;
  if (stat.tossupsHeard !== null) standing.tossupsHeard += stat.tossupsHeard;
  else standing.tossupsHeardKnown = false;
  standing.powers += stat.powers;
  standing.gets += stat.gets;
  standing.negs += stat.negs;
  standing.bonusPoints += stat.bonusPoints;
}

export function totalAcceptedResults(state: DirectorState): number {
  return acceptedGameRecords(state).length;
}
