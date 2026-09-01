/**
 * Transfers: where files come in and where assignments go out.
 *
 * # The boundary with Results, stated once so it stays kept
 *
 * Transfers moves files. Results decides what a result means. So this page discovers, imports,
 * stages, prepares and writes — and it shows the incoming pile with enough detail to know whether
 * to hurry — but accepting, rejecting, editing and reconciling live on Results and are reached from
 * here by a link. There is exactly one page in Director that changes a tournament's results, and a
 * director learns where it is once.
 *
 * The internal subsystem is called triage. The page is called Transfers, because "triage" tells a
 * tournament director nothing about what the page does.
 *
 * # Four sections, in the order a round happens
 *
 * Locations, incoming, outgoing, recent. Dense lists rather than cards: a director scanning this
 * mid-round is looking for one row, and cards make ten rows into a scroll.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type { DirectorState } from '../domain/model';
import type { DirectorController } from '../state/useDirectorController';
import { Button, StateLabel } from '../components/Controls';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import type { SectionId } from '../app/navigation';
import type { AssignmentSelection } from './assignment';
import { describeWarning } from './ingest';
import { transportLabel, type IncomingArtifact, type TransferLocation } from './model';
import { planAssignments } from './prepare';
import { useTransfers } from './useTransfers';

export function TransfersView({
  state,
  controller,
  onNavigate,
  onAnnounce,
}: {
  state: DirectorState;
  controller: DirectorController;
  onNavigate: (section: SectionId) => void;
  onAnnounce: (message: string) => void;
}) {
  const transfers = useTransfers(state, controller, onAnnounce);
  const [dropActive, setDropActive] = useState(false);
  const [selectionKind, setSelectionKind] = useState<'current-round' | 'released' | 'unconnected-rooms'>(
    'current-round',
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const currentRound =
    state.rounds.find((round) => round.id === state.tournament?.currentRoundId) ?? state.rounds.at(-1);
  const connectedRoomIds = new Set(
    state.qbtcpSessions.filter((session) => session.state !== 'abandoned').map((session) => session.roomId),
  );
  const roundGames = currentRound
    ? state.scheduledGames.filter((game) => game.roundId === currentRound.id && !game.bye)
    : [];
  const connectedCount = roundGames.filter((game) => game.roomId && connectedRoomIds.has(game.roomId)).length;

  const pending = state.transfers.artifacts.filter(
    (artifact) => artifact.status === 'staged' || artifact.status === 'failed',
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setDropActive(false);
      void transfers.importDataTransfer(event.dataTransfer);
    },
    [transfers],
  );

  return (
    <>
      <PageHeader
        eyebrow="Run"
        title="Transfers"
        description="Move assignments out and completed games in, over any mix of USB drives, shared folders, downloads, and QBTCP."
        actions={
          <Button variant="secondary" icon="upload" onClick={() => fileInputRef.current?.click()}>
            Import files
          </Button>
        }
      />
      <input
        ref={fileInputRef}
        className="director-visually-hidden-input"
        type="file"
        accept=".qbj,.json"
        multiple
        onChange={(event) => {
          const files = event.target.files ? Array.from(event.target.files) : [];
          void transfers.importFiles(files);
          event.currentTarget.value = '';
        }}
      />

      <div className="director-page-stack">
        {transfers.notice && (
          <section className="director-panel director-transfer-notice" role="status">
            <div className="director-panel-body director-transfer-notice-body">
              <Icon name="server" size={18} />
              <div>
                <strong>{transfers.notice.label} connected</strong>
                <small>
                  {transfers.notice.resultCount} completed QBSheet game
                  {transfers.notice.resultCount === 1 ? '' : 's'} found
                  {transfers.notice.assignmentCount > 0
                    ? ` · ${transfers.notice.assignmentCount} assignment file${transfers.notice.assignmentCount === 1 ? '' : 's'}`
                    : ''}
                  .
                </small>
              </div>
              <div className="director-row-actions">
                <Button variant="primary" onClick={() => onNavigate('results')}>
                  Review results
                </Button>
                <Button variant="quiet" onClick={transfers.dismissNotice}>
                  Dismiss
                </Button>
              </div>
            </div>
          </section>
        )}

        {!transfers.native && transfers.limitation && (
          <section className="director-panel">
            <div className="director-panel-body">
              <p className="director-panel-footnote">{transfers.limitation}</p>
            </div>
          </section>
        )}

        <section className="director-panel">
          <div className="director-panel-heading">
            <div>
              <p className="director-eyebrow">Locations</p>
              <h2>
                {state.transfers.locations.length === 0
                  ? 'No transfer locations'
                  : `${state.transfers.locations.filter((location) => location.connected).length} of ${state.transfers.locations.length} available`}
              </h2>
            </div>
            <Button variant="secondary" icon="plus" onClick={() => void transfers.addFolder()}>
              Add folder
            </Button>
          </div>
          {state.transfers.locations.length === 0 ? (
            <div className="director-panel-body">
              <p className="director-empty-copy">
                {transfers.native
                  ? 'Insert a USB drive or add a folder — a shared drive, a network share, or a folder your cloud client syncs. Director treats them all the same way.'
                  : 'Add a folder from the desktop app, or drag completed QBJ files onto this page.'}
              </p>
            </div>
          ) : (
            <div className="director-panel-body director-panel-body-list">
              <ul className="director-list director-transfer-list">
                {state.transfers.locations.map((location) => (
                  <LocationRow
                    key={location.id}
                    location={location}
                    advice={transfers.cloudAdviceFor(location)}
                    busy={transfers.busy}
                    onScan={() => void transfers.scanLocation(location.id)}
                    onPrepare={() => void transfers.prepareTo(location.id, selection)}
                    onInitialize={() => void transfers.initializeLocation(location.id)}
                    onWatch={(watching) => transfers.setWatching(location.id, watching)}
                    onRemove={() => transfers.removeLocation(location.id)}
                  />
                ))}
              </ul>
            </div>
          )}
        </section>

        <section
          className={`director-panel director-dropzone-panel ${dropActive ? 'is-active' : ''}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDropActive(true);
          }}
          onDragLeave={() => setDropActive(false)}
          onDrop={onDrop}
        >
          <div className="director-panel-heading">
            <div>
              <p className="director-eyebrow">Incoming</p>
              <h2>
                {pending.length === 0
                  ? 'No files waiting'
                  : `${pending.length} file${pending.length === 1 ? '' : 's'} found`}
              </h2>
            </div>
            {pending.some((artifact) => artifact.status === 'staged') && (
              <Button variant="primary" onClick={() => onNavigate('results')}>
                Review results
              </Button>
            )}
          </div>
          <div className="director-panel-body director-dropzone">
            <p>
              Drop completed QBJ files here
              <br />
              or
            </p>
            <Button variant="secondary" icon="file" onClick={() => fileInputRef.current?.click()}>
              Choose files
            </Button>
          </div>
          {state.transfers.artifacts.length > 0 && (
            <div className="director-table-wrap">
              <table className="director-table">
                <thead>
                  <tr>
                    <th scope="col">File</th>
                    <th scope="col">Game</th>
                    <th scope="col">Source</th>
                    <th scope="col">Status</th>
                    <th scope="col" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {state.transfers.artifacts.slice(0, 40).map((artifact) => (
                    <ArtifactRow
                      key={artifact.id}
                      state={state}
                      artifact={artifact}
                      onDismiss={() => controller.dismissTransferArtifact(artifact.id)}
                      onReview={() => onNavigate('results')}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="director-panel">
          <div className="director-panel-heading">
            <div>
              <p className="director-eyebrow">Outgoing</p>
              <h2>
                {currentRound
                  ? `${currentRound.name} · ${roundGames.length} game${roundGames.length === 1 ? '' : 's'}`
                  : 'No round generated'}
              </h2>
              {currentRound && (
                <p className="director-page-description">
                  {connectedCount} QBTCP room{connectedCount === 1 ? '' : 's'} connected ·{' '}
                  {roundGames.length - connectedCount} not connected
                </p>
              )}
            </div>
            <Button
              variant="secondary"
              icon="download"
              onClick={() => transfers.downloadAssignments(selection)}
            >
              Export assignment files
            </Button>
          </div>
          <div className="director-panel-body">
            <div className="director-filter-tabs" role="tablist" aria-label="Which games to prepare">
              <SelectionTab
                active={selectionKind === 'current-round'}
                onClick={() => setSelectionKind('current-round')}
              >
                Current round
              </SelectionTab>
              <SelectionTab
                active={selectionKind === 'released'}
                onClick={() => setSelectionKind('released')}
              >
                All released
              </SelectionTab>
              <SelectionTab
                active={selectionKind === 'unconnected-rooms'}
                onClick={() => setSelectionKind('unconnected-rooms')}
              >
                Rooms without QBTCP
              </SelectionTab>
            </div>
            <p className="director-panel-footnote">
              {plan.assignments.length} file{plan.assignments.length === 1 ? '' : 's'} would be prepared.
              Preparing files for rooms that are already connected is a backup, not a mistake — the room keeps
              whichever copy it needs.
            </p>
            {plan.warnings.map((warning) => (
              <p className="director-panel-footnote" key={warning}>
                {warning}
              </p>
            ))}
            {plan.failures.length > 0 && (
              <p className="director-error-copy" role="alert">
                {plan.failures.length} game{plan.failures.length === 1 ? '' : 's'} cannot be prepared:{' '}
                {plan.failures[0]?.reason}
              </p>
            )}
          </div>
          {state.transfers.locations.some((location) => location.connected && !location.readOnly) && (
            <div className="director-panel-footer">
              {state.transfers.locations
                .filter((location) => location.connected && !location.readOnly)
                .map((location) => (
                  <Button
                    key={location.id}
                    variant="primary"
                    icon="upload"
                    disabled={transfers.busy || plan.assignments.length === 0}
                    onClick={() => void transfers.prepareTo(location.id, selection)}
                  >
                    {location.kind === 'removable-drive' ? 'Prepare USB' : 'Prepare files'} · {location.label}
                  </Button>
                ))}
            </div>
          )}
        </section>

        <section className="director-panel">
          <div className="director-panel-heading">
            <div>
              <p className="director-eyebrow">Recent</p>
              <h2>Transfer history</h2>
            </div>
          </div>
          {state.transfers.events.length === 0 ? (
            <div className="director-panel-body">
              <p className="director-empty-copy">Nothing has been transferred yet.</p>
            </div>
          ) : (
            <div className="director-panel-body director-panel-body-list">
              <ul className="director-list director-plain-list">
                {state.transfers.events.slice(0, 25).map((event) => (
                  <li key={event.id}>
                    <div>
                      <strong>{event.summary}</strong>
                      {event.detail && <small className="director-table-subtext">{event.detail}</small>}
                    </div>
                    <span>{formatTime(event.at)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

function LocationRow({
  location,
  advice,
  busy,
  onScan,
  onPrepare,
  onInitialize,
  onWatch,
  onRemove,
}: {
  location: TransferLocation;
  advice?: string;
  busy: boolean;
  onScan: () => void;
  onPrepare: () => void;
  onInitialize: () => void;
  onWatch: (watching: boolean) => void;
  onRemove: () => void;
}) {
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
    <li className="director-transfer-row">
      <div>
        <strong>{location.label}</strong>
        <small className="director-table-subtext">
          {location.kind === 'removable-drive' ? 'USB drive' : 'Folder'}
          {location.cloudProvider ? ` · ${location.cloudProvider}` : ''} · {location.path}
        </small>
        {advice && <small className="director-table-subtext">{advice}</small>}
        {location.message && <small className="director-table-subtext">{location.message}</small>}
      </div>
      <StateLabel state={stateName} label={stateText} />
      <div className="director-round-row-actions">
        {location.connected && (
          <>
            <Button variant="quiet" disabled={busy} onClick={onScan}>
              Scan
            </Button>
            <Button variant="quiet" onClick={() => onWatch(!location.watching)}>
              {location.watching ? 'Stop watching' : 'Watch'}
            </Button>
            {!location.readOnly && (
              <>
                <Button variant="quiet" onClick={onInitialize}>
                  Set up
                </Button>
                <Button variant="secondary" disabled={busy} onClick={onPrepare}>
                  Prepare
                </Button>
              </>
            )}
          </>
        )}
        <Button variant="quiet" onClick={onRemove}>
          Remove
        </Button>
      </div>
    </li>
  );
}

function ArtifactRow({
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
  const left = scheduled ? teamName(state, scheduled.leftTeamId) : undefined;
  const right = scheduled?.rightTeamId ? teamName(state, scheduled.rightTeamId) : undefined;
  return (
    <tr>
      <td>
        <strong>{artifact.fileName}</strong>
        {artifact.detail && <small className="director-table-subtext">{artifact.detail}</small>}
        {artifact.warnings.length > 0 && (
          <small className="director-table-subtext">{artifact.warnings.map(describeWarning).join(' ')}</small>
        )}
      </td>
      <td>
        {scheduled ? (
          <>
            <strong>
              {left} · {right}
            </strong>
            <small className="director-table-subtext">
              {[room?.name, round?.name].filter(Boolean).join(' · ') || 'Scheduled game'}
            </small>
          </>
        ) : (
          <span className="director-table-subtext">Not matched</span>
        )}
      </td>
      <td>{artifact.sourceLabel}</td>
      <td>
        <StateLabel state={classificationState(artifact)} label={classificationLabel(artifact)} />
      </td>
      <td>
        <div className="director-row-actions">
          {artifact.status === 'staged' && (
            <Button variant="quiet" onClick={onReview}>
              Review
            </Button>
          )}
          {artifact.status !== 'ignored' && (
            <Button variant="quiet" onClick={onDismiss}>
              Dismiss
            </Button>
          )}
        </div>
      </td>
    </tr>
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

function SelectionTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`director-filter-tab ${active ? 'is-active' : ''}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function teamName(state: DirectorState, teamId: string | null): string {
  return teamId ? (state.teams.find((team) => team.id === teamId)?.displayName ?? 'Unknown team') : 'Bye';
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export { transportLabel };
