import type { IconName } from '../components/Icon';

export type SectionId =
  | 'overview'
  | 'teams'
  | 'format'
  | 'rooms'
  | 'packets'
  | 'tournament'
  | 'transfers'
  | 'results'
  | 'standings'
  | 'publish'
  | 'live'
  | 'settings';

export const navigation: Array<{
  label?: string;
  items: Array<{ id: SectionId; label: string; icon: IconName }>;
}> = [
  { items: [{ id: 'overview', label: 'Overview', icon: 'activity' }] },
  {
    label: 'Plan',
    items: [
      { id: 'teams', label: 'Teams', icon: 'teams' },
      { id: 'format', label: 'Format', icon: 'format' },
      { id: 'rooms', label: 'Rooms & staff', icon: 'rooms' },
      { id: 'packets', label: 'Packets', icon: 'file' },
    ],
  },
  {
    label: 'Run',
    items: [
      { id: 'tournament', label: 'Tournament', icon: 'tournament' },
      { id: 'transfers', label: 'Transfers', icon: 'upload' },
      { id: 'results', label: 'Results', icon: 'inbox' },
    ],
  },
  {
    label: 'Review',
    items: [
      { id: 'standings', label: 'Standings & stats', icon: 'standings' },
      { id: 'publish', label: 'Publish', icon: 'publish' },
      { id: 'live', label: 'QBSheet Live', icon: 'server' },
    ],
  },
  { items: [{ id: 'settings', label: 'Settings', icon: 'settings' }] },
];

export function labelForSection(section: SectionId): string {
  return navigation.flatMap((group) => group.items).find((item) => item.id === section)?.label ?? 'Overview';
}
