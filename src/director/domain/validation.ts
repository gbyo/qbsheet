import { type DirectorId, type DirectorState, type Room, type ScheduledGame } from './model';
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

export function runPreflight(state: DirectorState, nativeServerReady = false): PreflightIssue[] {
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
    if (!availability.supported) {
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
  const unscheduled = state.scheduledGames.filter(
    (game) => !game.bye && game.roomId === null && game.status !== 'cancelled',
  );
  if (unscheduled.length > 0) {
    issues.push({
      id: 'games-without-rooms',
      severity: 'warning',
      area: 'schedule',
      message: `${unscheduled.length} scheduled game(s) do not have a room.`,
    });
  }
  for (const round of state.rounds) {
    const games = state.scheduledGames.filter((game) => game.roundId === round.id);
    const referencedIds = round.scheduledGameIds;
    const actualIds = games.map((game) => game.id);
    const membershipValid =
      new Set(referencedIds).size === referencedIds.length &&
      referencedIds.length === actualIds.length &&
      actualIds.every((gameId) => referencedIds.includes(gameId));
    const roundPhase = state.phases.find((candidate) => candidate.id === round.phaseId);
    const roundFormat = roundPhase
      ? state.formats.find((candidate) => candidate.id === roundPhase.formatId)
      : undefined;
    const expectedTeams = expectedRoundTeams(state, roundPhase);
    const expectedByeCount = expectedRoundByeCount(state, roundPhase, expectedTeams.length);
    const isHistoricalClosed = round.status === 'closed';
    const poolValid = roundPhase?.poolIds.length
      ? roundPhase.poolIds.every((poolId) => {
          const pool = state.pools.find((candidate) => candidate.id === poolId);
          if (!pool) return false;
          const poolTeams = state.teams.filter(
            (team) => team.status === 'confirmed' && pool.teamIds.includes(team.id),
          );
          const poolGames = games.filter((game) => game.poolId === pool.id);
          // Historical closed pools should not be revalidated against the current confirmed-team set.
          if (isHistoricalClosed) return poolGames.every((game) => typeof game.poolId === 'string');
          return scheduleIsValid(poolGames, poolTeams, {
            expectedByeCount: poolTeams.length % 2,
            allowByes: roundFormat?.allowByes,
          });
        }) && games.every((game) => roundPhase.poolIds.includes(game.poolId ?? ''))
      : true;
    const scheduleValidForRound = isHistoricalClosed
      ? true
      : scheduleIsValid(games, expectedTeams, {
          expectedByeCount,
          allowByes: roundFormat?.allowByes,
        });
    if (
      !membershipValid ||
      !roundPhase ||
      (roundPhase.roundIds.length > 0 && !roundPhase.roundIds.includes(round.id)) ||
      games.some((game) => game.roundId !== round.id) ||
      !scheduleValidForRound ||
      !poolValid
    ) {
      issues.push({
        id: `round-invalid-${round.id}`,
        severity: 'blocker',
        area: 'schedule',
        message: `${round.name} contains an invalid matchup or round membership.`,
      });
    }
  }
  issues.push(...roomConflicts(state.rooms));
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
  if (!nativeServerReady) {
    issues.push({
      id: 'qbtcp-offline',
      severity: 'recommendation',
      area: 'qbtcp',
      message: 'Start the native QBTCP server before releasing electronic assignments.',
    });
  }
  if (!state.metadata.lastCheckpointAt) {
    issues.push({
      id: 'checkpoint-missing',
      severity: 'recommendation',
      area: 'storage',
      message: 'Create a checkpoint before the first round.',
    });
  }
  return issues;
}

function roomConflicts(rooms: Room[]): PreflightIssue[] {
  const usedStaff = new Map<string, string>();
  const issues: PreflightIssue[] = [];
  for (const room of rooms.filter((room) => room.available)) {
    for (const staffId of [room.moderatorId, room.scorekeeperId].filter((id): id is string => id !== null)) {
      const previous = usedStaff.get(staffId);
      if (previous) {
        issues.push({
          id: `staff-conflict-${staffId}`,
          severity: 'blocker',
          area: 'rooms',
          message: `${staffId} is assigned to both ${previous} and ${room.name}.`,
        });
      } else {
        usedStaff.set(staffId, room.name);
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

function expectedRoundTeams(state: DirectorState, phase: DirectorState['phases'][number] | undefined) {
  if (!phase || phase.poolIds.length === 0) {
    return state.teams.filter((team) => team.status === 'confirmed');
  }
  const ids = new Set(
    state.pools.filter((pool) => phase.poolIds.includes(pool.id)).flatMap((pool) => pool.teamIds),
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
    .filter((pool) => phase.poolIds.includes(pool.id))
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
    } else if (roundIds.size > 1) {
      // Multiple rounds sharing the same packet is actual reuse.
      for (const roundId of roundIds) representativeIds.add(`round:${roundId}`);
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
