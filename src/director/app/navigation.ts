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
  // Kept only so old deep links, search results, and saved navigation state
  // resolve. There is no Tournament destination; it resolves to Tournament day.
  | 'tournament';

export interface NavigationItem {
  id: SectionId;
  label: string;
  icon: IconName;
  /** The one-line description the destination's page header repeats. */
  description?: string;
}

export interface NavigationGroup {
  /** `null` for the ungrouped items at the top and bottom of the sidebar. */
  label: string | null;
  items: NavigationItem[];
}

/**
 * The Director information architecture.
 *
 * # One taxonomy
 *
 * The sidebar used to be grouped `Tournament / Setup / Output` while the pages
 * described themselves as `Plan / Run / Review`, so the application named its
 * own structure two different ways. `Plan / Run / Review` won: it is how a
 * director actually thinks about the day, and "Output" was a bucket that had
 * collected Transfers — which is operational work during the tournament, not
 * something produced at the end of it.
 *
 *   Plan    the tournament before it starts: who is coming, how it is
 *           structured, where it is played, what is read.
 *   Run     the day itself: the sequence of rounds, results coming in, moving
 *           files between machines.
 *   Review  what comes out: standings, exports, public publication.
 *
 * These three words are the *only* names for these groups. They appear in the
 * sidebar, in Help, and as the grouping in global search results.
 *
 * # Names agree everywhere
 *
 * Navigation label, page `<h1>`, and search results use the same string for a
 * destination, from `labelForSection`. The mismatches that existed —
 * sidebar `Stats` against page `Standings & stats`, sidebar `Exports` against
 * page `Publish`, sidebar `Rounds` against page `Tournament day` — are gone,
 * resolved in favour of the name that describes what the destination is for:
 *
 *   `Standings`       one destination, team and player views inside it.
 *   `Exports`         it writes local files. `QBSheet Live` is what publishes.
 *   `Tournament day`  it holds rounds *and* the breaks between them.
 *   `Operations`      rooms, staff, and equipment are one resource graph, not three
 *                     independent lists. The destination id stays `rooms` so every existing
 *                     deep link, saved navigation target, and search result still resolves.
 *
 * # Settings is a destination
 *
 * It holds tournament identity, operator identity, storage, recovery, and
 * audit. It was reachable only from the operator menu, which made recovery —
 * the thing an operator needs when something has gone wrong — the hardest
 * surface in the application to find.
 */

const overviewItem: NavigationItem = {
  id: 'overview',
  label: 'Overview',
  icon: 'activity',
  description: 'What is happening now, what needs attention, and what happens next.',
};

export const planGroup: NavigationGroup = {
  label: 'Plan',
  items: [
    { id: 'teams', label: 'Teams', icon: 'teams', description: 'Registration, rosters, and schools.' },
    { id: 'format', label: 'Format', icon: 'format', description: 'Structure, pairing, and scoring rules.' },
    {
      id: 'rooms',
      label: 'Operations',
      icon: 'rooms',
      description: 'Rooms, staff, equipment, and who is operating where.',
    },
    { id: 'packets', label: 'Packets', icon: 'file', description: 'Packet inventory and assignment.' },
  ],
};

export const runGroup: NavigationGroup = {
  label: 'Run',
  items: [
    {
      id: 'schedule',
      label: 'Tournament day',
      icon: 'calendar',
      description: 'The sequence of rounds and breaks, and the controls to run them.',
    },
    {
      id: 'transfers',
      label: 'Delivery',
      icon: 'usb',
      description: 'Room readiness, QBTCP, and assignment files.',
    },
    {
      id: 'results',
      label: 'Results',
      icon: 'inbox',
      description: 'Returned results, decisions, and protests.',
    },
  ],
};

export const reviewGroup: NavigationGroup = {
  label: 'Review',
  items: [
    {
      id: 'standings',
      label: 'Standings',
      icon: 'standings',
      description: 'Ranking, records, and statistics.',
    },
    { id: 'publish', label: 'Exports', icon: 'download', description: 'Write tournament files locally.' },
    { id: 'live', label: 'QBSheet Live', icon: 'network', description: 'Publish results publicly.' },
  ],
};

export const settingsItem: NavigationItem = {
  id: 'settings',
  label: 'Settings',
  icon: 'settings',
  description: 'Tournament and operator details, storage, recovery, and audit history.',
};

/** The sidebar, in order. */
export const navigationGroups: NavigationGroup[] = [
  { label: null, items: [overviewItem] },
  planGroup,
  runGroup,
  reviewGroup,
  { label: null, items: [settingsItem] },
];

/** Flat list of every destination in the sidebar. */
export const visibleNavigation: NavigationItem[] = navigationGroups.flatMap((group) => group.items);

const itemsById = new Map<SectionId, NavigationItem>(visibleNavigation.map((item) => [item.id, item]));

/** The group a destination belongs to — `Plan`, `Run`, `Review`, or none. */
export function groupForSection(section: SectionId): string | null {
  const canonical = canonicalSection(section);
  for (const group of navigationGroups) {
    if (group.items.some((item) => item.id === canonical)) return group.label;
  }
  return null;
}

/**
 * The one name for a destination. Navigation, page title, and search results
 * all read it from here, so they cannot drift apart again.
 */
export function labelForSection(section: SectionId): string {
  return itemsById.get(canonicalSection(section))?.label ?? 'Overview';
}

export function descriptionForSection(section: SectionId): string | undefined {
  return itemsById.get(canonicalSection(section))?.description;
}

export function iconForSection(section: SectionId): IconName {
  return itemsById.get(canonicalSection(section))?.icon ?? 'activity';
}

/**
 * Legacy `tournament` links resolve to Tournament day.
 *
 * Deep links and stored navigation targets from earlier builds must keep
 * working: the redesign changes labels and presentation, never whether a saved
 * target resolves.
 */
export function canonicalSection(section: SectionId): Exclude<SectionId, 'tournament'> {
  return section === 'tournament' ? 'schedule' : section;
}

/** Every id that resolves to a destination, including the legacy alias. */
export function isKnownSection(value: string): value is SectionId {
  return value === 'tournament' || itemsById.has(value as SectionId);
}
