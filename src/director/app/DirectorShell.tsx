import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import BrandLogo from '../../BrandLogo';
import { IconButton } from '../components/Controls';
import { Icon } from '../components/Icon';
import { Badge } from '../components/Status';
import { DirectorMenu } from '../components/DirectorMenu';
import { MenuItem, MenuNote, MenuSectionLabel, MenuSeparator } from '../components/Menu';
import { isNativeDirector, openNativeTournamentFile } from '../platform/native';
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
import type { DirectorNavigationTarget } from './navigationTarget';
import type { PickedFile } from '../components/FilePicker';

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
  const openMenuFrom = (name: 'tournament' | 'operator', event: { currentTarget: HTMLElement }) => {
    menuOpenerRef.current = event.currentTarget;
    setOpenMenu((current) => (current === name ? null : name));
  };

  const navigate = (section: SectionId, target?: DirectorNavigationTarget | null) => {
    closeMenu();
    setNavOpen(false);
    onNavigate(section, target);
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
          <span>Director</span>
        </div>

        <div className="director-tournament-switcher-wrap">
          <button
            type="button"
            className="director-tournament-switcher"
            aria-haspopup="menu"
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
                onFile={(file) => {
                  closeMenu();
                  onOpenFile(file);
                }}
              />
              <MenuItem
                icon="edit"
                onSelect={() =>
                  navigate('settings', { section: 'settings', entityType: 'setting', entityId: 'tournament' })
                }
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
              aria-haspopup="menu"
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
                  onSelect={() =>
                    navigate('settings', {
                      section: 'settings',
                      entityType: 'setting',
                      entityId: 'operator',
                    })
                  }
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
                    closeMenu();
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
 * A real `role="menuitem"`, so arrow-key travel through the menu works — the
 * old version was a `<label>` wrapping a file input, which is not a menu item
 * to a screen reader and was skipped by the menu's keyboard navigation. It
 * calls the desktop file dialog in the Tauri build and the browser's file input
 * otherwise; the operator sees the same entry either way.
 */
function ShellFileMenuItem({ onFile }: { onFile: (file: PickedFile) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const native = isNativeDirector();
  return (
    <>
      <button
        role="menuitem"
        type="button"
        className="director-menu-item"
        onClick={() => {
          if (!native) {
            inputRef.current?.click();
            return;
          }
          void openNativeTournamentFile().then((selected) => {
            if (!selected) return;
            const binary = atob(selected.contentBase64);
            onFile({
              fileName: selected.fileName,
              bytes: Uint8Array.from(binary, (character) => character.charCodeAt(0)),
            });
          });
        }}
      >
        <span className="director-menu-item-icon" aria-hidden="true">
          <Icon name="file" size={15} />
        </span>
        <span>Open tournament file…</span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={TOURNAMENT_FILE_ACCEPT}
        className="director-visually-hidden-input"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (!file) return;
          void file.arrayBuffer().then((buffer) => {
            onFile({ fileName: file.name, bytes: new Uint8Array(buffer) });
          });
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

export interface SearchResultView {
  id: string;
  section: SectionId;
  label: string;
  detail: string;
  group: string | null;
}

/**
 * Global search: a command/entity navigator.
 *
 * It finds a thing and goes to it. It does **not** filter any page — the value
 * used to be threaded into the Teams view, so typing here to navigate also
 * narrowed the Teams table under the results popover. Local filtering now lives
 * on the pages, in `SearchField`.
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
  results: SearchResultView[];
  onSelect: (result: SearchResultView) => void;
  inputRef: React.MutableRefObject<HTMLInputElement | null>;
}) {
  /*
   * The highlighted result is keyed to the query it belongs to, so a new
   * keystroke starts with nothing highlighted without an effect resetting state
   * after the fact — one render per keystroke rather than two, and no window in
   * which the highlight points at a result from the previous query.
   */
  const [highlight, setHighlight] = useState<{ query: string; index: number }>({
    query: '',
    index: -1,
  });
  const open = value.trim().length > 0;
  const activeIndex = highlight.query === value ? highlight.index : -1;
  const active = results.length > 0 ? Math.min(activeIndex, results.length - 1) : -1;
  const setActiveIndex = (next: number | ((current: number) => number)) =>
    setHighlight({
      query: value,
      index: typeof next === 'function' ? next(activeIndex) : next,
    });

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

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (value.trim()) onChange('');
      else inputRef.current?.blur();
      return;
    }
    if (!open || !results.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((current) => {
        const next = current + delta;
        return next < 0 ? results.length - 1 : next >= results.length ? 0 : next;
      });
      return;
    }
    if (event.key === 'Enter' && active >= 0) {
      event.preventDefault();
      const result = results[active];
      if (result) onSelect(result);
    }
  };

  return (
    <div className="director-search-wrap">
      <div className="director-search">
        <Icon name="search" size={16} />
        <label className="visually-hidden" htmlFor="director-global-search">
          Search the tournament
        </label>
        <input
          id="director-global-search"
          ref={inputRef}
          type="search"
          placeholder="Search teams, rooms, rounds, games"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open && results.length ? 'director-search-results' : undefined}
          aria-activedescendant={active >= 0 ? `director-search-result-${active}` : undefined}
        />
        <kbd aria-label={shortcutAriaLabel('k')}>{modifierKeyLabel()} K</kbd>
      </div>
      {open &&
        (results.length > 0 ? (
          <div
            id="director-search-results"
            className="director-search-results"
            role="listbox"
            aria-label="Search results"
          >
            {results.map((result, index) => (
              <button
                type="button"
                className={`director-search-result ${index === active ? 'is-active' : ''}`.trim()}
                key={`${result.section}-${result.id}`}
                id={`director-search-result-${index}`}
                role="option"
                aria-selected={index === active}
                onClick={() => onSelect(result)}
              >
                <span>
                  <strong>{result.label}</strong>
                  <small>{result.detail}</small>
                </span>
                <Badge
                  tone="neutral"
                  label={`${result.group ? `${result.group} · ` : ''}${labelForSection(result.section)}`}
                />
              </button>
            ))}
          </div>
        ) : (
          <div className="director-search-results director-search-empty" role="status">
            No matching teams, players, rooms, packets, rounds, or games.
          </div>
        ))}
    </div>
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
