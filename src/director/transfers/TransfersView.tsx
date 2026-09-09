/** Transfers moves files. Results decides what a result means. */
import { useCallback, useMemo, useState } from 'react';
import type { DirectorState } from '../domain';
import type { DirectorController } from '../state/useDirectorController';
import {
  ActionMenu,
  AdvancedSection,
  Button,
  Callout,
  Diagnostics,
  EmptyState,
  Field,
  FilePicker,
  MenuItem,
  Page,
  PageHeader,
  Panel,
  Segmented,
  Select,
  StateLabel,
  SummaryItem,
  SummaryList,
  Switch,
  useConfirm,
  type PickedFile,
} from '../components';
import type { SectionId } from '../app/navigation';
import { currentOperationalRound, type AssignmentSelection } from './assignment';
import { describeWarning } from './ingest';
import { transportLabel, type IncomingArtifact, type TransferLocation } from './model';
import { planAssignments } from './prepare';
import { prepareOperation, scanOperation, type TransfersRuntime } from './useTransfers';
import type { AnnounceInput } from '../notices';

type TransferView = 'incoming' | 'outgoing' | 'locations' | 'recent';
type SelectionKind = 'current-round' | 'released' | 'unconnected-rooms';

export function TransfersView({
  transfers,
  state,
  controller,
  onNavigate,
}: {
  transfers: TransfersRuntime;
  state: DirectorState;
  controller: DirectorController;
  onNavigate: (section: SectionId) => void;
  onAnnounce: (announcement: AnnounceInput) => void;
}) {
  const pending = state.transfers.artifacts.filter(
    (artifact) => artifact.status === 'staged' || artifact.status === 'failed',
  );
  const [view, setView] = useState<TransferView>(pending.length > 0 ? 'incoming' : 'outgoing');
  const [dropActive, setDropActive] = useState(false);
  const [selectionKind, setSelectionKind] = useState<SelectionKind>('current-round');

  const selection = useMemo<AssignmentSelection>(
    () =>
      selectionKind === 'released'
        ? { kind: 'released' }
        : selectionKind === 'unconnected-rooms'
          ? { kind: 'unconnected-rooms' }
          : { kind: 'current-round' },
    [selectionKind],
  );
  const plan = useMemo(() => planAssignments(state, selection), [selection, state]);
  const currentRound = currentOperationalRound(state);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setDropActive(false);
      void transfers.importDataTransfer(event.dataTransfer);
    },
    [transfers],
  );

  const importPickedFiles = (picked: PickedFile[]) => {
    const files = picked.map((item) => {
      const bytes = new ArrayBuffer(item.bytes.byteLength);
      new Uint8Array(bytes).set(item.bytes);
      return new File([bytes], item.fileName, { type: 'application/vnd.quizbowl.qbj+json' });
    });
    void transfers.importFiles(files);
    setView('incoming');
  };

  return (
    <Page>
      <PageHeader
        title="Transfers"
        description="Move completed games in and assignment files out over USB, folders, downloads, and QBTCP."
        actions={
          <FilePicker
            accept=".qbj,.json"
            multiple
            onPick={importPickedFiles}
            variant="secondary"
            icon="upload"
          >
            Import files
          </FilePicker>
        }
      />

      {transfers.notice && (
        <Callout
          tone="info"
          title={`${transfers.notice.label} connected`}
          actions={
            <>
              {transfers.notice.resultCount > 0 && (
                <Button variant="primary" onClick={() => onNavigate('results')}>
                  Review results
                </Button>
              )}
              <Button variant="quiet" onClick={transfers.dismissNotice}>
                Dismiss
              </Button>
            </>
          }
        >
          {transfers.notice.resultCount} completed QBSheet game{transfers.notice.resultCount === 1 ? '' : 's'}{' '}
          found
          {transfers.notice.assignmentCount > 0
            ? ` · ${transfers.notice.assignmentCount} assignment file${transfers.notice.assignmentCount === 1 ? '' : 's'}`
            : ''}
          .
        </Callout>
      )}
      {!transfers.native && transfers.limitation && <Callout tone="info">{transfers.limitation}</Callout>}

      <Segmented<TransferView>
        value={view}
        onChange={setView}
        ariaLabel="Transfer workflow"
        options={[
          { value: 'incoming', label: pending.length ? `Incoming ${pending.length}` : 'Incoming' },
          { value: 'outgoing', label: currentRound ? `Outgoing · ${currentRound.name}` : 'Outgoing' },
          { value: 'locations', label: `Locations ${state.transfers.locations.length}` },
          { value: 'recent', label: 'History' },
        ]}
      />

      {view === 'incoming' && (
        <IncomingView
          state={state}
          controller={controller}
          pending={pending}
          dropActive={dropActive}
          setDropActive={setDropActive}
          onDrop={onDrop}
          onPick={importPickedFiles}
          onReview={() => onNavigate('results')}
        />
      )}
      {view === 'outgoing' && (
        <OutgoingView
          transfers={transfers}
          state={state}
          currentRound={currentRound}
          selectionKind={selectionKind}
          setSelectionKind={setSelectionKind}
          selection={selection}
          plan={plan}
        />
      )}
      {view === 'locations' && <LocationsView transfers={transfers} state={state} selection={selection} />}
      {view === 'recent' && <HistoryView state={state} />}

      {transfers.status !== '' && (
        <p className="director-text-meta" role="status">
          Last transfer action: {transfers.status}
        </p>
      )}
    </Page>
  );
}

function IncomingView({
  state,
  controller,
  pending,
  dropActive,
  setDropActive,
  onDrop,
  onPick,
  onReview,
}: {
  state: DirectorState;
  controller: DirectorController;
  pending: IncomingArtifact[];
  dropActive: boolean;
  setDropActive: (active: boolean) => void;
  onDrop: (event: React.DragEvent) => void;
  onPick: (files: PickedFile[]) => void;
  onReview: () => void;
}) {
  return (
    <Panel
      title={
        pending.length === 0
          ? 'Incoming results'
          : `${pending.length} file${pending.length === 1 ? '' : 's'} need attention`
      }
      description="Import and discovery happen here; accepting, rejecting, correcting, and reconciling results happen only in Results."
      actions={
        pending.some((artifact) => artifact.status === 'staged') ? (
          <Button variant="primary" onClick={onReview}>
            Review results
          </Button>
        ) : undefined
      }
      flush
    >
      <div
        className={`director-dropzone ${dropActive ? 'is-active' : ''}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDropActive(true);
        }}
        onDragLeave={() => setDropActive(false)}
        onDrop={onDrop}
      >
        <p>Drop completed QBJ files here, or choose files from this computer.</p>
        <FilePicker accept=".qbj,.json" multiple onPick={onPick} variant="secondary" icon="file">
          Choose files
        </FilePicker>
      </div>
      {state.transfers.artifacts.length === 0 ? (
        <div className="director-empty-in-panel">
          <p className="director-empty-copy">No imported or discovered files yet.</p>
        </div>
      ) : (
        <SummaryList ariaLabel="Incoming transfer artifacts">
          {state.transfers.artifacts.slice(0, 40).map((artifact) => (
            <ArtifactItem
              key={artifact.id}
              state={state}
              artifact={artifact}
              onDismiss={() => controller.dismissTransferArtifact(artifact.id)}
              onReview={onReview}
            />
          ))}
        </SummaryList>
      )}
    </Panel>
  );
}

function ArtifactItem({
  state,
  artifact,
  onDismiss,
  onReview,
}: {
  state: DirectorState;
  artifact: IncomingArtifact;
  onDismiss: () => void;
  onReview: () => void;
}) {
  const scheduled = artifact.scheduledGameId
    ? state.scheduledGames.find((game) => game.id === artifact.scheduledGameId)
    : undefined;
  const round = scheduled ? state.rounds.find((entry) => entry.id === scheduled.roundId) : undefined;
  const room = scheduled?.roomId ? state.rooms.find((entry) => entry.id === scheduled.roomId) : undefined;
  const matchup = scheduled
    ? `${teamName(state, scheduled.leftTeamId)} vs ${teamName(state, scheduled.rightTeamId)}`
    : 'Not matched to a scheduled game';
  return (
    <SummaryItem
      title={<strong>{artifact.fileName}</strong>}
      status={<StateLabel state={classificationState(artifact)} label={classificationLabel(artifact)} />}
      summary={`${matchup}${scheduled ? ` · ${[room?.name, round?.name].filter(Boolean).join(' · ')}` : ''} · ${artifact.sourceLabel}`}
      actions={
        <div className="director-actions">
          {artifact.status === 'staged' && (
            <Button variant="primary" onClick={onReview}>
              Review
            </Button>
          )}
          {artifact.status !== 'ignored' && (
            <Button variant="quiet" onClick={onDismiss}>
              Dismiss
            </Button>
          )}
        </div>
      }
    >
      {(artifact.detail || artifact.warnings.length > 0) && (
        <Diagnostics label="File details" standalone={false}>
          {artifact.detail && <p>{artifact.detail}</p>}
          {artifact.warnings.length > 0 && <p>{artifact.warnings.map(describeWarning).join(' ')}</p>}
        </Diagnostics>
      )}
    </SummaryItem>
  );
}

function OutgoingView({
  transfers,
  state,
  currentRound,
  selectionKind,
  setSelectionKind,
  selection,
  plan,
}: {
  transfers: TransfersRuntime;
  state: DirectorState;
  currentRound: ReturnType<typeof currentOperationalRound>;
  selectionKind: SelectionKind;
  setSelectionKind: (kind: SelectionKind) => void;
  selection: AssignmentSelection;
  plan: ReturnType<typeof planAssignments>;
}) {
  const writable = state.transfers.locations.filter((location) => location.connected && !location.readOnly);
  const connectedRoomIds = new Set(
    state.qbtcpSessions.filter((session) => session.state !== 'abandoned').map((session) => session.roomId),
  );
  const roundGames = currentRound
    ? state.scheduledGames.filter(
        (game) => game.roundId === currentRound.id && !game.bye && game.status !== 'cancelled',
      )
    : [];
  const connectedCount = roundGames.filter((game) => game.roomId && connectedRoomIds.has(game.roomId)).length;

  if (!currentRound) {
    return (
      <EmptyState
        title="No current round"
        description="Generate a round from Tournament day before preparing assignment files."
      />
    );
  }
  return (
    <Panel
      title={`${currentRound.name} assignment files`}
      description={`${plan.assignments.length} file${plan.assignments.length === 1 ? '' : 's'} ready to prepare.`}
      actions={
        <Button variant="secondary" icon="download" onClick={() => transfers.downloadAssignments(selection)}>
          Download files
        </Button>
      }
    >
      {plan.failures.length > 0 && (
        <Callout
          tone="danger"
          title={`${plan.failures.length} game${plan.failures.length === 1 ? '' : 's'} cannot be prepared`}
        >
          {plan.failures[0]?.reason}
        </Callout>
      )}
      {plan.skipped.length > 0 && (
        <Callout
          tone="info"
          title={`${plan.skipped.length} selected game${plan.skipped.length === 1 ? '' : 's'} intentionally skipped`}
        >
          {plan.skipped.map((entry) => (
            <p key={entry.scheduledGameId}>
              {entry.scheduledGameId}: {entry.reason}
            </p>
          ))}
        </Callout>
      )}
      {plan.warnings.map((warning) => (
        <Callout key={warning} tone="warning">
          {warning}
        </Callout>
      ))}
      {writable.length === 0 ? (
        <Callout tone="info">
          No connected writable transfer location is available. Download the assignment files or add a
          location.
        </Callout>
      ) : (
        <SummaryList ariaLabel="Writable transfer destinations">
          {writable.map((location) => (
            <SummaryItem
              key={location.id}
              title={<strong>{location.label}</strong>}
              summary={`${location.kind === 'removable-drive' ? 'USB drive' : 'Folder'}${location.cloudProvider ? ` · ${location.cloudProvider}` : ''}`}
              actions={
                <Button
                  variant="primary"
                  icon="upload"
                  disabled={
                    transfers.isOperationActive(prepareOperation(location.id)) ||
                    plan.assignments.length === 0
                  }
                  onClick={() => void transfers.prepareTo(location.id, selection)}
                >
                  {transfers.isOperationActive(prepareOperation(location.id))
                    ? 'Preparing…'
                    : location.kind === 'removable-drive'
                      ? 'Prepare USB'
                      : 'Prepare files'}
                </Button>
              }
            />
          ))}
        </SummaryList>
      )}
      <AdvancedSection
        label="Assignment scope"
        hint={
          selectionKind === 'current-round'
            ? 'Current round is the normal tournament-day scope.'
            : 'An advanced scope is selected.'
        }
        icon="filter"
      >
        <Field
          label="Games to prepare"
          render={({ id, describedBy }) => (
            <Select<SelectionKind>
              id={id}
              ariaDescribedBy={describedBy}
              value={selectionKind}
              options={[
                { value: 'current-round', label: `Current round · ${currentRound.name}` },
                { value: 'released', label: 'All released games' },
                { value: 'unconnected-rooms', label: 'Rooms without QBTCP' },
              ]}
              onChange={setSelectionKind}
            />
          )}
        />
        {connectedCount > 0 && (
          <Diagnostics
            label="QBTCP delivery context"
            standalone={false}
            items={[
              { term: 'Connected current-round rooms', value: connectedCount },
              {
                term: 'Current-round rooms without QBTCP',
                value: Math.max(0, roundGames.length - connectedCount),
              },
            ]}
          >
            <p>
              Preparing a file for a connected room is a backup, not a conflict; the scorekeeper uses
              whichever copy it needs.
            </p>
          </Diagnostics>
        )}
      </AdvancedSection>
    </Panel>
  );
}

function LocationsView({
  transfers,
  state,
  selection,
}: {
  transfers: TransfersRuntime;
  state: DirectorState;
  selection: AssignmentSelection;
}) {
  return (
    <Panel
      title="Transfer locations"
      description="USB drives, shared folders, network shares, and cloud-synced folders are destinations and discovery sources."
      actions={
        <Button
          variant="secondary"
          icon="plus"
          disabled={!transfers.native}
          onClick={() => void transfers.addFolder()}
        >
          Add folder
        </Button>
      }
      flush
    >
      {state.transfers.locations.length === 0 ? (
        <div className="director-empty-in-panel">
          <p className="director-empty-copy">
            {transfers.native
              ? 'Insert a USB drive or add a folder when you need a reusable transfer location.'
              : 'Add folders from the desktop app. Browser preview can still import and download QBJ files.'}
          </p>
        </div>
      ) : (
        <SummaryList ariaLabel="Transfer locations">
          {state.transfers.locations.map((location) => (
            <LocationItem
              key={location.id}
              location={location}
              advice={transfers.cloudAdviceFor(location)}
              scanBusy={transfers.isOperationActive(scanOperation(location.id))}
              onScan={() => void transfers.scanLocation(location.id)}
              onInitialize={() => void transfers.initializeLocation(location.id)}
              onWatch={(watching) => transfers.setWatching(location.id, watching)}
              onRemove={() => transfers.removeLocation(location.id)}
              onPrepare={() => void transfers.prepareTo(location.id, selection)}
            />
          ))}
        </SummaryList>
      )}
    </Panel>
  );
}

function LocationItem({
  location,
  advice,
  scanBusy,
  onScan,
  onInitialize,
  onWatch,
  onRemove,
  onPrepare,
}: {
  location: TransferLocation;
  advice?: string;
  scanBusy: boolean;
  onScan: () => void;
  onInitialize: () => void;
  onWatch: (watching: boolean) => void;
  onRemove: () => void;
  onPrepare: () => void;
}) {
  const confirmAction = useConfirm();
  const stateName = !location.connected
    ? 'offline'
    : location.readOnly
      ? 'warning'
      : location.watching
        ? 'live'
        : 'connected';
  const stateText = !location.connected
    ? 'Not connected'
    : location.readOnly
      ? 'Read-only'
      : location.watching
        ? 'Watching'
        : 'Connected';
  return (
    <SummaryItem
      title={<strong>{location.label}</strong>}
      status={<StateLabel state={stateName} label={stateText} />}
      summary={`${location.kind === 'removable-drive' ? 'USB drive' : 'Folder'}${location.cloudProvider ? ` · ${location.cloudProvider}` : ''}${advice ? ` · ${advice}` : ''}`}
      actions={
        <div className="director-actions">
          {location.connected && (
            <Button variant="secondary" disabled={scanBusy} onClick={onScan}>
              {scanBusy ? 'Scanning…' : 'Scan'}
            </Button>
          )}
          <ActionMenu label={`${location.label} actions`} triggerLabel={`${location.label} actions`}>
            {(close) => (
              <>
                {location.connected && !location.readOnly && (
                  <MenuItem
                    icon="upload"
                    onSelect={() => {
                      close();
                      onPrepare();
                    }}
                  >
                    Prepare current assignment scope
                  </MenuItem>
                )}
                {location.connected && !location.readOnly && (
                  <MenuItem
                    icon="settings"
                    onSelect={() => {
                      close();
                      onInitialize();
                    }}
                  >
                    Set up QBSheet folder
                  </MenuItem>
                )}
                <MenuItem
                  icon="trash"
                  tone="danger"
                  onSelect={() => {
                    close();
                    void (async () => {
                      const approved = await confirmAction({
                        title: `Remove ${location.label} from Director?`,
                        consequence:
                          'The folder or drive itself is not deleted. Director only forgets this transfer-location record.',
                        confirmLabel: 'Remove location',
                        tone: 'danger',
                      });
                      if (approved) onRemove();
                    })();
                  }}
                >
                  Remove location…
                </MenuItem>
              </>
            )}
          </ActionMenu>
        </div>
      }
    >
      {location.connected && (
        <Switch
          checked={location.watching}
          label="Watch for completed games"
          hint="Takes effect immediately."
          onChange={onWatch}
        />
      )}
      <Diagnostics
        label="Location details"
        standalone={false}
        items={[
          { term: 'Path', value: location.path, mono: true },
          { term: 'Transport', value: transportLabel(location.kind) },
          ...(location.message ? [{ term: 'Last message', value: location.message }] : []),
        ]}
      />
    </SummaryItem>
  );
}

function HistoryView({ state }: { state: DirectorState }) {
  if (state.transfers.events.length === 0) {
    return (
      <EmptyState
        title="No transfer history"
        description="Scans, imports, prepared assignments, and other transfer actions will appear here."
      />
    );
  }
  return (
    <Panel title="Transfer history" description="Most recent actions first." flush>
      <SummaryList ariaLabel="Transfer history">
        {state.transfers.events.slice(0, 50).map((event) => (
          <SummaryItem
            key={event.id}
            title={<strong>{event.summary}</strong>}
            summary={[event.detail, formatTime(event.at)].filter(Boolean).join(' · ')}
          />
        ))}
      </SummaryList>
    </Panel>
  );
}

function classificationState(artifact: IncomingArtifact): string {
  switch (artifact.classification) {
    case 'ready':
      return 'ready';
    case 'duplicate':
      return 'info';
    case 'needs-review':
      return 'review';
    case 'assignment':
      return 'pending';
    case 'invalid':
      return 'error';
    default:
      return 'neutral';
  }
}

function classificationLabel(artifact: IncomingArtifact): string {
  switch (artifact.classification) {
    case 'ready':
      return 'Ready';
    case 'duplicate':
      return 'Duplicate';
    case 'needs-review':
      return 'Needs review';
    case 'assignment':
      return 'Assignment';
    case 'invalid':
      return 'Invalid';
    default:
      return 'Not a result';
  }
}

function teamName(state: DirectorState, teamId: string | null): string {
  return teamId ? (state.teams.find((team) => team.id === teamId)?.displayName ?? 'Unknown team') : 'Bye';
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export { transportLabel };
