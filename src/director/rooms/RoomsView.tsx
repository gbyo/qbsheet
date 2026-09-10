import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  deriveOperationalRoom,
  qbtcpSessionHasUnresolvedWork,
  roomIsAssignable,
  type DirectorId,
  type DirectorState,
  type OperationalRoomView,
  type StaffRole,
} from '../domain';
import type { DirectorController } from '../state/useDirectorController';
import {
  ActionMenu,
  AdvancedSection,
  Button,
  Callout,
  Checkbox,
  CheckboxGroup,
  Combobox,
  Diagnostics,
  Dialog,
  DialogSection,
  EmptyState,
  Field,
  FieldGrid,
  MenuItem,
  Page,
  PageHeader,
  Panel,
  Segmented,
  Select,
  StateLabel,
  SummaryItem,
  SummaryList,
  TextArea,
  TextInput,
  useConfirm,
  type SelectOption,
} from '../components';
import type { SectionId } from '../app/navigation';
import type { DirectorNavigationTarget } from '../app/navigationTarget';
import { isNativeDirector, issueNativeRoomPairing, resetNativeQbtcpCredentials } from '../platform/native';
import { buildInternetPairing } from '../relay/relayPairing';
import { localStorageRelayPanelStore, RelayPanel } from '../relay/RelayPanel';
import type { RelayConfig } from '../relay/relayConfig';
import type { NativeServerState } from '../server/useNativeServerStatus';
import {
  deriveQbtcpOperationalHealth,
  qbtcpHealthNeedsAttention,
  qbtcpHealthSummary,
  type QbtcpOperationalHealth,
} from '../server/qbtcpHealth';
import { errorNotice, type AnnounceInput } from '../notices';
import {
  AssignmentDialog,
  DutyPanel,
  OperationalEquipmentSummary,
  OperationalRoomSummary,
  OperationalStaffSummary,
  OperationsEmptyState,
  OperationsScopeControl,
  PrepareOperationsPanel,
  ResourceImpactDialog,
  RoundReadinessSummary,
  equipmentKindLabel,
  staffRoleOptions,
  useOperationsContext,
  type OperationsContext,
  type OperationsScope,
  type PendingUnavailability,
} from './operations';

type EquipmentKind = DirectorState['equipment'][number]['kind'];
type LogisticsView = 'rooms' | 'staff' | 'equipment' | 'requests';
type RoomFilter = 'all' | 'assignable' | 'active' | 'attention';

const logisticsViewOrder: Record<LogisticsView, number> = {
  rooms: 0,
  staff: 1,
  equipment: 2,
  requests: 3,
};

interface RoomDraft {
  name: string;
  building: string;
  floor: string;
  accessibility: string;
  directions: string;
  notes: string;
  moderatorId: string;
  scorekeeperId: string;
  equipmentId: string;
  available: boolean;
}
interface StaffDraft {
  name: string;
  roles: StaffRole[];
  notes: string;
  available: boolean;
}
interface EquipmentDraft {
  name: string;
  kind: EquipmentKind;
  notes: string;
  available: boolean;
}

const blankRoom = (): RoomDraft => ({
  name: '',
  building: '',
  floor: '',
  accessibility: '',
  directions: '',
  notes: '',
  moderatorId: '',
  scorekeeperId: '',
  equipmentId: '',
  available: true,
});
const blankStaff = (): StaffDraft => ({ name: '', roles: ['moderator'], notes: '', available: true });
const blankEquipment = (): EquipmentDraft => ({ name: '', kind: 'buzzer', notes: '', available: true });

export function RoomsView({
  state,
  controller,
  onNavigate,
  onAnnounce,
  navigationTarget,
  onClearNavigationTarget,
  server: nativeServer,
  relayPointer: controlledRelayPointer,
  onRelayPointerChange,
}: {
  state: DirectorState;
  controller: DirectorController;
  onNavigate?: (section: SectionId) => void;
  onAnnounce: (announcement: AnnounceInput) => void;
  navigationTarget?: DirectorNavigationTarget | null;
  onClearNavigationTarget?: () => void;
  server?: NativeServerState;
  relayPointer?: RelayConfig | null;
  onRelayPointerChange?: (config: RelayConfig | null) => void;
}) {
  const [view, setView] = useState<LogisticsView>('rooms');
  const [viewDirection, setViewDirection] = useState<'forward' | 'backward' | null>(null);
  const [filter, setFilter] = useState<RoomFilter>('all');
  const [scope, setScope] = useState<OperationsScope>('current');
  const [editingAssignmentId, setEditingAssignmentId] = useState<string | null>(null);
  const [pendingUnavailability, setPendingUnavailability] = useState<PendingUnavailability | null>(null);
  const [editingRoomId, setEditingRoomId] = useState<string | null | 'new'>(null);
  const [editingStaffId, setEditingStaffId] = useState<string | null | 'new'>(null);
  const [editingEquipmentId, setEditingEquipmentId] = useState<string | null | 'new'>(null);
  const [pairingRoomId, setPairingRoomId] = useState<string | null>(null);
  const [resettingPairings, setResettingPairings] = useState(false);
  const [amendmentMappings, setAmendmentMappings] = useState<Record<string, string>>({});
  const confirmAction = useConfirm();

  const targetRoomId =
    navigationTarget?.section === 'rooms' && navigationTarget.entityType === 'room'
      ? navigationTarget.entityId
      : undefined;
  // A deep link to a room selects the Rooms view. This adjusts state during
  // render rather than from an effect: the effect version rendered the wrong
  // view once before correcting itself, which is visible as a flash when
  // arriving from global search or an Overview attention item.
  const [appliedRoomTarget, setAppliedRoomTarget] = useState<string | undefined>(targetRoomId);
  if (targetRoomId && targetRoomId !== appliedRoomTarget) {
    setAppliedRoomTarget(targetRoomId);
    setViewDirection(null);
    setView('rooms');
  }

  // One derivation for the whole page. Rooms, staff, equipment, duties, the readiness summary and
  // the prepare panel are all views of this, which is what keeps them from disagreeing.
  const operationsContext = useOperationsContext(state, scope);
  const { operations } = operationsContext;

  const qbtcpStatus = nativeServer?.status ?? null;
  const qbtcpLoading = nativeServer?.loading ?? false;
  const nativeDirector = isNativeDirector();
  const qbtcpOperationalHealth: QbtcpOperationalHealth | null = nativeServer
    ? deriveQbtcpOperationalHealth(qbtcpLoading ? null : qbtcpStatus, controller.qbtcpHealth)
    : null;
  const qbtcpRunning = qbtcpStatus?.running ?? false;
  const qbtcpNeedsAttention =
    nativeDirector && qbtcpOperationalHealth ? qbtcpHealthNeedsAttention(qbtcpOperationalHealth) : false;
  const invitations = qbtcpStatus?.pairingInvitations ?? [];
  // The claimed relay pointer, shared by the operator panel (which edits it) and the room
  // invitations (which pair from it). The sync engine (#773) will move this into the
  // tournament document; until then the panel's store is the source of truth.
  const [storedRelayPointer, setStoredRelayPointer] = useState<RelayConfig | null>(() =>
    localStorageRelayPanelStore().load(),
  );
  const relayPointer = controlledRelayPointer === undefined ? storedRelayPointer : controlledRelayPointer;
  const setRelayPointer = (config: RelayConfig | null) => {
    setStoredRelayPointer(config);
    onRelayPointerChange?.(config);
  };
  const internetRelay =
    relayPointer?.enabled &&
    (relayPointer.directorTournamentId === state.tournament?.id ||
      (controlledRelayPointer === undefined && relayPointer.directorTournamentId === undefined)) &&
    relayPointer.baseUrl &&
    relayPointer.tournamentId
      ? { baseUrl: relayPointer.baseUrl, tournamentId: relayPointer.tournamentId }
      : null;
  const assignableRoomIds = useMemo(
    () => new Set(state.rooms.filter((room) => roomIsAssignable(state, room.id)).map((room) => room.id)),
    [state],
  );
  const pairingRooms = state.rooms.filter((room) => assignableRoomIds.has(room.id));
  const helpRequests = [...state.qbtcpHelpRequests].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
  const rosterAmendments = [...state.qbtcpRosterAmendments].reverse();
  const openHelpCount = helpRequests.filter((request) => request.status === 'open').length;
  const pendingAmendments = rosterAmendments.filter((entry) => entry.status === 'pending').length;
  const attentionCount = openHelpCount + pendingAmendments;

  // Filters read the derived readiness rather than the persisted `Room.status`, which is written
  // by six independent workflows and drifts from what the room is actually doing.
  const roomViews = operations.rooms;
  const activeRoomCount = roomViews.filter((entry) =>
    ['playing', 'awaiting-result', 'connected'].includes(entry.readiness),
  ).length;
  const attentionRoomCount = roomViews.filter((entry) =>
    ['help', 'blocked', 'offline'].includes(entry.readiness),
  ).length;
  const filteredRoomViews = roomViews.filter((entry) => {
    if (entry.room.id === targetRoomId) return true;
    if (filter === 'all') return true;
    if (filter === 'assignable') return entry.assignable;
    if (filter === 'active') {
      return ['playing', 'awaiting-result', 'connected'].includes(entry.readiness);
    }
    return ['help', 'blocked', 'offline'].includes(entry.readiness);
  });

  const toggleServer = async () => {
    if (!nativeServer) return;
    try {
      const next = await nativeServer.toggle();
      onAnnounce(next.message ?? (next.running ? 'QBTCP server started.' : 'QBTCP server stopped.'));
    } catch (reason: unknown) {
      onAnnounce(
        errorNotice(reason instanceof Error ? reason.message : 'The QBTCP server could not be changed.'),
      );
    }
  };

  const copyPairingLink = async (url: string, message: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable.');
      await navigator.clipboard.writeText(url);
      onAnnounce(message);
    } catch {
      onAnnounce(errorNotice('The pairing link could not be copied; use the link shown in the desktop app.'));
    }
  };

  const issuePairing = async (roomId: string) => {
    if (!nativeServer) return;
    setPairingRoomId(roomId);
    try {
      const invitation = await issueNativeRoomPairing(roomId);
      nativeServer.addInvitation(invitation);
      onAnnounce(`Pairing invitation issued for ${invitation.roomName}.`);
    } catch (reason: unknown) {
      onAnnounce(
        errorNotice(
          reason instanceof Error ? reason.message : 'A room pairing invitation could not be issued.',
        ),
      );
    } finally {
      setPairingRoomId(null);
    }
  };

  const setAdvertisedAddress = async (address: string) => {
    if (!nativeServer) return;
    try {
      const next = await nativeServer.setAdvertisedAddress(address);
      onAnnounce(next.message ?? `QBTCP pairing links will use ${address}.`);
    } catch (reason: unknown) {
      onAnnounce(
        errorNotice(
          reason instanceof Error ? reason.message : 'The QBTCP advertised address could not be set.',
        ),
      );
    }
  };

  const resetPairings = async () => {
    if (!nativeServer) return;
    const approved = await confirmAction({
      title: 'Reset all QBTCP pairings?',
      body: 'Use this only when you intend to revoke the current scorer authority for this tournament.',
      consequence:
        'Every paired scorer and open session will be disconnected and will need a fresh room invitation.',
      confirmLabel: 'Reset all pairings',
      tone: 'danger',
    });
    if (!approved) return;
    setResettingPairings(true);
    try {
      const next = await resetNativeQbtcpCredentials();
      nativeServer.apply(next);
      onAnnounce(next.message ?? 'QBTCP pairings were reset.');
    } catch (reason: unknown) {
      onAnnounce(
        errorNotice(reason instanceof Error ? reason.message : 'QBTCP pairings could not be reset.'),
      );
    } finally {
      setResettingPairings(false);
    }
  };

  const changeView = (nextView: LogisticsView) => {
    if (nextView === view) return;
    setViewDirection(logisticsViewOrder[nextView] > logisticsViewOrder[view] ? 'forward' : 'backward');
    setView(nextView);
  };

  /**
   * Route an operational deep link.
   *
   * A target inside Operations switches to the right subview rather than leaving the page; a
   * target elsewhere hands off to the shell. This is what makes "Replace Bob" land on Bob instead
   * of on the Operations page with Bob somewhere in it.
   */
  const navigateToTarget = (target: DirectorNavigationTarget) => {
    if (target.section !== 'rooms') {
      onNavigate?.(target.section);
      return;
    }
    const nextView: LogisticsView =
      target.entityType === 'staff' ? 'staff' : target.entityType === 'equipment' ? 'equipment' : 'rooms';
    changeView(nextView);
    if (target.entityType === 'game' && target.entityId) setEditingAssignmentId(target.entityId);
  };

  const primaryAdd =
    view === 'rooms' ? (
      <Button variant="primary" icon="plus" onClick={() => setEditingRoomId('new')}>
        Add room
      </Button>
    ) : view === 'staff' ? (
      <Button variant="primary" icon="plus" onClick={() => setEditingStaffId('new')}>
        Add staff
      </Button>
    ) : view === 'equipment' ? (
      <Button variant="primary" icon="plus" onClick={() => setEditingEquipmentId('new')}>
        Add equipment
      </Button>
    ) : undefined;

  const summaryLine = [
    `${state.staff.length} staff total`,
    `${operations.summary.moderators} moderator${operations.summary.moderators === 1 ? '' : 's'}`,
    `${operations.summary.scorekeepers} scorekeeper${operations.summary.scorekeepers === 1 ? '' : 's'}`,
    ...(operations.summary.runners > 0 ? [`${operations.summary.runners} runner`] : []),
    ...(operations.summary.hq > 0 ? [`${operations.summary.hq} HQ`] : []),
    `${operations.summary.unstaffedActiveRooms} unstaffed active room${operations.summary.unstaffedActiveRooms === 1 ? '' : 's'}`,
  ].join(' · ');

  return (
    <Page>
      <PageHeader
        title="Operations"
        description={
          state.rooms.length === 0 && state.staff.length === 0
            ? 'Rooms, staff, equipment, and who is operating where.'
            : summaryLine
        }
        actions={primaryAdd}
      />

      <OperationsScopeControl state={state} scope={scope} onChange={setScope} />

      {operationsContext.roundId && operations.summary.games > 0 && (
        <RoundReadinessSummary operations={operations} roundName={operationsContext.roundName} />
      )}

      <Segmented<LogisticsView>
        value={view}
        onChange={changeView}
        ariaLabel="Logistics view"
        options={[
          { value: 'rooms', label: `Rooms ${state.rooms.length}` },
          { value: 'staff', label: `Staff ${state.staff.length}` },
          { value: 'equipment', label: `Equipment ${state.equipment.length}` },
          { value: 'requests', label: attentionCount ? `Requests ${attentionCount}` : 'Requests' },
        ]}
      />

      <div key={view} className="director-logistics-view" data-direction={viewDirection ?? undefined}>
        {view === 'rooms' && (
          <>
            <PrepareOperationsPanel
              state={state}
              controller={controller}
              context={operationsContext}
              onAnnounce={onAnnounce}
              onNavigate={navigateToTarget}
            />
            <RoomsLogisticsView
              state={state}
              controller={controller}
              context={operationsContext}
              roomViews={filteredRoomViews}
              filter={filter}
              setFilter={setFilter}
              assignableCount={roomViews.filter((entry) => entry.assignable).length}
              activeCount={activeRoomCount}
              attentionCount={attentionRoomCount}
              onNavigate={navigateToTarget}
              onAnnounce={onAnnounce}
              navigationTarget={navigationTarget}
              onClearNavigationTarget={onClearNavigationTarget}
              onEditRoom={(roomId) => setEditingRoomId(roomId)}
              onEditAssignment={(gameId) => setEditingAssignmentId(gameId)}
              onPair={nativeServer ? (roomId) => void issuePairing(roomId) : undefined}
              onAdd={() => setEditingRoomId('new')}
            />
            <DutyPanel
              state={state}
              controller={controller}
              context={operationsContext}
              onAnnounce={onAnnounce}
            />
          </>
        )}

        {view === 'staff' && (
          <ResourceView
            title="Staff"
            description="Where each person is working now and next, and what is blocking them."
            emptyTitle="No staff yet"
            emptyDescription="Add staff only when you want Director to track room assignments."
            addLabel="Add staff member"
            onAdd={() => setEditingStaffId('new')}
          >
            <SummaryList ariaLabel="Staff">
              {operations.staff.map((staffView) => (
                <OperationalStaffSummary
                  key={staffView.staff.id}
                  view={staffView}
                  controller={controller}
                  onAnnounce={onAnnounce}
                  onNavigate={navigateToTarget}
                  onEdit={() => setEditingStaffId(staffView.staff.id)}
                  onMarkUnavailable={() =>
                    setPendingUnavailability({ kind: 'staff', id: staffView.staff.id })
                  }
                  navigationTarget={navigationTarget}
                  onClearNavigationTarget={onClearNavigationTarget}
                />
              ))}
            </SummaryList>
          </ResourceView>
        )}

        {view === 'equipment' && (
          <ResourceView
            title="Equipment"
            description="Where each resource is now and next, and which rounds depend on it."
            emptyTitle="No equipment yet"
            emptyDescription="Equipment tracking is optional until you need it."
            addLabel="Add equipment"
            onAdd={() => setEditingEquipmentId('new')}
          >
            <SummaryList ariaLabel="Equipment">
              {operations.equipment.map((equipmentView) => (
                <OperationalEquipmentSummary
                  key={equipmentView.equipment.id}
                  view={equipmentView}
                  controller={controller}
                  onAnnounce={onAnnounce}
                  onNavigate={navigateToTarget}
                  onEdit={() => setEditingEquipmentId(equipmentView.equipment.id)}
                  onMarkUnavailable={() =>
                    setPendingUnavailability({ kind: 'equipment', id: equipmentView.equipment.id })
                  }
                  navigationTarget={navigationTarget}
                  onClearNavigationTarget={onClearNavigationTarget}
                />
              ))}
            </SummaryList>
          </ResourceView>
        )}

        {view === 'requests' && (
          <RequestsView
            state={state}
            controller={controller}
            helpRequests={helpRequests}
            rosterAmendments={rosterAmendments}
            mappings={amendmentMappings}
            setMappings={setAmendmentMappings}
            onAnnounce={onAnnounce}
          />
        )}
      </div>

      {nativeServer && (
        <AdvancedSection
          label={qbtcpRunning || qbtcpNeedsAttention ? 'QBTCP local network' : 'Set up QBTCP local network'}
          hint={
            qbtcpRunning
              ? qbtcpOperationalHealth
                ? qbtcpHealthSummary(qbtcpOperationalHealth)
                : 'Checking native server'
              : qbtcpNeedsAttention
                ? qbtcpOperationalHealth
                  ? qbtcpHealthSummary(qbtcpOperationalHealth)
                  : 'Server needs attention'
                : 'Optional for network-connected scorekeepers'
          }
          icon="network"
          defaultOpen={qbtcpRunning || qbtcpNeedsAttention}
        >
          <QbtcpNetwork
            state={state}
            nativeServer={nativeServer}
            nativeDirector={nativeDirector}
            qbtcpLoading={qbtcpLoading}
            qbtcpRunning={qbtcpRunning}
            qbtcpNeedsAttention={qbtcpNeedsAttention}
            qbtcpOperationalHealth={qbtcpOperationalHealth}
            pairingRooms={pairingRooms}
            invitations={invitations}
            expiredPairingRoomIds={qbtcpStatus?.expiredPairingRoomIds ?? []}
            pairingRoomId={pairingRoomId}
            resettingPairings={resettingPairings}
            onToggle={() => void toggleServer()}
            onReset={() => void resetPairings()}
            onIssue={(roomId) => void issuePairing(roomId)}
            onCopy={(url, message) => void copyPairingLink(url, message)}
            onSetAddress={setAdvertisedAddress}
            internetRelay={internetRelay}
          />
        </AdvancedSection>
      )}

      {nativeServer && (
        <AdvancedSection
          label="Internet QBTCP"
          hint="Tournament-owned relay as the primary scoring address, with LAN fallback"
          icon="network"
          defaultOpen={false}
        >
          <RelayPanel
            directorTournamentId={state.tournament?.id}
            lan={{
              available: qbtcpRunning && Boolean(qbtcpStatus?.address),
              address:
                qbtcpRunning && qbtcpStatus?.address
                  ? `${qbtcpStatus.address}${qbtcpStatus.port ? `:${qbtcpStatus.port}` : ''}`
                  : null,
              // The native status carries no local-network permission signal today; the
              // relay status model already warns when one is reported.
              permissionIssue: null,
            }}
            onPointerChange={setRelayPointer}
            onAnnounce={onAnnounce}
          />
        </AdvancedSection>
      )}

      {editingRoomId && (
        <RoomDialog
          key={editingRoomId}
          state={state}
          room={editingRoomId === 'new' ? undefined : state.rooms.find((room) => room.id === editingRoomId)}
          controller={controller}
          onAnnounce={onAnnounce}
          onClose={() => setEditingRoomId(null)}
        />
      )}
      {editingStaffId && (
        <StaffDialog
          key={editingStaffId}
          member={
            editingStaffId === 'new' ? undefined : state.staff.find((member) => member.id === editingStaffId)
          }
          controller={controller}
          onAnnounce={onAnnounce}
          onClose={() => setEditingStaffId(null)}
        />
      )}
      {editingAssignmentId && (
        <AssignmentDialog
          key={editingAssignmentId}
          state={state}
          controller={controller}
          scheduledGameId={editingAssignmentId}
          onAnnounce={onAnnounce}
          onClose={() => setEditingAssignmentId(null)}
        />
      )}
      {pendingUnavailability && (
        <ResourceImpactDialog
          key={`${pendingUnavailability.kind}-${pendingUnavailability.id}`}
          state={state}
          controller={controller}
          pending={pendingUnavailability}
          onAnnounce={onAnnounce}
          onClose={() => setPendingUnavailability(null)}
        />
      )}
      {editingEquipmentId && (
        <EquipmentDialog
          key={editingEquipmentId}
          item={
            editingEquipmentId === 'new'
              ? undefined
              : state.equipment.find((item) => item.id === editingEquipmentId)
          }
          controller={controller}
          onAnnounce={onAnnounce}
          onClose={() => setEditingEquipmentId(null)}
        />
      )}
    </Page>
  );
}

function RoomsLogisticsView({
  state,
  controller,
  context,
  roomViews,
  filter,
  setFilter,
  assignableCount,
  activeCount,
  attentionCount,
  onNavigate,
  onAnnounce,
  navigationTarget,
  onClearNavigationTarget,
  onEditRoom,
  onEditAssignment,
  onPair,
  onAdd,
}: {
  state: DirectorState;
  controller: DirectorController;
  context: OperationsContext;
  roomViews: OperationalRoomView[];
  filter: RoomFilter;
  setFilter: (filter: RoomFilter) => void;
  assignableCount: number;
  activeCount: number;
  attentionCount: number;
  onNavigate: (target: DirectorNavigationTarget) => void;
  onAnnounce: (announcement: AnnounceInput) => void;
  navigationTarget?: DirectorNavigationTarget | null;
  onClearNavigationTarget?: () => void;
  onEditRoom: (roomId: string) => void;
  onEditAssignment: (scheduledGameId: DirectorId) => void;
  onPair?: (roomId: string) => void;
  onAdd: () => void;
}) {
  if (state.rooms.length === 0) return <OperationsEmptyState onAdd={onAdd} />;
  return (
    <Panel
      title="Rooms"
      description={
        context.roundName
          ? `What each room is doing in ${context.roundName}, and what happens next.`
          : 'What each room is doing, and what happens next.'
      }
      actions={
        <Segmented<RoomFilter>
          value={filter}
          onChange={setFilter}
          ariaLabel="Room filter"
          options={[
            { value: 'all', label: 'All' },
            { value: 'assignable', label: `Assignable ${assignableCount}` },
            { value: 'active', label: `Active ${activeCount}` },
            { value: 'attention', label: `Attention ${attentionCount}` },
          ]}
        />
      }
      flush
    >
      {roomViews.length === 0 ? (
        <div className="director-empty-in-panel">
          <p className="director-empty-copy">No rooms match this filter.</p>
          <Button variant="quiet" onClick={() => setFilter('all')}>
            Show all rooms
          </Button>
        </div>
      ) : (
        <SummaryList ariaLabel="Rooms">
          {roomViews.map((view) => (
            <OperationalRoomSummary
              key={view.room.id}
              state={state}
              view={view}
              context={context}
              controller={controller}
              onAnnounce={onAnnounce}
              onNavigate={onNavigate}
              onEditRoom={() => onEditRoom(view.room.id)}
              onEditAssignment={onEditAssignment}
              onPair={onPair && view.assignable ? () => onPair(view.room.id) : undefined}
              navigationTarget={navigationTarget}
              onClearNavigationTarget={onClearNavigationTarget}
              extra={
                view.room.accessibility ||
                view.room.directions ||
                view.room.notes ||
                roomQbtcpHasDetail(state, view.room.id) ? (
                  <Diagnostics
                    label="Room details & QBTCP"
                    standalone={false}
                    hint="Wayfinding, notes, and connection telemetry."
                  >
                    {view.room.accessibility && (
                      <p>
                        <strong>Accessibility:</strong> {view.room.accessibility}
                      </p>
                    )}
                    {view.room.directions && (
                      <p>
                        <strong>Directions:</strong> {view.room.directions}
                      </p>
                    )}
                    {view.room.notes && (
                      <p>
                        <strong>Notes:</strong> {view.room.notes}
                      </p>
                    )}
                    {roomQbtcpHasDetail(state, view.room.id) && (
                      <RoomQbtcpTelemetry state={state} roomId={view.room.id} />
                    )}
                  </Diagnostics>
                ) : undefined
              }
            />
          ))}
        </SummaryList>
      )}
    </Panel>
  );
}

function RoomDialog({
  state,
  room,
  controller,
  onAnnounce,
  onClose,
}: {
  state: DirectorState;
  room?: DirectorState['rooms'][number];
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<RoomDraft>(() =>
    room
      ? {
          name: room.name,
          building: room.building ?? '',
          floor: room.floor ?? '',
          accessibility: room.accessibility ?? '',
          directions: room.directions ?? '',
          notes: room.notes ?? '',
          moderatorId: room.moderatorId ?? '',
          scorekeeperId: room.scorekeeperId ?? '',
          equipmentId: room.equipmentId ?? '',
          available: room.available,
        }
      : blankRoom(),
  );
  const set = <K extends keyof RoomDraft>(key: K, value: RoomDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const save = () => {
    if (!draft.name.trim()) {
      onAnnounce(errorNotice('Enter a room name first.'));
      return;
    }
    const payload = {
      name: draft.name.trim(),
      building: draft.building.trim(),
      floor: draft.floor.trim(),
      accessibility: draft.accessibility,
      directions: draft.directions,
      notes: draft.notes,
      moderatorId: draft.moderatorId || null,
      scorekeeperId: draft.scorekeeperId || null,
      equipmentId: draft.equipmentId || null,
      available: draft.available,
    };
    const saved = room ? controller.updateRoom(room.id, payload) : controller.addRoom(payload);
    if (!saved) {
      onAnnounce(
        errorNotice(`The room could not be ${room ? 'updated' : 'added'}; review the Director error.`),
      );
      return;
    }
    onAnnounce(`${draft.name.trim()} ${room ? 'updated' : 'added'}.`);
    onClose();
  };
  const moderatorOptions: SelectOption[] = [
    { value: '', label: 'Unassigned' },
    ...staffForRole(state, 'moderator', draft.moderatorId).map((member) => ({
      value: member.id,
      label: member.name,
    })),
  ];
  const scorekeeperOptions: SelectOption[] = [
    { value: '', label: 'Unassigned' },
    ...staffForRole(state, 'scorekeeper', draft.scorekeeperId).map((member) => ({
      value: member.id,
      label: member.name,
    })),
  ];
  const equipmentOptions: SelectOption[] = [
    { value: '', label: 'Unassigned' },
    ...state.equipment
      .filter((item) => item.available || item.id === draft.equipmentId)
      .map((item) => ({ value: item.id, label: item.name, detail: equipmentKindLabel(item.kind) })),
  ];
  return (
    <Dialog
      title={room ? `Edit ${room.name}` : 'Add room'}
      description="Room logistics, staffing, and future assignability are saved together."
      size="lg"
      onClose={onClose}
      onSubmit={save}
      submitLabel={room ? 'Save changes' : 'Add room'}
    >
      <DialogSection title="Location">
        <FieldGrid>
          <Field label="Room name">
            <TextInput value={draft.name} onChange={(event) => set('name', event.target.value)} />
          </Field>
          <Field label="Building" optional>
            <TextInput value={draft.building} onChange={(event) => set('building', event.target.value)} />
          </Field>
          <Field label="Floor" optional>
            <TextInput value={draft.floor} onChange={(event) => set('floor', event.target.value)} />
          </Field>
          <Field label="Accessibility" optional>
            <TextInput
              value={draft.accessibility}
              onChange={(event) => set('accessibility', event.target.value)}
              placeholder="Step-free entrance"
            />
          </Field>
          <Field label="Directions" optional spanAll>
            <TextInput
              value={draft.directions}
              onChange={(event) => set('directions', event.target.value)}
              placeholder="East stairwell, first door on the left"
            />
          </Field>
          <Field label="Notes" optional spanAll>
            <TextArea rows={2} value={draft.notes} onChange={(event) => set('notes', event.target.value)} />
          </Field>
        </FieldGrid>
      </DialogSection>
      <DialogSection
        title="Assignments"
        description="Leave any resource unassigned when you do not want Director to track it."
      >
        <FieldGrid>
          <Field
            label="Moderator"
            render={({ id, labelId, describedBy }) => (
              <Select
                id={id}
                ariaLabelledBy={labelId}
                ariaDescribedBy={describedBy}
                value={draft.moderatorId}
                options={moderatorOptions}
                onChange={(value) => set('moderatorId', value)}
              />
            )}
          />
          <Field
            label="Scorekeeper"
            render={({ id, labelId, describedBy }) => (
              <Select
                id={id}
                ariaLabelledBy={labelId}
                ariaDescribedBy={describedBy}
                value={draft.scorekeeperId}
                options={scorekeeperOptions}
                onChange={(value) => set('scorekeeperId', value)}
              />
            )}
          />
          <Field
            label="Equipment"
            render={({ id, labelId, describedBy }) => (
              <Select
                id={id}
                ariaLabelledBy={labelId}
                ariaDescribedBy={describedBy}
                value={draft.equipmentId}
                options={equipmentOptions}
                onChange={(value) => set('equipmentId', value)}
              />
            )}
          />
        </FieldGrid>
        <Checkbox
          checked={draft.available}
          label="Available for future assignment"
          hint="Current game/session state is tracked separately; this controls whether future rounds can use the room."
          onChange={(checked) => set('available', checked)}
        />
      </DialogSection>
    </Dialog>
  );
}

function ResourceView({
  title,
  description,
  emptyTitle,
  emptyDescription,
  addLabel,
  onAdd,
  children,
}: {
  title: string;
  description: string;
  emptyTitle: string;
  emptyDescription: string;
  addLabel: string;
  onAdd: () => void;
  children: ReactNode;
}) {
  const hasItems = Array.isArray(children) ? children.length > 0 : true;
  return (
    <Panel title={title} description={description} flush>
      {hasItems ? (
        children
      ) : (
        <EmptyState title={emptyTitle} description={emptyDescription}>
          <Button variant="primary" icon="plus" onClick={onAdd}>
            {addLabel}
          </Button>
        </EmptyState>
      )}
    </Panel>
  );
}

function StaffDialog({
  member,
  controller,
  onAnnounce,
  onClose,
}: {
  member?: DirectorState['staff'][number];
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<StaffDraft>(() =>
    member
      ? {
          name: member.name,
          roles: member.roles.length ? [...member.roles] : ['moderator'],
          notes: member.notes ?? '',
          available: member.available,
        }
      : blankStaff(),
  );
  const save = () => {
    if (!draft.name.trim()) {
      onAnnounce(errorNotice('Enter a staff name first.'));
      return;
    }
    if (!draft.roles.length) {
      onAnnounce(errorNotice('Choose at least one staff role.'));
      return;
    }
    const payload = {
      name: draft.name.trim(),
      roles: draft.roles,
      notes: draft.notes,
      available: draft.available,
    };
    const saved = member ? controller.updateStaff(member.id, payload) : controller.addStaff(payload);
    if (!saved) {
      onAnnounce(
        errorNotice(
          `The staff member could not be ${member ? 'updated' : 'added'}; review the Director error.`,
        ),
      );
      return;
    }
    onAnnounce(`${draft.name.trim()} ${member ? 'updated' : 'added to staff'}.`);
    onClose();
  };
  return (
    <Dialog
      title={member ? `Edit ${member.name}` : 'Add staff member'}
      onClose={onClose}
      onSubmit={save}
      submitLabel={member ? 'Save changes' : 'Add staff member'}
    >
      <Field label="Name">
        <TextInput
          value={draft.name}
          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
        />
      </Field>
      <StaffRoleField
        roles={draft.roles}
        onChange={(roles) => setDraft((current) => ({ ...current, roles }))}
      />
      <Field label="Notes" optional>
        <TextArea
          rows={2}
          value={draft.notes}
          onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))}
        />
      </Field>
      <Checkbox
        checked={draft.available}
        label="Available for future assignment"
        onChange={(available) => setDraft((current) => ({ ...current, available }))}
      />
    </Dialog>
  );
}

function EquipmentDialog({
  item,
  controller,
  onAnnounce,
  onClose,
}: {
  item?: DirectorState['equipment'][number];
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<EquipmentDraft>(() =>
    item
      ? { name: item.name, kind: item.kind, notes: item.notes ?? '', available: item.available }
      : blankEquipment(),
  );
  const save = () => {
    if (!draft.name.trim()) {
      onAnnounce(errorNotice('Enter an equipment name first.'));
      return;
    }
    const payload = {
      name: draft.name.trim(),
      kind: draft.kind,
      notes: draft.notes,
      available: draft.available,
    };
    const saved = item ? controller.updateEquipment(item.id, payload) : controller.addEquipment(payload);
    if (!saved) {
      onAnnounce(
        errorNotice(
          `The equipment resource could not be ${item ? 'updated' : 'added'}; review the Director error.`,
        ),
      );
      return;
    }
    onAnnounce(`${draft.name.trim()} ${item ? 'updated' : 'added to equipment'}.`);
    onClose();
  };
  return (
    <Dialog
      title={item ? `Edit ${item.name}` : 'Add equipment'}
      onClose={onClose}
      onSubmit={save}
      submitLabel={item ? 'Save changes' : 'Add equipment'}
    >
      <Field label="Name">
        <TextInput
          value={draft.name}
          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
        />
      </Field>
      <Field
        label="Type"
        render={({ id, describedBy }) => (
          <Select<EquipmentKind>
            id={id}
            ariaDescribedBy={describedBy}
            value={draft.kind}
            options={[
              { value: 'buzzer', label: 'Buzzer' },
              { value: 'device', label: 'Laptop / tablet' },
              { value: 'other', label: 'Other' },
            ]}
            onChange={(kind) => setDraft((current) => ({ ...current, kind }))}
          />
        )}
      />
      <Field label="Notes" optional>
        <TextArea
          rows={2}
          value={draft.notes}
          onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))}
        />
      </Field>
      <Checkbox
        checked={draft.available}
        label="Available for future assignment"
        onChange={(available) => setDraft((current) => ({ ...current, available }))}
      />
    </Dialog>
  );
}

function RequestsView({
  state,
  controller,
  helpRequests,
  rosterAmendments,
  mappings,
  setMappings,
  onAnnounce,
}: {
  state: DirectorState;
  controller: DirectorController;
  helpRequests: DirectorState['qbtcpHelpRequests'];
  rosterAmendments: DirectorState['qbtcpRosterAmendments'];
  mappings: Record<string, string>;
  setMappings: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  onAnnounce: (announcement: AnnounceInput) => void;
}) {
  if (!helpRequests.length && !rosterAmendments.length) {
    return (
      <EmptyState
        title="No operational requests"
        description="QBTCP help requests and roster amendments will appear here when a room sends one."
      />
    );
  }
  return (
    <div className="director-stack">
      {helpRequests.length > 0 && (
        <Panel
          title="Scorekeeper help"
          description="Requests from connected rooms that may need a director decision."
          flush
        >
          <SummaryList ariaLabel="Scorekeeper help requests">
            {helpRequests.map((request) => (
              <SummaryItem
                key={request.id}
                title={
                  <strong>
                    {request.roomName} · {request.category}
                  </strong>
                }
                status={
                  <StateLabel
                    state={request.status === 'open' ? 'help' : 'finished'}
                    label={request.status === 'open' ? 'Open' : request.status}
                  />
                }
                summary={`${request.message} · ${formatTime(request.createdAt)}${request.operatorName ? ` · ${request.operatorName}` : ''}`}
                actions={
                  request.status === 'open' ? (
                    <Button
                      variant="primary"
                      onClick={() => {
                        void controller.resolveQbtcpHelp(request.id).then((resolved) => {
                          if (resolved) onAnnounce(`${request.roomName} help request resolved.`);
                          else
                            onAnnounce(
                              errorNotice(
                                `${request.roomName}'s help request was not resolved; review the Director error.`,
                              ),
                            );
                        });
                      }}
                    >
                      Mark resolved
                    </Button>
                  ) : undefined
                }
              >
                <Diagnostics
                  label="Request details"
                  standalone={false}
                  items={[{ term: 'Device', value: request.deviceId, mono: true }]}
                />
              </SummaryItem>
            ))}
          </SummaryList>
        </Panel>
      )}
      {rosterAmendments.length > 0 && (
        <Panel
          title="Roster amendments"
          description="Reconcile scorekeeper-entered names with the canonical roster."
          flush
        >
          <SummaryList ariaLabel="Roster amendments">
            {rosterAmendments.map((entry) => {
              const playerName = stringField(entry.amendment.playerName) ?? 'Unrecognized player';
              const referencedTeamId = stringField(entry.amendment.teamId);
              const referencedTeamName = stringField(entry.amendment.teamName);
              const referencedTeam = referencedTeamId
                ? state.teams.find((candidate) => candidate.id === referencedTeamId)
                : referencedTeamName
                  ? state.teams.find(
                      (candidate) =>
                        candidate.displayName.trim().toLocaleLowerCase() ===
                        referencedTeamName.toLocaleLowerCase(),
                    )
                  : undefined;
              const team =
                referencedTeam?.displayName ?? referencedTeamName ?? referencedTeamId ?? 'Team unresolved';
              const candidates = state.players.filter(
                (player) => player.active && (!referencedTeam || player.teamId === referencedTeam.id),
              );
              const selectedPlayerId = mappings[entry.id] ?? '';
              return (
                <SummaryItem
                  key={entry.id}
                  title={<strong>{playerName}</strong>}
                  status={
                    <StateLabel
                      state={entry.status === 'pending' ? 'review' : 'finished'}
                      label={rosterAmendmentStatusLabel(entry.status)}
                    />
                  }
                  summary={`${team} · Original scorekeeper submission retained as evidence.${entry.decidedBy ? ` Decided by ${entry.decidedBy}.` : ''}`}
                  actions={
                    entry.status === 'pending' ? (
                      <ActionMenu
                        label={`${playerName} amendment actions`}
                        triggerLabel="Resolve"
                        triggerVariant="primary"
                      >
                        {(close) => (
                          <>
                            <MenuItem
                              onSelect={() => {
                                close();
                                if (controller.approveRosterAmendmentAsNew(entry.id))
                                  onAnnounce(`${playerName} approved as a new canonical player.`);
                                else
                                  onAnnounce(
                                    errorNotice(`${playerName} was not approved; review the Director error.`),
                                  );
                              }}
                            >
                              Approve as new
                            </MenuItem>
                            <MenuItem
                              tone="danger"
                              onSelect={() => {
                                close();
                                if (controller.rejectRosterAmendment(entry.id))
                                  onAnnounce(`${playerName} roster amendment dismissed.`);
                                else
                                  onAnnounce(
                                    errorNotice(
                                      `${playerName}'s roster amendment was not dismissed; review the Director error.`,
                                    ),
                                  );
                              }}
                            >
                              Reject amendment
                            </MenuItem>
                          </>
                        )}
                      </ActionMenu>
                    ) : undefined
                  }
                >
                  {entry.status === 'pending' && (
                    <div className="director-roster-amendment-map">
                      <Field
                        label="Map to existing player"
                        render={({ id, labelId, describedBy }) => (
                          <Combobox
                            id={id}
                            ariaLabelledBy={labelId}
                            ariaDescribedBy={describedBy}
                            value={selectedPlayerId}
                            allowClear
                            placeholder="Search existing players…"
                            options={candidates.map((candidate) => ({
                              value: candidate.id,
                              label: candidate.name,
                              detail: teamName(state, candidate.teamId),
                            }))}
                            onChange={(value) =>
                              setMappings((previous) => ({ ...previous, [entry.id]: value }))
                            }
                          />
                        )}
                      />
                      <Button
                        variant="secondary"
                        disabled={!selectedPlayerId}
                        onClick={() => {
                          if (controller.mapRosterAmendment(entry.id, selectedPlayerId))
                            onAnnounce(`${playerName} mapped to the canonical roster.`);
                          else
                            onAnnounce(
                              errorNotice(`${playerName} was not mapped; review the Director error.`),
                            );
                        }}
                      >
                        Map player
                      </Button>
                    </div>
                  )}
                  <Diagnostics
                    label="Amendment details"
                    standalone={false}
                    items={[{ term: 'Session', value: entry.sessionId, mono: true }]}
                  />
                </SummaryItem>
              );
            })}
          </SummaryList>
        </Panel>
      )}
    </div>
  );
}

function QbtcpNetwork({
  state,
  nativeServer,
  nativeDirector,
  qbtcpLoading,
  qbtcpRunning,
  qbtcpNeedsAttention,
  qbtcpOperationalHealth,
  pairingRooms,
  invitations = [],
  expiredPairingRoomIds = [],
  pairingRoomId,
  resettingPairings,
  onToggle,
  onReset,
  onIssue,
  onCopy,
  onSetAddress,
  internetRelay = null,
}: {
  state: DirectorState;
  nativeServer: NativeServerState;
  nativeDirector: boolean;
  qbtcpLoading: boolean;
  qbtcpRunning: boolean;
  qbtcpNeedsAttention: boolean;
  qbtcpOperationalHealth: QbtcpOperationalHealth | null;
  pairingRooms: DirectorState['rooms'];
  invitations: NonNullable<NativeServerState['status']>['pairingInvitations'];
  expiredPairingRoomIds: string[];
  pairingRoomId: string | null;
  resettingPairings: boolean;
  onToggle: () => void;
  onReset: () => void;
  onIssue: (roomId: string) => void;
  onCopy: (url: string, message: string) => void;
  onSetAddress: (address: string) => Promise<void>;
  /** Enabled tournament relay pointer: invitations copy the Internet link as primary. */
  internetRelay?: { baseUrl: string; tournamentId: string } | null;
}) {
  const status = nativeServer.status;
  const now = useNow(1000);
  const [manualAddress, setManualAddress] = useState('');
  const addressOptions = (status?.addressCandidates ?? []).map((candidate) => ({
    value: candidate.address,
    label: `${candidate.interfaceName} · ${candidate.address}`,
  }));
  const chooseAddress = (address: string) => {
    setManualAddress(address);
    void onSetAddress(address);
  };
  return (
    <div className="director-stack">
      {qbtcpOperationalHealth?.kind === 'error' && (
        <Callout
          tone="danger"
          title={
            qbtcpOperationalHealth.source === 'snapshot'
              ? 'QBTCP snapshot ingestion needs attention'
              : 'QBTCP server needs attention'
          }
        >
          {qbtcpOperationalHealth.message}
        </Callout>
      )}
      {qbtcpOperationalHealth?.kind === 'stale' && (
        <Callout tone="warning" title="QBTCP snapshot sync delayed">
          Director has not ingested a fresh native snapshot recently. Check the server connection.
        </Callout>
      )}
      {qbtcpOperationalHealth?.kind === 'unverified' && (
        <Callout tone="warning" title="QBTCP snapshot sync not verified">
          The server is running, but Director has not ingested its first snapshot yet.
        </Callout>
      )}
      {qbtcpRunning && status?.sleepPrevention?.warning && (
        <Callout tone="warning" title="Host sleep protection unavailable">
          {status.sleepPrevention.warning}
        </Callout>
      )}
      <div className="director-actions">
        {nativeDirector ? (
          <Button
            variant={qbtcpRunning ? 'secondary' : 'primary'}
            icon={qbtcpRunning ? 'pause' : 'play'}
            disabled={qbtcpLoading}
            onClick={onToggle}
          >
            {qbtcpLoading ? 'Checking server' : qbtcpRunning ? 'Stop server' : 'Start server'}
          </Button>
        ) : (
          <Callout tone="info">
            Open the Tauri Director app to start the LAN server. Browser preview can still plan manual games.
          </Callout>
        )}
        {qbtcpRunning && status?.pairingUrl && invitations.length <= 1 && (
          <Button
            variant="secondary"
            icon="copy"
            onClick={() => onCopy(status.pairingUrl ?? '', 'Pairing link copied.')}
          >
            Copy pairing link
          </Button>
        )}
        {nativeDirector && (
          <Button variant="quiet" disabled={qbtcpLoading || resettingPairings} onClick={onReset}>
            {resettingPairings ? 'Resetting pairings…' : 'Reset all pairings'}
          </Button>
        )}
      </div>
      <Diagnostics
        defaultOpen={qbtcpNeedsAttention}
        standalone={false}
        items={[
          {
            term: 'Address',
            value:
              qbtcpRunning && status?.address
                ? `${status.address}${status.port ? `:${status.port}` : ''}`
                : qbtcpRunning
                  ? 'Unavailable — choose a reachable IPv4 address'
                  : 'Not listening',
            mono: true,
          },
          {
            term: 'Listener',
            value: qbtcpRunning ? (status?.bindAddress ?? `0.0.0.0:${status?.port ?? '—'}`) : '—',
            mono: true,
          },
          {
            term: 'Paired rooms',
            value: qbtcpRunning ? (status?.pairedRooms ?? state.qbtcpSessions.length) : '—',
          },
          { term: 'Protocol', value: qbtcpRunning ? (status?.protocol ?? 'QBTCP v1') : '—' },
          {
            term: 'Host sleep',
            value: qbtcpRunning ? (status?.sleepPrevention?.active ? 'Prevention active' : '—') : '—',
          },
          {
            term: 'Snapshot sync',
            value: qbtcpOperationalHealth ? qbtcpHealthSummary(qbtcpOperationalHealth) : 'Not available',
          },
        ]}
      />
      {qbtcpRunning && (status?.addressSelectionRequired || !status?.address) && (
        <Callout
          tone="warning"
          title={
            status?.addressSelectionRequired ? 'Multiple local networks detected' : 'Choose a pairing address'
          }
        >
          <p>
            Director will not guess which private interface scorekeeper devices can reach. Choose the scorer
            LAN address before sharing pairing links.
          </p>
          {addressOptions.length > 0 && (
            <Field label="Advertise QBTCP on">
              <Select
                value={
                  status?.address && addressOptions.some((option) => option.value === status.address)
                    ? status.address
                    : ''
                }
                options={addressOptions}
                onChange={chooseAddress}
                placeholder="Choose an interface…"
              />
            </Field>
          )}
          <Field label="Reachable IPv4 address" optional={addressOptions.length > 0}>
            <TextInput
              value={manualAddress}
              onChange={(event) => setManualAddress(event.target.value)}
              placeholder="192.168.1.54"
            />
          </Field>
          <Button
            variant="primary"
            disabled={!manualAddress.trim() || manualAddress.trim() === status?.address}
            onClick={() => void onSetAddress(manualAddress.trim())}
          >
            Use this address
          </Button>
        </Callout>
      )}
      {nativeDirector && qbtcpRunning && (
        <Panel
          title="Room invitations"
          description={`Each invitation is scoped to one room and expires after ${invitations[0]?.expiresInSeconds ?? 900} seconds.`}
          flush
        >
          <SummaryList ariaLabel="QBTCP room invitations">
            {pairingRooms.length === 0 ? (
              <div className="director-empty-in-panel">
                <p className="director-empty-copy">No assignable rooms are configured.</p>
              </div>
            ) : (
              pairingRooms.map((room) => {
                const invitation = invitations.find((entry) => entry.roomId === room.id);
                const expired = !invitation && expiredPairingRoomIds.includes(room.id);
                const remainingSeconds = invitation
                  ? Math.max(0, Math.ceil((Date.parse(invitation.expiresAt) - now) / 1000))
                  : null;
                // Who the round expects here, so the invitation is handed to the right person
                // rather than to whoever is standing nearest the laptop.
                const expected = expectedScorekeeperName(state, room.id);
                // Internet-primary pairing: the same code and room, served from the tournament
                // relay. A stored pointer that no longer validates falls back to the LAN link
                // rather than minting a broken one.
                let internetUrl: string | null = null;
                if (internetRelay && invitation) {
                  try {
                    internetUrl = buildInternetPairing({
                      baseUrl: internetRelay.baseUrl,
                      tournamentId: internetRelay.tournamentId,
                      code: invitation.pairingCode,
                      roomId: room.id,
                    }).url;
                  } catch {
                    internetUrl = null;
                  }
                }
                return (
                  <SummaryItem
                    key={room.id}
                    title={<strong>{room.name}</strong>}
                    status={
                      <StateLabel
                        state={invitation ? 'paired' : 'waiting'}
                        label={
                          invitation ? 'Invitation active' : expired ? 'Invitation expired' : 'No invitation'
                        }
                      />
                    }
                    summary={
                      <>
                        {expected && <span>Expected scorekeeper: {expected} · </span>}
                        <span>
                          {invitation
                            ? `Code ${invitation.pairingCode} · ${formatPairingRemaining(remainingSeconds ?? 0)}${internetUrl ? ' · Internet primary' : ''}`
                            : expired
                              ? 'The old code and link are no longer usable. Issue a fresh invitation.'
                              : 'Issue a room-specific invitation when the scorekeeper is ready to connect.'}
                        </span>
                      </>
                    }
                    actions={
                      <div className="director-actions">
                        {internetUrl ? (
                          <>
                            <Button
                              variant="secondary"
                              onClick={() =>
                                onCopy(internetUrl ?? '', `${room.name} Internet pairing link copied.`)
                              }
                            >
                              Copy Internet link
                            </Button>
                            {invitation?.pairingUrl && (
                              <Button
                                variant="quiet"
                                onClick={() =>
                                  onCopy(
                                    invitation.pairingUrl ?? '',
                                    `${room.name} LAN fallback link copied.`,
                                  )
                                }
                              >
                                LAN fallback
                              </Button>
                            )}
                          </>
                        ) : (
                          invitation?.pairingUrl && (
                            <Button
                              variant="secondary"
                              onClick={() =>
                                onCopy(invitation.pairingUrl ?? '', `${room.name} pairing link copied.`)
                              }
                            >
                              Copy link
                            </Button>
                          )
                        )}
                        <Button
                          variant={invitation ? 'quiet' : 'primary'}
                          disabled={pairingRoomId !== null}
                          onClick={() => onIssue(room.id)}
                        >
                          {pairingRoomId === room.id
                            ? 'Issuing…'
                            : invitation || expired
                              ? 'Issue new'
                              : 'Issue pairing'}
                        </Button>
                      </div>
                    }
                  />
                );
              })
            )}
          </SummaryList>
        </Panel>
      )}
    </div>
  );
}

/**
 * The scorekeeper the current round's assignment expects in a room.
 *
 * Read from the operational derivation so the pairing panel names the same person the room row
 * and preflight do.
 */
function expectedScorekeeperName(state: DirectorState, roomId: string): string | null {
  return deriveOperationalRoom(state, roomId)?.scorekeeper?.name ?? null;
}

function formatPairingRemaining(seconds: number): string {
  if (seconds < 60) return `Expires in ${seconds} sec`;
  const minutes = Math.ceil(seconds / 60);
  return `Expires in ${minutes} min`;
}

const qbtcpStaleAfterMs = 2 * 60 * 1000;
const qbtcpStaleTickMs = 30 * 1000;
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function RoomQbtcpTelemetry({ state, roomId }: { state: DirectorState; roomId: string }) {
  const now = useNow(qbtcpStaleTickMs);
  const allSessions = state.qbtcpSessions.filter((session) => session.roomId === roomId);
  const unresolvedSessions = allSessions.filter((session) => qbtcpSessionHasUnresolvedWork(state, session));
  const sessions = unresolvedSessions.length
    ? unresolvedSessions
    : [...allSessions].sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt)).slice(0, 1);
  const games = state.scheduledGames.filter(
    (game) => game.roomId === roomId && !game.bye && !['accepted', 'cancelled'].includes(game.status),
  );
  return (
    <div className="director-stack director-stack-tight">
      {sessions.map((session) => {
        const game = session.matchId
          ? state.scheduledGames.find((candidate) => candidate.id === session.matchId)
          : undefined;
        const lastSeen = new Date(session.lastSeenAt).getTime();
        const stale = Number.isFinite(lastSeen) && now - lastSeen > qbtcpStaleAfterMs;
        return (
          <div key={session.sessionId} className="director-inset director-inset-quiet">
            <StateLabel
              state={stale ? 'stale' : session.state}
              label={stale ? `${qbtcpSessionLabel(session.state)} · stale` : qbtcpSessionLabel(session.state)}
            />
            <p>
              {game ? matchupLabel(state, game) : 'No game linked'}
              {session.operatorName ? ` · ${session.operatorName}` : ''}
            </p>
            <small>
              Last seen {formatTime(session.lastSeenAt)}
              {session.resumable ? ' · Resumable' : ''}
            </small>
            <small className="director-mono">Session {session.sessionId}</small>
          </div>
        );
      })}
      {sessions.length === 0 && games.length === 0 && (
        <p className="director-text-meta">No active QBTCP session.</p>
      )}
    </div>
  );
}

function roomQbtcpHasDetail(state: DirectorState, roomId: string): boolean {
  return (
    state.qbtcpSessions.some((session) => session.roomId === roomId) ||
    state.qbtcpHelpRequests.some((request) => request.roomId === roomId) ||
    state.scheduledGames.some(
      (game) => game.roomId === roomId && !game.bye && !['accepted', 'cancelled'].includes(game.status),
    )
  );
}

function StaffRoleField({
  roles,
  onChange,
}: {
  roles: readonly StaffRole[];
  onChange: (roles: StaffRole[]) => void;
}) {
  return (
    <CheckboxGroup legend="Roles" hint="A staff member can have more than one role." columns>
      {staffRoleOptions.map((role) => (
        <Checkbox
          key={role.value}
          checked={roles.includes(role.value)}
          label={role.label}
          onChange={(checked) =>
            onChange(
              checked ? [...new Set([...roles, role.value])] : roles.filter((entry) => entry !== role.value),
            )
          }
        />
      ))}
    </CheckboxGroup>
  );
}

function staffForRole(
  state: DirectorState,
  role: 'moderator' | 'scorekeeper',
  selectedId: string,
): DirectorState['staff'] {
  return state.staff.filter(
    (member) => (member.roles.includes(role) && member.available) || member.id === selectedId,
  );
}
function teamName(state: DirectorState, id: string): string {
  return state.teams.find((team) => team.id === id)?.displayName ?? 'Unknown team';
}
function matchupLabel(state: DirectorState, game: DirectorState['scheduledGames'][number]): string {
  return `${teamName(state, game.leftTeamId)} vs ${game.rightTeamId ? teamName(state, game.rightTeamId) : 'Bye'}`;
}
function qbtcpSessionLabel(state: DirectorState['qbtcpSessions'][number]['state']): string {
  return state === 'result-received' ? 'Result received' : state.charAt(0).toUpperCase() + state.slice(1);
}
function rosterAmendmentStatusLabel(
  status: DirectorState['qbtcpRosterAmendments'][number]['status'],
): string {
  switch (status) {
    case 'approved-new':
      return 'Approved as new';
    case 'mapped-existing':
      return 'Mapped to existing';
    case 'rejected':
      return 'Rejected';
    default:
      return 'Review';
  }
}
function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
