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
