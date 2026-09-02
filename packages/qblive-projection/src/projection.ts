/**
 * The QBSheet Live public projection.
 *
 * ```
 * DirectorState + LivePublicationSettings  ->  QbliveSnapshot
 * ```
 *
 * # This is a boundary, not a filter
 *
 * The function below constructs a public document field by field. It never takes the internal
 * tournament object and deletes properties from it, and that distinction is the whole design: a
 * filter fails open — a new internal field appears and is published because nobody remembered to
 * add it to the deny list — while a constructor fails closed, because a new internal field is
 * simply not mentioned here and so cannot appear.
 *
 * `tests/privacy.test.ts` enforces the property directly: it stuffs a sentinel string into every
 * private corner of a Director document and asserts the sentinel does not occur anywhere in the
 * serialized snapshot, for every combination of publication settings.
 *
 * # Determinism
 *
 * Given the same state, the same settings, and the same revision, this returns byte-identical JSON.
 * The publication worker relies on that to decide whether anything actually changed, and the whole
 * durable outbox would degenerate into a busy loop without it. Nothing here reads the clock except
 * through the explicitly-passed `generatedAt`.
 */

import {
  acceptedGameRecords,
  zonedIsoOrNull,
  normalizeTimeZone,
  type DirectorId,
  type DirectorState,
  type GameRecord,
  type LivePublicationSettings,
  type Phase,
  type Pool,
  type Room,
  type Round,
  type ScheduledGame,
  type Team,
  type TournamentTimelineEvent,
} from '@qbsheet/tournament-domain';
import {
  QBLIVE_PROTOCOL_VERSION,
  type QbliveAnnouncement,
  type QbliveCapabilities,
  type QbliveDataTable,
  type QbliveLiveGame,
  type QblivePublicRoom,
  type QblivePublicTeam,
  type QblivePublicTournament,
  type QbliveResult,
  type QbliveScheduledGame,
  type QbliveSnapshot,
  type QbliveTimelineEvent,
} from '@qbsheet/qblive-protocol';
import {
  buildPlayerStatisticsTable,
  buildStandingsTable,
  buildTeamStatisticsTable,
  type TableNaming,
  type TableScope,
} from './tables.js';

export interface ProjectionInput {
  state: DirectorState;
  settings: LivePublicationSettings;
  publicationId: string;
  revision: number;
  /** The instant stamped on the snapshot. Passed in so the projection stays a pure function. */
  generatedAt: Date;
  capabilities: QbliveCapabilities;
  final?: boolean;
}

/**
 * An empty but well-formed snapshot.
 *
 * Returned whenever publication is off or there is no tournament, so that a caller who fails to
 * check either condition still publishes nothing rather than everything.
 */
export function emptySnapshot(input: Omit<ProjectionInput, 'state' | 'settings'>): QbliveSnapshot {
  return {
    protocolVersion: QBLIVE_PROTOCOL_VERSION,
    publicationId: input.publicationId,
    revision: input.revision,
    generatedAt: input.generatedAt.toISOString(),
    capabilities: input.capabilities,
    final: input.final ?? false,
    tournament: {
      id: input.publicationId,
      name: 'Tournament',
      date: null,
      venue: null,
      organizer: null,
      timeZone: 'UTC',
      status: 'upcoming',
    },
    teams: [],
    rooms: [],
    timeline: [],
    schedule: [],
    results: [],
    liveGames: [],
    standings: [],
    statistics: [],
    announcements: [],
  };
}

/**
 * A team's public label when names are not published.
 *
 * Seeds are competition facts printed on every bracket, so a seeded tournament keeps a usable
 * identity with no disclosure. Without a seed there is nothing to say, and an opaque ordinal is
 * honest about that.
 */
function anonymousTeamName(team: Team, index: number): string {
  return team.seed !== null && team.seed !== undefined ? `Seed ${team.seed}` : `Team ${index + 1}`;
}

interface Lookups {
  teams: Map<DirectorId, Team>;
  rooms: Map<DirectorId, Room>;
  rounds: Map<DirectorId, Round>;
  phases: Map<DirectorId, Phase>;
  pools: Map<DirectorId, Pool>;
  teamName: (teamId: DirectorId) => string;
}

function buildLookups(state: DirectorState, settings: LivePublicationSettings): Lookups {
  const teams = new Map(state.teams.map((team) => [team.id, team]));
  const publicNames = new Map<DirectorId, string>();
  state.teams.forEach((team, index) => {
    publicNames.set(team.id, settings.teamNames ? team.displayName : anonymousTeamName(team, index));
  });
  return {
    teams,
    rooms: new Map(state.rooms.map((room) => [room.id, room])),
    rounds: new Map(state.rounds.map((round) => [round.id, round])),
    phases: new Map(state.phases.map((phase) => [phase.id, phase])),
    pools: new Map(state.pools.map((pool) => [pool.id, pool])),
    teamName: (teamId) => publicNames.get(teamId) ?? 'Team',
  };
}

/**
 * Whether a round has been released to the public.
 *
 * This is the single rule that keeps unreleased playoff pairings off a spectator's phone. Director
 * generates a rebracket internally long before it goes up on the wall; `released` is the moment it
 * goes up, and nothing before that reaches the projection no matter what else is switched on.
 */
function roundIsPublic(round: Round | undefined): boolean {
  return round !== undefined && (round.status === 'released' || round.status === 'closed');
}

function gameIsPublic(game: ScheduledGame, lookups: Lookups): boolean {
  if (game.publicVisibility === 'hidden') return false;
  return roundIsPublic(lookups.rounds.get(game.roundId));
}

function publicGameState(game: ScheduledGame, hasResult: boolean): QbliveScheduledGame['state'] {
  if (game.status === 'cancelled') return 'cancelled';
  if (game.bye) return 'bye';
  if (hasResult) return 'final';
  if (game.status === 'live') return 'live';
  return 'upcoming';
}

/**
 * The scheduled start of a game.
 *
 * Rounds carry `startedAt` — when the round actually began — which is a different fact from when a
 * game was scheduled to begin. QBSheet Live only ever states a scheduled time, so a round that has
 * a start recorded contributes it and a round that does not contributes nothing. See
 * `docs/QBLIVE.md#no-estimated-times`: an absent time is rendered as absent, never estimated.
 *
 * A round's actual start is not a scheduled start. Until the tournament records an explicit
 * scheduled time for the round, `scheduledStart` is `null`.
 */
function scheduledStartFor(game: ScheduledGame, round: Round | undefined, timeZone: string): string | null {
  return zonedIsoOrNull(game.scheduledStart ?? round?.scheduledStart ?? null, timeZone);
}

function projectTournament(state: DirectorState, timeZone: string): QblivePublicTournament {
  const tournament = state.tournament;
  const status: QblivePublicTournament['status'] =
    tournament?.status === 'complete' || tournament?.status === 'archived'
      ? 'complete'
      : tournament?.status === 'running'
        ? 'in-progress'
        : 'upcoming';
  return {
    id: tournament?.id ?? '',
    name: tournament?.name ?? 'Tournament',
    date: tournament?.date ? tournament.date : null,
    venue: tournament?.venue ? tournament.venue : null,
    organizer: tournament?.organizer ? tournament.organizer : null,
    timeZone,
    status,
  };
}

function projectTeams(
  state: DirectorState,
  settings: LivePublicationSettings,
  lookups: Lookups,
): QblivePublicTeam[] {
  const organizations = new Map(state.organizations.map((organization) => [organization.id, organization]));
  return state.teams
    .filter((team) => team.status !== 'waitlist')
    .map((team) => {
      const organization = team.organizationId ? organizations.get(team.organizationId) : undefined;
      const players = settings.playerNames
        ? state.players
            .filter((player) => player.teamId === team.id && player.active)
            .map((player) => ({ id: player.id, name: player.name, teamId: team.id }))
        : undefined;
      return {
        id: team.id,
        name: lookups.teamName(team.id),
        // An organization name is a school name, which is the same disclosure as a team name.
        organization: settings.teamNames ? (organization?.shortName ?? organization?.name ?? null) : null,
        seed: team.seed,
        ...(players ? { players } : {}),
      };
    });
}

function projectRooms(state: DirectorState, settings: LivePublicationSettings): QblivePublicRoom[] {
  if (!settings.roomLocations) return [];
  return state.rooms.map((room) => ({
    id: room.id,
    name: room.name,
    building: room.building ? room.building : null,
    directions: settings.roomDirections && room.directions ? room.directions : null,
  }));
}

function projectTimeline(
  events: TournamentTimelineEvent[],
  timeZone: string,
  settings: LivePublicationSettings,
): QbliveTimelineEvent[] {
  return events
    .filter((event) => event.visibility === 'public')
    .map((event) => ({
      id: event.id,
      type: event.type,
      title: event.title,
      description: event.description ?? null,
      scheduledStart: zonedIsoOrNull(event.scheduledStart, timeZone),
      scheduledEnd: zonedIsoOrNull(event.scheduledEnd, timeZone),
      teamIds: event.teamIds ? [...event.teamIds] : [],
      roomId: settings.roomLocations ? (event.roomId ?? null) : null,
      location: event.location ?? null,
    }))
    .sort(
      (left, right) =>
        compareOptionalTimes(left.scheduledStart, right.scheduledStart) || left.id.localeCompare(right.id),
    );
}

/** Timed events first and in order; untimed events after them, in a stable order. */
function compareOptionalTimes(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left < right ? -1 : 1;
}

function projectSchedule(
  state: DirectorState,
  settings: LivePublicationSettings,
  lookups: Lookups,
  timeZone: string,
  resultsByGame: Map<DirectorId, GameRecord>,
): QbliveScheduledGame[] {
  if (!settings.releasedSchedule) return [];
  const games: QbliveScheduledGame[] = [];
  for (const game of state.scheduledGames) {
    if (!gameIsPublic(game, lookups)) continue;
    const round = lookups.rounds.get(game.roundId);
    const phase = round ? lookups.phases.get(round.phaseId) : undefined;
    const pool = game.poolId ? lookups.pools.get(game.poolId) : undefined;
    const teamIds = [game.leftTeamId, game.rightTeamId].filter((id): id is DirectorId => Boolean(id));
    games.push({
      id: game.id,
      roundId: game.roundId,
      roundName: round?.name ?? 'Round',
      roundNumber: round?.number ?? null,
      phaseId: phase?.id ?? null,
      phaseName: phase?.name ?? null,
      poolId: pool?.id ?? null,
      poolName: pool?.name ?? null,
      teamIds,
      roomId: settings.roomLocations ? game.roomId : null,
      scheduledStart: scheduledStartFor(game, round, timeZone),
      state: publicGameState(game, resultsByGame.has(game.id)),
    });
  }
  return games.sort(
    (left, right) =>
      (left.roundNumber ?? Number.MAX_SAFE_INTEGER) - (right.roundNumber ?? Number.MAX_SAFE_INTEGER) ||
      left.id.localeCompare(right.id),
  );
}

function projectResults(
  settings: LivePublicationSettings,
  lookups: Lookups,
  timeZone: string,
  accepted: GameRecord[],
): QbliveResult[] {
  if (!settings.acceptedResults) return [];
  const results: QbliveResult[] = [];
  for (const game of accepted) {
    // A result for a round nobody can see would disclose the pairing the schedule is withholding.
    if (!roundIsPublic(lookups.rounds.get(game.roundId))) continue;
    results.push({
      gameId: game.scheduledGameId,
      roundId: game.roundId,
      scores: game.scores.map((score) => ({ teamId: score.teamId, score: score.score })),
      outcome: 'played',
      acceptedAt: zonedIsoOrNull(game.acceptedAt ?? null, timeZone),
    });
  }
  return results.sort((left, right) => left.gameId.localeCompare(right.gameId));
}

/**
 * Games currently being played.
 *
 * Three independent switches meet here. `liveGameStatus` decides whether the game appears at all;
 * `liveScores` decides whether it carries a score; `liveProgress` decides whether it carries a
 * tossup count. A Director who wants spectators to know a game is happening without turning the
 * hallway into a scoreboard gets exactly that.
 */
function projectLiveGames(
  state: DirectorState,
  settings: LivePublicationSettings,
  lookups: Lookups,
  resultsByGame: Map<DirectorId, GameRecord>,
): QbliveLiveGame[] {
  if (!settings.liveGameStatus) return [];
  const sessionsByRoom = new Map(state.qbtcpSessions.map((session) => [session.roomId, session]));
  const live: QbliveLiveGame[] = [];
  for (const game of state.scheduledGames) {
    if (game.status !== 'live') continue;
    if (!gameIsPublic(game, lookups)) continue;
    if (resultsByGame.has(game.id)) continue;
    const teamIds = [game.leftTeamId, game.rightTeamId].filter((id): id is DirectorId => Boolean(id));
    const session = game.roomId ? sessionsByRoom.get(game.roomId) : undefined;
    const progress = session?.progress ?? null;
    const entry: QbliveLiveGame = {
      gameId: game.id,
      roundId: game.roundId,
      teamIds,
      roomId: settings.roomLocations ? game.roomId : null,
    };
    if (settings.liveScores && progress && teamIds.length === 2) {
      entry.scores = [
        { teamId: teamIds[0], score: progress.leftScore },
        { teamId: teamIds[1], score: progress.rightScore },
      ];
    }
    if (settings.liveProgress && progress) entry.tossupsRead = progress.tossupsRead;
    live.push(entry);
  }
  return live.sort((left, right) => left.gameId.localeCompare(right.gameId));
}

function projectAnnouncements(
  state: DirectorState,
  settings: LivePublicationSettings,
  timeZone: string,
  now: Date,
): QbliveAnnouncement[] {
  if (!settings.announcements) return [];
  const announcements = state.live?.announcements ?? [];
  return announcements
    .filter((announcement) => !announcement.withdrawn)
    .filter((announcement) => {
      if (!announcement.expiresAt) return true;
      const expiry = Date.parse(announcement.expiresAt);
      return Number.isNaN(expiry) || expiry > now.getTime();
    })
    .map((announcement) => ({
      id: announcement.id,
      title: announcement.title,
      body: announcement.body,
      severity: announcement.severity,
      publishedAt: zonedIsoOrNull(announcement.publishedAt, timeZone) ?? announcement.publishedAt,
      updatedAt: zonedIsoOrNull(announcement.updatedAt ?? null, timeZone),
      expiresAt: zonedIsoOrNull(announcement.expiresAt ?? null, timeZone),
      audienceTeamIds: [...announcement.audienceTeamIds],
    }))
    .sort(
      (left, right) => right.publishedAt.localeCompare(left.publishedAt) || left.id.localeCompare(right.id),
    );
}

/**
 * The scopes tables are produced for.
 *
 * Overall always; then each phase that has released rounds, and each pool inside it. A phase whose
 * rounds are all unreleased contributes no scope, because a scope label is itself a disclosure —
 * "Championship bracket" tells a spectator a bracket exists before the pairings go up.
 */
function tableScopes(state: DirectorState, lookups: Lookups): TableScope[] {
  const scopes: TableScope[] = [{ id: 'overall', label: 'Overall' }];
  for (const phase of [...state.phases].sort((left, right) => left.order - right.order)) {
    const phaseRounds = state.rounds.filter((round) => round.phaseId === phase.id);
    if (!phaseRounds.some((round) => roundIsPublic(round))) continue;
    scopes.push({ id: `phase:${phase.id}`, label: phase.name, phaseId: phase.id });
    for (const poolId of phase.poolIds) {
      const pool = lookups.pools.get(poolId);
      if (!pool) continue;
      scopes.push({
        id: `pool:${pool.id}`,
        label: `${phase.name} · ${pool.name}`,
        phaseId: phase.id,
        poolId: pool.id,
        teamIds: [...pool.teamIds],
      });
    }
  }
  return scopes;
}

/**
 * Project a Director document into a public QBLive snapshot.
 *
 * Pure. Same inputs, same bytes.
 */
export function projectLiveSnapshot(input: ProjectionInput): QbliveSnapshot {
  const { state, settings } = input;
  if (!settings.enabled || !state.tournament) {
    return emptySnapshot(input);
  }
  const timeZone = normalizeTimeZone(state.tournament.timeZone);
  const lookups = buildLookups(state, settings);
  const accepted = acceptedGameRecords(state);
  const resultsByGame = new Map(accepted.map((game) => [game.scheduledGameId, game]));

  const publicPlayerNames = new Map<DirectorId, string>();
  if (settings.playerNames) {
    for (const player of state.players) publicPlayerNames.set(player.id, player.name);
  }
  const naming: TableNaming = {
    teamName: lookups.teamName,
    playerName: (playerId) => publicPlayerNames.get(playerId) ?? null,
  };

  const scopes = tableScopes(state, lookups);
  const standings: QbliveDataTable[] = settings.standings
    ? scopes.map((scope) => buildStandingsTable(state, scope, naming))
    : [];
  const statistics: QbliveDataTable[] = [];
  if (settings.teamStatistics) {
    for (const scope of scopes) statistics.push(buildTeamStatisticsTable(state, scope, naming));
  }
  // Individual statistics need both switches: a table of names with no numbers is a roster
  // disclosure with no benefit, and numbers attached to unpublished names cannot be rendered.
  if (settings.playerStatistics && settings.playerNames) {
    for (const scope of scopes) statistics.push(buildPlayerStatisticsTable(state, scope, naming));
  }

  return {
    protocolVersion: QBLIVE_PROTOCOL_VERSION,
    publicationId: input.publicationId,
    revision: input.revision,
    generatedAt: input.generatedAt.toISOString(),
    capabilities: input.capabilities,
    final: input.final ?? false,
    tournament: projectTournament(state, timeZone),
    teams: projectTeams(state, settings, lookups),
    rooms: projectRooms(state, settings),
    timeline: projectTimeline(state.timeline, timeZone, settings),
    schedule: projectSchedule(state, settings, lookups, timeZone, resultsByGame),
    results: projectResults(settings, lookups, timeZone, accepted),
    liveGames: projectLiveGames(state, settings, lookups, resultsByGame),
    standings,
    statistics,
    announcements: projectAnnouncements(state, settings, timeZone, input.generatedAt),
  };
}
