import type { SectionId } from './navigation';

export type EntityType = 'team' | 'player' | 'room' | 'packet' | 'game' | 'round' | 'submission';

export interface DirectorNavigationTarget {
  section: SectionId;
  entityType?: EntityType;
  entityId?: string;
  // For player, also carry owning team for scroll target
  parentId?: string;
}
