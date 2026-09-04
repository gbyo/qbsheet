/**
 * Small hand-built Director documents, for the view tests that need a tournament to draw.
 *
 * The controller can build one of these for real, but a rendering test that has to drive the
 * controller to get a table on screen is a test that fails for reasons about the controller. These
 * are the plain records the views read, assembled by hand and shared so that six test files do not
 * each grow their own slightly different notion of what an accepted game looks like.
 */
import {
  defaultRules,
  emptyDirectorState,
  type DirectorState,
  type GameRecord,
  type Player,
  type PlayerGameStat,
  type ScheduledGame,
  type Team,
  type TeamGameScore,
} from '../src/director/domain';

const at = '2026-09-01T12:00:00.000Z';

export function tournamentState(name = 'Ninety Six Invitational'): DirectorState {
  const state = emptyDirectorState();
  state.tournament = {
    id: 'tournament-1',
    name,
    date: '2026-09-05',
    venue: '',
    organizer: '',
    status: 'draft',
    timeZone: 'America/New_York',
    rules: structuredClone(defaultRules),
    formatId: null,
    currentPhaseId: null,
    currentPacketId: null,
    currentRoundId: null,
    createdAt: at,
    updatedAt: at,
  };
  state.phases.push({
    id: 'phase-1',
    name: 'Preliminary',
    kind: 'preliminary',
    order: 1,
    formatId: 'format-1',
    poolIds: [],
    roundIds: ['round-1'],
    advancementRule: null,
    carryover: false,
    status: 'active',
  });
  state.rounds.push({
    id: 'round-1',
    phaseId: 'phase-1',
    name: 'Round 1',
    number: 1,
    revision: 1,
    status: 'released',
    packetId: null,
    scheduledGameIds: [],
    scheduledStart: null,
    releasedAt: at,
    startedAt: null,
    closedAt: null,
  });
  return state;
}

export function team(id: string, displayName: string): Team {
  return {
    id,
    organizationId: null,
    displayName,
    teamLetter: '',
    seed: null,
    status: 'confirmed',
    createdAt: at,
    updatedAt: at,
  };
}

export function player(id: string, teamId: string, name: string): Player {
  return { id, teamId, name, captain: false, active: true };
}

export function score(teamId: string, value: number, extra: Partial<TeamGameScore> = {}): TeamGameScore {
  return {
    teamId,
    score: value,
    superpowers: 0,
    powers: 0,
    gets: 0,
    negs: 0,
    bonuses: 0,
    bonusPoints: 0,
    bouncebacks: 0,
    ...extra,
  };
}

export function playerStat(
  playerId: string,
  teamId: string,
  extra: Partial<PlayerGameStat> = {},
): PlayerGameStat {
  return {
    playerId,
    teamId,
    superpowers: 0,
    powers: 0,
    gets: 0,
    negs: 0,
    bonusPoints: 0,
    tossupsHeard: 20,
    ...extra,
  };
}

export function scheduledGame(
  id: string,
  leftTeamId: string,
  rightTeamId: string,
  overrides: Partial<ScheduledGame> = {},
): ScheduledGame {
  return {
    id,
    roundId: 'round-1',
    poolId: null,
    roomId: null,
    packetId: null,
    leftTeamId,
    rightTeamId,
    bye: false,
    status: 'accepted',
    assignmentRevision: 1,
    ...overrides,
  };
}

export function acceptedGame(
  id: string,
  scheduledGameId: string,
  scores: TeamGameScore[],
  playerStats: PlayerGameStat[] = [],
): GameRecord {
  return {
    id,
    scheduledGameId,
    roundId: 'round-1',
    packetId: null,
    status: 'accepted',
    scores,
    playerStats,
    source: 'manual',
    detailedStats: 'complete',
    acceptedAt: at,
  };
}

/**
 * Two teams, one accepted game between them, and one player on each side with recorded stats.
 *
 * Enough for a standings table to have rows in it and for an export to have something to serialize.
 */
export function playedTournament(): DirectorState {
  const state = tournamentState();
  state.teams.push(team('team-a', 'Ninety Six'), team('team-b', 'Greenwood'));
  state.players.push(player('player-a', 'team-a', 'Gibson'), player('player-b', 'team-b', 'Emma'));
  state.scheduledGames.push(scheduledGame('scheduled-1', 'team-a', 'team-b'));
  state.games.push(
    acceptedGame(
      'game-1',
      'scheduled-1',
      [
        score('team-a', 300, { powers: 4, gets: 8, negs: 1, bonuses: 12, bonusPoints: 130 }),
        score('team-b', 210, { powers: 1, gets: 9, negs: 3, bonuses: 10, bonusPoints: 90 }),
      ],
      [
        playerStat('player-a', 'team-a', { powers: 4, gets: 8, negs: 1, bonusPoints: 130 }),
        playerStat('player-b', 'team-b', { powers: 1, gets: 9, negs: 3, bonusPoints: 90 }),
      ],
    ),
  );
  return state;
}
