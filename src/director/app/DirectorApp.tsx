import { useEffect, useMemo, useRef, useState } from 'react';
import BrandLogo from '../../BrandLogo';
import { Button, EmptyState, PanelBody, PanelFooter } from '../components/Controls';
import { Icon } from '../components/Icon';
import { navigation, labelForSection, type SectionId } from './navigation';
import { useDirectorController } from '../state/useDirectorController';
import { OverviewView } from '../overview/OverviewView';
import { TeamsView } from '../teams/TeamsView';
import { FormatView } from '../format/FormatView';
import { RoomsView } from '../rooms/RoomsView';
import { PacketsView } from '../packets/PacketsView';
import { TournamentView } from '../tournament/TournamentView';
import { ResultsView } from '../results/ResultsView';
import { TransfersView } from '../transfers/TransfersView';
import { StandingsView } from '../standings/StandingsView';
import { PublishView } from '../publish/PublishView';
import { LiveView } from '../live/LiveView';
import { SettingsView } from '../settings/SettingsView';
import { importArchiveBytes, importDirectorTournament, importQbjText } from '../format/interchange';
import { latestRound } from '../domain';
import {
  isNativeDirector,
  openNativeTournamentFile,
  readNativeServerStatus,
  type NativeServerStatus,
} from '../platform/native';
import type { DirectorTournamentInput } from '@qbsheet/tournament-formats';
import { localCalendarDate } from './date';
import { HelpDialog } from '../help/HelpDialog';
import { loadOperatorProfile, operatorInitials, saveOperatorProfile, type OperatorProfile } from '../operator/operatorProfile';
import type { DirectorNavigationTarget } from './navigationTarget';

export default function DirectorApp() {
  const controller = useDirectorController();
  const { loading, state, syncQbtcp } = controller;
  const nativeDirector = isNativeDirector();
  const [activeSection, setActiveSection] = useState<SectionId>('overview');
  const [search, setSearch] = useState('');
  const [searchActiveIndex, setSearchActiveIndex] = useState(-1);
  const [announcement, setAnnouncement] = useState('');
  const [qbtcpServerStatus, setQbtcpServerStatus] = useState<NativeServerStatus | null>(() =>
    nativeDirector ? null : { running: false },
  );
  const searchRef = useRef<HTMLInputElement>(null);
  const searchResults = useMemo(() => searchTournament(state, search), [search, state]);
  const activeSearchIndex =
    searchResults.length > 0 ? Math.min(searchActiveIndex, searchResults.length - 1) : -1;
  const [helpOpen, setHelpOpen] = useState(false);
  const helpButtonRef = useRef<HTMLButtonElement>(null);
  const [operatorProfile, setOperatorProfile] = useState<OperatorProfile>(() => loadOperatorProfile());
  const [operatorMenuOpen, setOperatorMenuOpen] = useState(false);
  const [operatorDialogOpen, setOperatorDialogOpen] = useState(false);
  const [navigationTarget, setNavigationTarget] = useState<DirectorNavigationTarget | null>(null);
  const [tournamentMenuOpen, setTournamentMenuOpen] = useState(false);
  const tournamentButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', focusSearch);
    return () => window.removeEventListener('keydown', focusSearch);
  }, []);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [activeSection]);

  useEffect(() => {
    if (loading || !state.tournament) return;
    if (!nativeDirector) return;
    let active = true;
    const poll = () => {
      if (!active) return;
      void syncQbtcp();
      void readNativeServerStatus().then((next) => {
        if (active) setQbtcpServerStatus(next);
      });
    };
    poll();
    const interval = window.setInterval(poll, 1000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [loading, nativeDirector, state.tournament, syncQbtcp]);

  if (loading) return <div className="director-loading">Opening local tournament storage…</div>;
  if (!state.tournament)
    return (
      <>
        {controller.error && (
          <p className="director-error-copy" role="alert">
            {controller.error}
          </p>
        )}
        <NewTournamentScreen
          controller={controller}
          onAnnounce={setAnnouncement}
          announcement={announcement}
        />
      </>
    );
  const tournament = state.tournament;

  const navigate = (section: SectionId, target?: DirectorNavigationTarget | null) => {
    setActiveSection(section);
    setAnnouncement('');
    if (target) setNavigationTarget(target);
  };
  const selectSearchResult = (result: SearchResult) => {
    const target: DirectorNavigationTarget = {
      section: result.section,
      entityType: result.entityType,
      entityId: result.id,
      parentId: result.parentId,
    };
    navigate(result.section, target);
    setSearch('');
    setSearchActiveIndex(-1);
  };
  const updateSearch = (value: string) => {
    setSearch(value);
    setSearchActiveIndex(-1);
  };
  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (search.trim()) updateSearch('');
      else searchRef.current?.blur();
      return;
    }
    if (!searchResults.length || !search.trim()) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setSearchActiveIndex((current) => {
        const next = current + direction;
        return next < 0 ? searchResults.length - 1 : next >= searchResults.length ? 0 : next;
      });
      return;
    }
    if (event.key === 'Enter' && activeSearchIndex >= 0) {
      event.preventDefault();
      const result = searchResults[activeSearchIndex];
      if (result) selectSearchResult(result);
    }
  };
  const resultReviewCount = controller.state.submissions.filter(
    (submission) => submission.status === 'review' || submission.status === 'received',
  ).length;
  const transferPendingCount = controller.state.transfers.artifacts.filter(
    (artifact) => artifact.status === 'staged',
  ).length;
  const sidebarServer = describeSidebarServer(qbtcpServerStatus, nativeDirector);
  const renderPage = () => {
    const clearTarget = () => setNavigationTarget(null);
    switch (activeSection) {
      case 'overview':
        return (
          <OverviewView
            state={controller.state}
            controller={controller}
            onNavigate={navigate}
            onAnnounce={setAnnouncement}
            nativeServerReady={qbtcpServerStatus?.running ?? false}
            nativeServerAvailable={nativeDirector}
          />
        );
      case 'teams':
        return (
          <TeamsView
            state={controller.state}
            controller={controller}
            search={search}
            onAnnounce={setAnnouncement}
            navigationTarget={navigationTarget}
            onClearNavigationTarget={clearTarget}
          />
        );
      case 'format':
        return (
          <FormatView
            state={controller.state}
            controller={controller}
            onNavigate={navigate}
            onAnnounce={setAnnouncement}
          />
        );
      case 'rooms':
        return (
          <RoomsView
            state={controller.state}
            controller={controller}
            onNavigate={navigate}
            onAnnounce={setAnnouncement}
            navigationTarget={navigationTarget}
            onClearNavigationTarget={clearTarget}
          />
        );
      case 'packets':
        return (
          <PacketsView
            state={controller.state}
            controller={controller}
            onAnnounce={setAnnouncement}
            navigationTarget={navigationTarget}
            onClearNavigationTarget={clearTarget}
          />
        );
      case 'tournament':
        return (
          <TournamentView
            state={controller.state}
            controller={controller}
            onNavigate={navigate}
            onAnnounce={setAnnouncement}
            navigationTarget={navigationTarget}
            onClearNavigationTarget={clearTarget}
          />
        );
      case 'transfers':
        return (
          <TransfersView
            state={controller.state}
            controller={controller}
            onNavigate={navigate}
            onAnnounce={setAnnouncement}
          />
        );
      case 'results':
        return (
          <ResultsView
            state={controller.state}
            controller={controller}
            onNavigate={navigate}
            onAnnounce={setAnnouncement}
            navigationTarget={navigationTarget}
            onClearNavigationTarget={clearTarget}
          />
        );
      case 'standings':
        return (
          <StandingsView state={controller.state} controller={controller} onAnnounce={setAnnouncement} />
        );
      case 'publish':
        return <PublishView state={controller.state} onAnnounce={setAnnouncement} />;
      case 'live':
        return <LiveView state={controller.state} actions={controller.live} onAnnounce={setAnnouncement} />;
      case 'settings':
        return <SettingsView state={controller.state} controller={controller} onAnnounce={setAnnouncement} operatorProfile={operatorProfile} onSaveOperator={(p) => { setOperatorProfile(p); saveOperatorProfile(p); setAnnouncement('Operator profile saved.'); }} />;
    }
  };

  return (
    <div className="director-app">
      <aside className="director-sidebar">
        <div className="director-brand">
          <BrandLogo className="director-wordmark" />
          <span>Director</span>
        </div>
        <div className="director-tournament-switcher-wrap">
          <button
            ref={tournamentButtonRef}
            type="button"
            className="director-tournament-switcher"
            aria-haspopup="menu"
            aria-expanded={tournamentMenuOpen}
            aria-label={`Tournament: ${tournament.name}. Switch tournament`}
            onClick={() => setTournamentMenuOpen((v) => !v)}
          >
            <span className="director-tournament-overline">Tournament</span>
            <strong>{tournament.name}</strong>
            <span>
              {statusLabel(tournament.status)}
              {controller.state.rounds.length
                ? ` · Round ${latestRound(controller.state.rounds)?.number ?? 0}`
                : ''}
            </span>
            <Icon name="chevron" size={14} />
          </button>
          {tournamentMenuOpen && (
            <div role="menu" className="director-tournament-menu" aria-label="Tournament switcher">
              <div className="director-tournament-menu-header">
                <strong>{tournament.name}</strong>
                <small>{tournament.date} · {statusLabel(tournament.status)}</small>
                <small className="director-mono">{tournament.id.slice(0, 8)}</small>
              </div>
              <div role="separator" className="director-menu-separator" />
              <button role="menuitem" type="button" className="director-menu-item" onClick={() => { setTournamentMenuOpen(false); setHelpOpen(true); }}>
                View tournament details
              </button>
              <button role="menuitem" type="button" className="director-menu-item" onClick={() => {
                setTournamentMenuOpen(false);
                if (confirm('Create a new tournament? Current tournament remains saved locally.')) {
                  // For now, navigate to new-tournament flow via reset: controller will handle create
                  setAnnouncement('Use the new tournament form after saving current work.');
                }
              }}>
                New tournament…
              </button>
              <label role="menuitem" className="director-menu-item director-menu-file">
                Open archive…
                <input type="file" accept=".qbst,.qbj,.json" className="director-visually-hidden-input" onChange={(e) => { setTournamentMenuOpen(false); void (async () => { const f = e.target.files?.[0]; if (!f) return; const text = await f.text(); try { const parsed = JSON.parse(text); const { importDirectorTournament } = await import('../format/interchange'); if (parsed && typeof parsed === 'object' && 'schemaVersion' in parsed) { controller.importSnapshot(parsed); } else if (parsed && typeof parsed === 'object' && 'tournament' in parsed) { controller.importSnapshot(importDirectorTournament(parsed as DirectorTournamentInput)); } setAnnouncement('Archive imported.'); } catch { setAnnouncement('Could not open archive.'); } })(); e.currentTarget.value=''; }} />
              </label>
              <div role="separator" className="director-menu-separator" />
              <div className="director-menu-note">Multi-tournament library persists locally; switch retains current save.</div>
            </div>
          )}
        </div>
        <nav className="director-nav" aria-label="Tournament sections">
          {navigation.map((group, index) => (
            <div className="director-nav-group" key={group.label ?? `primary-${index}`}>
              {group.label && <p className="director-nav-label">{group.label}</p>}
              {group.items.map((item) => (
                <SectionLink
                  key={item.id}
                  section={item}
                  active={item.id === activeSection}
                  onSelect={navigate}
                  count={
                    item.id === 'results'
                      ? resultReviewCount || undefined
                      : item.id === 'transfers'
                        ? transferPendingCount || undefined
                        : undefined
                  }
                />
              ))}
            </div>
          ))}
        </nav>
        <div className="director-sidebar-footer">
          <div className={`director-server-status is-${sidebarServer.kind}`} data-status={sidebarServer.kind}>
            <span className="director-server-dot" aria-hidden="true" />
            <div>
              <strong>{sidebarServer.label}</strong>
              <small>
                {sidebarServer.detail ??
                  (controller.repositoryKind === 'tauri-sqlite'
                    ? 'SQLite storage'
                    : 'Browser preview storage')}
              </small>
            </div>
          </div>
          <button
            ref={helpButtonRef}
            type="button"
            className="director-help-link"
            onClick={() => setHelpOpen(true)}
          >
            <Icon name="help" size={15} /> Help & keyboard shortcuts
          </button>
          <div className="director-operator-wrap">
            <button
              type="button"
              className="director-operator"
              aria-haspopup="menu"
              aria-expanded={operatorMenuOpen}
              onClick={() => setOperatorMenuOpen((v) => !v)}
            >
              <span className="director-avatar">{operatorInitials(operatorProfile.displayName)}</span>
              <div>
                <strong>{operatorProfile.displayName}</strong>
                <small>{operatorProfile.role ?? 'Local operator'}</small>
              </div>
            </button>
            {operatorMenuOpen && (
              <div role="menu" className="director-operator-menu" aria-label="Operator menu">
                <button role="menuitem" type="button" className="director-menu-item" onClick={() => { setOperatorMenuOpen(false); setOperatorDialogOpen(true); }}>Operator profile…</button>
                <button role="menuitem" type="button" className="director-menu-item" onClick={() => { setOperatorMenuOpen(false); navigate('settings'); }}>Settings</button>
                <button role="menuitem" type="button" className="director-menu-item" onClick={() => { setOperatorMenuOpen(false); setHelpOpen(true); }}>Keyboard shortcuts / Help</button>
              </div>
            )}
          </div>
        </div>
      </aside>
      <main className="director-main">
        <header className="director-topbar">
          <div className="director-breadcrumb">
            <span>{tournament.name}</span>
            <Icon name="chevron" size={13} />
            <strong>{labelForSection(activeSection)}</strong>
          </div>
          <div className="director-topbar-actions">
            <div className="director-search-wrap">
              <label className="director-search">
                <Icon name="search" size={16} />
                <span className="visually-hidden">Search tournament</span>
                <input
                  ref={searchRef}
                  type="search"
                  placeholder="Search teams, rooms, games"
                  value={search}
                  onChange={(event) => updateSearch(event.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  role="combobox"
                  aria-autocomplete="list"
                  aria-expanded={search.trim().length > 0}
                  aria-controls={search.trim() && searchResults.length ? 'director-search-results' : undefined}
                  aria-activedescendant={
                    activeSearchIndex >= 0 ? `director-search-result-${activeSearchIndex}` : undefined
                  }
                />
                <kbd>⌘/Ctrl K</kbd>
              </label>
              {search.trim() &&
                (searchResults.length > 0 ? (
                  <div
                    id="director-search-results"
                    className="director-search-results"
                    role="listbox"
                    aria-label="Search results"
                  >
                    {searchResults.map((result, index) => (
                      <button
                        type="button"
                        className={`director-search-result ${index === activeSearchIndex ? 'is-active' : ''}`}
                        key={`${result.section}-${result.id}`}
                        id={`director-search-result-${index}`}
                        role="option"
                        aria-selected={index === activeSearchIndex}
                        onClick={() => selectSearchResult(result)}
                      >
                        <span>
                          <strong>{result.label}</strong>
                          <small>{result.detail}</small>
                        </span>
                        <Icon name="chevron" size={13} />
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="director-search-results director-search-empty" role="status">
                    No matching teams, players, rooms, packets, or games.
                  </div>
                ))}
            </div>
            <button
              type="button"
              className="director-icon-button director-topbar-button"
              title="Help"
              aria-label="Help"
              onClick={() => setHelpOpen(true)}
            >
              <Icon name="help" />
            </button>
            <button
              type="button"
              className="director-avatar director-avatar-top"
              title={operatorProfile.displayName}
              aria-label={`Operator: ${operatorProfile.displayName}`}
              aria-haspopup="menu"
              aria-expanded={operatorMenuOpen}
              onClick={() => setOperatorMenuOpen((v) => !v)}
            >
              {operatorInitials(operatorProfile.displayName)}
            </button>
          </div>
        </header>
        <div className="director-content">
          {controller.error && (
            <p className="director-error-copy" role="alert">
              {controller.error}
            </p>
          )}
          {renderPage()}
        </div>
        {announcement && (
          <div className="director-toast" role="status">
            <Icon name="check" size={16} />
            <span>{announcement}</span>
            <button type="button" aria-label="Dismiss notification" onClick={() => setAnnouncement('')}>
              ×
            </button>
          </div>
        )}
      </main>
      <HelpDialog open={helpOpen} onClose={() => { setHelpOpen(false); helpButtonRef.current?.focus(); }} />
      {operatorDialogOpen && (
        <OperatorProfileDialog
          profile={operatorProfile}
          onClose={() => setOperatorDialogOpen(false)}
          onSave={(p) => { setOperatorProfile(p); saveOperatorProfile(p); setOperatorDialogOpen(false); setAnnouncement('Operator profile saved.'); }}
        />
      )}
    </div>
  );
}

function OperatorProfileDialog({ profile, onClose, onSave }: { profile: OperatorProfile; onClose: () => void; onSave: (p: OperatorProfile) => void; }) {
  const [name, setName] = useState(profile.displayName);
  const [role, setRole] = useState(profile.role ?? '');
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (!d.open) d.showModal();
    const h = (e: Event) => { e.preventDefault(); onClose(); };
    d.addEventListener('cancel', h);
    return () => d.removeEventListener('cancel', h);
  }, [onClose]);
  return (
    <dialog ref={dialogRef} className="director-operator-dialog" aria-labelledby="operator-dialog-title" onClose={onClose}>
      <div className="director-help-dialog-header">
        <h2 id="operator-dialog-title">Operator profile</h2>
        <button type="button" className="director-button director-button-secondary" onClick={onClose}>Close</button>
      </div>
      <p className="director-panel-footnote">Local only — not saved to exports or Live. Used for audit events.</p>
      <div className="director-form-grid director-form-grid-single" style={{ marginTop: 16 }}>
        <label className="director-form-field">
          <span>Display name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Director" />
        </label>
        <label className="director-form-field">
          <span>Role / title (optional)</span>
          <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Local operator" />
        </label>
      </div>
      <div className="director-form-actions" style={{ marginTop: 16 }}>
        <Button variant="primary" onClick={() => { if (!name.trim()) return; onSave({ displayName: name.trim(), role: role.trim() || undefined }); }}>Save</Button>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
      </div>
    </dialog>
  );
}

function SectionLink({
  section,
  active,
  onSelect,
  count,
}: {
  section: { id: SectionId; label: string; icon: Parameters<typeof Icon>[0]['name'] };
  active: boolean;
  onSelect: (section: SectionId) => void;
  count?: number;
}) {
  return (
    <button
      type="button"
      className={`director-nav-link ${active ? 'is-active' : ''}`}
      aria-label={count !== undefined ? `${section.label}, ${count} needing attention` : section.label}
      aria-current={active ? 'page' : undefined}
      onClick={() => onSelect(section.id)}
    >
      <Icon name={section.icon} />
      <span>{section.label}</span>
      {count !== undefined && <span className="director-nav-count">{count}</span>}
    </button>
  );
}

function NewTournamentScreen({
  controller,
  onAnnounce,
  announcement,
}: {
  controller: ReturnType<typeof useDirectorController>;
  onAnnounce: (message: string) => void;
  announcement: string;
}) {
  const [name, setName] = useState('');
  const [date, setDate] = useState(() => localCalendarDate());
  const [venue, setVenue] = useState('');
  const [organizer, setOrganizer] = useState('');
  const create = () => {
    if (!name.trim()) {
      onAnnounce('Enter a tournament name first.');
      return;
    }
    controller.createTournament({ name, date, venue, organizer });
  };
  const importArchive = async (file: File | undefined) => {
    if (!file) return;
    try {
      const extension = file.name.toLocaleLowerCase().split('.').at(-1);
      if (extension === 'qbst') {
        const report = importArchiveBytes(new Uint8Array(await file.arrayBuffer()));
        if (!report.ok || !report.state) {
          onAnnounce(report.errors.join(' ') || 'That archive is not valid.');
          return;
        }
        if (!controller.importSnapshot(report.state)) {
          onAnnounce('That portable archive could not be imported.');
          return;
        }
        onAnnounce(importWarningMessage('Portable archive imported.', report.warnings));
        return;
      }
      const value = await file.text();
      if (extension === 'qbj') {
        const report = importQbjText(value);
        if (!report.ok || !report.state) {
          onAnnounce(report.errors.join(' ') || 'That QBJ file is not valid.');
          return;
        }
        if (!controller.importSnapshot(report.state)) {
          onAnnounce('That QBJ file could not be imported.');
          return;
        }
        onAnnounce(importWarningMessage('QBJ tournament imported.', report.warnings));
        return;
      }
      const parsed: unknown = JSON.parse(value);
      if (isDirectorStateLike(parsed)) {
        if (!controller.importSnapshot(parsed)) return;
        onAnnounce('Director tournament imported.');
        return;
      }
      if (isDirectorTournamentLike(parsed)) {
        if (!controller.importSnapshot(importDirectorTournament(parsed as DirectorTournamentInput))) {
          onAnnounce('That tournament data could not be imported.');
          return;
        }
        onAnnounce('Tournament data imported.');
        return;
      }
      const report = importQbjText(value);
      if (report.ok && report.state) {
        if (!controller.importSnapshot(report.state)) {
          onAnnounce('That QBJ tournament could not be imported.');
          return;
        }
        onAnnounce(importWarningMessage('QBJ tournament imported.', report.warnings));
        return;
      }
      onAnnounce(report.errors.join(' ') || 'That file is not a supported Director archive.');
    } catch (reason: unknown) {
      onAnnounce(reason instanceof Error ? reason.message : 'That file could not be read.');
    }
  };
  const openNative = async () => {
    try {
      const selected = await openNativeTournamentFile();
      if (!selected) return;
      const binary = atob(selected.contentBase64);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      const extension = selected.fileName.toLocaleLowerCase().split('.').at(-1);
      if (extension === 'qbst') {
        const report = importArchiveBytes(bytes);
        if (!report.ok || !report.state)
          throw new Error(report.errors.join(' ') || 'That archive is not valid.');
        if (!controller.importSnapshot(report.state)) throw new Error('That archive could not be imported.');
        onAnnounce(importWarningMessage('Portable archive imported.', report.warnings));
      } else if (extension === 'qbj') {
        const report = importQbjText(new TextDecoder().decode(bytes));
        if (!report.ok || !report.state)
          throw new Error(report.errors.join(' ') || 'That file is not a supported QBJ archive.');
        if (!controller.importSnapshot(report.state)) throw new Error('That QBJ file could not be imported.');
        onAnnounce(importWarningMessage('QBJ tournament imported.', report.warnings));
      } else if (extension === 'json') {
        const text = new TextDecoder().decode(bytes);
        const parsed: unknown = JSON.parse(text);
        if (isDirectorStateLike(parsed)) {
          if (!controller.importSnapshot(parsed))
            throw new Error('That Director state could not be imported.');
          onAnnounce('Director tournament imported.');
        } else if (isDirectorTournamentLike(parsed)) {
          if (!controller.importSnapshot(importDirectorTournament(parsed as DirectorTournamentInput)))
            throw new Error('That tournament data could not be imported.');
          onAnnounce('Tournament data imported.');
        } else {
          const report = importQbjText(text);
          if (!report.ok || !report.state)
            throw new Error(
              report.errors.join(' ') || 'That file is not a supported Director or QBJ archive.',
            );
          if (!controller.importSnapshot(report.state))
            throw new Error('That QBJ tournament could not be imported.');
          onAnnounce(importWarningMessage('QBJ tournament imported.', report.warnings));
        }
      } else {
        throw new Error('That file type is not supported. Choose a .qbst, .qbj, or .json file.');
      }
    } catch (reason: unknown) {
      onAnnounce(reason instanceof Error ? reason.message : 'That file could not be opened.');
    }
  };
  return (
    <div className="director-app director-app-start">
      <main className="director-start-main">
        <div className="director-brand director-start-brand">
          <BrandLogo className="director-wordmark" />
          <span>Director</span>
        </div>
        <EmptyState
          title="Create or open a tournament"
          description="Director stores the tournament locally as you work. Start with metadata, then add teams, rooms, packets, and a format."
          variant="standalone"
          className="director-start-empty-state"
        >
          <form
            className="director-start-form"
            onSubmit={(event) => {
              event.preventDefault();
              create();
            }}
          >
            <PanelBody className="director-start-form-body">
              <label className="director-form-field">
                <span>Tournament name</span>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Saturday invitational"
                />
              </label>
              <label className="director-form-field">
                <span>Date</span>
                <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
              </label>
              <label className="director-form-field">
                <span>Venue</span>
                <input
                  value={venue}
                  onChange={(event) => setVenue(event.target.value)}
                  placeholder="School or building"
                />
              </label>
              <label className="director-form-field">
                <span>Organizer</span>
                <input
                  value={organizer}
                  onChange={(event) => setOrganizer(event.target.value)}
                  placeholder="Your name or organization"
                />
              </label>
            </PanelBody>
            <PanelFooter className="director-form-actions">
              <Button variant="primary" icon="plus" type="submit">
                Create tournament
              </Button>
              <label className="director-button director-button-secondary">
                <Icon name="upload" size={15} />
                <span>
                  Open archive
                  <input
                    className="director-visually-hidden-input"
                    type="file"
                    accept=".qbst,.qbj,.json"
                    onChange={(event) => {
                      void importArchive(event.target.files?.[0]);
                      event.currentTarget.value = '';
                    }}
                  />
                </span>
              </label>
              {isNativeDirector() && (
                <Button variant="quiet" icon="file" onClick={() => void openNative()}>
                  Choose file…
                </Button>
              )}
            </PanelFooter>
          </form>
        </EmptyState>
        {announcement && (
          <div className="director-toast director-toast-start" role="status">
            <Icon name="alert" size={16} />
            <span>{announcement}</span>
          </div>
        )}
      </main>
    </div>
  );
}

function importWarningMessage(message: string, warnings: string[]): string {
  return warnings.length > 0
    ? `${message} ${warnings.length} compatibility warning${warnings.length === 1 ? '' : 's'} retained.`
    : message;
}

type SidebarServerKind = 'unknown' | 'unavailable' | 'stopped' | 'running' | 'paired' | 'error';

function describeSidebarServer(
  status: NativeServerStatus | null,
  native: boolean,
): { kind: SidebarServerKind; label: string; detail?: string } {
  if (!native) return { kind: 'unavailable', label: 'QBTCP not started' };
  if (!status) return { kind: 'unknown', label: 'Checking QBTCP…' };
  if (!status.running) {
    return status.message && !isExpectedStoppedMessage(status.message)
      ? { kind: 'error', label: 'QBTCP server error', detail: status.message }
      : { kind: 'stopped', label: 'QBTCP not started' };
  }
  const pairedRooms = status.pairedRooms ?? 0;
  return pairedRooms > 0
    ? {
        kind: 'paired',
        label: `${pairedRooms} room${pairedRooms === 1 ? '' : 's'} paired`,
      }
    : { kind: 'running', label: 'QBTCP server running' };
}

function isExpectedStoppedMessage(message: string): boolean {
  return /^qbtcp server stopped\.?$/i.test(message.trim());
}

function statusLabel(status: string): string {
  return status === 'draft'
    ? 'Draft'
    : status === 'running'
      ? 'In progress'
      : status === 'complete'
        ? 'Complete'
        : 'Archived';
}

type SearchResult = { id: string; section: SectionId; label: string; detail: string; entityType?: import('./navigationTarget').EntityType; parentId?: string };

function searchTournament(
  state: ReturnType<typeof useDirectorController>['state'],
  query: string,
): SearchResult[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const results: SearchResult[] = [];
  const matches = (values: unknown[]) =>
    values.some((value) =>
      String(value ?? '')
        .toLocaleLowerCase()
        .includes(needle),
    );
  for (const team of state.teams) {
    const organization = team.organizationId
      ? state.organizations.find((entry) => entry.id === team.organizationId)?.name
      : undefined;
    if (matches([team.displayName, team.teamLetter, team.status, organization])) {
      results.push({
        id: team.id,
        section: 'teams',
        label: team.displayName,
        detail: [organization, team.teamLetter && `Team ${team.teamLetter}`, team.status]
          .filter(Boolean)
          .join(' · '),
        entityType: 'team',
      });
    }
  }
  for (const player of state.players) {
    const team = state.teams.find((entry) => entry.id === player.teamId);
    if (matches([player.name, team?.displayName, player.rosterNumber])) {
      results.push({
        id: player.id,
        section: 'teams',
        label: player.name,
        detail: team?.displayName ?? 'Roster player',
        entityType: 'player',
        parentId: player.teamId,
      });
    }
  }
  for (const room of state.rooms) {
    if (matches([room.name, room.building, room.floor, room.status])) {
      results.push({ id: room.id, section: 'rooms', label: room.name, detail: room.status, entityType: 'room' });
    }
  }
  for (const packet of state.packets) {
    if (matches([packet.name, packet.source])) {
      results.push({
        id: packet.id,
        section: 'packets',
        label: packet.name,
        detail: `${packet.source} packet`,
        entityType: 'packet',
      });
    }
  }
  for (const round of state.rounds) {
    if (matches([round.name, round.number, round.status])) {
      results.push({
        id: round.id,
        section: 'tournament',
        label: round.name,
        detail: `Round ${round.number} · ${round.status}`,
        entityType: 'round',
      });
    }
  }
  for (const game of state.scheduledGames) {
    const left = state.teams.find((team) => team.id === game.leftTeamId)?.displayName;
    const right = game.rightTeamId
      ? state.teams.find((team) => team.id === game.rightTeamId)?.displayName
      : 'Bye';
    const round = state.rounds.find((entry) => entry.id === game.roundId);
    if (matches([game.id, left, right, round?.name, game.status])) {
      results.push({
        id: game.id,
        section: 'tournament',
        label: `${left ?? 'Unknown'} · ${right ?? 'Unknown'}`,
        detail: `${round?.name ?? 'Scheduled game'} · ${game.status}`,
        entityType: 'game',
      });
    }
  }
  for (const submission of state.submissions) {
    const game = state.games.find((entry) => entry.id === submission.gameId);
    if (matches([submission.id, submission.transportResultId, submission.status, game?.scheduledGameId])) {
      results.push({
        id: submission.id,
        section: 'results',
        label: `Result ${submission.transportResultId ?? submission.id}`,
        detail: submission.status,
        entityType: 'submission',
      });
    }
  }
  return results.slice(0, 12);
}

function isDirectorStateLike(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'schemaVersion' in value &&
    'tournament' in value &&
    'teams' in value &&
    'scheduledGames' in value,
  );
}

function isDirectorTournamentLike(value: unknown): value is DirectorTournamentInput {
  return Boolean(value && typeof value === 'object' && 'tournament' in value && !('schemaVersion' in value));
}
