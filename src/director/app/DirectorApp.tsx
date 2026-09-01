import { useEffect, useRef, useState } from 'react';
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
import { StandingsView } from '../standings/StandingsView';
import { PublishView } from '../publish/PublishView';
import { SettingsView } from '../settings/SettingsView';
import { importArchiveBytes, importDirectorTournament, importQbjText } from '../format/interchange';
import {
  isNativeDirector,
  openNativeTournamentFile,
  readNativeServerStatus,
  type NativeServerStatus,
} from '../platform/native';
import type { DirectorTournamentInput } from '@qbsheet/tournament-formats';

export default function DirectorApp() {
  const controller = useDirectorController();
  const { loading, state, syncQbtcp } = controller;
  const [activeSection, setActiveSection] = useState<SectionId>('overview');
  const [search, setSearch] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [qbtcpServerStatus, setQbtcpServerStatus] = useState<NativeServerStatus | null>(() =>
    isNativeDirector() ? null : { running: false },
  );
  const searchRef = useRef<HTMLInputElement>(null);

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
    if (loading || !state.tournament) return;
    if (!isNativeDirector()) return;
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
  }, [loading, state.tournament, syncQbtcp]);

  if (loading) return <div className="director-loading">Opening local tournament storage…</div>;
  if (!state.tournament)
    return (
      <NewTournamentScreen controller={controller} onAnnounce={setAnnouncement} announcement={announcement} />
    );
  const tournament = state.tournament;

  const navigate = (section: SectionId) => {
    setActiveSection(section);
    setAnnouncement('');
  };
  const resultReviewCount = controller.state.submissions.filter(
    (submission) => submission.status === 'review' || submission.status === 'received',
  ).length;
  const sidebarServer = describeSidebarServer(qbtcpServerStatus, isNativeDirector());
  const renderPage = () => {
    switch (activeSection) {
      case 'overview':
        return (
          <OverviewView
            state={controller.state}
            controller={controller}
            onNavigate={navigate}
            onAnnounce={setAnnouncement}
          />
        );
      case 'teams':
        return (
          <TeamsView
            state={controller.state}
            controller={controller}
            search={search}
            onAnnounce={setAnnouncement}
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
        return <RoomsView state={controller.state} controller={controller} onAnnounce={setAnnouncement} />;
      case 'packets':
        return <PacketsView state={controller.state} controller={controller} onAnnounce={setAnnouncement} />;
      case 'tournament':
        return (
          <TournamentView
            state={controller.state}
            controller={controller}
            onNavigate={navigate}
            onAnnounce={setAnnouncement}
          />
        );
      case 'results':
        return <ResultsView state={controller.state} controller={controller} onAnnounce={setAnnouncement} />;
      case 'standings':
        return (
          <StandingsView state={controller.state} controller={controller} onAnnounce={setAnnouncement} />
        );
      case 'publish':
        return <PublishView state={controller.state} onAnnounce={setAnnouncement} />;
      case 'settings':
        return <SettingsView state={controller.state} controller={controller} onAnnounce={setAnnouncement} />;
    }
  };

  return (
    <div className="director-app">
      <aside className="director-sidebar">
        <div className="director-brand">
          <BrandLogo className="director-wordmark" />
          <span>Director</span>
        </div>
        <div className="director-tournament-switcher">
          <span className="director-tournament-overline">Tournament</span>
          <strong>{tournament.name}</strong>
          <span>
            {statusLabel(tournament.status)}
            {controller.state.rounds.length ? ` · Round ${controller.state.rounds.at(-1)?.number ?? 0}` : ''}
          </span>
          <Icon name="chevron" size={14} />
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
                  count={item.id === 'results' ? resultReviewCount : undefined}
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
            type="button"
            className="director-help-link"
            onClick={() => setAnnouncement('Use ⌘ K or Ctrl K to search teams, rooms, and games.')}
          >
            <Icon name="help" size={15} /> Help & keyboard shortcuts
          </button>
          <div className="director-operator">
            <span className="director-avatar">D</span>
            <div>
              <strong>Director</strong>
              <small>Local operator</small>
            </div>
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
            <label className="director-search">
              <Icon name="search" size={16} />
              <span className="visually-hidden">Search tournament</span>
              <input
                ref={searchRef}
                type="search"
                placeholder="Search teams, rooms, games"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <kbd>⌘ K</kbd>
            </label>
            <button
              type="button"
              className="director-icon-button director-topbar-button"
              title="Help"
              aria-label="Help"
              onClick={() => setAnnouncement('Use ⌘ K or Ctrl K to focus search.')}
            >
              <Icon name="help" />
            </button>
            <span className="director-avatar director-avatar-top" title="Local operator">
              D
            </span>
          </div>
        </header>
        <div className="director-content">{renderPage()}</div>
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
    </div>
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
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
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
        controller.importSnapshot(report.state);
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
        controller.importSnapshot(report.state);
        onAnnounce(importWarningMessage('QBJ tournament imported.', report.warnings));
        return;
      }
      const parsed: unknown = JSON.parse(value);
      if (controller.importSnapshot(parsed)) {
        onAnnounce('Director tournament imported.');
        return;
      }
      if (parsed && typeof parsed === 'object' && 'tournament' in parsed) {
        controller.importSnapshot(importDirectorTournament(parsed as DirectorTournamentInput));
        onAnnounce('Tournament data imported.');
        return;
      }
      onAnnounce('That file is not a supported Director archive.');
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
        controller.importSnapshot(report.state);
        onAnnounce(importWarningMessage('Portable archive imported.', report.warnings));
      } else {
        const report = importQbjText(new TextDecoder().decode(bytes));
        if (!report.ok || !report.state)
          throw new Error(report.errors.join(' ') || 'That file is not a supported QBJ archive.');
        controller.importSnapshot(report.state);
        onAnnounce(importWarningMessage('QBJ tournament imported.', report.warnings));
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
                    accept=".qbst,.qbj,.json,.qbsheet"
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
