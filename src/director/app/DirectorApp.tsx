import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import BrandLogo from '../../BrandLogo';
import { Button } from '../components/Controls';
import { Callout } from '../components/Status';
import { Dialog } from '../components/Dialog';
import { ConfirmProvider, useConfirm } from '../components/Dialog';
import { DirtyFormProvider, FormActions, useDirtyForms } from '../components/Fields';
import { FilePicker } from '../components/FilePicker';
import { SummaryItem, SummaryList } from '../components/Layout';
import { ActionMenu, MenuItem } from '../components/Menu';
import { Badge } from '../components/Status';
import { useFormState } from '../components/Fields';
import { canonicalSection, groupForSection, labelForSection, type SectionId } from './navigation';
import {
  useDirectorController,
  type DocumentTransitionCheck,
  type DirectorDocumentTransition,
  type NewTournamentInput,
} from '../state/useDirectorController';
import { OverviewView } from '../overview/OverviewView';
import { TeamsView } from '../teams/TeamsView';
import { FormatView } from '../format/FormatView';
import { RoundsView } from '../schedule/RoundsView';
import { RoomsView } from '../rooms/RoomsView';
import { PacketsView } from '../packets/PacketsView';
import { ResultsView } from '../results/ResultsView';
import { useTransfers } from '../transfers/useTransfers';
import { TransfersView } from '../transfers/TransfersView';
import { StandingsView } from '../standings/StandingsView';
import { downloadArchive, PublishView } from '../publish/PublishView';
import { LiveView } from '../live/LiveView';
import { SettingsView } from '../settings/SettingsView';
import { latestRound } from '../domain';
import { currentOperationalRound } from '../transfers/assignment';
import { isNativeDirector, type NativeServerStatus } from '../platform/native';
import { useNativeServerStatus } from '../server/useNativeServerStatus';
import {
  deriveQbtcpOperationalHealth,
  qbtcpHealthSummary,
  type QbtcpOperationalHealth,
} from '../server/qbtcpHealth';
import { DirectorToast } from '../components/DirectorToast';
import { errorNotice, toDirectorNotice, type AnnounceInput, type DirectorNotice } from '../notices';
import { localCalendarDate } from './date';
import { HelpDialog } from '../help/HelpDialog';
import {
  loadOperatorProfile,
  operatorInitials,
  saveOperatorProfile,
  type OperatorProfile,
} from '../operator/operatorProfile';
import type { DirectorNavigationTarget } from './navigationTarget';
import { pageSearchTargets, revealSettingsTarget, settingsSearchTargets } from './searchTargets';
import {
  DirectorShell,
  GlobalSearch,
  statusLabel,
  type NowChip,
  type SearchResultView,
  type TournamentSummary,
} from './DirectorShell';
import {
  TournamentFields,
  emptyTournamentForm,
  localTimeZone,
  validateTournamentForm,
  type TournamentFormValues,
} from './TournamentForm';
import { openTournamentFile } from './openTournament';
import type { PickedFile } from '../components/FilePicker';

/**
 * The Director application.
 *
 * Composition only: the shell is `DirectorShell`, the confirmation service is
 * `ConfirmProvider`, and the pages own their own content. What lives here is
 * the state the shell and the pages share — the active destination, the global
 * search query, the deep-link target, the operator profile, and the toast.
 *
 * # Canonical editing surfaces
 *
 * Tournament details and the operator profile used to exist twice each: once as
 * a dialog reached from a menu, and once as a form in Settings, with the two
 * copies already drifting (the timezone control was a `<datalist>` in one and a
 * plain text input in the other). Settings is now the single canonical surface
 * for both, and the menu entries navigate to it with a deep link to the right
 * section. Creating a tournament remains a dialog, because it is a
 * modal decision rather than a setting, and it shares its fields with the
 * startup screen via `TournamentFields`.
 */
export default function DirectorApp() {
  return (
    <ConfirmProvider>
      <DirtyFormProvider>
        <DirectorAppContent />
      </DirtyFormProvider>
    </ConfirmProvider>
  );
}

function DirectorAppContent() {
  const controller = useDirectorController();
  const { loading, state, syncQbtcp, canLeaveCurrentDocument, retryPersistence } = controller;
  const dirtyForms = useDirtyForms();
  const confirm = useConfirm();
  const nativeDirector = isNativeDirector();
  const [activeSection, setActiveSection] = useState<SectionId>('overview');
  const [search, setSearch] = useState('');
  const [announcement, setAnnouncement] = useState<DirectorNotice | null>(null);
  const announce = useCallback(
    (input: AnnounceInput) => setAnnouncement(toDirectorNotice(input)),
    [setAnnouncement],
  );
  const transfers = useTransfers(state, controller, announce, !loading && !controller.documentTransition);
  // The one shared native QBTCP snapshot: Overview preflight, Rooms, and the
  // top-bar now-strip all read this same state, and Rooms writes through to it.
  const nativeServer = useNativeServerStatus({
    active: !loading && state.tournament != null && nativeDirector,
    onPoll: () => {
      void syncQbtcp();
    },
  });
  const qbtcpServerStatus: NativeServerStatus | null = !nativeDirector
    ? { running: false }
    : nativeServer.loading
      ? null
      : nativeServer.status;
  const qbtcpOperationalHealth: QbtcpOperationalHealth | null = nativeDirector
    ? deriveQbtcpOperationalHealth(qbtcpServerStatus, controller.qbtcpHealth)
    : null;
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [operatorProfile, setOperatorProfile] = useState<OperatorProfile>(() => loadOperatorProfile());
  const [navigationTarget, setNavigationTarget] = useState<DirectorNavigationTarget | null>(null);
  const [newTournamentOpen, setNewTournamentOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [blockedTransition, setBlockedTransition] = useState<{
    check: Extract<DocumentTransitionCheck, { ok: false }>;
    action: () => boolean | Promise<boolean>;
  } | null>(null);

  const discardDirtyFormsBefore = useCallback(
    async (action: () => boolean | Promise<boolean>): Promise<boolean> => {
      const dirty = dirtyForms.filter((form) => form.dirty);
      if (dirty.length === 0) return Boolean(await action());
      const confirmed = await confirm({
        title: 'Discard unsaved changes?',
        body: `You have unsaved changes in ${dirty.map((form) => form.label).join(' and ')}.`,
        consequence: 'Continuing will discard those drafts; saved tournament data is not changed.',
        confirmLabel: 'Discard changes',
        cancelLabel: 'Keep editing',
        tone: 'warning',
      });
      if (!confirmed) return false;
      dirty.forEach((form) => form.discard());
      return Boolean(await action());
    },
    [confirm, dirtyForms],
  );

  const requestDocumentTransition = useCallback(
    (action: () => boolean | Promise<boolean>, onBlocked?: () => void): boolean | Promise<boolean> => {
      const start = () => {
        const check = canLeaveCurrentDocument();
        if (!check.ok) {
          onBlocked?.();
          setBlockedTransition({ check, action });
          return false;
        }
        return action();
      };
      if (dirtyForms.some((form) => form.dirty)) {
        void discardDirtyFormsBefore(start);
        return false;
      }
      return start();
    },
    [canLeaveCurrentDocument, discardDirtyFormsBefore, dirtyForms, setBlockedTransition],
  );

  const retryBlockedTransition = useCallback(async () => {
    if (!blockedTransition) return;
    const saved = await retryPersistence();
    if (!saved) return;
    const action = blockedTransition.action;
    setBlockedTransition(null);
    await action();
  }, [blockedTransition, retryPersistence, setBlockedTransition]);

  // The index does not depend on the query: `cmdk` ranks it per keystroke.
  const searchIndex = useMemo(() => buildSearchIndex(state), [state]);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [activeSection]);

  const navigate = useCallback(
    (section: SectionId, target?: DirectorNavigationTarget | null) => {
      const nextSection = canonicalSection(section);
      const change = () => {
        setActiveSection(nextSection);
        setAnnouncement(null);
        setNavigationTarget(target ? { ...target, section: nextSection } : null);
        return true;
      };
      if (nextSection === activeSection) return change();
      void discardDirtyFormsBefore(change);
    },
    [activeSection, discardDirtyFormsBefore, setAnnouncement, setNavigationTarget],
  );

  const importFile = useCallback(
    (file: PickedFile) => {
      void requestDocumentTransition(() => {
        const result = openTournamentFile(file, (snapshot) =>
          controller.importSnapshot(snapshot as Parameters<typeof controller.importSnapshot>[0]),
        );
        announce(result.announcement);
        return result.ok;
      });
    },
    [announce, controller, requestDocumentTransition],
  );

  const saveOperator = useCallback((profile: OperatorProfile): boolean => {
    setOperatorProfile(profile);
    saveOperatorProfile(profile);
    return true;
  }, []);

  if (controller.documentTransition)
    return <DocumentTransitionLoading transition={controller.documentTransition} />;
  if (loading) return <div className="director-loading">Opening local tournament storage…</div>;
  if (!state.tournament)
    return (
      <StartScreen
        controller={controller}
        onAnnounce={announce}
        announcement={announcement}
        onImport={importFile}
      />
    );

  const tournament = state.tournament;
  const catalog: TournamentSummary[] = controller.tournaments.some((entry) => entry.id === tournament.id)
    ? controller.tournaments.map((entry) => ({
        id: entry.id,
        name: entry.name,
        date: entry.date,
        status: entry.status,
      }))
    : [{ id: tournament.id, name: tournament.name, date: tournament.date, status: tournament.status }];
  const recentTournaments = catalog.filter((entry) => entry.status !== 'archived');
  const archivedTournaments = catalog.filter((entry) => entry.status === 'archived');

  const resultReviewCount = state.submissions.filter(
    (submission) => submission.status === 'review' || submission.status === 'received',
  ).length;
  const transferPendingCount = state.transfers.artifacts.filter(
    (artifact) => artifact.status === 'staged',
  ).length;

  const clearTarget = () => setNavigationTarget(null);
  const renderPage = () => {
    switch (activeSection) {
      case 'overview':
        return (
          <OverviewView
            state={state}
            controller={controller}
            onNavigate={navigate}
            onAnnounce={announce}
            nativeServerReady={qbtcpServerStatus?.running ?? false}
            nativeServerAvailable={nativeDirector}
            qbtcpHealth={controller.qbtcpHealth}
            qbtcpOperationalHealth={qbtcpOperationalHealth}
          />
        );
      case 'teams':
        return (
          <TeamsView
            state={state}
            controller={controller}
            onAnnounce={announce}
            navigationTarget={navigationTarget}
            onClearNavigationTarget={clearTarget}
          />
        );
      case 'format':
        return (
          <FormatView state={state} controller={controller} onNavigate={navigate} onAnnounce={announce} />
        );
      case 'schedule':
      case 'tournament':
        return (
          <RoundsView
            transfers={transfers}
            state={state}
            controller={controller}
            onNavigate={navigate}
            onAnnounce={announce}
            navigationTarget={navigationTarget}
            onClearNavigationTarget={clearTarget}
          />
        );
      case 'rooms':
        return (
          <RoomsView
            state={state}
            controller={controller}
            onNavigate={navigate}
            onAnnounce={announce}
            navigationTarget={navigationTarget}
            onClearNavigationTarget={clearTarget}
            server={nativeServer}
          />
        );
      case 'packets':
        return (
          <PacketsView
            state={state}
            controller={controller}
            onNavigate={navigate}
            onAnnounce={announce}
            navigationTarget={navigationTarget}
            onClearNavigationTarget={clearTarget}
          />
        );
      case 'transfers':
        return (
          <TransfersView
            transfers={transfers}
            state={state}
            controller={controller}
            onNavigate={navigate}
            onAnnounce={announce}
          />
        );
      case 'results':
        return (
          <ResultsView
            state={state}
            controller={controller}
            onNavigate={navigate}
            onAnnounce={announce}
            navigationTarget={navigationTarget}
            onClearNavigationTarget={clearTarget}
          />
        );
      case 'standings':
        return <StandingsView state={state} controller={controller} onAnnounce={announce} />;
      case 'publish':
        return <PublishView state={state} onAnnounce={announce} onNavigate={navigate} />;
      case 'live':
        return <LiveView state={state} actions={controller.live} onAnnounce={announce} />;
      case 'settings':
        return (
          <SettingsView
            state={state}
            controller={controller}
            onAnnounce={announce}
            operatorProfile={operatorProfile}
            onSaveOperator={saveOperator}
            navigationTarget={navigationTarget}
            onClearNavigationTarget={clearTarget}
            onRestoreCheckpoint={(checkpointId) =>
              Promise.resolve(requestDocumentTransition(() => controller.restoreCheckpoint(checkpointId)))
            }
          />
        );
    }
  };

  return (
    <>
      <DirectorShell
        tournament={{
          id: tournament.id,
          name: tournament.name,
          date: tournament.date,
          status: tournament.status,
        }}
        activeSection={activeSection}
        onNavigate={navigate}
        recentTournaments={recentTournaments}
        archivedTournaments={archivedTournaments}
        onSwitchTournament={(id, name) => {
          void requestDocumentTransition(async () => {
            const switched = await controller.switchTournament(id);
            if (switched) announce(`Opened ${name}.`);
            return switched;
          });
        }}
        onNewTournament={() => setNewTournamentOpen(true)}
        onOpenFile={importFile}
        onOpenFileError={(message) => announce(errorNotice(message))}
        onManageTournaments={() => setManageOpen(true)}
        onArchiveTournament={() => {
          void controller.archiveTournament().then((archived) => {
            if (archived) announce(`${tournament.name} archived.`);
          });
        }}
        canArchive={tournament.status === 'complete'}
        operatorName={operatorProfile.displayName}
        operatorRole={operatorProfile.role ?? 'Local operator'}
        operatorInitials={operatorInitials(operatorProfile.displayName)}
        onHelp={() => setHelpOpen(true)}
        navCounts={{
          results: resultReviewCount
            ? { count: resultReviewCount, tone: 'warning', label: 'awaiting review' }
            : undefined,
          transfers: transferPendingCount
            ? { count: transferPendingCount, tone: 'info', label: 'staged transfers' }
            : undefined,
        }}
        nowChips={nowChips(state, qbtcpOperationalHealth, nativeDirector, navigate)}
        search={
          <GlobalSearch
            value={search}
            onChange={setSearch}
            results={searchIndex}
            inputRef={searchRef}
            onSelect={(result) => {
              setSearch('');
              /*
               * A page result is a destination and nothing more — handing it an
               * entity target would make the arriving view hunt for a `page:teams`
               * entity and mark nothing. A settings result names the sub-section
               * Settings switches to, then focuses its own panel or field.
               */
              if (result.kind === 'page') {
                navigate(result.section, null);
                return;
              }
              if (result.kind === 'setting') {
                navigate('settings', {
                  section: 'settings',
                  entityType: 'setting',
                  entityId: result.settingsEntityId ?? 'tournament',
                });
                revealSettingsTarget({
                  panelId: result.settingsPanelId,
                  fieldLabel: result.settingsFieldLabel,
                });
                return;
              }
              navigate(result.section, {
                section: result.section,
                entityType: result.entityType,
                entityId: result.id,
                parentId: result.parentId,
              });
            }}
          />
        }
        banners={
          <>
            {tournament.status === 'archived' && (
              <ArchivedTournamentReadOnlyNotice
                tournamentName={tournament.name}
                onReopen={() =>
                  void controller.reopenTournament().then((reopened) => {
                    if (reopened) announce(`${tournament.name} reopened as a draft.`);
                  })
                }
              />
            )}
            {(controller.writerStatus === 'blocked' || controller.writerStatus === 'unavailable') && (
              <Callout tone="warning" title="Read-only Director tab" role="alert">
                {controller.writerStatus === 'blocked'
                  ? 'Another browser tab is editing this tournament. Close it, or make your changes there.'
                  : 'This browser cannot safely coordinate multiple Director tabs, so edits are disabled here.'}
              </Callout>
            )}
            {/*
              A healthy save says nothing at all. A save in flight is one quiet
              line. A failed save is a danger callout carrying the two recovery
              actions, and it does not go away on its own.
            */}
            {controller.persistence.status === 'saving' && (
              <Callout tone="info" role="status">
                Saving tournament changes. Keep Director open until this finishes.
              </Callout>
            )}
            {controller.persistence.status === 'failed' && (
              <Callout
                tone="danger"
                title="Changes are not saved"
                role="alert"
                actions={
                  <>
                    <Button
                      variant="secondary"
                      onClick={() =>
                        void controller
                          .retryPersistence()
                          .then((saved) =>
                            announce(
                              saved
                                ? 'Tournament changes saved.'
                                : errorNotice('Tournament changes are still not saved.'),
                            ),
                          )
                      }
                    >
                      Retry save
                    </Button>
                    <Button
                      variant="secondary"
                      icon="download"
                      onClick={() => void downloadArchive(state, announce)}
                    >
                      Export recovery archive
                    </Button>
                  </>
                }
              >
                {controller.persistence.error ?? 'Director storage failed.'} The tournament is still open in
                memory — retry the save, or export a recovery archive before closing Director.
              </Callout>
            )}
            {controller.error && (
              <Callout tone="danger" role="alert">
                {controller.error}
              </Callout>
            )}
          </>
        }
      >
        {renderPage()}
      </DirectorShell>
      {announcement && <DirectorToast announcement={announcement} onDismiss={() => setAnnouncement(null)} />}
      <HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
      {newTournamentOpen && (
        <NewTournamentDialog
          onClose={() => setNewTournamentOpen(false)}
          onCreate={(input) => {
            const result = requestDocumentTransition(
              () => {
                const created = controller.createTournament(input);
                if (created) {
                  setNewTournamentOpen(false);
                  announce(`${input.name} created.`);
                }
                return created;
              },
              () => setNewTournamentOpen(false),
            );
            return typeof result === 'boolean' ? result : false;
          }}
        />
      )}
      {manageOpen && (
        <ManageTournamentsDialog
          tournaments={catalog}
          currentId={tournament.id}
          onClose={() => setManageOpen(false)}
          onSwitch={(entry) => {
            setManageOpen(false);
            void requestDocumentTransition(async () => {
              const switched = await controller.switchTournament(entry.id);
              if (switched) announce(`Opened ${entry.name}.`);
              return switched;
            });
          }}
          onReopen={(entry) => {
            void controller.reopenTournament(entry.id).then((reopened) => {
              if (reopened) announce(`${entry.name} reopened as a draft.`);
            });
          }}
          onArchive={() => {
            void controller.archiveTournament().then((archived) => {
              if (archived) announce(`${tournament.name} archived.`);
            });
          }}
          canArchive={tournament.status === 'complete'}
        />
      )}
      {blockedTransition && (
        <DocumentTransitionDialog
          check={blockedTransition.check}
          onCancel={() => setBlockedTransition(null)}
          onRetry={() => void retryBlockedTransition()}
          onExport={() => void downloadArchive(state, announce)}
        />
      )}
    </>
  );
}

export function ArchivedTournamentReadOnlyNotice({
  tournamentName,
  onReopen,
}: {
  tournamentName: string;
  onReopen: () => void;
}) {
  return (
    <Callout
      tone="info"
      title="Archived tournament — read-only"
      role="status"
      actions={
        <Button variant="secondary" icon="refresh" onClick={onReopen}>
          Reopen as draft
        </Button>
      }
    >
      {tournamentName} is open for historical inspection. Reopen it as a draft before making changes.
    </Callout>
  );
}

export function DocumentTransitionLoading({ transition }: { transition: DirectorDocumentTransition }) {
  const message =
    transition.kind === 'switching'
      ? 'Opening tournament…'
      : transition.kind === 'creating-tournament'
        ? 'Creating tournament…'
        : transition.kind === 'restoring-checkpoint'
          ? 'Restoring recovery point…'
          : 'Applying recovery edit…';
  return (
    <div className="director-loading" role="status">
      {message}
    </div>
  );
}

function DocumentTransitionDialog({
  check,
  onCancel,
  onRetry,
  onExport,
}: {
  check: Extract<DocumentTransitionCheck, { ok: false }>;
  onCancel: () => void;
  onRetry: () => void;
  onExport: () => void;
}) {
  return (
    <Dialog
      title="Unsaved tournament changes"
      description="This tournament cannot be replaced yet because its latest changes exist only in memory."
      size="sm"
      onClose={onCancel}
      footer={
        <div className="director-dialog-footer">
          <Button variant="secondary" onClick={onCancel} data-autofocus>
            Cancel
          </Button>
          <Button variant="secondary" onClick={onRetry}>
            Retry save
          </Button>
          <Button variant="secondary" icon="download" onClick={onExport}>
            Export recovery archive
          </Button>
        </div>
      }
    >
      <p>
        Revision {check.revision} is not durable yet (last durable revision: {check.durableRevision}). Leaving
        now would lose the in-memory changes.
      </p>
      {check.error && <p className="director-panel-footnote">Save error: {check.error}</p>}
      <p className="director-panel-footnote">
        Retry the save, export a recovery archive, or cancel and keep working in this tournament.
      </p>
    </Dialog>
  );
}

/**
 * The top-bar operational strip.
 *
 * This is what replaced the permanent QBTCP panel in the sidebar and the
 * `Tournament name › Section` label that pretended to be a breadcrumb. It says
 * what is happening *now*, and optional subsystems appear only when they are in
 * use or need attention — which is the product principle applied to chrome.
 */
export function nowChips(
  state: ReturnType<typeof useDirectorController>['state'],
  health: QbtcpOperationalHealth | null,
  native: boolean,
  navigate: (section: SectionId) => void,
): NowChip[] {
  const chips: NowChip[] = [];
  const round = currentOperationalRound(state) ?? latestRound(state.rounds);
  if (round) {
    const inProgress = round.status === 'released' || round.status === 'prepared';
    chips.push({
      label: round.name,
      detail: inProgress ? 'in progress' : humanRoundStatus(round.status),
      tone: inProgress ? 'info' : 'neutral',
      ariaLabel: `${round.name}, ${inProgress ? 'in progress' : humanRoundStatus(round.status)}. Go to Tournament day`,
      onSelect: () => navigate('schedule'),
    });
  }
  // QBTCP earns a chip for every operational state other than an intentionally stopped server. A
  // tournament that never turns it on never sees it, and browser mode never fabricates native state.
  if (native && health && health.kind !== 'checking' && health.kind !== 'off') {
    if (health.kind === 'error') {
      chips.push({
        label: health.source === 'snapshot' ? 'QBTCP sync error' : 'QBTCP error',
        detail: qbtcpHealthSummary(health),
        tone: 'danger',
        ariaLabel: `QBTCP ${health.source === 'snapshot' ? 'snapshot ingestion' : 'server'} error. Go to Rooms`,
        onSelect: () => navigate('rooms'),
      });
    } else if (health.kind === 'stale' || health.kind === 'unverified') {
      chips.push({
        label: health.kind === 'stale' ? 'QBTCP sync delayed' : 'QBTCP sync pending',
        detail: qbtcpHealthSummary(health),
        tone: 'warning',
        ariaLabel: `QBTCP ${health.kind === 'stale' ? 'snapshot sync is delayed' : 'snapshot ingestion is not verified'}. Go to Rooms`,
        onSelect: () => navigate('rooms'),
      });
    } else if (health.kind === 'healthy') {
      chips.push({
        label:
          health.pairedRooms > 0
            ? `${health.pairedRooms} room${health.pairedRooms === 1 ? '' : 's'} paired`
            : 'QBTCP on',
        tone: 'success',
        ariaLabel: `QBTCP running and snapshot sync is healthy, ${health.pairedRooms} rooms paired. Go to Rooms`,
        onSelect: () => navigate('rooms'),
      });
    }
  }
  return chips;
}

function humanRoundStatus(status: string): string {
  return status === 'planned'
    ? 'not started'
    : status === 'closed'
      ? 'finished'
      : status === 'prepared'
        ? 'ready to start'
        : status;
}

/* ------------------------------------------------------------ New tournament */

type NewTournamentDialogProps =
  | {
      onClose: () => void;
      onCreate: (input: NewTournamentInput) => boolean;
      controller?: never;
      onCreated?: never;
    }
  | {
      onClose: () => void;
      controller: ReturnType<typeof useDirectorController>;
      onCreated: (name: string) => void;
      onCreate?: never;
    };

export function NewTournamentDialog(props: NewTournamentDialogProps) {
  const { onClose } = props;
  const form = useFormState<TournamentFormValues>({
    initial: emptyTournamentForm(localCalendarDate(), localTimeZone()),
    validate: validateTournamentForm,
    onSubmit: (draft) => {
      const input = {
        name: draft.name.trim(),
        date: draft.date,
        venue: draft.venue,
        organizer: draft.organizer,
      };
      if (props.onCreate) return props.onCreate(input);
      const created = props.controller.createTournament(input);
      if (!created) return false;
      props.onCreated(draft.name.trim());
      return true;
    },
  });

  return (
    <Dialog
      title="New tournament"
      description="You can add the format, rooms, and packets afterwards."
      size="sm"
      onClose={onClose}
      onSubmit={() => form.submit()}
      submitLabel="Create tournament"
      submitDisabled={!form.draft.name.trim()}
      errors={form.formErrors}
    >
      <TournamentFields mode="create" values={form.draft} onChange={form.set} errorFor={form.errorFor} />
    </Dialog>
  );
}

/* ------------------------------------------------------- Manage tournaments */

/**
 * Reopening and archiving, given a surface of their own.
 *
 * The switcher used to be a switcher, an archive manager, a tournament-details
 * menu, a New Tournament command, an Open command, and a reopen tool, with a
 * "Reopen" button embedded inside archived menu rows. Switching is now the
 * switcher's job; this is where the tournaments themselves are managed.
 */
function ManageTournamentsDialog({
  tournaments,
  currentId,
  onClose,
  onSwitch,
  onReopen,
  onArchive,
  canArchive,
}: {
  tournaments: TournamentSummary[];
  currentId: string;
  onClose: () => void;
  onSwitch: (entry: TournamentSummary) => void;
  onReopen: (entry: TournamentSummary) => void;
  onArchive: () => void;
  canArchive: boolean;
}) {
  const confirm = useConfirm();
  const active = tournaments.filter((entry) => entry.status !== 'archived');
  const archived = tournaments.filter((entry) => entry.status === 'archived');

  return (
    <Dialog
      title="Manage tournaments"
      description="Every tournament document stored on this computer."
      size="lg"
      onClose={onClose}
      cancelLabel="Done"
    >
      <section className="director-section">
        <div className="director-section-header">
          <div>
            <h3>Open</h3>
          </div>
        </div>
        <SummaryList ariaLabel="Tournaments">
          {active.map((entry) => (
            <SummaryItem
              key={entry.id}
              title={entry.name}
              status={
                entry.id === currentId ? (
                  <Badge tone="info" label="Open now" />
                ) : (
                  <Badge state={entry.status} label={statusLabel(entry.status)} />
                )
              }
              summary={entry.date || 'No date set'}
              actions={
                entry.id === currentId ? (
                  <Button
                    variant="quiet"
                    disabled={!canArchive}
                    title={canArchive ? undefined : 'Mark the tournament complete first.'}
                    onClick={() => {
                      void confirm({
                        title: `Archive ${entry.name}?`,
                        body: 'It leaves the recent list and stops appearing in the switcher.',
                        consequence: 'Nothing is deleted. You can reopen it from here at any time.',
                        confirmLabel: 'Archive tournament',
                        tone: 'warning',
                      }).then((confirmed) => {
                        if (confirmed) onArchive();
                      });
                    }}
                  >
                    Archive
                  </Button>
                ) : (
                  <Button variant="secondary" onClick={() => onSwitch(entry)}>
                    Open
                  </Button>
                )
              }
            />
          ))}
        </SummaryList>
      </section>
      {archived.length > 0 && (
        <section className="director-section director-section-divided">
          <div className="director-section-header">
            <div>
              <h3>Archived</h3>
              <p className="director-section-description">
                Kept on this computer. Reopening restores a tournament as a draft.
              </p>
            </div>
          </div>
          <SummaryList ariaLabel="Archived tournaments">
            {archived.map((entry) => (
              <SummaryItem
                key={entry.id}
                title={entry.name}
                status={<Badge state="archived" label="Archived" />}
                summary={entry.date || 'No date set'}
                actions={
                  <>
                    <Button variant="secondary" onClick={() => onSwitch(entry)}>
                      Open
                    </Button>
                    <ActionMenu label={`${entry.name} actions`}>
                      {(close) => (
                        <MenuItem
                          icon="refresh"
                          onSelect={() => {
                            close();
                            onReopen(entry);
                          }}
                        >
                          Reopen as draft
                        </MenuItem>
                      )}
                    </ActionMenu>
                  </>
                }
              />
            ))}
          </SummaryList>
        </section>
      )}
    </Dialog>
  );
}

/* ---------------------------------------------------------- Startup screen */

/**
 * The no-tournament experience.
 *
 * It stays focused — one panel, one decision — but it is recognisably the same
 * product as the rest of Director: the same fields, the same validation, the
 * same buttons. The two competing file affordances are gone: there was an
 * `Open archive` label styled as a secondary button *and*, in the desktop
 * build, a quiet `Choose file…` button that did the same job through the native
 * dialog. There is now one Create flow and one Open flow.
 */
function StartScreen({
  controller,
  onAnnounce,
  announcement,
  onImport,
}: {
  controller: ReturnType<typeof useDirectorController>;
  onAnnounce: (announcement: AnnounceInput) => void;
  announcement: DirectorNotice | null;
  onImport: (file: PickedFile) => void;
}) {
  const form = useFormState<TournamentFormValues>({
    initial: emptyTournamentForm(localCalendarDate(), localTimeZone()),
    validate: validateTournamentForm,
    onSubmit: (draft) => {
      controller.createTournament({
        name: draft.name.trim(),
        date: draft.date,
        venue: draft.venue,
        organizer: draft.organizer,
      });
    },
  });

  return (
    <div className="director-app-start">
      <main className="director-start-main">
        <div className="director-brand director-start-brand">
          <BrandLogo className="director-wordmark" />
          <span>Director</span>
        </div>
        <div className="director-start-heading">
          <h1>Create a tournament</h1>
          <p>Director keeps it on this computer as you work. Nothing is uploaded.</p>
        </div>
        {controller.error && (
          <Callout tone="danger" role="alert">
            {controller.error}
          </Callout>
        )}
        <form
          className="director-start-panel"
          onSubmit={(event) => {
            event.preventDefault();
            form.submit();
          }}
        >
          <div className="director-panel-body">
            <TournamentFields
              mode="create"
              values={form.draft}
              onChange={form.set}
              errorFor={form.errorFor}
            />
          </div>
          <div className="director-panel-footer">
            <FormActions>
              <Button variant="primary" icon="plus" type="submit" size="lg">
                Create tournament
              </Button>
            </FormActions>
          </div>
        </form>
        <div className="director-start-open">
          <span>Already have a tournament file?</span>
          <FilePicker
            accept=".qbst,.qbj,.yft,.json"
            icon="file"
            variant="secondary"
            preferNative
            onError={(message) => onAnnounce(errorNotice(message))}
            onPick={(files) => {
              const file = files[0];
              if (file) onImport(file);
            }}
          >
            Open tournament file…
          </FilePicker>
        </div>
        {announcement && (
          <DirectorToast announcement={announcement} className="director-toast director-toast-start" />
        )}
      </main>
    </div>
  );
}

/* ------------------------------------------------------------ Global search */

type SearchResult = SearchResultView;

/**
 * Everything global search can reach: pages, settings, and the tournament's own entities.
 *
 * # Why this is an index rather than a query
 *
 * It used to take the query and return substring matches, which meant the query
 * decided what existed. Ranking is `cmdk`'s now — it scores the whole index per
 * keystroke, best match first — so this builds the candidates once per state
 * change and never sees the query at all. A typo, a middle-of-the-word match, or
 * "tz" for the timezone setting all work as a result, none of which a substring
 * scan could do.
 *
 * `keywords` carries what an entry is findable by but does not show: a game's
 * raw id, a team's organization, a round's status. Those were part of the old
 * substring corpus, and dropping them would have quietly narrowed search while
 * the visible result list looked the same.
 *
 * Results carry the destination *and* its `Plan / Run / Review` group, so the
 * list reads in the same terms as the sidebar. The deep-link targets are
 * unchanged: every entity result still resolves to a specific team, player,
 * room, packet, round, game, or submission.
 */
function buildSearchIndex(state: ReturnType<typeof useDirectorController>['state']): SearchResult[] {
  const results: SearchResult[] = [];
  const push = (result: Omit<SearchResult, 'group'>) =>
    results.push({ kind: 'entity', ...result, group: groupForSection(result.section) });

  for (const page of pageSearchTargets) {
    push({
      id: `page:${page.section}`,
      kind: 'page',
      section: page.section,
      label: page.label,
      detail: page.detail,
      keywords: page.keywords,
    });
  }
  for (const setting of settingsSearchTargets) {
    push({
      id: `setting:${setting.id}`,
      kind: 'setting',
      section: 'settings',
      label: setting.label,
      detail: setting.detail,
      keywords: setting.keywords,
      entityType: 'setting',
      settingsEntityId: setting.entityId,
      settingsPanelId: setting.panelId,
      settingsFieldLabel: setting.fieldLabel,
    });
  }

  for (const team of state.teams) {
    const organization = team.organizationId
      ? state.organizations.find((entry) => entry.id === team.organizationId)?.name
      : undefined;
    push({
      id: team.id,
      section: 'teams',
      label: team.displayName,
      detail: [organization, team.teamLetter && `Team ${team.teamLetter}`, team.status]
        .filter(Boolean)
        .join(' · '),
      keywords: terms([team.teamLetter, team.status, organization, 'team']),
      entityType: 'team',
    });
  }
  for (const player of state.players) {
    const team = state.teams.find((entry) => entry.id === player.teamId);
    push({
      id: player.id,
      section: 'teams',
      label: player.name,
      detail: team?.displayName ?? 'Roster player',
      keywords: terms([team?.displayName, player.rosterNumber, 'player', 'roster']),
      entityType: 'player',
      parentId: player.teamId,
    });
  }
  for (const room of state.rooms) {
    push({
      id: room.id,
      section: 'rooms',
      label: room.name,
      detail: [room.building, room.status].filter(Boolean).join(' · '),
      keywords: terms([room.building, room.floor, room.status, 'room']),
      entityType: 'room',
    });
  }
  for (const packet of state.packets) {
    push({
      id: packet.id,
      section: 'packets',
      label: packet.name,
      detail: `${packet.source} packet`,
      keywords: terms([packet.source, 'packet']),
      entityType: 'packet',
    });
  }
  for (const round of state.rounds) {
    push({
      id: round.id,
      section: 'schedule',
      label: round.name,
      detail: `Round ${round.number} · ${humanRoundStatus(round.status)}`,
      keywords: terms([round.number, round.status, humanRoundStatus(round.status), 'round']),
      entityType: 'round',
    });
  }
  for (const game of state.scheduledGames) {
    const left = state.teams.find((team) => team.id === game.leftTeamId)?.displayName;
    const right = game.rightTeamId
      ? state.teams.find((team) => team.id === game.rightTeamId)?.displayName
      : 'Bye';
    const round = state.rounds.find((entry) => entry.id === game.roundId);
    push({
      id: game.id,
      section: 'results',
      label: `${left ?? 'Unknown'} · ${right ?? 'Unknown'}`,
      detail: `${round?.name ?? 'Scheduled game'} · ${game.status}`,
      // The raw id is how a diagnostic link into a specific game is followed;
      // the row itself stopped printing it, so only search carries it.
      keywords: terms([game.id, round?.name, game.status, 'game']),
      entityType: 'game',
    });
  }
  for (const submission of state.submissions) {
    const game = state.games.find((entry) => entry.id === submission.gameId);
    push({
      id: submission.id,
      section: 'results',
      label: `Result ${submission.transportResultId ?? submission.id}`,
      detail: submission.status,
      keywords: terms([submission.id, submission.transportResultId, game?.scheduledGameId, 'result']),
      entityType: 'submission',
    });
  }
  return results;
}

/** Search terms, minus the blanks and the duplicates of the visible text. */
function terms(values: unknown[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) seen.add(text);
  }
  return [...seen];
}

export { labelForSection };
