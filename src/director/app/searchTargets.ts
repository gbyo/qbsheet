import { visibleNavigation, type SectionId } from './navigation';

/**
 * What global search can find besides the tournament's own entities.
 *
 * # Why pages and settings are indexed at all
 *
 * Search used to hold only teams, players, rooms, packets, rounds, games, and
 * submissions — the things a tournament *has*. But an operator reaching for
 * search does not sort the query into "entity" and "destination" first: they
 * type "timezone" or "recovery" or "standings" and expect to arrive. Every one
 * of those was a miss, so the answer to a missed query was to go and learn the
 * sidebar and the four Settings sub-sections instead.
 *
 * So the index also carries every destination and every individual setting, and
 * the search field says so. Two rules keep it honest:
 *
 *   - **Pages are read from the sidebar**, not restated here. `labelForSection`
 *     is already the one name for a destination; this reads the same list, so a
 *     renamed or added destination is searchable without a second edit.
 *   - **Settings name their own target.** A settings result carries the
 *     sub-section the Settings view switches to (`entityId`, the value
 *     `settingsSectionForTarget` reads), the panel to scroll to, and — for the
 *     individual settings — the field to focus, matched on the visible label.
 *     The label is the thing the operator typed; focusing anything else would
 *     land them on the panel and make them hunt.
 */

/** Search terms a destination is reached by that its own name does not contain. */
const pageKeywords: Partial<Record<SectionId, string[]>> = {
  overview: ['home', 'dashboard', 'now', 'attention'],
  teams: ['roster', 'rosters', 'players', 'schools', 'registration', 'clubs'],
  format: ['pools', 'brackets', 'stages', 'advancement', 'pairing', 'scoring rules', 'tossups', 'bonuses'],
  rooms: ['staff', 'moderators', 'scorekeepers', 'equipment', 'qbtcp'],
  packets: ['questions', 'sets', 'question sets'],
  schedule: ['rounds', 'breaks', 'lunch', 'start', 'release', 'day'],
  results: ['submissions', 'protests', 'review', 'accept', 'reject', 'games'],
  transfers: ['usb', 'import', 'export', 'sneakernet', 'files'],
  standings: ['stats', 'statistics', 'ranking', 'records', 'leaders'],
  publish: ['exports', 'csv', 'qbj', 'download', 'files', 'reports'],
  live: ['spectators', 'stream', 'public', 'publish', 'audience'],
  settings: ['preferences', 'options', 'configuration', 'operator', 'recovery', 'audit', 'storage'],
};

export interface PageSearchTarget {
  section: SectionId;
  label: string;
  detail: string;
  keywords: string[];
}

/** Every sidebar destination, in sidebar order. */
export const pageSearchTargets: PageSearchTarget[] = visibleNavigation.map((item) => ({
  section: item.id,
  label: item.label,
  detail: item.description ?? 'Director destination',
  keywords: ['page', 'go to', ...(pageKeywords[item.id] ?? [])],
}));

/** The Settings sub-section a result switches to — what `settingsSectionForTarget` reads. */
export type SettingsTargetId = 'tournament' | 'operator' | 'recovery' | 'audit' | 'system';

export interface SettingsSearchTarget {
  /** Stable within the settings index; namespaced by the search index itself. */
  id: string;
  label: string;
  detail: string;
  entityId: SettingsTargetId;
  /** The panel to scroll to on arrival, where one carries an id. */
  panelId?: string;
  /** The field to focus inside that panel, matched on its visible label. */
  fieldLabel?: string;
  keywords: string[];
}

const settingsPanels: SettingsSearchTarget[] = [
  {
    id: 'tournament',
    label: 'Tournament details',
    detail: 'Settings · General',
    entityId: 'tournament',
    panelId: 'settings-tournament',
    keywords: ['identity', 'tournament settings', 'name', 'date', 'venue', 'organizer'],
  },
  {
    id: 'operator',
    label: 'Local operator',
    detail: 'Settings · General',
    entityId: 'operator',
    panelId: 'settings-operator',
    keywords: ['who am i', 'attribution', 'display name', 'role', 'local app setting'],
  },
  {
    id: 'recovery',
    label: 'Recovery',
    detail: 'Settings · Recovery',
    entityId: 'recovery',
    panelId: 'settings-recovery',
    keywords: ['recovery point', 'checkpoint', 'restore', 'backup', 'rollback', 'undo'],
  },
  {
    id: 'audit',
    label: 'Audit history',
    detail: 'Settings · Audit',
    entityId: 'audit',
    panelId: 'settings-audit',
    keywords: ['history', 'log', 'changes', 'who changed', 'decisions'],
  },
  {
    id: 'system',
    label: 'System status',
    detail: 'Settings · System',
    entityId: 'system',
    keywords: ['diagnostics', 'storage', 'schema', 'build', 'version', 'health', 'last saved'],
  },
  {
    id: 'system-storage',
    label: 'Storage & build diagnostics',
    detail: 'Settings · System',
    entityId: 'system',
    keywords: ['storage mode', 'indexeddb', 'sqlite', 'schema version', 'audit events', 'support'],
  },
  {
    id: 'system-network',
    label: 'Local network boundaries',
    detail: 'Settings · System',
    entityId: 'system',
    keywords: ['qbtcp', 'listeners', 'credentials', 'live', 'ports', 'network'],
  },
];

/**
 * The individual settings, each one focusing its own field.
 *
 * These are the words an operator actually types — "timezone", "question set",
 * "end date" — none of which name a panel. `fieldLabel` is the visible label
 * `Field` renders, which is what makes the focus target derivable rather than a
 * second id to keep in step.
 */
const settingsFields: SettingsSearchTarget[] = [
  {
    id: 'tournament-name',
    label: 'Tournament name',
    detail: 'Settings · Tournament details',
    entityId: 'tournament',
    panelId: 'settings-tournament',
    fieldLabel: 'Name',
    keywords: ['rename', 'title'],
  },
  {
    id: 'tournament-venue',
    label: 'Venue',
    detail: 'Settings · Tournament details',
    entityId: 'tournament',
    panelId: 'settings-tournament',
    fieldLabel: 'Venue',
    keywords: ['school', 'building', 'site', 'location', 'where'],
  },
  {
    id: 'tournament-date',
    label: 'Date',
    detail: 'Settings · Tournament details',
    entityId: 'tournament',
    panelId: 'settings-tournament',
    fieldLabel: 'Date',
    keywords: ['day', 'when', 'start date'],
  },
  {
    id: 'tournament-end-date',
    label: 'End date',
    detail: 'Settings · Tournament details',
    entityId: 'tournament',
    panelId: 'settings-tournament',
    fieldLabel: 'End date',
    keywords: ['multi-day', 'last day', 'finish'],
  },
  {
    id: 'tournament-organizer',
    label: 'Organizer',
    detail: 'Settings · Tournament details',
    entityId: 'tournament',
    panelId: 'settings-tournament',
    fieldLabel: 'Organizer',
    keywords: ['host', 'run by', 'organiser'],
  },
  {
    id: 'tournament-question-set',
    label: 'Question set',
    detail: 'Settings · Tournament details',
    entityId: 'tournament',
    panelId: 'settings-tournament',
    fieldLabel: 'Question set',
    keywords: ['packet set', 'questions', 'acf', 'naqt'],
  },
  {
    id: 'tournament-timezone',
    label: 'Tournament timezone',
    detail: 'Settings · Tournament details',
    entityId: 'tournament',
    panelId: 'settings-tournament',
    fieldLabel: 'Tournament timezone',
    keywords: ['time zone', 'tz', 'clock', 'utc', 'offset'],
  },
  {
    id: 'operator-display-name',
    label: 'Operator display name',
    detail: 'Settings · Local operator',
    entityId: 'operator',
    panelId: 'settings-operator',
    fieldLabel: 'Display name',
    keywords: ['my name', 'signature', 'attribution'],
  },
  {
    id: 'operator-role',
    label: 'Operator role',
    detail: 'Settings · Local operator',
    entityId: 'operator',
    panelId: 'settings-operator',
    fieldLabel: 'Role',
    keywords: ['job', 'title', 'tournament director'],
  },
];

/** Every settings destination: the panels, then the individual settings inside them. */
export const settingsSearchTargets: SettingsSearchTarget[] = [...settingsPanels, ...settingsFields];

const focusableInPanel =
  'input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** The control a `Field` labelled `label` renders, found through the label's `for`. */
function fieldControl(scope: ParentNode, label: string): HTMLElement | null {
  const labels = Array.from(scope.querySelectorAll<HTMLLabelElement>('label.director-field-label'));
  const match = labels.find((element) => {
    const text = element.querySelector('span')?.textContent?.trim();
    return text === label;
  });
  if (!match) return null;
  const control = match.htmlFor ? document.getElementById(match.htmlFor) : null;
  return control ?? match.querySelector<HTMLElement>(focusableInPanel);
}

/**
 * Bring a settings target into view and put focus on it.
 *
 * Deferred a tick because the caller has just navigated: the panel it wants
 * does not exist until Settings has rendered the sub-section, and three of the
 * four sub-sections only mount when they are the selected one.
 */
export function revealSettingsTarget(target: { panelId?: string; fieldLabel?: string }): void {
  if (!target.panelId && !target.fieldLabel) return;
  window.setTimeout(() => {
    const panel = target.panelId ? document.getElementById(target.panelId) : null;
    panel?.scrollIntoView({ block: 'start', behavior: 'auto' });
    const scope: ParentNode = panel ?? document;
    const control = target.fieldLabel ? fieldControl(scope, target.fieldLabel) : null;
    const fallback = panel?.querySelector<HTMLElement>(focusableInPanel) ?? null;
    const focusTarget = control ?? fallback;
    if (!focusTarget) return;
    focusTarget.focus({ preventScroll: true });
    // A field deep in a long panel is otherwise focused off screen.
    if (control) control.scrollIntoView({ block: 'center', behavior: 'auto' });
  }, 0);
}
