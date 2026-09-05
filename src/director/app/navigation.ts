import type { IconName } from '../components/Icon';

export type SectionId =
  | 'overview'
  | 'teams'
  | 'format'
  | 'schedule'
  | 'rooms'
  | 'packets'
  | 'transfers'
  | 'results'
  | 'standings'
  | 'publish'
  | 'live'
  | 'settings'
  // Kept only so old deep links, search results, and saved state resolve.
  // There is no Tournament destination in the UI; it resolves to Rounds.
  | 'tournament';

export interface NavigationItem {
  id: SectionId;
  label: string;
  icon: IconName;
}

export interface NavigationGroup {
  label: string;
  items: NavigationItem[];
}

/**
 * The visible Director information architecture.
 *
 * One workspace, three steady groups. Every destination is directly
 * discoverable: progressive disclosure hides irrelevant *controls*, never
 * ordinary destinations. The narrow top-bar More menu contains global actions,
 * not another navigation bucket.
 * See `docs/DIRECTOR_PRODUCT_PRINCIPLES.md` (principle 1: complexity comes
 * from the tournament, not the application).
 */
export const navigationGroups: NavigationGroup[] = [
  {
    label: 'Tournament',
    items: [
      { id: 'overview', label: 'Overview', icon: 'activity' },
      { id: 'teams', label: 'Teams', icon: 'teams' },
      { id: 'schedule', label: 'Rounds', icon: 'calendar' },
      { id: 'results', label: 'Results', icon: 'inbox' },
      { id: 'standings', label: 'Stats', icon: 'standings' },
    ],
  },
  {
    label: 'Setup',
    items: [
      { id: 'format', label: 'Format', icon: 'format' },
      { id: 'rooms', label: 'Rooms & staff', icon: 'rooms' },
      { id: 'packets', label: 'Packets', icon: 'file' },
    ],
  },
  {
    label: 'Output',
    items: [
      { id: 'live', label: 'QBSheet Live', icon: 'server' },
      { id: 'publish', label: 'Exports', icon: 'publish' },
      { id: 'transfers', label: 'Transfers', icon: 'upload' },
    ],
  },
];

/** Flat list of every section that has a real destination in the sidebar. */
export const visibleNavigation: NavigationItem[] = navigationGroups.flatMap((group) => group.items);

const sectionLabels: Record<SectionId, string> = {
  overview: 'Overview',
  teams: 'Teams',
  format: 'Format',
  schedule: 'Rounds',
  rooms: 'Rooms & staff',
  packets: 'Packets',
  tournament: 'Rounds',
  transfers: 'Transfers',
  results: 'Results',
  standings: 'Stats',
  publish: 'Exports',
  live: 'QBSheet Live',
  settings: 'Settings',
};

export function labelForSection(section: SectionId): string {
  return sectionLabels[section] ?? 'Overview';
}

/** Legacy Tournament Control links resolve to the Rounds workspace. */
export function canonicalSection(section: SectionId): Exclude<SectionId, 'tournament'> {
  return section === 'tournament' ? 'schedule' : section;
}
