/** Delivery answers whether the current round is ready; Results decides what a return means. */
import { useCallback, useMemo, useState } from 'react';
import type { DirectorId, DirectorState } from '../domain';
import type { DirectorController } from '../state/useDirectorController';
import {
  ActionMenu,
  AdvancedSection,
  Button,
  Callout,
  Checkbox,
  CheckboxGroup,
  DataTable,
  Dialog,
  DialogSection,
  Diagnostics,
  EmptyState,
  Field,
  IdentityCell,
  Link,
  MenuItem,
  MenuSectionLabel,
  MenuSeparator,
  Page,
  PageHeader,
  Panel,
  RowDetail,
  Segmented,
  Select,
  Specs,
  StateLabel,
  SummaryItem,
  SummaryList,
  Switch,
  useConfirm,
  type Column,
} from '../components';
import type { SectionId } from '../app/navigation';
import type { DirectorNavigationTarget } from '../app/navigationTarget';
import { useNavigationHighlight } from '../app/useNavigationHighlight';
import type { AnnounceInput } from '../notices';
import { errorNotice, infoNotice, warningNotice } from '../notices';
import type { AssignmentSelection } from './assignment';
import {
  deriveCurrentRoundDelivery,
  describeDeliveryIntent,
  liveRoomSessions,
  matchupForGame,
  type AssignmentReadinessState,
  type GameDeliveryStatus,
  type GameResultState,
} from './deliveryStatus';
import type { TransferLocation } from './model';
import { scanOperation, type TransfersRuntime } from './useTransfers';

type PrepareMode = 'needed' | 'files' | 'backup';

interface PrepareRequest {
  mode: PrepareMode;
  initialIds: DirectorId[];
}

type DeliveryAction = {
  kind:
    | 'prepare-file'
    | 'reprepare-file'
    | 'recover-session'
    | 'review-result'
    | 'resolve-result'
    | 'assign-room';
  label: string;
} | null;

function deliveryLabel(state: AssignmentReadinessState): string {
  switch (state) {
    case 'qbtcp-connected':
      return 'QBTCP connected';
    case 'qbtcp-delivered':
      return 'Delivered by QBTCP';
    case 'file-current':
      return 'File prepared';
    case 'file-needed':
      return 'File needed';
    case 'needs-reprepare':
      return 'Needs re-preparation';
    case 'manual':
      return 'Manual delivery';
    case 'problem':
      return 'Delivery problem';
  }
}

function deliveryTone(
  state: AssignmentReadinessState,
): 'neutral' | 'info' | 'success' | 'warning' | 'danger' {
  switch (state) {
    case 'qbtcp-connected':
      return 'success';
    case 'qbtcp-delivered':
      return 'info';
    case 'file-current':
      return 'info';
    case 'file-needed':
    case 'needs-reprepare':
      return 'warning';
    case 'manual':
      return 'neutral';
    case 'problem':
      return 'danger';
  }
}

function resultLabel(state: GameResultState): string {
  switch (state) {
    case 'waiting':
      return 'Waiting';
    case 'received':
      return 'Received';
    case 'review':
      return 'Needs review';
    case 'accepted':
      return 'Accepted';
    case 'rejected':
      return 'Rejected';
    case 'conflict':
      return 'Conflict';
    case 'duplicate':
      return 'Duplicate received';
  }
}

function resultTone(state: GameResultState): 'neutral' | 'info' | 'success' | 'warning' | 'danger' {
  switch (state) {
    case 'waiting':
      return 'neutral';
    case 'received':
    case 'review':
      return 'warning';
    case 'accepted':
      return 'success';
    case 'rejected':
    case 'conflict':
      return 'danger';
    case 'duplicate':
      return 'warning';
  }
}

function openHelpForRow(state: DirectorState, row: GameDeliveryStatus) {
  return row.roomId
    ? state.qbtcpHelpRequests.find((request) => request.roomId === row.roomId && request.status === 'open')
    : undefined;
}

/** The one visible row action: the next repair that actually belongs to this row. */
function deliveryActionForRow(state: DirectorState, row: GameDeliveryStatus): DeliveryAction {
  if (!row.roomId) return { kind: 'assign-room', label: 'Assign room →' };
  if (openHelpForRow(state, row) || row.assignment.state === 'problem') {
    return { kind: 'recover-session', label: 'Fix session →' };
  }
  if (row.assignment.state === 'needs-reprepare') {
    return { kind: 'reprepare-file', label: 'Re-prepare' };
  }
  if (row.assignment.state === 'file-needed') {
    return { kind: 'prepare-file', label: 'Prepare file' };
  }
  if (row.result.state === 'conflict') {
    return { kind: 'resolve-result', label: 'Resolve result →' };
  }
  if (row.result.state === 'review' || row.result.state === 'received') {
    return { kind: 'review-result', label: 'Review result →' };
  }
  return null;
}

function deliveryDisplay(
  state: DirectorState,
  row: GameDeliveryStatus,
): {
  state: string;
  label: string;
  tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
  detail?: string;
} {
  if (!row.roomId) {
    return { state: 'unassigned', label: 'Room unassigned', tone: 'warning' };
  }
  const help = openHelpForRow(state, row);
  if (help) {
    return { state: 'recovery', label: 'Session needs recovery', tone: 'danger', detail: help.message };
  }
  if (row.assignment.state === 'problem' && row.intent.primary === 'qbtcp') {
    const waitingForScorer = row.assignment.message?.startsWith('No live QBTCP session') ?? false;
    if (waitingForScorer) {
      return { state: 'qbtcp-waiting', label: 'QBTCP waiting for scorer', tone: 'warning' };
    }
  }
  return {
    state: row.assignment.state,
    label: deliveryLabel(row.assignment.state),
    tone: deliveryTone(row.assignment.state),
    detail: row.assignment.message,
  };
}

function formatTime(value: string | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function formatBytes(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB free`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB free`;
}

export function TransfersView({
  transfers,
  state,
  controller,
  onNavigate,
  onAnnounce,
  navigationTarget,
  onClearNavigationTarget,
}: {
  transfers: TransfersRuntime;
  state: DirectorState;
  controller: DirectorController;
  onNavigate: (section: SectionId, target?: DirectorNavigationTarget | null) => void;
  onAnnounce: (announcement: AnnounceInput) => void;
  navigationTarget?: DirectorNavigationTarget | null;
  onClearNavigationTarget?: () => void;
}) {
  const delivery = useMemo(() => deriveCurrentRoundDelivery(state), [state]);
  const [prepareRequest, setPrepareRequest] = useState<PrepareRequest | null>(null);
  const [destinationsOpen, setDestinationsOpen] = useState(false);

  const openPrepare = useCallback((mode: PrepareMode, initialIds: DirectorId[]) => {
    setPrepareRequest({ mode, initialIds });
  }, []);

  const neededIds = delivery.needingFiles.map((row) => row.scheduledGameId);
  const destinationSummary = describeDestinationSummary(state.transfers.locations);

  return (
    <Page>
      <PageHeader
        title="Delivery"
        description="Room readiness, assignment files, and recovery for the current round."
        actions={
          <>
            {neededIds.length > 0 && (
              <Button variant="primary" icon="file" onClick={() => openPrepare('needed', neededIds)}>
                Prepare needed files ({neededIds.length})
              </Button>
            )}
            <Button variant="secondary" icon="settings" onClick={() => setDestinationsOpen(true)}>
              File destinations
            </Button>
            <ActionMenu label="Delivery actions" triggerLabel="Delivery actions" triggerVariant="quiet">
              {(close) => (
                <>
                  <MenuItem
                    icon="file"
                    onSelect={() => {
                      close();
                      openPrepare('files', neededIds);
                    }}
                  >
                    Prepare files…
                  </MenuItem>
                  <MenuItem
                    icon="copy"
                    onSelect={() => {
                      close();
                      openPrepare('backup', []);
                    }}
                  >
                    Prepare backups…
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem
                    icon="settings"
                    onSelect={() => {
                      close();
                      setDestinationsOpen(true);
                    }}
                  >
                    Manage file destinations
                  </MenuItem>
                </>
              )}
            </ActionMenu>
          </>
        }
      />

      <p className="director-delivery-destination-summary" role="status">
        {destinationSummary}
      </p>

      {transfers.notice && (
        <Callout
          tone="info"
          title={`${transfers.notice.label} connected`}
          actions={
            <>
              {transfers.notice.resultCount > 0 && (
                <Link onClick={() => onNavigate('results')}>Review returned results →</Link>
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
          . Review returned results in Results.
        </Callout>
      )}
      {!transfers.native && transfers.limitation && <Callout tone="info">{transfers.limitation}</Callout>}

      <CurrentRoundSection
        transfers={transfers}
        state={state}
        controller={controller}
        delivery={delivery}
        onNavigate={onNavigate}
        onAnnounce={onAnnounce}
        onOpenPrepare={openPrepare}
        navigationTarget={navigationTarget}
        onClearNavigationTarget={onClearNavigationTarget}
      />

      <AdvancedSection
        label="Transfer history and diagnostics"
        hint="Locations, transfer evidence, and troubleshooting detail."
      >
        <HistoryView state={state} />
      </AdvancedSection>

      {transfers.status !== '' && (
        <p className="director-text-meta" role="status">
          Last transfer action: {transfers.status}
        </p>
      )}

      {prepareRequest && (
        <PrepareFilesDialog
          key={`${prepareRequest.mode}:${prepareRequest.initialIds.join(',')}`}
          mode={prepareRequest.mode}
          initialIds={prepareRequest.initialIds}
          delivery={delivery}
          state={state}
          transfers={transfers}
          onAnnounce={onAnnounce}
          onClose={() => setPrepareRequest(null)}
        />
      )}
      {destinationsOpen && (
        <FileDestinationsDialog
          transfers={transfers}
          state={state}
          onClose={() => setDestinationsOpen(false)}
        />
      )}
    </Page>
  );
}

/** Where a row-level prepare action goes: direct when unambiguous, dialog when it is not. */
function usePrepareGames({
  transfers,
  state,
  onAnnounce,
  onOpenPrepare,
}: {
  transfers: TransfersRuntime;
  state: DirectorState;
  onAnnounce: (announcement: AnnounceInput) => void;
  onOpenPrepare: (mode: PrepareMode, initialIds: DirectorId[]) => void;
}) {
  return useCallback(
    async (gameIds: DirectorId[], action: string, mode: PrepareMode = 'needed') => {
      if (gameIds.length === 0) return;
      const selection: AssignmentSelection = { kind: 'games', scheduledGameIds: gameIds };
      const writable = state.transfers.locations.filter(
        (location) => location.connected && !location.readOnly,
      );
      if (writable.length === 1) {
        await transfers.prepareTo(writable[0]!.id, selection);
        return;
      }
      if (writable.length === 0) {
        if (!transfers.native) {
          transfers.downloadAssignments(selection);
          return;
        }
        onAnnounce(
          errorNotice(
            `No connected drive or folder to ${action}. Open File destinations to connect one, then try again.`,
          ),
        );
        return;
      }
      onOpenPrepare(mode, gameIds);
    },
    [onAnnounce, onOpenPrepare, state.transfers.locations, transfers],
  );
}

function CurrentRoundSection({
  transfers,
  state,
  controller,
  delivery,
  onNavigate,
  onAnnounce,
  onOpenPrepare,
  navigationTarget,
  onClearNavigationTarget,
}: {
  transfers: TransfersRuntime;
  state: DirectorState;
  controller: DirectorController;
  delivery: ReturnType<typeof deriveCurrentRoundDelivery>;
  onNavigate: (section: SectionId, target?: DirectorNavigationTarget | null) => void;
  onAnnounce: (announcement: AnnounceInput) => void;
  onOpenPrepare: (mode: PrepareMode, initialIds: DirectorId[]) => void;
  navigationTarget?: DirectorNavigationTarget | null;
  onClearNavigationTarget?: () => void;
}) {
  const prepareGames = usePrepareGames({ transfers, state, onAnnounce, onOpenPrepare });
  const [filter, setFilter] = useState<'all' | 'attention'>('all');
  const [expandedRowId, setExpandedRowId] = useState<DirectorId | null>(null);
  const targetGameId =
    navigationTarget?.section === 'transfers' && navigationTarget.entityType === 'game'
      ? navigationTarget.entityId
      : undefined;
  useNavigationHighlight(navigationTarget, 'transfers', 'game', targetGameId ?? '', onClearNavigationTarget);

  if (!delivery.round) {
    return (
      <EmptyState
        title="No active round to deliver"
        description="Start a round from Tournament day to see its room-by-room readiness here. File destinations and transfer history remain available above."
      />
    );
  }

  const attentionRows = delivery.rows.filter((row) => deliveryActionForRow(state, row));
  const readyCount = Math.max(0, delivery.rows.length - attentionRows.length);
  const visibleRows = filter === 'attention' ? attentionRows : delivery.rows;
  const summary = `${attentionRows.length} room${attentionRows.length === 1 ? '' : 's'} need attention · ${readyCount} of ${delivery.rows.length} ready`;
  const columns: Column<GameDeliveryStatus>[] = [
    {
      key: 'identity',
      header: 'Room / game',
      priority: 1,
      render: (row) => <IdentityCell title={row.roomName} detail={row.matchup} />,
    },
    {
      key: 'delivery',
      header: 'Delivery',
      priority: 2,
      render: (row) => {
        const display = deliveryDisplay(state, row);
        return (
          <span className="director-table-state-cell">
            <StateLabel state={display.state} label={display.label} tone={display.tone} />
            {display.detail && <small>{display.detail}</small>}
            {row.assignment.backupCurrent && <small>File backup ready</small>}
          </span>
        );
      },
    },
    {
      key: 'result',
      header: 'Result',
      priority: 2,
      render: (row) => (
        <span className="director-table-state-cell">
          <StateLabel
            state={row.result.state}
            label={resultLabel(row.result.state)}
            tone={resultTone(row.result.state)}
          />
          {row.result.scoreLine && <small>{row.result.scoreLine}</small>}
          {row.result.sourceLabel && <small>{row.result.sourceLabel}</small>}
        </span>
      ),
    },
    {
      key: 'route',
      header: 'Route',
      priority: 4,
      render: (row) => <span className="director-text-secondary">{describeDeliveryIntent(row.intent)}</span>,
    },
    {
      key: 'action',
      header: 'Action',
      priority: 1,
      actions: true,
      render: (row) => (
        <DeliveryRowActions
          row={row}
          state={state}
          controller={controller}
          action={deliveryActionForRow(state, row)}
          onNavigate={onNavigate}
          onAnnounce={onAnnounce}
          onPrepare={prepareGames}
          onOpenPrepare={onOpenPrepare}
          expanded={expandedRowId === row.scheduledGameId}
          onToggleDetails={() =>
            setExpandedRowId((current) => (current === row.scheduledGameId ? null : row.scheduledGameId))
          }
        />
      ),
    },
  ];

  return (
    <Panel title={delivery.round.name} description={summary} flush>
      <div className="director-delivery-toolbar">
        <Segmented<'all' | 'attention'>
          value={filter}
          onChange={setFilter}
          ariaLabel="Delivery room filter"
          options={[
            { value: 'all', label: `All rooms ${delivery.rows.length}` },
            { value: 'attention', label: `Needs attention (${attentionRows.length})` },
          ]}
        />
        <span className="director-toolbar-count">
          Showing {visibleRows.length} of {delivery.rows.length} rooms
        </span>
      </div>
      <DataTable
        items={visibleRows}
        columns={columns}
        rowKey={(row) => row.scheduledGameId}
        rowProps={(row) => ({
          className: row.scheduledGameId === targetGameId ? 'is-navigation-target' : undefined,
          'data-director-navigation-id': row.scheduledGameId,
          'data-director-navigation-focus': true,
          tabIndex: -1,
        })}
        ariaLabel={`${delivery.round.name} delivery by room`}
        rowDetail={(row) =>
          row.scheduledGameId === expandedRowId ? (
            <DeliveryRowDetail
              row={row}
              state={state}
              onPrepareBackup={() => onOpenPrepare('backup', [row.scheduledGameId])}
              onClose={() => setExpandedRowId(null)}
            />
          ) : null
        }
        empty={
          <EmptyState
            title="No rooms need attention"
            description="The current round has no actionable delivery gaps. Switch to All rooms to see every assignment."
            variant="inline"
          />
        }
      />
    </Panel>
  );
}

function DeliveryRowActions({
  row,
  state,
  controller,
  action,
  onNavigate,
  onAnnounce,
  onPrepare,
  onOpenPrepare,
  expanded,
  onToggleDetails,
}: {
  row: GameDeliveryStatus;
  state: DirectorState;
  controller: DirectorController;
  action: DeliveryAction;
  onNavigate: (section: SectionId, target?: DirectorNavigationTarget | null) => void;
  onAnnounce: (announcement: AnnounceInput) => void;
  onPrepare: (gameIds: DirectorId[], action: string, mode?: PrepareMode) => Promise<void>;
  onOpenPrepare: (mode: PrepareMode, initialIds: DirectorId[]) => void;
  expanded: boolean;
  onToggleDetails: () => void;
}) {
  const navigateFor = (kind: NonNullable<DeliveryAction>['kind']) => {
    if (kind === 'prepare-file' || kind === 'reprepare-file') {
      void onPrepare(
        [row.scheduledGameId],
        kind === 'reprepare-file' ? 're-prepare this file' : 'prepare this file',
        'needed',
      );
      return;
    }
    if (kind === 'assign-room') {
      onNavigate('rooms', {
        section: 'rooms',
        entityType: 'game',
        entityId: row.scheduledGameId,
        parentId: row.roundId,
      });
      return;
    }
    if (kind === 'recover-session') {
      onNavigate(
        'rooms',
        row.roomId ? { section: 'rooms', entityType: 'room', entityId: row.roomId } : { section: 'rooms' },
      );
      return;
    }
    if (kind === 'resolve-result' || kind === 'review-result') {
      onNavigate(
        'results',
        row.result.submissionId
          ? { section: 'results', entityType: 'submission', entityId: row.result.submissionId }
          : { section: 'results' },
      );
    }
  };

  const setRoute = (primary: 'qbtcp' | 'file' | 'manual' | null) => {
    const game = state.scheduledGames.find((entry) => entry.id === row.scheduledGameId);
    const label = game ? matchupForGame(state, game) : row.matchup;
    if (primary === null) {
      if (controller.setGameDeliveryIntent(row.scheduledGameId, undefined)) {
        onAnnounce(`${label}: back to the derived route.`);
      }
      return;
    }
    if (controller.setGameDeliveryIntent(row.scheduledGameId, { primary, fallbacks: [] })) {
      onAnnounce(
        `${label}: will use ${primary === 'qbtcp' ? 'QBTCP' : primary === 'file' ? 'file' : 'manual delivery'}.`,
      );
    }
  };

  return (
    <>
      {action &&
        (action.kind === 'prepare-file' || action.kind === 'reprepare-file' ? (
          <Button
            variant="quiet"
            size="sm"
            onClick={() => navigateFor(action.kind)}
            aria-label={`${action.label} for ${row.roomName}, ${row.matchup}`}
          >
            {action.label}
          </Button>
        ) : (
          <Link
            onClick={() => navigateFor(action.kind)}
            aria-label={`${action.label.replace(' →', '')} for ${row.roomName}, ${row.matchup}`}
          >
            {action.label}
          </Link>
        ))}
      <ActionMenu label={`Actions for ${row.roomName}, ${row.matchup}`}>
        {(close) => (
          <>
            <MenuItem
              icon="info"
              onSelect={() => {
                close();
                onToggleDetails();
              }}
            >
              {expanded ? 'Hide delivery details' : 'View delivery details'}
            </MenuItem>
            <MenuItem
              icon="history"
              onSelect={() => {
                close();
                onToggleDetails();
              }}
            >
              View transfer history
            </MenuItem>
            {row.intent.primary !== 'file' && (
              <MenuItem
                icon="copy"
                onSelect={() => {
                  close();
                  onOpenPrepare('backup', [row.scheduledGameId]);
                }}
              >
                Prepare file backup
              </MenuItem>
            )}
            <MenuSeparator />
            <MenuSectionLabel>Change delivery route</MenuSectionLabel>
            <MenuItem
              onSelect={() => {
                close();
                setRoute('qbtcp');
              }}
            >
              Use QBTCP
            </MenuItem>
            <MenuItem
              onSelect={() => {
                close();
                setRoute('file');
              }}
            >
              Use file
            </MenuItem>
            <MenuItem
              onSelect={() => {
                close();
                setRoute('manual');
              }}
            >
              Manual delivery
            </MenuItem>
            {row.intent.source === 'explicit' && (
              <MenuItem
                onSelect={() => {
                  close();
                  setRoute(null);
                }}
              >
                Clear explicit route
              </MenuItem>
            )}
          </>
        )}
      </ActionMenu>
    </>
  );
}

function DeliveryRowDetail({
  row,
  state,
  onPrepareBackup,
  onClose,
}: {
  row: GameDeliveryStatus;
  state: DirectorState;
  onPrepareBackup: () => void;
  onClose: () => void;
}) {
  const assignments = state.transfers.assignments
    .filter((assignment) => assignment.scheduledGameId === row.scheduledGameId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const latest = assignments[0];
  const sessions = liveRoomSessions(state, row.roomId);
  const latestSession =
    sessions[0] ??
    state.qbtcpSessions
      .filter((session) => session.roomId === row.roomId)
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))[0];
  const artifact = row.result.artifactId
    ? state.transfers.artifacts.find((entry) => entry.id === row.result.artifactId)
    : undefined;
  const fileHistory = assignments.map(
    (assignment) => `${assignment.destinationLabel} · ${formatTime(assignment.createdAt)}`,
  );

  return (
    <RowDetail>
      <div className="director-row-detail-header">
        <div>
          <strong>Delivery details</strong>
          <p className="director-text-secondary">
            {row.roomName} · {row.matchup}
          </p>
        </div>
        <Button variant="quiet" size="sm" onClick={onClose}>
          Hide details
        </Button>
      </div>
      <Specs
        items={[
          { term: 'Primary route', value: describeDeliveryIntent(row.intent) },
          {
            term: 'Route source',
            value:
              row.intent.source === 'explicit'
                ? 'Explicit game route'
                : row.intent.source === 'round-default'
                  ? 'Round default'
                  : row.intent.source === 'session'
                    ? 'Connected room session'
                    : 'Manual fallback',
          },
          {
            term: 'Assignment revision',
            value: String(
              state.scheduledGames.find((game) => game.id === row.scheduledGameId)?.assignmentRevision ?? '—',
            ),
          },
          {
            term: 'Latest QBTCP session',
            value: latestSession
              ? `${latestSession.state} · ${formatTime(latestSession.lastSeenAt)}`
              : 'No session recorded',
          },
          {
            term: 'Latest assignment',
            value: latest
              ? `${latest.destinationLabel} · ${formatTime(latest.createdAt)}`
              : 'No assignment transfer recorded',
          },
          { term: 'Result source', value: row.result.sourceLabel ?? 'No result yet' },
          ...(artifact
            ? [
                { term: 'Returned file', value: artifact.fileName },
                ...(artifact.originalPath
                  ? [{ term: 'Path', value: artifact.originalPath, mono: true }]
                  : []),
              ]
            : []),
        ]}
      />
      {fileHistory.length > 0 && (
        <div>
          <strong>Transfer history</strong>
          <ul className="director-compact-list">
            {fileHistory.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        </div>
      )}
      {row.intent.primary !== 'file' && (
        <div className="director-row-detail-actions">
          <Button variant="quiet" size="sm" onClick={onPrepareBackup}>
            Prepare file backup
          </Button>
        </div>
      )}
    </RowDetail>
  );
}

function PrepareFilesDialog({
  mode,
  initialIds,
  delivery,
  state,
  transfers,
  onAnnounce,
  onClose,
}: {
  mode: PrepareMode;
  initialIds: DirectorId[];
  delivery: ReturnType<typeof deriveCurrentRoundDelivery>;
  state: DirectorState;
  transfers: TransfersRuntime;
  onAnnounce: (announcement: AnnounceInput) => void;
  onClose: () => void;
}) {
  const rows = delivery.rows;
  const [selectedIds, setSelectedIds] = useState<DirectorId[]>(() =>
    initialIds.filter((id) => rows.some((row) => row.scheduledGameId === id)),
  );
  const writable = state.transfers.locations.filter((location) => location.connected && !location.readOnly);
  const [destinationId, setDestinationId] = useState(writable.length === 1 ? writable[0]!.id : '');
  const selectedCount = selectedIds.length;
  const descriptor = mode === 'backup' ? 'assignment file backups' : 'assignment files';
  const submitLabel =
    mode === 'backup'
      ? `Prepare ${selectedCount} backup${selectedCount === 1 ? '' : 's'}`
      : `Prepare ${selectedCount} file${selectedCount === 1 ? '' : 's'}`;

  const toggle = (id: DirectorId, checked: boolean) => {
    setSelectedIds((current) => {
      if (checked) return current.includes(id) ? current : [...current, id];
      return current.filter((entry) => entry !== id);
    });
  };

  return (
    <Dialog
      title={mode === 'backup' ? 'Prepare assignment file backups' : 'Prepare assignment files'}
      description="Choose the games and destination. Changing the selection only changes this preparation run; it does not change any game's delivery route."
      size="lg"
      onClose={onClose}
      onSubmit={() => {
        if (selectedIds.length === 0) {
          onAnnounce(infoNotice(`Select at least one game to prepare ${descriptor}.`));
          return;
        }
        const selection: AssignmentSelection = { kind: 'games', scheduledGameIds: selectedIds };
        if (writable.length === 0) {
          if (!transfers.native) {
            const count = transfers.downloadAssignments(selection);
            if (count > 0) onClose();
            return;
          }
          onAnnounce(errorNotice('Connect a writable drive or folder before preparing assignment files.'));
          return;
        }
        const destination = writable.find((location) => location.id === destinationId);
        if (!destination) {
          onAnnounce(errorNotice('Choose a writable file destination.'));
          return;
        }
        void transfers.prepareTo(destination.id, selection).then((report) => {
          if (!report) return;
          const names = new Map(rows.map((row) => [row.scheduledGameId, `${row.roomName} · ${row.matchup}`]));
          const failed = report.failures.map(
            (entry) => `${names.get(entry.scheduledGameId) ?? entry.scheduledGameId}: ${entry.reason}`,
          );
          const skipped = report.skipped.map(
            (entry) => `${names.get(entry.scheduledGameId) ?? entry.scheduledGameId}: ${entry.reason}`,
          );
          if (failed.length > 0 || skipped.length > 0) {
            onAnnounce(
              warningNotice(
                `${report.written.length} file${report.written.length === 1 ? '' : 's'} prepared at ${destination.label}. Still unresolved: ${[...failed, ...skipped].join(' · ')}`,
              ),
            );
          } else {
            onAnnounce(
              `${report.written.length} assignment file${report.written.length === 1 ? '' : 's'} prepared at ${destination.label}.`,
            );
          }
          if (failed.length === 0) onClose();
        });
      }}
      submitLabel={submitLabel}
      submitDisabled={selectedCount === 0 || (writable.length > 0 && !destinationId)}
    >
      <DialogSection
        title="Games"
        description={
          mode === 'needed'
            ? 'Games needing a file are selected. You can add or remove games before preparing.'
            : undefined
        }
      >
        {rows.length === 0 ? (
          <EmptyState
            title="No current-round games"
            description="There are no games available for this preparation run."
            variant="inline"
          />
        ) : (
          <CheckboxGroup legend="Current-round games" hint="Byes and cancelled games are not shown.">
            {rows.map((row) => {
              const display = deliveryDisplay(state, row);
              return (
                <Checkbox
                  key={row.scheduledGameId}
                  checked={selectedIds.includes(row.scheduledGameId)}
                  onChange={(checked) => toggle(row.scheduledGameId, checked)}
                  ariaLabel={`${row.roomName}, ${row.matchup}`}
                  label={
                    <span className="director-prepare-choice">
                      <strong>{row.roomName}</strong>
                      <span>{row.matchup}</span>
                      <StateLabel state={display.state} label={display.label} tone={display.tone} />
                    </span>
                  }
                />
              );
            })}
          </CheckboxGroup>
        )}
      </DialogSection>
      <DialogSection title="Destination">
        {writable.length === 0 ? (
          <Callout tone={transfers.native ? 'warning' : 'info'}>
            {transfers.native
              ? 'No connected writable destination is available. Connect a drive or add a folder in File destinations.'
              : 'No native destination is connected. Director will download the selected files to the browser download folder.'}
          </Callout>
        ) : writable.length === 1 ? (
          <p className="director-dialog-choice-summary">
            {writable[0]!.label} · {writable[0]!.kind === 'removable-drive' ? 'USB drive' : 'Folder'}
          </p>
        ) : (
          <Field
            label="Write files to"
            render={({ id, labelId, describedBy }) => (
              <Select
                id={id}
                ariaLabelledBy={labelId}
                ariaDescribedBy={describedBy}
                value={destinationId}
                options={writable.map((location) => ({
                  value: location.id,
                  label: location.label,
                  detail: location.kind === 'removable-drive' ? 'USB drive' : 'Folder',
                }))}
                onChange={setDestinationId}
              />
            )}
          />
        )}
      </DialogSection>
    </Dialog>
  );
}

function describeDestinationSummary(locations: TransferLocation[]): string {
  const connected = locations.filter((location) => location.connected);
  if (connected.length === 0) return 'Files: No connected destinations';
  return `Files: ${connected
    .map(
      (location) =>
        `${location.label} · ${location.readOnly ? 'Read-only' : location.watching ? 'Watching' : 'Connected'}`,
    )
    .join(' · ')}`;
}

function FileDestinationsDialog({
  transfers,
  state,
  onClose,
}: {
  transfers: TransfersRuntime;
  state: DirectorState;
  onClose: () => void;
}) {
  const connected = state.transfers.locations.filter((location) => location.connected);
  const disconnected = state.transfers.locations.filter((location) => !location.connected);
  return (
    <Dialog
      title="File destinations"
      description="Connected drives and folders are used for assignment files and optional returned-result scans. Provider APIs are not required; synced folders remain ordinary filesystem locations."
      size="lg"
      onClose={onClose}
    >
      <div className="director-dialog-section-actions">
        <Button
          variant="secondary"
          icon="plus"
          disabled={!transfers.native}
          onClick={() => void transfers.addFolder()}
        >
          Add folder
        </Button>
      </div>
      {!transfers.native && (
        <Callout tone="info">
          Browser preview can import dropped or picked QBJ files and download assignments. Native drive
          enumeration and folder watching require the Director desktop app.
        </Callout>
      )}
      {connected.length === 0 && disconnected.length === 0 ? (
        <EmptyState
          title="No file destinations"
          description="Add a folder or connect a removable drive when you need assignment files."
          variant="contained"
        />
      ) : (
        <>
          {connected.length > 0 && (
            <DialogSection title="Connected locations">
              <SummaryList ariaLabel="Connected file destinations">
                {connected.map((location) => (
                  <DestinationItem key={location.id} transfers={transfers} location={location} />
                ))}
              </SummaryList>
            </DialogSection>
          )}
          {disconnected.length > 0 && (
            <DialogSection title={`Remembered locations (${disconnected.length})`}>
              <SummaryList ariaLabel="Remembered disconnected file destinations">
                {disconnected.map((location) => (
                  <SummaryItem
                    key={location.id}
                    title={<strong>{location.label}</strong>}
                    status={<StateLabel state="offline" label="Not connected" />}
                    summary={`${location.kind === 'removable-drive' ? 'USB drive' : 'Folder'} · ${location.path}`}
                    actions={
                      <Button variant="quiet" size="sm" onClick={() => transfers.removeLocation(location.id)}>
                        Forget
                      </Button>
                    }
                  />
                ))}
              </SummaryList>
            </DialogSection>
          )}
        </>
      )}
    </Dialog>
  );
}

function DestinationItem({
  transfers,
  location,
}: {
  transfers: TransfersRuntime;
  location: TransferLocation;
}) {
  const confirmAction = useConfirm();
  const scanning = transfers.isOperationActive(scanOperation(location.id));
  return (
    <SummaryItem
      title={
        <strong>
          {location.kind === 'removable-drive' ? 'USB drive' : 'Folder'} · {location.label}
        </strong>
      }
      status={
        <StateLabel
          state={location.readOnly ? 'warning' : location.watching ? 'watching' : 'connected'}
          label={location.readOnly ? 'Read-only' : location.watching ? 'Watching' : 'Connected'}
        />
      }
      summary={[location.path, formatBytes(location.availableBytes)]
        .filter((value) => value !== '—')
        .join(' · ')}
      actions={
        <div className="director-actions">
          <Button
            variant="quiet"
            size="sm"
            disabled={scanning}
            onClick={() => void transfers.scanLocation(location.id)}
          >
            {scanning ? 'Scanning…' : 'Scan for returned results'}
          </Button>
          <ActionMenu label={`${location.label} actions`}>
            {(close) => (
              <>
                {location.connected && !location.readOnly && (
                  <MenuItem
                    icon="settings"
                    onSelect={() => {
                      close();
                      void transfers.initializeLocation(location.id);
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
                        title: `Forget ${location.label}?`,
                        consequence:
                          'The folder or drive is not deleted. Director only forgets this destination record.',
                        confirmLabel: 'Forget location',
                        tone: 'danger',
                      });
                      if (approved) transfers.removeLocation(location.id);
                    })();
                  }}
                >
                  Forget location…
                </MenuItem>
              </>
            )}
          </ActionMenu>
        </div>
      }
    >
      <div className="director-device-options">
        {location.connected && (
          <Switch
            checked={location.watching}
            label="Watch for returned results"
            hint="Scans the Results folder periodically."
            onChange={(watching) => transfers.setWatching(location.id, watching)}
          />
        )}
        <Diagnostics
          label="Destination details"
          standalone={false}
          items={[
            { term: 'Path', value: location.path, mono: true },
            { term: 'QBSheet folder', value: location.initialized ? 'Ready' : 'Not initialized' },
            ...(location.message ? [{ term: 'Last message', value: location.message }] : []),
            ...(transfers.cloudAdviceFor(location)
              ? [{ term: 'Sync note', value: transfers.cloudAdviceFor(location) as string }]
              : []),
          ]}
        />
      </div>
    </SummaryItem>
  );
}

function HistoryView({ state }: { state: DirectorState }) {
  if (state.transfers.events.length === 0) {
    return (
      <EmptyState
        title="No transfer history"
        description="Scans, prepared assignments, imports, and other transfer actions will appear here."
      />
    );
  }
  return (
    <SummaryList ariaLabel="Transfer history">
      {state.transfers.events.slice(0, 50).map((event) => (
        <SummaryItem
          key={event.id}
          title={<strong>{event.summary}</strong>}
          summary={[event.detail, formatTime(event.at)].filter(Boolean).join(' · ')}
        />
      ))}
    </SummaryList>
  );
}
