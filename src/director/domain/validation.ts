import { type DirectorId, type DirectorState, type ScheduledGame } from './model';
import {
  currentFormat,
  currentPhase,
  currentPacket,
  formatGenerationAvailability,
  scheduleIsValid,
} from './scheduling';

export type PreflightSeverity = 'blocker' | 'warning' | 'recommendation';

export interface PreflightIssue {
  id: string;
  severity: PreflightSeverity;
  area: 'tournament' | 'teams' | 'format' | 'schedule' | 'rooms' | 'packets' | 'storage' | 'qbtcp';
  message: string;
  action?: string;
}

export function runPreflight(
  state: DirectorState,
  nativeServerReady = false,
  nativeServerAvailable = true,
): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  if (!state.tournament) {
    issues.push({
      id: 'tournament-missing',
      severity: 'blocker',
      area: 'tournament',
      message: 'Create or open a tournament first.',
    });
    return issues;
  }
  if (state.teams.filter((team) => team.status === 'confirmed').length < 2) {
    issues.push({
      id: 'teams-too-few',
      severity: 'blocker',
      area: 'teams',
      message: 'Add at least two confirmed teams.',
    });
  }
  const duplicateNames = duplicateValues(
    state.teams
      .filter((team) => team.status !== 'dropped')
      .map((team) => team.displayName.trim().toLocaleLowerCase()),
  );
  if (duplicateNames.length > 0) {
    issues.push({
      id: 'duplicate-teams',
      severity: 'blocker',
      area: 'teams',
      message: `Duplicate team names: ${duplicateNames.join(', ')}.`,
    });
  }
  const format = currentFormat(state);
  const phase = currentPhase(state);
  if (!state.tournament.formatId || !format) {
    issues.push({
      id: 'format-missing',
      severity: 'blocker',
      area: 'format',
      message: 'Choose a valid current tournament format.',
    });
  }
  if (format && (!phase || phase.formatId !== format.id)) {
    issues.push({
      id: 'phase-missing',
      severity: 'blocker',
      area: 'format',
      message: 'Choose a valid current phase for the selected format.',
    });
  }
  if (format) {
    const availability = formatGenerationAvailability(state);
    const tournamentClosed = state.tournament.status === 'complete' || state.tournament.status === 'archived';
    if (!availability.supported && !tournamentClosed) {
      issues.push({
        id: 'format-generation-unavailable',
        severity: 'blocker',
        area: 'format',
        message: availability.message,
      });
    }
  }
  if (state.tournament.currentPacketId && !currentPacket(state)) {
    issues.push({
      id: 'packet-current-missing',
      severity: 'blocker',
      area: 'packets',
      message: 'The selected current packet no longer exists.',
    });
  }
  const roundById = new Map(state.rounds.map((round) => [round.id, round]));
  const unscheduled = state.scheduledGames.filter((game) => {
    const round = roundById.get(game.roundId);
    return !game.bye && game.roomId === null && game.status !== 'cancelled' && round?.status !== 'closed';
  });
  // Room guidance only matters once the tournament uses rooms at all. A manual
  // tournament with no room records never needs this warning.
  if (unscheduled.length > 0 && state.rooms.length > 0) {
    issues.push({
      id: 'games-without-rooms',
      severity: 'warning',
      area: 'schedule',
      message: `${unscheduled.length} scheduled game(s) do not have a room.`,
    });
  }
  const unavailableRooms = state.scheduledGames.filter((game) => {
    if (game.bye || game.status === 'cancelled' || !game.roomId) return false;
    const round = state.rounds.find((entry) => entry.id === game.roundId);
    if (!round || (round.status !== 'planned' && round.status !== 'prepared')) return false;
    const room = state.rooms.find((entry) => entry.id === game.roomId);
    return !room || !room.available || room.status !== 'available';
  });
  if (unavailableRooms.length > 0) {
    issues.push({
      id: 'games-with-unavailable-rooms',
      severity: 'blocker',
      area: 'rooms',
      message: `${unavailableRooms.length} scheduled game(s) use rooms that are unavailable or not operationally ready.`,
      action: 'Open Rooms',
    });
  }
  for (const round of state.rounds) {
    if (!roundScheduleIsValid(state, round.id)) {
      issues.push({
        id: `round-invalid-${round.id}`,
        severity: 'blocker',
        area: 'schedule',
        message: `${round.name} contains an invalid matchup or round membership.`,
      });
    }
  }
  const roundIds = new Set(state.rounds.map((round) => round.id));
  const orphanedGames = state.scheduledGames.filter((game) => !roundIds.has(game.roundId));
  if (orphanedGames.length > 0) {
    issues.push({
      id: 'games-without-round',
      severity: 'blocker',
      area: 'schedule',
      message: `${orphanedGames.length} scheduled game(s) reference a missing round.`,
    });
  }
  issues.push(...roomAssignmentConflicts(state));
  const packetReuse = packetUseConflicts(state);
  if (packetReuse.length > 0) {
    issues.push({
      id: 'packet-reuse',
      severity: 'warning',
      area: 'packets',
      message: `Packet reuse detected: ${packetReuse.map((entry) => `${entry.packetId} (${entry.gameIds.length} games)`).join(', ')}.`,
    });
  }
  issues.push(...packetReferenceIssues(state));
  // QBTCP serves rooms: with no room records there is nothing to pair, so a
  // roomless manual tournament is never nagged about the native server.
  if (nativeServerAvailable && !nativeServerReady && state.rooms.length > 0) {
    if (state.tournament.status !== 'complete' && state.tournament.status !== 'archived') {
      issues.push({
        id: 'qbtcp-offline',
        severity: 'recommendation',
        area: 'qbtcp',
        message: 'Start the native QBTCP server before releasing electronic assignments.',
      });
    }
  }
  if (
    !state.metadata.lastCheckpointAt &&
    state.tournament.status !== 'complete' &&
    state.tournament.status !== 'archived'
  ) {
    issues.push({
      id: 'checkpoint-missing',
      severity: 'recommendation',
      area: 'storage',
      message: 'Create a checkpoint before the first round.',
    });
  }
  return issues;
}

export function roomAssignmentConflicts(
  state: DirectorState,
  roomIds?: ReadonlySet<DirectorId>,
): PreflightIssue[] {
  const rooms = state.rooms.filter((room) => room.available && (!roomIds || roomIds.has(room.id)));
  const staffById = new Map(state.staff.map((member) => [member.id, member]));
  const equipmentById = new Map(state.equipment.map((item) => [item.id, item]));
  const usedStaff = new Map<string, string>();
  const reportedStaffConflicts = new Set<string>();
  const usedEquipment = new Map<string, string>();
  const reportedEquipmentConflicts = new Set<string>();
  const issues: PreflightIssue[] = [];
  for (const room of rooms) {
    for (const [role, staffId] of [
      ['moderator', room.moderatorId],
      ['scorekeeper', room.scorekeeperId],
    ] as const) {
      if (!staffId) continue;
      const member = staffById.get(staffId);
      if (!member) {
        issues.push({
          id: `staff-missing-${staffId}`,
          severity: 'blocker',
          area: 'rooms',
          message: `${room.name} references a missing ${role}.`,
        });
        continue;
      }
      if (!member.available) {
        issues.push({
          id: `staff-unavailable-${staffId}`,
          severity: 'blocker',
          area: 'rooms',
          message: `${member.name} is unavailable but assigned to ${room.name}.`,
        });
      }
      if (!member.roles.includes(role)) {
        issues.push({
          id: `staff-role-${staffId}-${role}`,
          severity: 'blocker',
          area: 'rooms',
          message: `${member.name} is assigned as ${role} in ${room.name} but is not marked for that role.`,
        });
      }
      const previous = usedStaff.get(staffId);
      if (previous && !reportedStaffConflicts.has(staffId)) {
        issues.push({
          id: `staff-conflict-${staffId}`,
          severity: 'blocker',
          area: 'rooms',
          message: `${member.name} is assigned to both ${previous} and ${room.name}.`,
        });
        reportedStaffConflicts.add(staffId);
      } else {
        if (!previous) usedStaff.set(staffId, `${room.name} (${role})`);
      }
    }
    if (room.equipmentId) {
      const equipment = equipmentById.get(room.equipmentId);
      if (!equipment) {
        issues.push({
          id: `equipment-missing-${room.equipmentId}`,
          severity: 'blocker',
          area: 'rooms',
          message: `${room.name} references missing equipment.`,
        });
      } else {
        if (!equipment.available) {
          issues.push({
            id: `equipment-unavailable-${room.equipmentId}`,
            severity: 'blocker',
            area: 'rooms',
            message: `${equipment.name} is unavailable but assigned to ${room.name}.`,
          });
        }
        const previous = usedEquipment.get(room.equipmentId);
        if (previous && !reportedEquipmentConflicts.has(room.equipmentId)) {
          issues.push({
            id: `equipment-conflict-${room.equipmentId}`,
            severity: 'blocker',
            area: 'rooms',
            message: `${equipment.name} is assigned to both ${previous} and ${room.name}.`,
          });
          reportedEquipmentConflicts.add(room.equipmentId);
        } else if (!previous) {
          usedEquipment.set(room.equipmentId, room.name);
        }
      }
    }
  }
  return issues;
}

function duplicateValues(values: string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].filter(([, count]) => count > 1).map(([value]) => value);
}

export function roundGames(state: DirectorState, roundId: string): ScheduledGame[] {
  return state.scheduledGames.filter((game) => game.roundId === roundId);
}

/**
 * Validate the round-local invariants required before a round can move through its lifecycle.
 *
 * `runPreflight` reports this as a single actionable issue, while the controller uses the same
 * predicate immediately before prepare, release, and close. Keeping the check here prevents an
 * imported or hand-edited round from bypassing the field and pool constraints merely because each
 * individual pairing looks well formed.
 */
export function roundScheduleIsValid(state: DirectorState, roundId: DirectorId): boolean {
  const round = state.rounds.find((entry) => entry.id === roundId);
  if (!round) return false;
  const games = roundGames(state, roundId);
  const actualIds = games.map((game) => game.id);
  const referencedIds = round.scheduledGameIds;
  const membershipValid =
    new Set(referencedIds).size === referencedIds.length &&
    new Set(actualIds).size === actualIds.length &&
    referencedIds.length === actualIds.length &&
    actualIds.every((gameId) => referencedIds.includes(gameId));
  if (!membershipValid) return false;

  const phase = state.phases.find((candidate) => candidate.id === round.phaseId);
  if (!phase || (phase.roundIds.length > 0 && !phase.roundIds.includes(round.id))) return false;

  // Closed rounds are historical records. Their original field may contain teams that were later
  // dropped, so preserve the existing preflight rule of checking membership without re-ranking it
  // against today's active field.
  if (round.status === 'closed') {
    if (phase.poolIds.length === 0) return games.every((game) => game.poolId == null);
    const poolIds = new Set(phase.poolIds);
    return (
      phase.poolIds.every((poolId) =>
        state.pools.some((pool) => pool.id === poolId && pool.phaseId === phase.id),
      ) && games.every((game) => typeof game.poolId === 'string' && poolIds.has(game.poolId))
    );
  }

  const format = state.formats.find((candidate) => candidate.id === phase.formatId);
  if (!format || games.length === 0) return false;
  // A single-elimination round is a resolvable slice of a bracket, not a field-wide pairing. The
  // first slice may contain several bracket byes (for example, three byes in a five-team draw),
  // while later slices contain only the winners that are ready to advance. The bracket adapter has
  // already proved the dependency graph; here we enforce the operational invariants that matter
  // before release: unique participants, no pool leakage, and stable bracket identities.
  if (format.kind === 'single-elimination') {
    return games.every((game) => game.poolId == null && Boolean(game.bracketKey)) && scheduleIsValid(games);
  }
  const expectedTeams =
    format.kind === 'custom'
      ? state.teams.filter(
          (team) =>
            team.status === 'confirmed' &&
            games.some((game) => game.leftTeamId === team.id || game.rightTeamId === team.id),
        )
      : expectedRoundTeams(state, phase);
  if (expectedTeams.length < 2) return false;
  const expectedByeCount =
    format.kind === 'custom'
      ? expectedTeams.length % 2
      : expectedRoundByeCount(state, phase, expectedTeams.length);
  if (
    !scheduleIsValid(games, expectedTeams, {
      expectedByeCount,
      allowByes: format.allowByes,
    })
  ) {
    return false;
  }

  if (phase.poolIds.length === 0) return games.every((game) => game.poolId == null);

  const pools = phase.poolIds
    .map((poolId) => state.pools.find((pool) => pool.id === poolId))
    .filter((pool): pool is NonNullable<typeof pool> => pool !== undefined && pool.archived !== true);
  if (pools.some((pool) => !pool || pool.phaseId !== phase.id)) return false;
  const confirmedIds = new Set(
    state.teams.filter((team) => team.status === 'confirmed').map((team) => team.id),
  );
  const poolTeamIds = pools.flatMap((pool) => pool?.teamIds ?? []);
  const poolTeamIdSet = new Set(poolTeamIds);
  if (
    poolTeamIds.some((teamId, index) => !confirmedIds.has(teamId) || poolTeamIds.indexOf(teamId) !== index) ||
    (format.kind === 'pools' &&
      (poolTeamIdSet.size !== confirmedIds.size ||
        [...confirmedIds].some((teamId) => !poolTeamIdSet.has(teamId))))
  ) {
    return false;
  }
  const activePoolIds = new Set(pools.map((pool) => pool.id));
  if (!games.every((game) => typeof game.poolId === 'string' && activePoolIds.has(game.poolId))) {
    return false;
  }
  return pools.every((pool) => {
    if (!pool) return false;
    const poolTeams = state.teams.filter(
      (team) => team.status === 'confirmed' && pool.teamIds.includes(team.id),
    );
    const poolGames = games.filter((game) => game.poolId === pool.id);
    return scheduleIsValid(poolGames, poolTeams, {
      expectedByeCount: poolTeams.length % 2,
      allowByes: format.allowByes,
    });
  });
}

function expectedRoundTeams(state: DirectorState, phase: DirectorState['phases'][number] | undefined) {
  if (!phase || phase.poolIds.length === 0) {
    return state.teams.filter((team) => team.status === 'confirmed');
  }
  const ids = new Set(
    state.pools
      .filter((pool) => phase.poolIds.includes(pool.id) && pool.archived !== true)
      .flatMap((pool) => pool.teamIds),
  );
  return state.teams.filter((team) => team.status === 'confirmed' && ids.has(team.id));
}

function expectedRoundByeCount(
  state: DirectorState,
  phase: DirectorState['phases'][number] | undefined,
  expectedTeamCount: number,
): number {
  if (!phase || phase.poolIds.length === 0) return expectedTeamCount % 2;
  return state.pools
    .filter((pool) => phase.poolIds.includes(pool.id) && pool.archived !== true)
    .reduce((count, pool) => {
      const activeCount = pool.teamIds.filter(
        (teamId) => state.teams.find((team) => team.id === teamId)?.status === 'confirmed',
      ).length;
      return count + (activeCount % 2);
    }, 0);
}

export function packetUseConflicts(
  state: DirectorState,
): Array<{ packetId: DirectorId; gameIds: DirectorId[] }> {
  const uses = new Map<DirectorId, Set<DirectorId>>();
  const roundUses = new Map<DirectorId, Set<DirectorId>>();
  const directUseRounds = new Map<DirectorId, Set<DirectorId>>();
  const add = (packetId: DirectorId | null, gameId: DirectorId) => {
    if (!packetId) return;
    const game = state.scheduledGames.find((candidate) => candidate.id === gameId);
    const roundId = game?.roundId;
    const round = roundId ? state.rounds.find((candidate) => candidate.id === roundId) : undefined;
    const isRoundPacket = !game?.packetId && round?.packetId === packetId;
    if (isRoundPacket && roundId) {
      const rounds = roundUses.get(packetId) ?? new Set<DirectorId>();
      rounds.add(roundId);
      roundUses.set(packetId, rounds);
      return;
    }
    const gameIds = uses.get(packetId) ?? new Set<DirectorId>();
    gameIds.add(gameId);
    uses.set(packetId, gameIds);
    if (roundId) {
      const rounds = directUseRounds.get(packetId) ?? new Set<DirectorId>();
      rounds.add(roundId);
      directUseRounds.set(packetId, rounds);
    }
  };
  const recordToScheduled = new Map(state.games.map((game) => [game.id, game.scheduledGameId]));
  for (const game of state.scheduledGames) {
    const round = state.rounds.find((candidate) => candidate.id === game.roundId);
    add(game.packetId ?? round?.packetId ?? null, game.id);
  }
  for (const packet of state.packets) {
    for (const gameId of packet.assignedGameIds) {
      add(packet.id, recordToScheduled.get(gameId) ?? gameId);
    }
    for (const gameId of packet.usedGameIds) {
      add(packet.id, recordToScheduled.get(gameId) ?? gameId);
    }
  }
  // Include round-level uses as a single representative per round so that a round packet shared
  // by multiple games in the same round does not appear as reuse.
  for (const [packetId, roundIds] of roundUses) {
    if (roundIds.size === 0) continue;
    const representativeIds = uses.get(packetId) ?? new Set<DirectorId>();
    // If there is also a direct per-game use, keep it. Otherwise, collapse the round's games to
    // one entry per round so a single round packet counts as one use.
    if (representativeIds.size === 0) {
      for (const roundId of roundIds) representativeIds.add(`round:${roundId}`);
      uses.set(packetId, representativeIds);
    } else {
      // A direct use in one round and a round-level use in another are two physical uses. Keep
      // only round representatives that are not already represented by a direct game use; a
      // direct override and an inherited packet in the same round are still one round's use.
      const directRounds = directUseRounds.get(packetId) ?? new Set<DirectorId>();
      for (const roundId of roundIds) {
        if (!directRounds.has(roundId)) representativeIds.add(`round:${roundId}`);
      }
    }
  }
  return [...uses.entries()]
    .filter(([, gameIds]) => gameIds.size > 1)
    .map(([packetId, gameIds]) => ({ packetId, gameIds: [...gameIds] }));
}

function packetReferenceIssues(state: DirectorState): PreflightIssue[] {
  const scheduledIds = new Set(state.scheduledGames.map((game) => game.id));
  const scheduledById = new Map(state.scheduledGames.map((game) => [game.id, game]));
  const roundById = new Map(state.rounds.map((round) => [round.id, round]));
  const gameToScheduled = new Map(state.games.map((game) => [game.id, game.scheduledGameId]));
  const packetIds = new Set(state.packets.map((packet) => packet.id));
  const packetIdsByScheduled = new Map<DirectorId, Set<DirectorId>>();
  const issues: PreflightIssue[] = [];
  const canonicalReference = (id: string): string | undefined =>
    scheduledIds.has(id) ? id : gameToScheduled.get(id);
  const effectivePacketId = (scheduled: ScheduledGame): DirectorId | null =>
    scheduled.packetId ?? roundById.get(scheduled.roundId)?.packetId ?? null;
  const addPacketForScheduled = (scheduledGameId: DirectorId, packetId: DirectorId): void => {
    const ids = packetIdsByScheduled.get(scheduledGameId) ?? new Set<DirectorId>();
    ids.add(packetId);
    packetIdsByScheduled.set(scheduledGameId, ids);
  };
  const addIssue = (issue: PreflightIssue): void => {
    if (!issues.some((existing) => existing.id === issue.id)) issues.push(issue);
  };

  for (const scheduled of state.scheduledGames) {
    const effective = effectivePacketId(scheduled);
    if (effective) {
      addPacketForScheduled(scheduled.id, effective);
      if (!packetIds.has(effective)) {
        addIssue({
          id: `scheduled-packet-missing-${scheduled.id}-${effective}`,
          severity: 'blocker',
          area: 'packets',
          message: `Scheduled game “${scheduled.id}” references unknown packet “${effective}”.`,
        });
      }
    }
  }
  for (const game of state.games) {
    const scheduled = scheduledById.get(game.scheduledGameId);
    if (!scheduled || !game.packetId) continue;
    addPacketForScheduled(scheduled.id, game.packetId);
    const effective = effectivePacketId(scheduled);
    if (effective && effective !== game.packetId) {
      addIssue({
        id: `record-packet-mismatch-${game.id}`,
        severity: 'blocker',
        area: 'packets',
        message: `Result “${game.id}” references packet “${game.packetId}”, but its scheduled game uses “${effective}”.`,
      });
    }
    if (!packetIds.has(game.packetId)) {
      addIssue({
        id: `record-packet-missing-${game.id}-${game.packetId}`,
        severity: 'blocker',
        area: 'packets',
        message: `Result “${game.id}” references unknown packet “${game.packetId}”.`,
      });
    }
  }
  for (const packet of state.packets) {
    const assigned = packet.assignedGameIds ?? [];
    const used = packet.usedGameIds ?? [];
    for (const [kind, ids] of [
      ['assigned', assigned],
      ['used', used],
    ] as const) {
      for (const id of ids) {
        const canonical = canonicalReference(id);
        if (!canonical) {
          addIssue({
            id: `packet-${kind}-missing-${packet.id}-${id}`,
            severity: 'blocker',
            area: 'packets',
            message: `Packet “${packet.name}” has a ${kind} reference to unknown game “${id}”.`,
          });
        } else {
          addPacketForScheduled(canonical, packet.id);
          const scheduled = scheduledById.get(canonical);
          const effective = scheduled ? effectivePacketId(scheduled) : null;
          if (scheduled && effective && effective !== packet.id) {
            addIssue({
              id: `packet-${kind}-mismatch-${packet.id}-${canonical}`,
              severity: 'blocker',
              area: 'packets',
              message: `Packet “${packet.name}” lists game “${canonical}”, but that scheduled game uses packet “${effective}”.`,
            });
          }
        }
      }
      const canonicalIds = ids.map(canonicalReference).filter((id): id is string => Boolean(id));
      if (new Set(canonicalIds).size !== canonicalIds.length) {
        addIssue({
          id: `packet-${kind}-duplicate-${packet.id}`,
          severity: 'warning',
          area: 'packets',
          message: `Packet “${packet.name}” repeats a ${kind} reference; repeated entries do not count as separate game use.`,
        });
      }
    }
    for (const roundId of packet.assignedRoundIds ?? []) {
      if (!state.rounds.some((round) => round.id === roundId)) {
        addIssue({
          id: `packet-round-missing-${packet.id}-${roundId}`,
          severity: 'blocker',
          area: 'packets',
          message: `Packet “${packet.name}” references unknown round “${roundId}”.`,
        });
      } else {
        const roundPacketId = roundById.get(roundId)?.packetId;
        if (roundPacketId && roundPacketId !== packet.id) {
          addIssue({
            id: `packet-round-mismatch-${packet.id}-${roundId}`,
            severity: 'blocker',
            area: 'packets',
            message: `Packet “${packet.name}” lists round “${roundId}”, but that round uses packet “${roundPacketId}”.`,
          });
        }
      }
    }
  }
  for (const [scheduledGameId, packetIdsForGame] of packetIdsByScheduled) {
    if (packetIdsForGame.size > 1) {
      addIssue({
        id: `packet-assignment-conflict-${scheduledGameId}`,
        severity: 'blocker',
        area: 'packets',
        message: `Scheduled game “${scheduledGameId}” is associated with multiple packet IDs: ${[...packetIdsForGame].join(', ')}.`,
      });
    }
  }
  return issues;
}
