/** Delivery moves assignments out; Results decides what a return means. */
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
  FilePicker,
  MenuItem,
  Page,
  PageHeader,
  Panel,
  StateLabel,
  SummaryItem,
  SummaryList,
  Switch,
  useConfirm,
  type PickedFile,
} from '../components';
import type { SectionId } from '../app/navigation';
import type { AssignmentSelection } from './assignment';
import { transferArtifactNeedsAttention, transferArtifactResolution } from './attention';
import {
  deriveCurrentRoundDelivery,
  describeDeliveryIntent,
  matchupForGame,
  type AssignmentReadinessState,
  type GameDeliveryStatus,
  type GameResultState,
} from './deliveryStatus';
import { describeWarning } from './ingest';
import { type IncomingArtifact, type TransferLocation } from './model';
import { prepareOperation, scanOperation, type TransfersRuntime } from './useTransfers';
import { type AnnounceInput } from '../notices';
import type { DirectorId } from '../domain';

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

export function TransfersView({
  transfers,
  state,
  controller,
  onNavigate,
  onAnnounce,
}: {
  transfers: TransfersRuntime;
  state: DirectorState;
  controller: DirectorController;
  onNavigate: (section: SectionId) => void;
  onAnnounce: (announcement: AnnounceInput) => void;
}) {
  const delivery = useMemo(() => deriveCurrentRoundDelivery(state), [state]);
  const pending = state.transfers.artifacts.filter((artifact) =>
    transferArtifactNeedsAttention(artifact, state.submissions),
  );
  const [dropActive, setDropActive] = useState(false);
  const [selected, setSelected] = useState<DirectorId[]>([]);

  // Selections address current-round rows only. When the operational round
  // changes, previously visible rows disappear and their IDs must not linger
  // where the operator can no longer see or uncheck them (#756). This is the
  // render-phase adjustment pattern (no effect): the reset applies before the
  // new round's rows commit, so no stale selection is ever actionable.
  const roundId = delivery.round?.id;
  const [selectionRoundId, setSelectionRoundId] = useState(roundId);
  if (selectionRoundId !== roundId) {
    setSelectionRoundId(roundId);
    setSelected([]);
  }

  // Defense in depth: the effective selection is the intersection of the
  // stored selection and the currently displayed rows, so a game removed or
  // regenerated within the same round is also excluded from counts and
  // device actions (#756).
  const effectiveSelected = useMemo(() => {
    const visible = new Set(delivery.rows.map((row) => row.scheduledGameId));
    return selected.filter((gameId) => visible.has(gameId));
  }, [delivery, selected]);

  const toggleSelected = useCallback((gameId: string) => {
    setSelected((previous) =>
      previous.includes(gameId) ? previous.filter((entry) => entry !== gameId) : [...previous, gameId],
    );
  }, []);

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
  };

  return (
    <Page>
      <PageHeader
        title="Delivery & Results"
        description="How every current-round game reaches its room, what has come back, and where files need to go."
        actions={
          <FilePicker
            accept=".qbj,.json"
            multiple
            onPick={importPickedFiles}
            variant="secondary"
            icon="upload"
          >
            Import returned files
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

      <CurrentRoundSection
        transfers={transfers}
        state={state}
        controller={controller}
        delivery={delivery}
        selected={selected}
        onToggleSelected={toggleSelected}
        onNavigate={onNavigate}
        onAnnounce={onAnnounce}
      />

      <ReturnedResultsSection
        state={state}
        controller={controller}
        pending={pending}
        dropActive={dropActive}
        setDropActive={setDropActive}
        onDrop={onDrop}
        onPick={importPickedFiles}
        onReview={() => onNavigate('results')}
      />

      <DevicesSection
        transfers={transfers}
        state={state}
        delivery={delivery}
        selected={effectiveSelected}
        onAnnounce={onAnnounce}
      />

      <AdvancedSection label="History and diagnostics" hint="Transfer events and troubleshooting detail.">
        <HistoryView state={state} />
      </AdvancedSection>

      {transfers.status !== '' && (
        <p className="director-text-meta" role="status">
          Last transfer action: {transfers.status}
        </p>
      )}
    </Page>
  );
}

/** Where a prepare action goes: the one writable device, a download, or an explicit choice below. */
function usePrepareGames({
  transfers,
  state,
  onAnnounce,
}: {
  transfers: TransfersRuntime;
  state: DirectorState;
  onAnnounce: (announcement: AnnounceInput) => void;
}) {
  return useCallback(
    async (gameIds: string[], action: string) => {
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
          `No connected drive or folder to ${action}. Connect one below, then try again. The games stay selected.`,
        );
        return;
      }
      onAnnounce(
        `More than one connected destination can ${action}. Pick a drive or folder below; the games stay selected.`,
      );
    },
    [onAnnounce, state.transfers.locations, transfers],
  );
}

function CurrentRoundSection({
  transfers,
  state,
  controller,
  delivery,
  selected,
  onToggleSelected,
  onNavigate,
  onAnnounce,
}: {
  transfers: TransfersRuntime;
  state: DirectorState;
  controller: DirectorController;
  delivery: ReturnType<typeof deriveCurrentRoundDelivery>;
  selected: string[];
  onToggleSelected: (gameId: string) => void;
  onNavigate: (section: SectionId) => void;
  onAnnounce: (announcement: AnnounceInput) => void;
}) {
  const prepareGames = usePrepareGames({ transfers, state, onAnnounce });
  const ensureSelected = useCallback(
    (gameId: string) => {
      if (!selected.includes(gameId)) onToggleSelected(gameId);
    },
    [onToggleSelected, selected],
  );

  if (!delivery.round) {
    return (
      <EmptyState
        title="No current round"
        description="Generate a round from Tournament day to see room-by-room delivery here. Returned results and devices below still work."
      />
    );
  }
  const connectedRooms = new Set(
    state.qbtcpSessions.filter((session) => session.state !== 'abandoned').map((session) => session.roomId),
  );
  const connectedCount = delivery.rows.filter((row) => row.roomId && connectedRooms.has(row.roomId)).length;
  const summary = [
    delivery.needingFiles.length > 0
      ? `${delivery.needingFiles.length} room${delivery.needingFiles.length === 1 ? '' : 's'} need${delivery.needingFiles.length === 1 ? 's' : ''} assignment files`
      : null,
    delivery.qbtcpProblem.length > 0
      ? `${delivery.qbtcpProblem.length} delivery problem${delivery.qbtcpProblem.length === 1 ? '' : 's'}`
      : null,
    delivery.needingReview.length > 0
      ? `${delivery.needingReview.length} result${delivery.needingReview.length === 1 ? '' : 's'} need review`
      : null,
    `${connectedCount} of ${delivery.rows.length} rooms QBTCP-connected`,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Panel title={`${delivery.round.name} · room by room`} description={summary}>
      {delivery.rows.length === 0 ? (
        <div className="director-empty-in-panel">
          <p className="director-empty-copy">
            No scheduled games in this round yet. Assign rooms from Tournament day when the draw is ready.
          </p>
        </div>
      ) : (
        <SummaryList ariaLabel={`${delivery.round.name} delivery by room`}>
          {delivery.rows.map((row) => (
            <GameRow
              key={row.scheduledGameId}
              row={row}
              state={state}
              controller={controller}
              checked={selected.includes(row.scheduledGameId)}
              onToggleChecked={() => onToggleSelected(row.scheduledGameId)}
              onPrepare={() => void prepareGames([row.scheduledGameId], 'write this assignment')}
              onPrepareFallback={() => {
                ensureSelected(row.scheduledGameId);
                void prepareGames([row.scheduledGameId], 'write this fallback');
              }}
              onReview={() => onNavigate('results')}
              onRecover={() => onNavigate('rooms')}
              onAnnounce={onAnnounce}
            />
          ))}
        </SummaryList>
      )}
    </Panel>
  );
}

function intentDetail(row: GameDeliveryStatus): string {
  switch (row.intent.source) {
    case 'explicit':
      return `Route: ${describeDeliveryIntent({ primary: row.intent.primary, fallbacks: row.intent.fallbacks })}`;
    case 'session':
      return 'Route: QBTCP, scorer connected';
    case 'round-default':
      return `Route: ${row.intent.primary === 'qbtcp' ? 'QBTCP' : row.intent.primary === 'file' ? 'file' : 'manual'} (round default)`;
    case 'manual':
      return 'Route: manual';
  }
}

function GameRow({
  row,
  state,
  controller,
  checked,
  onToggleChecked,
  onPrepare,
  onPrepareFallback,
  onReview,
  onRecover,
  onAnnounce,
}: {
  row: GameDeliveryStatus;
  state: DirectorState;
  controller: DirectorController;
  checked: boolean;
  onToggleChecked: () => void;
  onPrepare: () => void;
  onPrepareFallback: () => void;
  onReview: () => void;
  onRecover: () => void;
  onAnnounce: (announcement: AnnounceInput) => void;
}) {
  const openHelp = row.roomId
    ? state.qbtcpHelpRequests.find((request) => request.roomId === row.roomId && request.status === 'open')
    : undefined;
  const needsReview = row.result.state === 'review' || row.result.state === 'conflict';
  const resultDetail =
    row.result.state === 'waiting'
      ? 'No result yet'
      : `${resultLabel(row.result.state)}${row.result.sourceLabel ? ` · ${row.result.sourceLabel}` : ''}`;
  const assignmentDetail = [
    deliveryLabel(row.assignment.state),
    row.assignment.backupCurrent ? 'file backup prepared' : null,
    row.assignment.message ?? null,
  ]
    .filter(Boolean)
    .join(' · ');

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
    <SummaryItem
      selected={checked}
      title={
        <strong>
          {row.roomName} · {row.matchup}
        </strong>
      }
      status={
        <span className="director-states">
          <StateLabel state={row.assignment.state} label={deliveryLabel(row.assignment.state)} />
          <StateLabel state={row.result.state} label={resultLabel(row.result.state)} />
        </span>
      }
      summary={`${intentDetail(row)} · ${assignmentDetail} · Result: ${resultDetail}`}
      actions={
        <div className="director-actions">
          <input
            type="checkbox"
            checked={checked}
            onChange={onToggleChecked}
            aria-label={`Select ${row.roomName}, ${row.matchup} for file preparation`}
          />
          {row.needsFile && (
            <Button variant="primary" onClick={onPrepare}>
              {row.assignment.state === 'needs-reprepare' ? 'Re-prepare file' : 'Prepare assignment'}
            </Button>
          )}
          {row.assignment.state === 'problem' && (
            <Button variant="primary" onClick={onPrepareFallback}>
              Prepare file fallback
            </Button>
          )}
          {(needsReview || row.result.state === 'received') && (
            <Button variant={needsReview ? 'primary' : 'secondary'} onClick={onReview}>
              Review
            </Button>
          )}
          {openHelp && (
            <Button variant="secondary" onClick={onRecover}>
              Session needs recovery
            </Button>
          )}
          <ActionMenu label={`Delivery route for ${row.matchup}`} triggerLabel="Route">
            {(close) => (
              <>
                <MenuItem
                  onSelect={() => {
                    close();
                    setRoute('qbtcp');
                  }}
                >
                  Deliver via QBTCP
                </MenuItem>
                <MenuItem
                  onSelect={() => {
                    close();
                    setRoute('file');
                  }}
                >
                  Deliver via file
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
        </div>
      }
    >
      {row.result.scoreLine && <p className="director-panel-footnote">{row.result.scoreLine}</p>}
    </SummaryItem>
  );
}

function ReturnedResultsSection({
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
  const staged = pending.some((artifact) => artifact.status === 'staged');
  return (
    <Panel
      title={
        pending.length === 0
          ? 'Returned results'
          : `${pending.length} returned result${pending.length === 1 ? '' : 's'} need attention`
      }
      description="Every transport lands in the same review pipeline. Accepting happens only in Results."
      actions={
        staged ? (
          <Button variant="primary" onClick={onReview}>
            Review results
          </Button>
        ) : undefined
      }
    >
      {pending.length === 0 ? (
        <div className="director-empty-in-panel">
          <p className="director-empty-copy">
            Nothing waiting. Results arrive automatically over QBTCP, or import them below.
          </p>
        </div>
      ) : (
        <SummaryList ariaLabel="Returned results needing attention">
          {pending.slice(0, 40).map((artifact) => (
            <ReturnedResultItem
              key={artifact.id}
              state={state}
              artifact={artifact}
              onDismiss={() => controller.dismissTransferArtifact(artifact.id)}
              onReview={onReview}
            />
          ))}
        </SummaryList>
      )}
      <div
        className={`director-dropzone ${dropActive ? 'is-active' : ''}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDropActive(true);
        }}
        onDragLeave={() => setDropActive(false)}
        onDrop={onDrop}
      >
        <p>Drop returned QBJ files here, or choose files from this computer.</p>
        <FilePicker accept=".qbj,.json" multiple onPick={onPick} variant="secondary" icon="file">
          Choose files
        </FilePicker>
      </div>
    </Panel>
  );
}

function ReturnedResultItem({
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
  const resolution = transferArtifactResolution(artifact, state.submissions);
  const title = scheduled ? (
    <strong>
      {matchupForGame(state, scheduled)}
      {[room?.name, round?.name].filter(Boolean).length > 0
        ? ` · ${[room?.name, round?.name].filter(Boolean).join(' · ')}`
        : ''}
    </strong>
  ) : (
    <strong>{artifact.fileName}</strong>
  );
  return (
    <SummaryItem
      title={title}
      status={
        <StateLabel
          state={resolution ?? classificationState(artifact)}
          label={
            resolution
              ? `${resolution === 'accepted' ? 'Accepted' : 'Rejected'} in Results`
              : classificationLabel(artifact)
          }
        />
      }
      summary={
        scheduled
          ? `${resultSourceLine(artifact)} · ${artifact.status === 'staged' ? 'ready for review' : artifact.status}`
          : `${artifact.sourceLabel} · unmatched file, filename kept for diagnosis`
      }
      actions={
        <div className="director-actions">
          {transferArtifactNeedsAttention(artifact, state.submissions) && artifact.status === 'staged' && (
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
      <Diagnostics label="File details" standalone={false}>
        {scheduled && (
          <p>
            {artifact.fileName}
            {artifact.originalPath ? ` · ${artifact.originalPath}` : ''}
          </p>
        )}
        {artifact.detail && <p>{artifact.detail}</p>}
        {artifact.warnings.length > 0 && <p>{artifact.warnings.map(describeWarning).join(' ')}</p>}
      </Diagnostics>
    </SummaryItem>
  );
}

/** Transport stays secondary context: `via QBTCP`, a drive label, an import path. */
function resultSourceLine(artifact: IncomingArtifact): string {
  if (artifact.sourceKind === 'qbtcp')
    return `via QBTCP${artifact.sourceLabel ? ` · ${artifact.sourceLabel}` : ''}`;
  if (artifact.sourceKind === 'removable-drive') return `from ${artifact.sourceLabel}`;
  return artifact.sourceLabel;
}

function DevicesSection({
  transfers,
  state,
  delivery,
  selected,
  onAnnounce,
}: {
  transfers: TransfersRuntime;
  state: DirectorState;
  delivery: ReturnType<typeof deriveCurrentRoundDelivery>;
  selected: string[];
  onAnnounce: (announcement: AnnounceInput) => void;
}) {
  const connected = state.transfers.locations.filter((location) => location.connected);
  const disconnected = state.transfers.locations.filter((location) => !location.connected);
  return (
    <Panel
      title="USB drives & folders"
      description="Destinations for assignment files and sources for returned results. Files go to selected rooms only."
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
    >
      {connected.length === 0 ? (
        <div className="director-empty-in-panel">
          <p className="director-empty-copy">
            {transfers.native
              ? 'Insert a USB drive or add a folder when rooms need assignment files.'
              : 'Add folders from the desktop app. Browser preview can still import and download files.'}
          </p>
        </div>
      ) : (
        <SummaryList ariaLabel="Connected USB drives and folders">
          {connected.map((location) => (
            <DeviceCard
              key={location.id}
              transfers={transfers}
              location={location}
              delivery={delivery}
              selected={selected}
              onAnnounce={onAnnounce}
            />
          ))}
        </SummaryList>
      )}
      {disconnected.length > 0 && (
        <AdvancedSection
          label={`Disconnected devices (${disconnected.length})`}
          hint="Remembered locations that are not currently available."
        >
          <SummaryList ariaLabel="Disconnected devices">
            {disconnected.map((location) => (
              <SummaryItem
                key={location.id}
                title={<strong>{location.label}</strong>}
                status={<StateLabel state="offline" label="Not connected" />}
                summary={`${location.kind === 'removable-drive' ? 'USB drive' : 'Folder'} · remembered, needs no action`}
                actions={
                  <Button variant="quiet" onClick={() => transfers.removeLocation(location.id)}>
                    Forget
                  </Button>
                }
              />
            ))}
          </SummaryList>
        </AdvancedSection>
      )}
    </Panel>
  );
}

function DeviceCard({
  transfers,
  location,
  delivery,
  selected,
  onAnnounce,
}: {
  transfers: TransfersRuntime;
  location: TransferLocation;
  delivery: ReturnType<typeof deriveCurrentRoundDelivery>;
  selected: string[];
  onAnnounce: (announcement: AnnounceInput) => void;
}) {
  const confirmAction = useConfirm();
  const needing = delivery.needingFiles;
  const preparing = transfers.isOperationActive(prepareOperation(location.id));
  const scanning = transfers.isOperationActive(scanOperation(location.id));
  const copySelection = (selection: AssignmentSelection, what: string) => {
    if (location.readOnly) {
      onAnnounce(`${location.label} is read-only. Nothing was written.`);
      return;
    }
    void transfers.prepareTo(location.id, selection).then((report) => {
      if (report && (report.failures.length > 0 || report.skipped.length > 0)) {
        const remaining = [...report.failures.map((entry) => entry.scheduledGameId)];
        onAnnounce(
          `${what}: ${report.written.length} written${remaining.length > 0 ? `, still needing files: ${remaining.join(', ')}` : ''}.`,
        );
      }
    });
  };
  return (
    <SummaryItem
      title={
        <strong>
          {location.kind === 'removable-drive' ? 'USB drive' : 'Folder'} · {location.label}
        </strong>
      }
      status={
        <StateLabel
          state={location.readOnly ? 'warning' : location.watching ? 'live' : 'connected'}
          label={location.readOnly ? 'Read-only' : location.watching ? 'Watching' : 'Connected'}
        />
      }
      summary={
        needing.length > 0
          ? `Assignments needed for ${needing.length} room${needing.length === 1 ? '' : 's'}: ${needing.map((row) => `${row.roomName} · ${row.matchup}`).join('; ')}`
          : 'Every current-round room is covered; selected games can still be copied as backup.'
      }
      actions={
        <div className="director-actions">
          {!location.readOnly && (
            <>
              <Button
                variant="primary"
                disabled={preparing || needing.length === 0}
                onClick={() =>
                  copySelection(
                    { kind: 'needing-files', roundId: delivery.round?.id },
                    `Copied rooms needing files to ${location.label}`,
                  )
                }
              >
                {preparing
                  ? 'Copying…'
                  : `Copy rooms needing files${needing.length > 0 ? ` (${needing.length})` : ''}`}
              </Button>
              <Button
                variant="secondary"
                disabled={preparing || selected.length === 0}
                onClick={() =>
                  copySelection(
                    { kind: 'games', scheduledGameIds: selected },
                    `Copied ${selected.length} selected game${selected.length === 1 ? '' : 's'} to ${location.label}`,
                  )
                }
              >
                Copy selected{selected.length > 0 ? ` (${selected.length})` : ''}
              </Button>
            </>
          )}
          <Button
            variant="secondary"
            disabled={scanning}
            onClick={() => void transfers.scanLocation(location.id)}
          >
            {scanning ? 'Checking…' : 'Check for returned results'}
          </Button>
          <ActionMenu label={`${location.label} actions`} triggerLabel={`${location.label} actions`}>
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
                        title: `Remove ${location.label} from Director?`,
                        consequence:
                          'The folder or drive itself is not deleted. Director only forgets this device record.',
                        confirmLabel: 'Remove location',
                        tone: 'danger',
                      });
                      if (approved) transfers.removeLocation(location.id);
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
      <div className="director-device-options">
        {location.connected && (
          <Switch
            checked={location.watching}
            label="Watch for returned results"
            hint="Takes effect immediately."
            onChange={(watching) => transfers.setWatching(location.id, watching)}
          />
        )}
        <Diagnostics
          label="Device details"
          standalone={false}
          items={[
            { term: 'Path', value: location.path, mono: true },
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
        description="Scans, imports, prepared assignments, and other transfer actions will appear here."
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

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
