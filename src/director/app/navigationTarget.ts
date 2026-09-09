import type { SectionId } from './navigation';

/**
 * The kinds of thing a deep link can point at.
 *
 * `setting` is new: making Settings a real destination means the tournament and
 * operator menu entries navigate to a *section* of it rather than opening their
 * own dialogs, so the same highlight machinery that finds a team or a room now
 * also finds a settings section.
 */
export type EntityType =
  | 'team'
  | 'player'
  | 'room'
  | 'packet'
  | 'game'
  | 'round'
  | 'submission'
  | 'setting'
  | 'staff'
  | 'equipment'
  | 'location';

export interface DirectorNavigationTarget {
  section: SectionId;
  entityType?: EntityType;
  entityId?: string;
  // For player, also carry owning team for scroll target
  parentId?: string;
}

/**
 * Where an operational problem's fix lives.
 *
 * The domain reports problems against a room, a person, a resource, or a game, without knowing
 * what a Director "section" is. This is the one place that mapping happens, so an attention item,
 * a preflight blocker, and a planner decision all route the same way.
 *
 * A game routes to Operations rather than to Tournament day: an unstaffed or unroomed game is
 * fixed on the assignment, and its round comes along as the parent so the scope control can land
 * on the right round.
 */
export function navigationTargetForOperational(target: {
  entityType: 'room' | 'staff' | 'equipment' | 'game' | 'round';
  entityId: string;
  parentId?: string;
}): DirectorNavigationTarget {
  switch (target.entityType) {
    case 'round':
      return { section: 'schedule', entityType: 'round', entityId: target.entityId };
    case 'game':
      return {
        section: 'rooms',
        entityType: 'game',
        entityId: target.entityId,
        ...(target.parentId ? { parentId: target.parentId } : {}),
      };
    default:
      return { section: 'rooms', entityType: target.entityType, entityId: target.entityId };
  }
}
