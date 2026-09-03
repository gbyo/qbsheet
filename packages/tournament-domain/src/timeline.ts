/**
 * The tournament timeline.
 *
 * # Why this is not the schedule
 *
 * A tournament day is not a list of games. It is a list of games, a lunch, a check-in window, an
 * awards ceremony, and whatever else a Director tells people to be somewhere for. QBSheet Live's
 * Home tab answers "where does my team go next", and a scheduling model that only knows about games
 * answers it wrong at noon.
 *
 * Games stay in `ScheduledGame`, because a game is a competitive object with results, packets, and
 * an assignment revision. This is the non-game half, plus the projection's shared vocabulary for
 * ordering the two together.
 */

import type { DirectorId } from './model.js';

export type TimelineEventType = 'round' | 'lunch' | 'break' | 'check-in' | 'awards' | 'ceremony' | 'custom';

/**
 * Who may see an event.
 *
 * `staff` exists so a Director can put "moderator meeting 8:15" on the same timeline as everything
 * else without it reaching the public projection. The projection drops anything but `public`.
 */
export type TimelineVisibility = 'public' | 'staff' | 'hidden';

export interface TournamentTimelineEvent {
  id: DirectorId;
  type: TimelineEventType;
  title: string;
  description?: string;
  /** Stored as written by the Director; the projection re-expresses it in the tournament zone. */
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
  /** Empty means the event concerns everybody. */
  teamIds?: DirectorId[];
  roomId?: DirectorId | null;
  /** Free text for events that happen somewhere that is not a numbered room. */
  location?: string;
  visibility: TimelineVisibility;
  /**
   * Explicit position in the tournament-day sequence shared with rounds.
   * Missing values sort last and are densified on load; see `dayOrder.ts`.
   */
  dayOrder?: number | null;
  createdAt: string;
  updatedAt: string;
}

export const timelineEventTypes: readonly TimelineEventType[] = [
  'round',
  'lunch',
  'break',
  'check-in',
  'awards',
  'ceremony',
  'custom',
] as const;

export function timelineEventTypeLabel(type: TimelineEventType): string {
  switch (type) {
    case 'round':
      return 'Round';
    case 'lunch':
      return 'Lunch';
    case 'break':
      return 'Break';
    case 'check-in':
      return 'Check-in';
    case 'awards':
      return 'Awards';
    case 'ceremony':
      return 'Ceremony';
    case 'custom':
      return 'Event';
  }
}

export function normalizeTimelineEvents(value: unknown): TournamentTimelineEvent[] {
  if (!Array.isArray(value)) return [];
  const events: TournamentTimelineEvent[] = [];
  for (const candidate of value) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const record = candidate as Record<string, unknown>;
    if (typeof record.id !== 'string' || typeof record.title !== 'string') continue;
    const type = timelineEventTypes.includes(record.type as TimelineEventType)
      ? (record.type as TimelineEventType)
      : 'custom';
    const visibility: TimelineVisibility =
      record.visibility === 'public' || record.visibility === 'staff' || record.visibility === 'hidden'
        ? record.visibility
        : 'hidden';
    events.push({
      id: record.id,
      type,
      title: record.title,
      description: typeof record.description === 'string' ? record.description : undefined,
      scheduledStart: typeof record.scheduledStart === 'string' ? record.scheduledStart : null,
      scheduledEnd: typeof record.scheduledEnd === 'string' ? record.scheduledEnd : null,
      teamIds: Array.isArray(record.teamIds)
        ? record.teamIds.filter((id): id is string => typeof id === 'string')
        : undefined,
      roomId: typeof record.roomId === 'string' ? record.roomId : null,
      location: typeof record.location === 'string' ? record.location : undefined,
      visibility,
      dayOrder:
        typeof record.dayOrder === 'number' && Number.isFinite(record.dayOrder) ? record.dayOrder : undefined,
      createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date(0).toISOString(),
      updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date(0).toISOString(),
    });
  }
  return events;
}
