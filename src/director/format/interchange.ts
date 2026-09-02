import {
  exportDirectorArchive,
  exportQbjText,
  exportSqbsTeams,
  exportTeamsCsv,
  importDirectorArchive,
  importQbj,
  type DirectorTournament,
  type DirectorTournamentInput,
  type GameRecord as InterchangeGameRecord,
  type GameTeamResult,
  type JsonObject,
  type JsonValue,
  type TeamRecord,
} from '@qbsheet/tournament-formats';
import {
  defaultRules,
  emptyDirectorState,
  isoNow,
  newDirectorId,
  type DirectorState,
  type GameRecord,
  type TeamGameScore,
} from '../domain';
import { DirectorStateVersionError, normalizeDirectorState } from '../persistence/stateMigrations';

/**
 * Director-only state lives in a namespaced top-level extension. The QBJ writer intentionally
 * ignores DirectorTournament.extensions, so this keeps the lossless archive payload out of the
 * public QBJ document while allowing a .qbst round trip to restore operational state exactly.
 */
export const directorStateArchiveExtension = 'qbsheet:director-state' as const;

export interface DirectorImportReport {
  ok: boolean;
  state?: DirectorState;
  warnings: string[];
  errors: string[];
}

function jsonValue(value: unknown): JsonValue {
  try {
    return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
  } catch {
    return null;
  }
}

function jsonObject(value: unknown): JsonObject | undefined {
  const candidate = jsonValue(value);
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? (candidate as JsonObject)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function teamStatus(status: string | undefined): DirectorState['teams'][number]['status'] {
  if (status === 'dropped' || status === 'withdrawn' || status === 'no-show') return 'dropped';
  if (status === 'late') return 'waitlist';
  return 'confirmed';
}

function gameStatus(status: string | undefined): GameRecord['status'] {
  switch (status) {
    case 'released':
    case 'in-progress':
      return 'live';
    case 'submitted':
      return 'submitted';
    case 'accepted':
    case 'complete':
      return 'accepted';
    case 'rejected':
      return 'rejected';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'scheduled';
  }
}

function scheduleStatus(status: string | undefined): DirectorState['scheduledGames'][number]['status'] {
  switch (status) {
    case 'released':
      return 'released';
    case 'in-progress':
      return 'live';
    case 'submitted':
      return 'submitted';
    case 'accepted':
    case 'complete':
      return 'accepted';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'scheduled';
  }
}

function auditType(action: string): DirectorState['audit'][number]['type'] {
  if (action.includes('drop')) return 'team-dropped';
  if (action.includes('schedule') || action.includes('repair')) return 'schedule-repaired';
  if (action.includes('accept')) return 'result-accepted';
  if (action.includes('result') || action.includes('submit')) return 'result-received';
  if (action.includes('protest') && action.includes('rule')) return 'protest-ruled';
  if (action.includes('protest')) return 'protest-created';
  if (action.includes('packet')) return 'packet-changed';
  if (action.includes('room')) return 'room-changed';
  if (action.includes('team') || action.includes('roster')) return 'team-changed';
  if (action.includes('checkpoint')) return 'checkpoint-created';
  return 'tournament-updated';
}

function phaseKind(kind: string | undefined): DirectorState['phases'][number]['kind'] {
  switch (kind) {
    case 'playoff':
    case 'final':
    case 'placement':
    case 'custom':
      return kind;
    default:
      return 'preliminary';
  }
}

function formatKind(kind: string | undefined): DirectorState['formats'][number]['kind'] {
  switch (kind) {
    case 'round-robin':
    case 'double-round-robin':
    case 'pools':
    case 'playoff-pools':
    case 'single-elimination':
    case 'swiss':
    case 'custom':
      return kind;
    default:
      return 'custom';
  }
}

function sourceForPacket(source: string | undefined): 'manual' | 'qbj' | 'imported' {
  if (source === 'qbj') return 'qbj';
  if (source === 'manual') return 'manual';
  return 'imported';
}

function resultScores(game: InterchangeGameRecord): TeamGameScore[] {
  return (game.result?.teams ?? []).map((team) => ({
    teamId: team.teamId,
    score: number(team.points) ?? 0,
    powers: number(team.powers) ?? 0,
    gets: number(team.gets) ?? 0,
    negs: number(team.negs) ?? 0,
    bonuses: number(team.bonusesHeard) ?? 0,
    bonusPoints: number(team.bonusPoints) ?? 0,
    bouncebacks: number(team.bonusBouncebackPoints) ?? 0,
  }));
}

function interchangeTeam(state: DirectorState, team: DirectorState['teams'][number]): TeamRecord {
  const players = state.players
    .filter((player) => player.teamId === team.id)
    .map((player) => ({
      id: player.id,
      name: player.name,
      captain: player.captain,
      ...(player.rosterNumber === undefined ? {} : { rosterNumber: player.rosterNumber }),
      ...(player.notes ? { notes: player.notes } : {}),
    }));
  return {
    id: team.id,
    name: team.displayName,
    displayName: team.displayName,
    ...(team.teamLetter ? { letter: team.teamLetter } : {}),
    ...(team.organizationId ? { organizationId: team.organizationId } : {}),
    ...(team.seed === null ? {} : { seed: team.seed }),
    status: team.status === 'confirmed' ? 'active' : team.status === 'waitlist' ? 'late' : 'dropped',
    ...(team.notes ? { notes: team.notes } : {}),
    playerIds: players.map((player) => player.id),
    players,
  };
}

function preservedDirectorState(data: DirectorTournament): DirectorState | undefined {
  const candidate = data.extensions?.[directorStateArchiveExtension];
  if (!candidate) return undefined;
  try {
    const restored = normalizeDirectorState(candidate);
    return restored.tournament?.id === data.tournament.id ? restored : undefined;
  } catch (reason: unknown) {
    if (reason instanceof DirectorStateVersionError) throw reason;
    // A foreign or stale extension must not make an otherwise valid interchange document unreadable.
    return undefined;
  }
}

function toInterchangeGame(state: DirectorState, game: GameRecord): InterchangeGameRecord {
  const scheduled = state.scheduledGames.find((entry) => entry.id === game.scheduledGameId);
  const scores: GameTeamResult[] = game.scores.map((score) => ({
    teamId: score.teamId,
    points: score.score,
    powers: score.powers,
    gets: score.gets,
    negs: score.negs,
    bonusesHeard: score.bonuses,
    bonusPoints: score.bonusPoints,
    bonusBouncebackPoints: score.bouncebacks,
  }));
  return {
    id: game.id,
    scheduledGameId: game.scheduledGameId,
    roundId: game.roundId,
    ...(scheduled?.roomId ? { roomId: scheduled.roomId } : {}),
    ...(game.packetId ? { packetId: game.packetId } : {}),
    teamIds: [
      scheduled?.leftTeamId ?? game.scores[0]?.teamId ?? null,
      scheduled?.rightTeamId ?? game.scores[1]?.teamId ?? null,
    ],
    status: game.status,
    result: {
      teams: scores,
      players: game.playerStats.map((player) => ({
        playerId: player.playerId,
        teamId: player.teamId,
        powers: player.powers,
        gets: player.gets,
        negs: player.negs,
        points: player.bonusPoints,
        ...(player.tossupsHeard === null || player.tossupsHeard === undefined
          ? {}
          : { tossupsHeard: player.tossupsHeard }),
        bonusPoints: player.bonusPoints,
      })),
      notes: game.note,
      rawSubmission: jsonValue(game.rawQbj),
    },
    ...(game.rawQbj !== undefined ? { rawSubmission: jsonValue(game.rawQbj) } : {}),
    ...(game.finishedAt ? { submittedAt: game.finishedAt } : {}),
    ...(game.acceptedAt ? { acceptedAt: game.acceptedAt } : {}),
  };
}

export function toInterchange(state: DirectorState): DirectorTournament {
  const tournament = state.tournament;
  if (!tournament) {
    throw new Error('Create or open a tournament before exporting it.');
  }
  const phases = state.phases.map((phase) => ({
    id: phase.id,
    name: phase.name,
    kind: phase.kind,
    order: phase.order,
    poolIds: phase.poolIds,
    roundIds: phase.roundIds,
    ...(phase.advancementRule ? { advancement: jsonObject(phase.advancementRule) } : {}),
    carryovers: { enabled: phase.carryover },
  }));
  const rounds = state.rounds.map((round) => ({
    id: round.id,
    name: round.name,
    phaseId: round.phaseId,
    number: round.number,
    packetIds: round.packetId ? [round.packetId] : [],
    revision: round.revision,
    status: round.status,
  }));
  const scheduledGames = state.scheduledGames.map((game) => ({
    id: game.id,
    roundId: game.roundId,
    roomId: game.roomId ?? undefined,
    packetId: game.packetId ?? undefined,
    teamIds: [game.leftTeamId, game.rightTeamId] as [string | null, string | null],
    status: game.status,
    bye: game.bye,
    extensions: game.movedFromRoomId ? { movedFromRoomId: game.movedFromRoomId } : undefined,
  }));
  return {
    tournament: {
      id: tournament.id,
      name: tournament.name,
      ...(tournament.date ? { date: tournament.date } : {}),
      ...(tournament.venue ? { location: tournament.venue } : {}),
      notes: tournament.organizer ? `Organizer: ${tournament.organizer}` : undefined,
      extensions: {
        status: tournament.status,
        ...(tournament.formatId ? { formatId: tournament.formatId } : {}),
        ...(state.formats.find((format) => format.id === tournament.formatId)?.name
          ? { formatName: state.formats.find((format) => format.id === tournament.formatId)?.name ?? '' }
          : {}),
        currentPhaseId: tournament.currentPhaseId,
        currentPacketId: tournament.currentPacketId,
        currentRoundId: tournament.currentRoundId,
      },
    },
    rules: jsonObject(tournament.rules),
    organizations: state.organizations.map((organization) => ({
      id: organization.id,
      name: organization.name,
      ...(organization.shortName ? { city: organization.shortName } : {}),
      ...(organization.notes ? { notes: organization.notes } : {}),
    })),
    players: state.players.map((player) => ({
      id: player.id,
      name: player.name,
      ...(state.teams.find((team) => team.id === player.teamId)?.organizationId
        ? {
            organizationId:
              state.teams.find((team) => team.id === player.teamId)?.organizationId ?? undefined,
          }
        : {}),
      captain: player.captain,
      ...(player.rosterNumber === undefined ? {} : { rosterNumber: player.rosterNumber }),
      ...(player.notes ? { notes: player.notes } : {}),
    })),
    teams: state.teams.map((team) => interchangeTeam(state, team)),
    registrations: state.teams.map((team) => ({
      id: `registration-${team.id}`,
      teamId: team.id,
      ...(team.organizationId ? { organizationId: team.organizationId } : {}),
      ...(team.seed === null ? {} : { seed: team.seed }),
      status: team.status,
    })),
    rooms: state.rooms.map((room) => ({
      id: room.id,
      name: room.name,
      ...(room.building ? { building: room.building } : {}),
      ...(room.floor ? { floor: room.floor } : {}),
      accessible: Boolean(room.accessibility),
      directions: room.directions,
      notes: room.notes,
      ...(room.moderatorId ? { moderatorId: room.moderatorId } : {}),
      ...(room.scorekeeperId ? { scorekeeperId: room.scorekeeperId } : {}),
      ...(room.equipmentId ? { equipmentIds: [room.equipmentId] } : {}),
      available: room.available,
    })),
    staff: state.staff.map((member) => ({
      id: member.id,
      name: member.name,
      role: member.roles[0],
      notes: member.notes,
    })),
    equipment: state.equipment.map((item) => ({
      id: item.id,
      name: item.name,
      kind: item.kind,
      available: item.available,
      notes: item.notes,
    })),
    packets: state.packets.map((packet) => ({
      id: packet.id,
      name: packet.name,
      extensions: { source: packet.source },
      gameIds: packet.assignedGameIds,
      replacementForId: packet.replacementForPacketId ?? undefined,
      tiebreaker: packet.tiebreaker,
      used: packet.usedGameIds.length > 0,
      notes: packet.notes,
    })),
    phases,
    pools: state.pools.map((pool) => ({
      id: pool.id,
      phaseId: pool.phaseId,
      name: pool.name,
      teamIds: pool.teamIds,
      order: pool.order,
    })),
    rounds,
    scheduledGames,
    games: state.games.map((game) => toInterchangeGame(state, game)),
    playerStatistics: [],
    qbtcpSessions: state.qbtcpSessions.map((session) => ({
      id: session.sessionId,
      roomId: session.roomId,
      clientId: session.deviceId,
      status: session.state,
      lastSeenAt: session.lastSeenAt,
    })),
    resultSubmissions: state.submissions.map((submission) => ({
      id: submission.id,
      gameId: submission.gameId,
      receivedAt: submission.receivedAt,
      status: submission.status,
      fingerprint: submission.fingerprint,
      raw: jsonValue(submission.rawSubmission),
      ...(submission.reason ? { reviewNote: submission.reason } : {}),
      ...(submission.acceptedAt ? { reviewedAt: submission.acceptedAt } : {}),
    })),
    protests: state.protests.map((protest) => ({
      id: protest.id,
      gameId: protest.gameId,
      subject: protest.category,
      description: protest.description,
      status: protest.status === 'ruled' ? 'resolved' : protest.status,
      ruling: protest.ruling,
      createdAt: protest.createdAt,
      resolvedAt: protest.status === 'ruled' ? protest.updatedAt : undefined,
    })),
    auditEvents: state.audit.map((event) => ({
      id: event.id,
      at: event.at,
      action: event.type,
      actor: event.actor,
      entityId: event.entityId,
      details: event.details ? jsonObject(event.details) : undefined,
    })),
    extensions: {
      archiveSchemaVersion: state.schemaVersion,
      metadata: jsonValue(state.metadata),
      [directorStateArchiveExtension]: jsonValue(state),
    },
  };
}

function fromInterchange(data: DirectorTournament): DirectorState {
  const preserved = preservedDirectorState(data);
  if (preserved) return preserved;
  const state = emptyDirectorState();
  const now = isoNow();
  const tournamentExtensions = data.tournament.extensions ?? {};
  const extensionStatus = text(tournamentExtensions.status);
  const status: NonNullable<DirectorState['tournament']>['status'] =
    extensionStatus === 'running' || extensionStatus === 'complete' || extensionStatus === 'archived'
      ? extensionStatus
      : 'draft';
  const formatId = text(tournamentExtensions.formatId) ?? newDirectorId('format');
  const phaseIds = data.phases.map((phase) => phase.id);
  const firstPhase = data.phases[0];
  const currentRoundId = text(tournamentExtensions.currentRoundId) ?? data.rounds.at(-1)?.id ?? null;
  const currentPhaseId =
    text(tournamentExtensions.currentPhaseId) ??
    data.rounds.find((round) => round.id === currentRoundId)?.phaseId ??
    (phaseIds.length === 1 ? phaseIds[0] : null);
  state.tournament = {
    id: data.tournament.id,
    name: data.tournament.name,
    date: data.tournament.date ?? '',
    venue: data.tournament.location ?? '',
    organizer: text(data.tournament.notes)?.replace(/^Organizer:\s*/, '') ?? '',
    status,
    rules: {
      ...defaultRules,
      ...rulesFromInterchange(data.rules),
    },
    formatId,
    currentPhaseId,
    currentPacketId: text(tournamentExtensions.currentPacketId) ?? null,
    currentRoundId,
    createdAt: now,
    updatedAt: now,
  };
  state.formats = [
    {
      id: formatId,
      name: text(tournamentExtensions.formatName) ?? firstPhase?.name ?? 'Imported format',
      kind: formatKind(firstPhase?.kind),
      phaseIds,
      roundsPerTeam: null,
      avoidRematches: true,
      avoidSameOrganization: false,
      allowByes: true,
      editable: true,
    },
  ];
  state.organizations = data.organizations.map((organization) => ({
    id: organization.id,
    name: organization.name,
    shortName: organization.city,
    notes: organization.notes,
  }));
  const teamPlayers = new Map<string, string[]>();
  data.teams.forEach((team) =>
    teamPlayers.set(team.id, team.playerIds ?? team.players?.map((player) => player.id) ?? []),
  );
  state.teams = data.teams.map((team) => ({
    id: team.id,
    organizationId: team.organizationId ?? null,
    displayName: team.displayName ?? team.name,
    teamLetter: team.letter ?? '',
    seed: team.seed ?? null,
    status: teamStatus(team.status),
    notes: team.notes,
    createdAt: now,
    updatedAt: now,
  }));
  const teamForPlayer = new Map<string, string>();
  teamPlayers.forEach((players, teamId) =>
    players.forEach((playerId) => teamForPlayer.set(playerId, teamId)),
  );
  state.players = data.players.map((player) => ({
    id: player.id,
    teamId: teamForPlayer.get(player.id) ?? '',
    name: player.name,
    captain: player.captain ?? false,
    active: true,
    rosterNumber: player.rosterNumber,
    notes: player.notes,
  }));
  state.rooms = data.rooms.map((room) => ({
    id: room.id,
    name: room.name,
    building: room.building,
    floor: room.floor,
    accessibility: room.accessible ? 'Accessible' : '',
    directions: room.directions,
    notes: room.notes,
    status: room.available === false ? 'offline' : 'available',
    moderatorId: room.moderatorId ?? null,
    scorekeeperId: room.scorekeeperId ?? null,
    equipmentId: room.equipmentIds?.[0] ?? null,
    available: room.available !== false,
  }));
  state.staff = data.staff.map((member) => ({
    id: member.id,
    name: member.name,
    roles: member.role ? [member.role as DirectorState['staff'][number]['roles'][number]] : [],
    available: true,
    notes: member.notes,
  }));
  state.equipment = data.equipment.map((item) => ({
    id: item.id,
    name: item.name,
    kind: item.kind === 'buzzer' ? 'buzzer' : item.kind === 'device' ? 'device' : 'other',
    available: item.available !== false,
    notes: item.notes,
  }));
  state.packets = data.packets.map((packet) => ({
    id: packet.id,
    name: packet.name,
    source: sourceForPacket(text(packet.extensions?.source)),
    assignedRoundIds: packet.roundId ? [packet.roundId] : [],
    assignedGameIds: packet.gameIds ?? [],
    usedGameIds: packet.used ? (packet.gameIds ?? []) : [],
    replacementForPacketId: packet.replacementForId ?? null,
    tiebreaker: packet.tiebreaker ?? false,
    notes: packet.notes,
  }));
  state.phases = data.phases.map((phase) => ({
    id: phase.id,
    name: phase.name,
    kind: phaseKind(phase.kind),
    order: phase.order ?? 1,
    formatId,
    poolIds: phase.poolIds ?? [],
    roundIds: phase.roundIds ?? [],
    advancementRule: phase.advancement
      ? {
          qualifiersPerPool: number(phase.advancement.qualifiersPerPool) ?? 1,
          tiebreakers: defaultRules.tiebreakers,
          manualOverrideAllowed: true,
        }
      : null,
    carryover: typeof phase.carryovers?.enabled === 'boolean' ? phase.carryovers.enabled : false,
    status: 'planned',
  }));
  state.pools = data.pools.map((pool) => ({
    id: pool.id,
    phaseId: pool.phaseId ?? firstPhase?.id ?? '',
    name: pool.name,
    teamIds: pool.teamIds ?? [],
    order: pool.order ?? 1,
  }));
  const roundById = new Map(data.rounds.map((round) => [round.id, round]));
  state.rounds = data.rounds.map((round) => ({
    id: round.id,
    phaseId: round.phaseId ?? firstPhase?.id ?? '',
    name: round.name,
    number: round.number ?? 1,
    revision: round.revision ?? 1,
    status: roundStatus(round.status),
    packetId: round.packetIds?.[0] ?? null,
    scheduledGameIds: data.scheduledGames.filter((game) => game.roundId === round.id).map((game) => game.id),
    startedAt: null,
    closedAt: round.status === 'closed' ? now : null,
  }));
  state.scheduledGames = data.scheduledGames.map((game) => ({
    id: game.id,
    roundId: game.roundId ?? '',
    roomId: game.roomId ?? null,
    packetId: game.packetId ?? null,
    leftTeamId: game.teamIds?.[0] ?? '',
    rightTeamId: game.teamIds?.[1] ?? null,
    bye: game.bye ?? game.teamIds?.[1] === null,
    status: scheduleStatus(game.status),
    assignmentRevision: 1,
    movedFromRoomId: text(game.extensions?.movedFromRoomId),
  }));
  state.games = data.games.map((game) => ({
    id: game.id,
    scheduledGameId: game.scheduledGameId ?? game.id,
    roundId: game.roundId ?? roundById.get(game.scheduledGameId ?? '')?.id ?? '',
    packetId: game.packetId ?? null,
    status: gameStatus(game.status),
    scores: resultScores(game),
    playerStats: (game.result?.players ?? []).map((player) => ({
      playerId: player.playerId,
      teamId: player.teamId,
      powers: player.powers ?? 0,
      gets: player.gets ?? 0,
      negs: player.negs ?? 0,
      bonusPoints: player.bonusPoints ?? 0,
      tossupsHeard: player.tossupsHeard ?? null,
    })),
    source: 'qbj' as const,
    rawQbj: game.rawSubmission ?? game.result?.rawSubmission,
    finishedAt: game.submittedAt,
    acceptedAt: game.acceptedAt,
    note: game.result?.notes,
  }));
  state.submissions = data.resultSubmissions.map((submission) => ({
    id: submission.id,
    gameId: submission.gameId,
    receivedAt: submission.receivedAt,
    fingerprint: submission.fingerprint ?? '',
    status:
      submission.status === 'pending'
        ? 'received'
        : submission.status === 'edited'
          ? 'accepted'
          : submission.status === 'duplicate'
            ? 'duplicate'
            : submission.status === 'accepted'
              ? 'accepted'
              : submission.status === 'rejected'
                ? 'rejected'
                : 'review',
    rawSubmission: submission.raw,
    reason: submission.reviewNote,
    acceptedAt: submission.reviewedAt,
  }));
  state.protests = data.protests.map((protest) => ({
    id: protest.id,
    gameId: protest.gameId,
    category:
      protest.subject === 'tossup' || protest.subject === 'bonus' || protest.subject === 'procedure'
        ? protest.subject
        : 'other',
    description: protest.description,
    status: protest.status === 'resolved' ? 'ruled' : protest.status === 'withdrawn' ? 'withdrawn' : 'open',
    ruling: protest.ruling,
    createdAt: protest.createdAt,
    updatedAt: protest.resolvedAt ?? protest.createdAt,
  }));
  state.audit = data.auditEvents.map((event) => ({
    id: event.id,
    at: event.at,
    actor: event.actor ?? 'Import',
    type: auditType(event.action),
    summary: event.action,
    entityId: event.entityId,
    details: event.details,
  }));
  state.qbtcpSessions = data.qbtcpSessions.map((session) => ({
    roomId: session.roomId ?? '',
    sessionId: session.id,
    deviceId: session.clientId ?? '',
    state: session.status === 'connected' ? 'live' : session.status === 'expired' ? 'abandoned' : 'paired',
    lastSeenAt: session.lastSeenAt ?? now,
    progress: null,
    helpRequestId: null,
  }));
  state.metadata.lastSavedAt = now;
  return normalizeDirectorState(state);
}

function roundStatus(status: string | undefined): DirectorState['rounds'][number]['status'] {
  switch (status) {
    case 'ready':
    case 'prepared':
      return 'prepared';
    case 'released':
      return 'released';
    case 'closed':
    case 'complete':
      return 'closed';
    default:
      return 'planned';
  }
}

function rulesFromInterchange(
  rules: JsonObject | undefined,
): Partial<DirectorState['tournament'] extends infer T ? (T extends { rules: infer R } ? R : never) : never> {
  if (!rules) return {};
  const firstNumber = (...values: unknown[]): number | undefined => {
    for (const value of values) {
      const candidate = number(value);
      if (candidate !== undefined) return candidate;
    }
    return undefined;
  };
  return {
    tossupValue: firstNumber(rules.tossupValue, rules.tossupPoints),
    powerValue: firstNumber(rules.powerValue, rules.powerPoints),
    negValue: firstNumber(rules.negValue, rules.negPoints),
    bonusValue: firstNumber(rules.bonusValue, rules.bonusPoints),
    tossupCount: firstNumber(rules.tossupCount, rules.tossupsPerGame),
    bonusParts: firstNumber(rules.bonusParts),
    bouncebacks: typeof rules.bouncebacks === 'boolean' ? rules.bouncebacks : undefined,
    overtime: typeof rules.overtime === 'boolean' ? rules.overtime : undefined,
    lightning: typeof rules.lightning === 'boolean' ? rules.lightning : undefined,
    maximumActivePlayers: firstNumber(rules.maximumActivePlayers, rules.maximumPlayersPerTeam),
    regulationMinutes: firstNumber(rules.regulationMinutes),
    tiebreakers: Array.isArray(rules.tiebreakers)
      ? rules.tiebreakers.filter(
          (value): value is NonNullable<DirectorState['tournament']>['rules']['tiebreakers'][number] =>
            value === 'head-to-head' ||
            value === 'record' ||
            value === 'points' ||
            value === 'margin' ||
            value === 'powers' ||
            value === 'gets' ||
            value === 'playoff',
        )
      : undefined,
  };
}

export function exportArchiveBytes(state: DirectorState): Uint8Array {
  return exportDirectorArchive(toInterchange(state), {
    generator: { name: 'QBSheet Director' },
  });
}

export function exportQbj(state: DirectorState): string {
  return exportQbjText(toInterchange(state), { mode: 'tournament' });
}

export function exportTeamCsv(state: DirectorState): string {
  const data = toInterchange(state);
  return exportTeamsCsv(data.teams, { players: data.players });
}

export function exportSqbs(state: DirectorState): string {
  return exportSqbsTeams(toInterchange(state).teams);
}

export function importArchiveBytes(bytes: Uint8Array): DirectorImportReport {
  const report = importDirectorArchive(bytes);
  if (!report.ok)
    return {
      ok: false,
      errors: report.errors.map((entry) => entry.message),
      warnings: report.warnings.map((entry) => entry.message),
    };
  return {
    ok: true,
    state: fromInterchange(report.value.tournament),
    errors: [],
    warnings: report.warnings.map((entry) => entry.message),
  };
}

export function importQbjText(value: string): DirectorImportReport {
  const report = importQbj(value);
  if (!report.ok)
    return {
      ok: false,
      errors: report.errors.map((entry) => entry.message),
      warnings: report.warnings.map((entry) => entry.message),
    };
  return {
    ok: true,
    state: fromInterchange(report.value.tournament),
    errors: [],
    warnings: report.warnings.map((entry) => entry.message),
  };
}

export function importDirectorTournament(value: DirectorTournamentInput): DirectorState {
  return fromInterchange({
    ...value,
    organizations: value.organizations ?? [],
    players: value.players ?? [],
    teams: value.teams ?? [],
    registrations: value.registrations ?? [],
    rooms: value.rooms ?? [],
    staff: value.staff ?? [],
    equipment: value.equipment ?? [],
    packets: value.packets ?? [],
    phases: value.phases ?? [],
    pools: value.pools ?? [],
    rounds: value.rounds ?? [],
    scheduledGames: value.scheduledGames ?? [],
    games: value.games ?? [],
    playerStatistics: value.playerStatistics ?? [],
    qbtcpSessions: value.qbtcpSessions ?? [],
    resultSubmissions: value.resultSubmissions ?? [],
    protests: value.protests ?? [],
    auditEvents: value.auditEvents ?? [],
  });
}
