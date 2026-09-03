import type { IconName } from '../components/Icon';

export type SectionId =
  | 'overview'
  | 'teams'
  | 'format'
  | 'schedule'
  | 'rooms'
  | 'packets'
  | 'tournament'
  | 'transfers'
  | 'results'
  | 'standings'
  | 'publish'
  | 'live'
  | 'settings';

export interface NavigationItem {
  id: SectionId;
  label: string;
  icon: IconName;
}

/**
 * The visible Director information architecture.
 *
 * Five stable primary destinations mirror what a director actually does:
 * check the day, manage teams, run rounds, resolve results, read stats.
 * Everything else lives in one stable More menu; the section ids underneath
 * are unchanged, so routes, deep links, and search targets keep working.
 * See `docs/DIRECTOR_PRODUCT_PRINCIPLES.md` (principle 1: complexity comes
 * from the tournament, not the application).
 */
export const primaryNavigation: NavigationItem[] = [
  { id: 'overview', label: 'Overview', icon: 'activity' },
  { id: 'teams', label: 'Teams', icon: 'teams' },
  { id: 'schedule', label: 'Rounds', icon: 'calendar' },
  { id: 'results', label: 'Results', icon: 'inbox' },
  { id: 'standings', label: 'Stats', icon: 'standings' },
];

export const moreNavigation: NavigationItem[] = [
  { id: 'format', label: 'Format', icon: 'format' },
  { id: 'tournament', label: 'Tournament', icon: 'tournament' },
  { id: 'rooms', label: 'Rooms & staff', icon: 'rooms' },
  { id: 'packets', label: 'Packets', icon: 'file' },
  { id: 'transfers', label: 'Transfers', icon: 'upload' },
  { id: 'live', label: 'QBSheet Live', icon: 'server' },
  { id: 'publish', label: 'Exports', icon: 'publish' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

export function labelForSection(section: SectionId): string {
  return [...primaryNavigation, ...moreNavigation].find((item) => item.id === section)?.label ?? 'Overview';
}
