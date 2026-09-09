import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Command, defaultFilter } from 'cmdk';
import BrandLogo from '../../BrandLogo';
import { IconButton } from '../components/Controls';
import { Icon } from '../components/Icon';
import { Badge } from '../components/Status';
import { DirectorMenu } from '../components/DirectorMenu';
import { MenuItem, MenuNote, MenuSectionLabel, MenuSeparator } from '../components/Menu';
import { isNativeDirector } from '../platform/native';
import { pickDirectorFiles } from '../components/filePickerContract';
import { useConfirm } from '../components/Dialog';
import { modifierKeyLabel, shortcutAriaLabel } from '../components/platform';
import {
  canonicalSection,
  labelForSection,
  navigationGroups,
  type NavigationItem,
  type SectionId,
} from './navigation';
import { TOURNAMENT_FILE_ACCEPT } from './openTournament';
import type { DirectorNavigationTarget, EntityType } from './navigationTarget';
import { revealSettingsTarget } from './searchTargets';
import type { PickedFile } from '../components/filePickerContract';

/**
 * The Director shell: sidebar, top bar, and the frame around a page.
 *
 * # Where every global thing lives, once
 *
 * Global actions used to be duplicated across eight places — the sidebar
 * tournament switcher, a tournament menu, the sidebar operator area, a sidebar
 * Help link, a top-bar Help button, a top-bar avatar, the operator menu, and a
 * narrow-window "More" menu that re-implemented tournament management. Several
 * of those offered the same three commands with different labels.
 *
 * There are now exactly three homes:
 *
 *   **Tournament switcher** (sidebar, top)  Switching between tournaments, and
 *   the tournament/file actions that belong to the *document*: New, Open,
 *   Details, Manage tournaments.
 *
 *   **Operator** (sidebar, bottom)  Who is operating, plus the two
 *   application-level things: Settings and Help.
 *
 *   **Settings** (a real navigation destination)  Everything editable.
 *
 * The top bar keeps global search and the operational "now" strip, and nothing
 * else. There is no second avatar, no second Help button, and no More menu:
 * narrow windows render this same tree as a rail and then a drawer.
 */

export interface TournamentSummary {
  id: string;
  name: string;
  date: string;
  status: string;
}

export interface NowChip {
  label: ReactNode;
  detail?: string;
  tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
  onSelect?: () => void;
  ariaLabel?: string;
}

export function statusLabel(status: string): string {
  return status === 'draft'
    ? 'Draft'
    : status === 'running'
      ? 'In progress'
      : status === 'complete'
        ? 'Complete'
        : 'Archived';
}

export function DirectorShell({
  tournament,
  activeSection,
  onNavigate,
  recentTournaments,
  archivedTournaments,
  onSwitchTournament,
  onNewTournament,
  onOpenFile,
  onOpenFileError,
  onManageTournaments,
  onArchiveTournament,
  canArchive,
  operatorName,
  operatorRole,
  operatorInitials,
  onHelp,
  navCounts,
  nowChips,
  search,
  banners,
  children,
}: {
  tournament: TournamentSummary;
  activeSection: SectionId;
  onNavigate: (section: SectionId, target?: DirectorNavigationTarget | null) => void;
  recentTournaments: TournamentSummary[];
  archivedTournaments: TournamentSummary[];
  onSwitchTournament: (id: string, name: string) => void;
  onNewTournament: () => void;
  onOpenFile: (file: PickedFile) => void;
  onOpenFileError: (message: string) => void;
  onManageTournaments: () => void;
  onArchiveTournament: () => void;
  canArchive: boolean;
  operatorName: string;
  operatorRole: string;
  operatorInitials: string;
  onHelp: () => void;
  /** Per-destination counts, e.g. results awaiting review. */
  navCounts?: Partial<Record<SectionId, { count: number; tone?: 'info' | 'warning'; label: string }>>;
  /** The operational strip on the right of the top bar. Empty is normal. */
  nowChips?: NowChip[];
  search: ReactNode;
  /** Persistence and writer-status banners, above the page. */
  banners?: ReactNode;
  children: ReactNode;
}) {
  // Exactly one popover is ever open, so opening one always closes the other
  // and neither can be stranded under a dialog.
  const [openMenu, setOpenMenu] = useState<'tournament' | 'operator' | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const menuOpenerRef = useRef<HTMLElement | null>(null);
  const confirm = useConfirm();

  const closeMenu = useCallback(() => setOpenMenu(null), []);
  /**
   * Close the menu and put focus back on the button that opened it, so a menu
   * item that opens an overlay hands that overlay a real element to return to.
   */
  const closeMenuToOpener = useCallback(() => {
    setOpenMenu(null);
    menuOpenerRef.current?.focus({ preventScroll: true });
  }, []);
  const openMenuFrom = (name: 'tournament' | 'operator', event: { currentTarget: HTMLElement }) => {
    menuOpenerRef.current = event.currentTarget;
    setOpenMenu((current) => (current === name ? null : name));
  };

  const navigate = (section: SectionId, target?: DirectorNavigationTarget | null) => {
    closeMenu();
    setNavOpen(false);
    onNavigate(section, target);
  };

  const navigateToSettingsPanel = (
    entityId: 'tournament' | 'operator',
    panelId: 'settings-tournament' | 'settings-operator',
  ) => {
    navigate('settings', { section: 'settings', entityType: 'setting', entityId });
    // The same arrival global search performs, from the same helper: land on the
    // panel with focus inside it rather than at the top of Settings.
    revealSettingsTarget({ panelId });
  };

  const archiveCurrent = () => {
    closeMenu();
    void confirm({
      title: `Archive ${tournament.name}?`,
      body: 'The tournament leaves the recent list and stops appearing in the switcher.',
      consequence: 'Nothing is deleted. You can reopen it from Manage tournaments at any time.',
      confirmLabel: 'Archive tournament',
      tone: 'warning',
    }).then((confirmed) => {
      if (confirmed) onArchiveTournament();
    });
  };

  return (
    <div className="director-app" data-nav-open={navOpen || undefined}>
      <aside className="director-sidebar">
        <div className="director-brand">
          <BrandLogo className="director-wordmark" />
        </div>

        <div className="director-tournament-switcher-wrap">
          <button
            type="button"
            className="director-tournament-switcher"
            aria-haspopup="dialog"
            aria-expanded={openMenu === 'tournament'}
            aria-label={`Tournament: ${tournament.name}. Switch tournament or open tournament actions`}
            onClick={(event) => openMenuFrom('tournament', event)}
          >
            <strong>{tournament.name}</strong>
            <small>{statusLabel(tournament.status)}</small>
            <Icon name="chevron" size={14} />
          </button>
          {openMenu === 'tournament' && (
            <DirectorMenu
              label="Tournament"
              className="director-menu director-tournament-menu"
              searchPlaceholder="Search tournaments"
              align="start"
              openerRef={menuOpenerRef}
              onClose={closeMenu}
            >
              {/*
                Switching is separated from the tournament/file actions below it.
                Archived tournaments are plain switch targets: the old
                action-inside-a-row "Reopen" button made a menu row two controls
                and broke arrow-key travel. Reopening lives in Manage
                tournaments, where it belongs with the rest of that work.
              */}
              <MenuSectionLabel>Switch tournament</MenuSectionLabel>
              {recentTournaments.map((entry) => (
                <MenuItem
                  key={entry.id}
                  selected={entry.id === tournament.id}
                  detail={entry.date || statusLabel(entry.status)}
                  onSelect={() => {
                    closeMenu();
                    onSwitchTournament(entry.id, entry.name);
                  }}
                >
                  {entry.name}
                </MenuItem>
              ))}
              {archivedTournaments.length > 0 && (
                <>
                  <MenuSectionLabel>Archived</MenuSectionLabel>
                  {archivedTournaments.slice(0, 5).map((entry) => (
                    <MenuItem
                      key={entry.id}
                      detail={entry.date || 'Archived'}
                      onSelect={() => {
                        closeMenu();
                        onSwitchTournament(entry.id, entry.name);
                      }}
                    >
                      {entry.name}
                    </MenuItem>
                  ))}
                </>
              )}
              <MenuSeparator />
              <MenuSectionLabel>Tournament</MenuSectionLabel>
              <MenuItem
                icon="plus"
                onSelect={() => {
                  closeMenu();
                  onNewTournament();
                }}
              >
                New tournament…
              </MenuItem>
              <ShellFileMenuItem
                accept={TOURNAMENT_FILE_ACCEPT}
                onFile={(file) => {
                  closeMenu();
                  onOpenFile(file);
                }}
                onError={(message) => {
                  closeMenu();
                  onOpenFileError(message);
                }}
              />
              <MenuItem
                icon="edit"
                onSelect={() => navigateToSettingsPanel('tournament', 'settings-tournament')}
              >
                Tournament details…
              </MenuItem>
              <MenuItem
                icon="clipboard"
                onSelect={() => {
                  closeMenu();
                  onManageTournaments();
                }}
              >
                Manage tournaments…
              </MenuItem>
              <MenuItem icon="lock" disabled={!canArchive} onSelect={archiveCurrent}>
                Archive this tournament
              </MenuItem>
              {!canArchive && <MenuNote>A tournament can be archived once it is marked complete.</MenuNote>}
            </DirectorMenu>
          )}
        </div>

        <nav className="director-nav" aria-label="Director sections">
          {navigationGroups.map((group, index) => (
            <div className="director-nav-group" key={group.label ?? `group-${index}`}>
              {group.label && (
                <p className="director-nav-label" aria-hidden="true">
                  {group.label}
                </p>
              )}
              {group.items.map((item) => (
                <SectionLink
                  key={item.id}
                  item={item}
                  group={group.label}
                  active={item.id === activeSection}
                  onSelect={navigate}
                  badge={navCounts?.[item.id]}
                />
              ))}
            </div>
          ))}
        </nav>

        {/*
          The sidebar footer is operator identity and the two application-level
          entries. QBTCP status is deliberately absent: an optional subsystem
          does not get permanent sidebar real estate in tournaments that never
          turn it on. It appears in the top bar's now-strip when it is running,
          being configured, or in trouble.
        */}
        <div className="director-sidebar-footer">
          <div className="director-operator-wrap">
            <button
              type="button"
              className="director-operator"
              aria-haspopup="dialog"
              aria-expanded={openMenu === 'operator'}
              aria-label={`Operator: ${operatorName}. Application menu`}
              onClick={(event) => openMenuFrom('operator', event)}
            >
              <span className="director-avatar" aria-hidden="true">
                {operatorInitials}
              </span>
              <div>
                <strong>{operatorName}</strong>
                <small>{operatorRole}</small>
              </div>
              <Icon name="chevron" size={13} />
            </button>
            {openMenu === 'operator' && (
              <DirectorMenu
                label="Application menu"
                className="director-menu director-operator-menu"
                align="start"
                placement="top"
                openerRef={menuOpenerRef}
                onClose={closeMenu}
              >
                <MenuItem
                  icon="users"
                  onSelect={() => navigateToSettingsPanel('operator', 'settings-operator')}
                >
                  Operator profile…
                </MenuItem>
                <MenuItem icon="settings" onSelect={() => navigate('settings')}>
                  Settings
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  icon="help"
                  onSelect={() => {
                    closeMenuToOpener();
                    onHelp();
                  }}
                >
                  Help &amp; keyboard shortcuts
                </MenuItem>
              </DirectorMenu>
            )}
          </div>
        </div>
      </aside>

      <main className="director-main">
        <header className="director-topbar">
          <IconButton
            icon="format"
            label={navOpen ? 'Close navigation' : 'Open navigation'}
            className="director-nav-toggle"
            aria-expanded={navOpen}
            onClick={() => setNavOpen((current) => !current)}
          />
          {search}
          {nowChips && nowChips.length > 0 && (
            <div className="director-now-strip">
              {nowChips.map((chip, index) =>
                chip.onSelect ? (
                  <button
                    key={index}
                    type="button"
                    className="director-now-chip"
                    data-tone={chip.tone}
                    aria-label={chip.ariaLabel}
                    onClick={chip.onSelect}
                  >
                    <strong>{chip.label}</strong>
                    {chip.detail && <span>{chip.detail}</span>}
                  </button>
                ) : (
                  <span key={index} className="director-now-chip" data-tone={chip.tone}>
                    <strong>{chip.label}</strong>
                    {chip.detail && <span>{chip.detail}</span>}
                  </span>
                ),
              )}
            </div>
          )}
        </header>
        <div className="director-content">
          {banners}
          {children}
        </div>
      </main>
    </div>
  );
}

/**
 * The one Open affordance in the shell.
 *
 * A real menu entry — a `cmdk` item, so it filters and takes arrow-key travel
 * like every other line in the popover. The old version was a `<label>`
 * wrapping a file input, which is not an entry to a screen reader and was
 * skipped by the menu's keyboard navigation. It calls the desktop file dialog
 * in the Tauri build and the browser's file input otherwise; the operator sees
 * the same entry either way.
 */
function ShellFileMenuItem({
  accept,
  onFile,
  onError,
}: {
  accept: string;
  onFile: (file: PickedFile) => void;
  onError: (message: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const native = isNativeDirector();
  const onPick = (files: PickedFile[]) => {
    const file = files[0];
    if (file) onFile(file);
  };
  return (
    <>
      <Command.Item
        className="director-menu-item"
        onSelect={() => {
          if (!native) {
            inputRef.current?.click();
            return;
          }
          void pickDirectorFiles({ native: true, accept, onPick, onError });
        }}
      >
        <span className="director-menu-item-icon" aria-hidden="true">
          <Icon name="file" size={15} />
        </span>
        <span>Open tournament file…</span>
      </Command.Item>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="director-visually-hidden-input"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (!file) return;
          void pickDirectorFiles({ native: false, files: [file], onPick, onError });
        }}
      />
    </>
  );
}

function SectionLink({
  item,
  group,
  active,
  onSelect,
  badge,
}: {
  item: NavigationItem;
  group: string | null;
  active: boolean;
  onSelect: (section: SectionId) => void;
  badge?: { count: number; tone?: 'info' | 'warning'; label: string };
}) {
  // The accessible name carries the group, so a screen-reader user hears the
  // same `Plan / Run / Review` structure a sighted operator reads — the visible
  // group label is `aria-hidden` because it is not a heading, it is a divider.
  const name = [group ? `${group}:` : null, item.label, badge ? `${badge.count} ${badge.label}` : null]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type="button"
      className={`director-nav-link ${active ? 'is-active' : ''}`.trim()}
      aria-label={name}
      aria-current={active ? 'page' : undefined}
      title={item.label}
      onClick={() => onSelect(item.id)}
    >
      <Icon name={item.icon} />
      <span>{item.label}</span>
      {badge && badge.count > 0 && (
        <span className="director-nav-count" data-tone={badge.tone}>
          {badge.count}
        </span>
      )}
    </button>
  );
}

/* ============================================================ Global search */

export type SearchResultKind = 'page' | 'setting' | 'entity';

export interface SearchResultView {
  id: string;
  section: SectionId;
  label: string;
  detail: string;
  group: string | null;
  /** What selecting it does: go to a destination, open a setting, or open a thing. */
  kind?: SearchResultKind;
  /** Terms it is findable by that the visible text does not contain. */
  keywords?: string[];
  entityType?: EntityType;
  parentId?: string;
  /** Settings only: the sub-section the Settings view switches to. */
  settingsEntityId?: string;
  /** Settings only: the panel to scroll to. */
  settingsPanelId?: string;
  /** Settings only: the field to focus, by its visible label. */
  settingsFieldLabel?: string;
}

/**
 * Global search: a command navigator over pages, settings, and entities.
 *
 * It finds a thing and goes to it. It does **not** filter any page — the value
 * used to be threaded into the Teams view, so typing here to navigate also
 * narrowed the Teams table under the results popover. Local filtering now lives
 * on the pages, in `SearchField`.
 *
 * # Why cmdk owns the list
 *
 * The results were a hand-rolled combobox over substring matches: a highlight
 * index kept in step with the query by hand, and a corpus that held only the
 * tournament's entities. Two things came out of that. Typing "timezone" or
 * "recovery" or "standings" — a setting, a settings panel, a destination — found
 * nothing, so the answer to a missed query was to go and learn the sidebar
 * instead. And a near miss was a miss: "northvew" matched no team.
 *
 * `cmdk` supplies the fuzzy scorer, the arrow travel, Home/End, Enter, and the
 * active-descendant announcement. What is kept here is the shape the design
 * system commits to: the top bar owns global search, so this stays an inline
 * field with a popover under it rather than becoming a modal palette.
 *
 * # Why the ranking is done here rather than by cmdk's own filter
 *
 * A subsequence scorer matches far more than it should on a long query: every
 * one of `standings`'s letters can be found scattered through "Venue · Settings
 * · Tournament details", so a query that has one excellent answer came back with
 * a dozen. Scores separate them — the real match scores ~0.99 and that tail
 * ~0.012 — but cmdk's `filter` sees one item at a time and cannot know it is
 * looking at a tail.
 *
 * So the scoring is cmdk's `defaultFilter` and the *judgement* is here: drop
 * anything under a floor, take the best twelve, and order the groups by their
 * own best match. `shouldFilter={false}` then tells cmdk the list it is given is
 * the list to show, in the order given. Twelve is what the hand-rolled version
 * capped at; the floor sits below a typo (`northvew` for Northview scores ~0.17)
 * and above scattered noise (~0.01).
 *
 * Escape is two-stage, as it is in the menus: it clears a query in flight, and
 * gives the field up only once there is nothing to clear.
 */
export function GlobalSearch({
  value,
  onChange,
  results,
  onSelect,
  inputRef,
}: {
  value: string;
  onChange: (value: string) => void;
  /** The whole index. Ranking and filtering are cmdk's, not the caller's. */
  results: SearchResultView[];
  onSelect: (result: SearchResultView) => void;
  inputRef: React.MutableRefObject<HTMLInputElement | null>;
}) {
  const open = value.trim().length > 0;

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', focusSearch);
    return () => window.removeEventListener('keydown', focusSearch);
  }, [inputRef]);

  const groups = useMemo(() => rankSearchResults(results, value), [results, value]);

  return (
    <Command
      className="director-search-wrap"
      /* Names the field: cmdk renders this as its visually hidden label. */
      label="Search the tournament"
      shouldFilter={false}
      loop
    >
      <div className="director-search">
        <Icon name="search" size={16} />
        {/* No `id` or `type`: cmdk sets both itself, and its own id is what the
            list and the active-descendant announcement are wired to. */}
        <Command.Input
          ref={inputRef}
          value={value}
          onValueChange={onChange}
          placeholder="Search pages, settings, teams, rooms, rounds, games"
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            if (value.trim()) onChange('');
            else inputRef.current?.blur();
          }}
        />
        <kbd aria-label={shortcutAriaLabel('k')}>{modifierKeyLabel()} K</kbd>
      </div>
      {open &&
        (groups.length > 0 ? (
          <Command.List className="director-search-results" label="Search results">
            {groups.map(({ heading, kind, results: found }) => (
              <Command.Group key={kind} heading={heading}>
                {found.map((result) => (
                  <Command.Item
                    key={`${result.section}-${result.id}`}
                    className="director-search-result"
                    onSelect={() => onSelect(result)}
                  >
                    <span>
                      <strong>{result.label}</strong>
                      <small>{result.detail}</small>
                    </span>
                    <Badge
                      tone="neutral"
                      label={`${result.group ? `${result.group} · ` : ''}${labelForSection(result.section)}`}
                    />
                  </Command.Item>
                ))}
              </Command.Group>
            ))}
          </Command.List>
        ) : (
          <div className="director-search-results director-search-empty" role="status">
            Nothing matches “{value.trim()}”. Pages, settings, teams, players, rooms, packets, rounds, games,
            and results are all searchable.
          </div>
        ))}
    </Command>
  );
}

/** Below this, a match is a scorer artefact rather than something anyone typed for. */
const minimumSearchScore = 0.05;

/** The most results the popover will offer, best first. */
const maximumSearchResults = 12;

const searchGroupOrder: { heading: string; kind: SearchResultKind }[] = [
  { heading: 'Pages', kind: 'page' },
  { heading: 'Settings', kind: 'setting' },
  { heading: 'Tournament', kind: 'entity' },
];

export interface SearchResultGroup {
  heading: string;
  kind: SearchResultKind;
  results: SearchResultView[];
}

/**
 * Score the index against the query and return the groups worth showing.
 *
 * Exported for its own test: the ranking is the part with judgement in it, and
 * driving it through the shell to check that "standings" does not offer Venue
 * would be testing it through three other components.
 */
export function rankSearchResults(results: SearchResultView[], query: string): SearchResultGroup[] {
  const needle = query.trim();
  if (!needle) return [];
  const scored = results
    .map((result) => ({
      result,
      score: defaultFilter(`${result.label} ${result.detail}`, needle, result.keywords),
    }))
    .filter((entry) => entry.score >= minimumSearchScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, maximumSearchResults);
  return (
    searchGroupOrder
      .map(({ heading, kind }) => ({
        heading,
        kind,
        results: scored.filter((entry) => (entry.result.kind ?? 'entity') === kind),
      }))
      // A group is placed by its own best match, so the kind that answers the
      // query leads — searching a team name does not put Pages above it.
      .filter((group) => group.results.length > 0)
      .sort((a, b) => (b.results[0]?.score ?? 0) - (a.results[0]?.score ?? 0))
      .map((group) => ({
        heading: group.heading,
        kind: group.kind,
        results: group.results.map((entry) => entry.result),
      }))
  );
}

/** Kept for callers that only need the canonical target shape. */
export function toNavigationTarget(
  result: SearchResultView,
  entityType?: DirectorNavigationTarget['entityType'],
  parentId?: string,
): DirectorNavigationTarget {
  return {
    section: canonicalSection(result.section),
    entityType,
    entityId: result.id,
    parentId,
  };
}
