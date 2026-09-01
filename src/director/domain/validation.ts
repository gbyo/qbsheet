import { type DirectorState, type Room, type ScheduledGame } from './model';
import { scheduleIsValid } from './scheduling';

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
  if (!state.tournament.formatId || state.formats.length === 0) {
    issues.push({
      id: 'format-missing',
      severity: 'blocker',
      area: 'format',
      message: 'Choose a tournament format.',
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
    if (!scheduleIsValid(games)) {
      issues.push({
        id: `round-invalid-${round.id}`,
        severity: 'blocker',
        area: 'schedule',
        message: `${round.name} contains a team conflict.`,
      });
    }
  }
  issues.push(...roomConflicts(state.rooms));
  const packetReuse = state.packets.filter(
    (packet) => new Set(packet.usedGameIds).size !== packet.usedGameIds.length,
  );
  if (packetReuse.length > 0) {
    issues.push({
      id: 'packet-reuse',
      severity: 'warning',
      area: 'packets',
      message: 'One or more packets are recorded as used more than once.',
    });
  }
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
