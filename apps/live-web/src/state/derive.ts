/**
 * Reading a QBLive snapshot from a followed team's point of view.
 *
 * Shared by Home, Schedule and the Live Activity payload builder, and written as pure functions so
 * the same answers can be tested without a DOM. The rule that runs through all of it: an absent
 * time is rendered as absent. Nothing here estimates.
 */

import type {
  QbliveAnnouncement,
  QbliveDataTable,
  QbliveLiveGame,
  QbliveResult,
  QbliveScheduledGame,
  QbliveSnapshot,
  QbliveTimelineEvent,
} from '@qbsheet/qblive-protocol';

export interface TeamNextEvent {
  kind: 'game' | 'event';
  game?: QbliveScheduledGame;
  event?: QbliveTimelineEvent;
  /** The exact scheduled start, or null when the tournament has not stated one. */
  scheduledStart: string | null;
}

export function teamName(snapshot: QbliveSnapshot, teamId: string | null | undefined): string {
  if (!teamId) return '—';
  return snapshot.teams.find((team) => team.id === teamId)?.name ?? 'Team';
}

export function roomName(snapshot: QbliveSnapshot, roomId: string | null | undefined): string | null {
  if (!roomId) return null;
  return snapshot.rooms.find((room) => room.id === roomId)?.name ?? null;
}

export function roomDirections(snapshot: QbliveSnapshot, roomId: string | null | undefined): string | null {
  if (!roomId) return null;
  return snapshot.rooms.find((room) => room.id === roomId)?.directions ?? null;
}

export function opponentOf(game: QbliveScheduledGame, teamId: string): string | null {
  return game.teamIds.find((id) => id !== teamId) ?? null;
}

export function gamesForTeam(snapshot: QbliveSnapshot, teamId: string): QbliveScheduledGame[] {
  return snapshot.schedule.filter((game) => game.teamIds.includes(teamId));
}

export function liveGameForTeam(snapshot: QbliveSnapshot, teamId: string): QbliveLiveGame | null {
  return snapshot.liveGames.find((game) => game.teamIds.includes(teamId)) ?? null;
}

export function resultFor(snapshot: QbliveSnapshot, gameId: string): QbliveResult | null {
  return snapshot.results.find((result) => result.gameId === gameId) ?? null;
}

/**
 * The team's next public commitment.
 *
 * Games and timeline events are considered together, because a team's next thing at 12:05 is lunch,
 * not the round after it. Ordering is by stated time; anything untimed sorts after everything timed
 * rather than being given a guessed position.
 */
export function nextEventForTeam(snapshot: QbliveSnapshot, teamId: string, now: Date): TeamNextEvent | null {
  const candidates: TeamNextEvent[] = [];

  for (const game of gamesForTeam(snapshot, teamId)) {
    if (game.state === 'final' || game.state === 'cancelled') continue;
    candidates.push({ kind: 'game', game, scheduledStart: game.scheduledStart });
  }
  for (const event of snapshot.timeline) {
    if (event.teamIds.length > 0 && !event.teamIds.includes(teamId)) continue;
    // A finished event is not next. An event with no end and no start cannot be ordered, so it is
    // offered only when nothing else is.
    if (event.scheduledEnd && Date.parse(event.scheduledEnd) < now.getTime()) continue;
    candidates.push({ kind: 'event', event, scheduledStart: event.scheduledStart });
  }

  if (candidates.length === 0) return null;

  const live = candidates.find((candidate) => candidate.game?.state === 'live');
  if (live) return live;

  const upcoming = candidates
    .filter((candidate) => candidate.scheduledStart !== null)
    .filter((candidate) => Date.parse(candidate.scheduledStart!) >= now.getTime() - 90 * 60_000)
    .sort((left, right) => left.scheduledStart!.localeCompare(right.scheduledStart!));
  if (upcoming.length > 0) return upcoming[0];

  // Nothing has a usable time. Fall back to the first unfinished game in round order, with no time.
  const untimed = candidates
    .filter((candidate) => candidate.kind === 'game')
    .sort(
      (left, right) =>
        (left.game!.roundNumber ?? Number.MAX_SAFE_INTEGER) -
        (right.game!.roundNumber ?? Number.MAX_SAFE_INTEGER),
    );
  return untimed[0] ?? candidates[0] ?? null;
}

export function recentResultsForTeam(snapshot: QbliveSnapshot, teamId: string, limit = 5): QbliveResult[] {
  const teamGameIds = new Set(gamesForTeam(snapshot, teamId).map((game) => game.id));
  return snapshot.results
    .filter((result) => teamGameIds.has(result.gameId))
    .sort((left, right) => (right.acceptedAt ?? '').localeCompare(left.acceptedAt ?? ''))
    .slice(0, limit);
}

/**
 * The team's placement in the overall standings, as the Director's own table reports it.
 *
 * Read out of the table rather than recomputed. Director is authoritative for placement, and a
 * client that derived its own rank would contradict the printout at the front desk the first time a
 * tiebreaker mattered.
 */
export function placementForTeam(
  snapshot: QbliveSnapshot,
  teamId: string,
): { rank: number; of: number; table: QbliveDataTable } | null {
  const table =
    snapshot.standings.find((candidate) => candidate.scope === 'overall') ?? snapshot.standings[0];
  if (!table) return null;
  const index = table.rows.findIndex((row) => row.teamId === teamId);
  if (index === -1) return null;
  const rankColumn = table.columns.findIndex((column) => column.kind === 'rank');
  const cell = rankColumn === -1 ? null : table.rows[index].cells[rankColumn];
  const rank = typeof cell?.value === 'number' ? cell.value : index + 1;
  return { rank, of: table.rows.length, table };
}

export function placementForPlayer(
  snapshot: QbliveSnapshot,
  playerId: string,
): { rank: number; of: number; table: QbliveDataTable } | null {
  for (const table of snapshot.statistics) {
    const index = table.rows.findIndex((row) => row.playerId === playerId);
    if (index !== -1) return { rank: index + 1, of: table.rows.length, table };
  }
  return null;
}

/** Announcements this team should see, newest first, expired ones removed. */
export function announcementsForTeam(
  snapshot: QbliveSnapshot,
  teamId: string | null,
  now: Date,
): QbliveAnnouncement[] {
  return snapshot.announcements.filter((announcement) => {
    if (announcement.expiresAt && Date.parse(announcement.expiresAt) <= now.getTime()) return false;
    if (announcement.audienceTeamIds.length === 0) return true;
    return teamId !== null && announcement.audienceTeamIds.includes(teamId);
  });
}

export function playersOf(snapshot: QbliveSnapshot, teamId: string): { id: string; name: string }[] {
  return snapshot.teams.find((team) => team.id === teamId)?.players ?? [];
}

/** Whether the tournament publishes any player-level information at all. */
export function publishesPlayers(snapshot: QbliveSnapshot): boolean {
  return snapshot.teams.some((team) => (team.players?.length ?? 0) > 0);
}
