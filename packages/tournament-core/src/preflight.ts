import type { EntityId, Phase, Pool, RoomAssignment, ScheduledGame, TournamentSnapshot } from './model';
import { validateRules } from './rules';
import { validateSchedule } from './scheduling';

export type PreflightSeverity = 'blocker' | 'warning' | 'recommendation';
export type PreflightPurpose = 'start' | 'finalize';

export interface PreflightCheck {
  readonly code: string;
  readonly severity: PreflightSeverity;
  readonly title: string;
  readonly message: string;
  readonly entityIds: readonly EntityId[];
}

export interface QbtcpPreflightState {
  readonly listenerReady: boolean;
  readonly port?: number;
  readonly pairedRoomIds?: readonly EntityId[];
}

export interface StoragePreflightState {
  readonly writable: boolean;
  readonly backupDirectoryConfigured?: boolean;
  readonly lastCheckpointAt?: string | null;
}

export interface PreflightInput {
  readonly tournament: TournamentSnapshot;
  readonly schedule?: readonly ScheduledGame[];
  readonly qbtcp?: QbtcpPreflightState;
  readonly storage?: StoragePreflightState;
  readonly purpose?: PreflightPurpose;
  readonly requireStaff?: boolean;
  readonly requirePackets?: boolean;
  readonly requireQbtcp?: boolean;
}

export interface PreflightReport {
  readonly checks: readonly PreflightCheck[];
  readonly blockers: readonly PreflightCheck[];
  readonly warnings: readonly PreflightCheck[];
  readonly recommendations: readonly PreflightCheck[];
  readonly canStart: boolean;
  readonly canFinalize: boolean;
}

function check(
  code: string,
  severity: PreflightSeverity,
  title: string,
  message: string,
  entityIds: readonly EntityId[] = [],
): PreflightCheck {
  return { code, severity, title, message, entityIds };
}

function duplicateIds<T extends { readonly id: EntityId }>(values: readonly T[]): EntityId[] {
  const seen = new Set<EntityId>();
  const duplicates = new Set<EntityId>();
  for (const value of values) {
    if (seen.has(value.id)) duplicates.add(value.id);
    seen.add(value.id);
  }
  return [...duplicates];
}

function duplicateNames<T extends { readonly id: EntityId; readonly name: string }>(
  values: readonly T[],
): T[] {
  const seen = new Map<string, T>();
  const duplicates: T[] = [];
  for (const value of values) {
    const key = value.name.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
    const previous = seen.get(key);
    if (previous) duplicates.push(value, previous);
    seen.set(key, value);
  }
  return [...new Map(duplicates.map((value) => [value.id, value])).values()];
}

function addReferenceChecks(
  checks: PreflightCheck[],
  tournament: TournamentSnapshot,
  phases: readonly Phase[],
  pools: readonly Pool[],
): void {
  const phaseIds = new Set(phases.map((phase) => phase.id));
  const poolIds = new Set(pools.map((pool) => pool.id));
  const teamIds = new Set(tournament.teams.map((team) => team.id));
  for (const phase of phases) {
    const missingPools = phase.poolIds.filter((poolId) => !poolIds.has(poolId));
    const missingRounds = phase.roundIds.filter(
      (roundId) => !tournament.rounds.some((round) => round.id === roundId),
    );
    if (missingPools.length > 0 || missingRounds.length > 0) {
      checks.push(
        check(
          'phase-reference',
          'blocker',
          'Phase references are incomplete',
          `Phase “${phase.name}” references missing pools or rounds.`,
          [phase.id, ...missingPools, ...missingRounds],
        ),
      );
    }
  }
  for (const pool of pools) {
    if (!phaseIds.has(pool.phaseId))
      checks.push(
        check(
          'pool-phase-reference',
          'blocker',
          'Pool has no phase',
          `Pool “${pool.name}” references a missing phase.`,
          [pool.id, pool.phaseId],
        ),
      );
    const duplicates = pool.teamIds.filter((teamId, index) => pool.teamIds.indexOf(teamId) !== index);
    const missingTeams = pool.teamIds.filter((teamId) => !teamIds.has(teamId));
    if (duplicates.length > 0)
      checks.push(
        check(
          'pool-duplicate-team',
          'blocker',
          'Pool contains a duplicate team',
          `Pool “${pool.name}” contains a team more than once.`,
          [pool.id, ...duplicates],
        ),
      );
    if (missingTeams.length > 0)
      checks.push(
        check(
          'pool-missing-team',
          'blocker',
          'Pool contains a missing team',
          `Pool “${pool.name}” references a team that no longer exists.`,
          [pool.id, ...missingTeams],
        ),
      );
  }
}

function addTeamAndRosterChecks(checks: PreflightCheck[], tournament: TournamentSnapshot): void {
  const duplicateTeamIds = duplicateIds(tournament.teams);
  if (duplicateTeamIds.length > 0)
    checks.push(
      check(
        'duplicate-team-id',
        'blocker',
        'Duplicate team ids',
        'The tournament contains duplicate team identifiers.',
        duplicateTeamIds,
      ),
    );
  const duplicateTeamNames = duplicateNames(tournament.teams);
  if (duplicateTeamNames.length > 0)
    checks.push(
      check(
        'duplicate-team-name',
        'blocker',
        'Duplicate team names',
        'Team names must be unique before assignments are released.',
        duplicateTeamNames.map((team) => team.id),
      ),
    );
  const activeTeams = tournament.teams.filter((team) => team.status === 'active' || team.status === 'late');
  if (activeTeams.length < 2)
    checks.push(
      check(
        'too-few-teams',
        'blocker',
        'Not enough teams',
        'At least two active teams are required to start a round.',
        activeTeams.map((team) => team.id),
      ),
    );
  const organizationIds = new Set(tournament.organizations.map((organization) => organization.id));
  for (const team of tournament.teams) {
    if (team.organizationId && !organizationIds.has(team.organizationId))
      checks.push(
        check(
          'team-missing-organization',
          'blocker',
          'Team organization is missing',
          `Team “${team.displayName}” references an unknown organization.`,
          [team.id, team.organizationId],
        ),
      );
    const playerIds = new Set(team.playerIds);
    if (playerIds.size !== team.playerIds.length)
      checks.push(
        check(
          'duplicate-roster-player',
          'blocker',
          'Duplicate roster entry',
          `Team “${team.displayName}” lists a player more than once.`,
          [team.id],
        ),
      );
  }
  const teamIds = new Set(tournament.teams.map((team) => team.id));
  for (const player of tournament.players) {
    if (player.teamId && !teamIds.has(player.teamId))
      checks.push(
        check(
          'player-missing-team',
          'blocker',
          'Player team is missing',
          `Player “${player.name}” references an unknown team.`,
          [player.id, player.teamId],
        ),
      );
    if (
      player.teamId &&
      tournament.teams.find((team) => team.id === player.teamId)?.playerIds.includes(player.id) === false
    ) {
      checks.push(
        check(
          'roster-link-mismatch',
          'blocker',
          'Roster links disagree',
          `Player “${player.name}” is not listed in both directions of the roster relationship.`,
          [player.id, player.teamId],
        ),
      );
    }
  }
}

function addStaffChecks(
  checks: PreflightCheck[],
  tournament: TournamentSnapshot,
  schedule: readonly ScheduledGame[],
  requireStaff: boolean,
): void {
  const staffById = new Map(tournament.staff.map((member) => [member.id, member]));
  const assignmentsByRound = new Map<EntityId, RoomAssignment[]>();
  for (const assignment of tournament.roomAssignments) {
    const current = assignmentsByRound.get(assignment.roundId) ?? [];
    current.push(assignment);
    assignmentsByRound.set(assignment.roundId, current);
    if (!tournament.rooms.some((room) => room.id === assignment.roomId))
      checks.push(
        check(
          'assignment-missing-room',
          'blocker',
          'Room assignment is invalid',
          `Room assignment “${assignment.id}” references a missing room.`,
          [assignment.id, assignment.roomId],
        ),
      );
    for (const staffId of [assignment.moderatorId, assignment.scorekeeperId]) {
      if (staffId && !staffById.has(staffId))
        checks.push(
          check(
            'assignment-missing-staff',
            'blocker',
            'Staff assignment is invalid',
            `Room assignment “${assignment.id}” references missing staff.`,
            [assignment.id, staffId],
          ),
        );
    }
  }
  for (const [roundId, assignments] of assignmentsByRound) {
    for (const role of ['moderatorId', 'scorekeeperId'] as const) {
      const seen = new Map<EntityId, EntityId>();
      for (const assignment of assignments) {
        const staffId = assignment[role];
        if (!staffId) continue;
        const previous = seen.get(staffId);
        if (previous)
          checks.push(
            check(
              'staff-double-booked',
              'blocker',
              'Staff member is double-booked',
              `Staff member “${staffId}” is assigned twice in round “${roundId}”.`,
              [staffId, previous, assignment.id],
            ),
          );
        seen.set(staffId, assignment.id);
      }
    }
  }
  const activeMatches = schedule.filter((game) => game.kind !== 'bye');
  if (
    requireStaff &&
    activeMatches.length > 0 &&
    tournament.staff.filter((member) => member.active).length === 0
  ) {
    checks.push(
      check(
        'staff-required',
        'blocker',
        'Staff assignments are required',
        'This tournament is configured to require staff, but no active staff members exist.',
      ),
    );
  } else if (activeMatches.length > 0 && tournament.staff.length === 0) {
    checks.push(
      check(
        'staff-not-configured',
        'recommendation',
        'Staff is not configured',
        'Add moderators and scorekeepers if the event will not use self-contained room procedures.',
      ),
    );
  }
}

function addPacketChecks(
  checks: PreflightCheck[],
  tournament: TournamentSnapshot,
  schedule: readonly ScheduledGame[],
  requirePackets: boolean,
): void {
  const packetsById = new Map(tournament.packets.map((packet) => [packet.id, packet]));
  const byRound = new Map<EntityId, Map<EntityId, EntityId[]>>();
  for (const game of schedule) {
    if (game.kind === 'bye') continue;
    if (!game.packetId) {
      checks.push(
        check(
          requirePackets ? 'packet-required' : 'packet-unassigned',
          requirePackets ? 'blocker' : 'recommendation',
          'Packet is not assigned',
          `Game “${game.id}” has no packet assigned.`,
          [game.id],
        ),
      );
      continue;
    }
    const packet = packetsById.get(game.packetId);
    if (!packet) {
      checks.push(
        check(
          'missing-packet',
          'blocker',
          'Packet does not exist',
          `Game “${game.id}” references packet “${game.packetId}”, which is not in inventory.`,
          [game.id, game.packetId],
        ),
      );
      continue;
    }
    const roundPackets = byRound.get(game.roundId) ?? new Map<EntityId, EntityId[]>();
    const gameIds = roundPackets.get(packet.id) ?? [];
    gameIds.push(game.id);
    roundPackets.set(packet.id, gameIds);
    byRound.set(game.roundId, roundPackets);
  }
  for (const [roundId, packets] of byRound) {
    for (const [packetId, gameIds] of packets) {
      if (gameIds.length > 1)
        checks.push(
          check(
            'packet-reused-in-round',
            'blocker',
            'Packet is reused in one round',
            `Packet “${packetId}” is assigned to multiple games in round “${roundId}”.`,
            [packetId, ...gameIds],
          ),
        );
    }
  }
  const useSites = new Map<EntityId, EntityId[]>();
  for (const game of schedule) {
    if (game.kind !== 'bye' && game.packetId) {
      const sites = useSites.get(game.packetId) ?? [];
      sites.push(game.id);
      useSites.set(game.packetId, sites);
    }
  }
  for (const [packetId, gameIds] of useSites) {
    if (gameIds.length > 1)
      checks.push(
        check(
          'packet-reuse',
          'warning',
          'Packet is used more than once',
          `Packet “${packetId}” is assigned to ${gameIds.length} games; confirm replacement or repeated-use policy.`,
          [packetId, ...gameIds],
        ),
      );
  }
}

function addStorageChecks(checks: PreflightCheck[], storage: StoragePreflightState | undefined): void {
  if (!storage) {
    checks.push(
      check(
        'storage-not-probed',
        'recommendation',
        'Storage has not been probed',
        'Run a writable-storage and checkpoint probe before releasing a round.',
      ),
    );
    return;
  }
  if (!storage.writable)
    checks.push(
      check(
        'storage-not-writable',
        'blocker',
        'Tournament storage is not writable',
        'Director cannot safely persist results or schedule changes.',
      ),
    );
  if (storage.backupDirectoryConfigured === false)
    checks.push(
      check(
        'backup-location-missing',
        'warning',
        'Backup location is not configured',
        'Configure a backup location before a live event.',
      ),
    );
  if (!storage.lastCheckpointAt)
    checks.push(
      check(
        'checkpoint-missing',
        'warning',
        'No checkpoint has been recorded',
        'Create a checkpoint before the first live round.',
      ),
    );
}

/** Check whether a tournament snapshot is safe to start or finalize. */
export function runPreflight(input: PreflightInput): PreflightReport {
  const tournament = input.tournament;
  const schedule = input.schedule ?? tournament.scheduledGames;
  const purpose = input.purpose ?? 'start';
  const checks: PreflightCheck[] = [];
  if (!tournament.metadata.name.trim())
    checks.push(
      check(
        'missing-tournament-name',
        'blocker',
        'Tournament name is missing',
        'Give the tournament a name before saving or releasing a round.',
      ),
    );
  const rulesIssues = validateRules(tournament.rules);
  for (const rulesIssue of rulesIssues)
    checks.push(check(`rules-${rulesIssue.code}`, 'blocker', 'Rules need attention', rulesIssue.message));
  addTeamAndRosterChecks(checks, tournament);
  addReferenceChecks(checks, tournament, tournament.phases, tournament.pools);

  if (schedule.length === 0) {
    const phaseNeedsSchedule = tournament.phases.some(
      (phase) => phase.status === 'scheduled' || phase.status === 'in-progress',
    );
    checks.push(
      check(
        phaseNeedsSchedule ? 'schedule-missing' : 'schedule-not-generated',
        phaseNeedsSchedule ? 'blocker' : 'recommendation',
        'Schedule is not generated',
        phaseNeedsSchedule
          ? 'The active phase has no scheduled games.'
          : 'Generate a schedule before starting the tournament.',
      ),
    );
  } else {
    const scheduleIssues = validateSchedule(schedule, tournament.teams, {
      rooms: tournament.rooms,
      requireRoomAssignments: false,
      rematchPolicy: tournament.rules.rematchPolicy,
      requireExplicitByes: true,
    });
    for (const scheduleIssue of scheduleIssues) {
      const severity: PreflightSeverity =
        scheduleIssue.severity === 'error'
          ? 'blocker'
          : scheduleIssue.severity === 'warning'
            ? 'warning'
            : 'recommendation';
      checks.push(
        check(`schedule-${scheduleIssue.code}`, severity, 'Schedule needs attention', scheduleIssue.message, [
          ...scheduleIssue.gameIds,
          ...scheduleIssue.teamIds,
        ]),
      );
    }
  }
  const activeRooms = tournament.rooms.filter((room) => room.active);
  if (schedule.some((game) => game.kind !== 'bye') && activeRooms.length === 0)
    checks.push(
      check(
        'rooms-missing',
        'blocker',
        'No active rooms',
        'At least one active room is required for scheduled games.',
      ),
    );
  if (schedule.some((game) => game.kind !== 'bye' && !game.roomId))
    checks.push(
      check(
        'rooms-unassigned',
        'warning',
        'Some games have no room',
        'Assign rooms before releasing the affected round.',
      ),
    );
  addStaffChecks(checks, tournament, schedule, input.requireStaff ?? false);
  addPacketChecks(checks, tournament, schedule, input.requirePackets ?? false);
  if (!input.qbtcp) {
    checks.push(
      check(
        'qbtcp-not-probed',
        input.requireQbtcp ? 'blocker' : 'recommendation',
        'QBTCP listener has not been checked',
        'Probe the native listener before releasing electronic assignments.',
      ),
    );
  } else if (!input.qbtcp.listenerReady) {
    checks.push(
      check(
        'qbtcp-not-ready',
        input.requireQbtcp ? 'blocker' : 'warning',
        'QBTCP listener is not ready',
        'The Director server is not accepting room connections.',
      ),
    );
  } else if (!input.qbtcp.port || input.qbtcp.port < 1 || input.qbtcp.port > 65535) {
    checks.push(
      check(
        'qbtcp-invalid-port',
        'blocker',
        'QBTCP port is invalid',
        'Use a valid TCP port before pairing rooms.',
      ),
    );
  }
  addStorageChecks(checks, input.storage);

  const openProtests = tournament.protests.filter(
    (protest) => protest.status === 'open' || protest.status === 'under-review',
  );
  if (openProtests.length > 0 && purpose === 'finalize')
    checks.push(
      check(
        'open-protests',
        'blocker',
        'Protests remain unresolved',
        'Resolve all protests before finalizing standings.',
        openProtests.map((protest) => protest.id),
      ),
    );
  else if (openProtests.length > 0)
    checks.push(
      check(
        'open-protests',
        'warning',
        'Protests remain unresolved',
        'Live standings may change when these protests are ruled.',
        openProtests.map((protest) => protest.id),
      ),
    );

  const blockers = checks.filter((current) => current.severity === 'blocker');
  const warnings = checks.filter((current) => current.severity === 'warning');
  const recommendations = checks.filter((current) => current.severity === 'recommendation');
  return {
    checks,
    blockers,
    warnings,
    recommendations,
    canStart: blockers.length === 0,
    canFinalize: blockers.length === 0 && openProtests.length === 0,
  };
}

export function preflightIsClean(report: PreflightReport): boolean {
  return report.blockers.length === 0 && report.warnings.length === 0;
}
