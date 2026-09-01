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
  powers: number;
  gets: number;
  negs: number;
  bonusPoints: number;
  ppg: number;
}

function acceptedGames(state: DirectorState): GameRecord[] {
  return state.games.filter((game) => game.status === 'accepted');
}

export function deriveTeamStandings(
  state: DirectorState,
  games: GameRecord[] = acceptedGames(state),
): TeamStanding[] {
  const byTeam = new Map<DirectorId, TeamStanding>();
  for (const team of state.teams) {
    if (team.status === 'dropped') continue;
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

  for (const game of games) {
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
      leftStanding.headToHead += 1;
      rightStanding.headToHead -= 1;
    } else if (right.score > left.score) {
      rightStanding.wins += 1;
      leftStanding.losses += 1;
      rightStanding.headToHead += 1;
      leftStanding.headToHead -= 1;
    } else {
      leftStanding.ties += 1;
      rightStanding.ties += 1;
    }
  }

  for (const standing of byTeam.values()) {
    standing.winPercentage =
      standing.gamesPlayed === 0 ? 0 : (standing.wins + standing.ties * 0.5) / standing.gamesPlayed;
  }

  const rules = state.tournament?.rules;
  return [...byTeam.values()].sort((a, b) => compareStandings(a, b, rules));
}

function compareStandings(a: TeamStanding, b: TeamStanding, rules?: TournamentRules): number {
  const order = rules?.tiebreakers ?? ['record', 'points', 'margin', 'powers', 'gets'];
  for (const key of order) {
    const difference =
      key === 'record'
        ? b.winPercentage - a.winPercentage
        : key === 'head-to-head'
          ? b.headToHead - a.headToHead
          : key === 'points'
            ? b.pointsFor - a.pointsFor
            : key === 'margin'
              ? b.margin - a.margin
              : key === 'powers'
                ? b.powers - a.powers
                : key === 'gets'
                  ? b.gets - a.gets
                  : 0;
    if (difference !== 0) return difference;
  }
  return a.teamId.localeCompare(b.teamId);
}

export function derivePlayerStandings(state: DirectorState): PlayerStanding[] {
  const byPlayer = new Map<DirectorId, PlayerStanding>();
  for (const player of state.players) {
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
  for (const game of acceptedGames(state)) {
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
  standing.tossupsHeard += stat.tossupsHeard;
  standing.powers += stat.powers;
  standing.gets += stat.gets;
  standing.negs += stat.negs;
  standing.bonusPoints += stat.bonusPoints;
}

export function totalAcceptedResults(state: DirectorState): number {
  return acceptedGames(state).length;
}
