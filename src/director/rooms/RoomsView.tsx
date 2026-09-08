import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  qbtcpSessionHasUnresolvedWork,
  roomIsAssignable,
  type DirectorState,
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
  Switch,
  TextArea,
  TextInput,
  type SelectOption,
} from '../components';
import type { SectionId } from '../app/navigation';
import type { DirectorNavigationTarget } from '../app/navigationTarget';
import { useNavigationHighlight } from '../app/useNavigationHighlight';
import { isNativeDirector, issueNativeRoomPairing } from '../platform/native';
import type { NativeServerState } from '../server/useNativeServerStatus';
import { errorNotice, type AnnounceInput } from '../notices';

type EquipmentKind = DirectorState['equipment'][number]['kind'];
type LogisticsView = 'rooms' | 'staff' | 'equipment' | 'requests';
type RoomFilter = 'all' | 'assignable' | 'active' | 'attention';

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
}: {
  state: DirectorState;
  controller: DirectorController;
  onNavigate?: (section: SectionId) => void;
  onAnnounce: (announcement: AnnounceInput) => void;
  navigationTarget?: DirectorNavigationTarget | null;
  onClearNavigationTarget?: () => void;
  server?: NativeServerState;
}) {
  const [view, setView] = useState<LogisticsView>('rooms');
  const [filter, setFilter] = useState<RoomFilter>('all');
  const [editingRoomId, setEditingRoomId] = useState<string | null | 'new'>(null);
  const [editingStaffId, setEditingStaffId] = useState<string | null | 'new'>(null);
  const [editingEquipmentId, setEditingEquipmentId] = useState<string | null | 'new'>(null);
  const [pairingRoomId, setPairingRoomId] = useState<string | null>(null);
  const [amendmentMappings, setAmendmentMappings] = useState<Record<string, string>>({});

  const targetRoomId =
    navigationTarget?.section === 'rooms' && navigationTarget.entityType === 'room'
      ? navigationTarget.entityId
      : undefined;
  useEffect(() => {
    if (targetRoomId) setView('rooms');
  }, [targetRoomId]);

  const qbtcpStatus = nativeServer?.status ?? null;
  const qbtcpLoading = nativeServer?.loading ?? false;
  const nativeDirector = isNativeDirector();
  const qbtcpRunning = qbtcpStatus?.running ?? false;
  const qbtcpHasError = !qbtcpLoading && nativeDirector && !qbtcpRunning && Boolean(qbtcpStatus?.message);
  const invitations = qbtcpStatus?.pairingInvitations ?? [];
  const assignableRoomIds = useMemo(
    () => new Set(state.rooms.filter((room) => roomIsAssignable(state, room.id)).map((room) => room.id)),
    [state],
  );
  const pairingRooms = state.rooms.filter((room) => assignableRoomIds.has(room.id));
  const helpRequests = [...state.qbtcpHelpRequests].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const rosterAmendments = [...state.qbtcpRosterAmendments].reverse();
  const openHelpCount = helpRequests.filter((request) => request.status === 'open').length;
  const pendingAmendments = rosterAmendments.filter((entry) => entry.status === 'pending').length;
  const attentionCount = openHelpCount + pendingAmendments;

  const filteredRooms = state.rooms.filter((room) => {
    if (room.id === targetRoomId) return true;
    if (filter === 'all') return true;
    if (filter === 'assignable') return assignableRoomIds.has(room.id);
    const hasOpenHelp = state.qbtcpHelpRequests.some(
      (request) => request.roomId === room.id && request.status === 'open',
    );
    const hasActiveGame = state.scheduledGames.some(
      (game) => game.roomId === room.id && !game.bye && !['accepted', 'cancelled'].includes(game.status),
    );
    if (filter === 'active') return hasActiveGame || room.status === 'live';
    return hasOpenHelp || room.status === 'help' || room.status === 'offline';
  });

  const toggleServer = async () => {
    if (!nativeServer) return;
    try {
      const next = await nativeServer.toggle();
      onAnnounce(next.message ?? (next.running ? 'QBTCP server started.' : 'QBTCP server stopped.'));
    } catch (reason: unknown) {
      onAnnounce(errorNotice(reason instanceof Error ? reason.message : 'The QBTCP server could not be changed.'));
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
        errorNotice(reason instanceof Error ? reason.message : 'A room pairing invitation could not be issued.'),
      );
    } finally {
      setPairingRoomId(null);
    }
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

  return (
    <Page>
      <PageHeader
        title="Rooms & staff"
        description={`${state.rooms.length} room${state.rooms.length === 1 ? '' : 's'} · ${state.staff.length} staff · ${state.equipment.length} equipment resource${state.equipment.length === 1 ? '' : 's'}`}
        actions={primaryAdd}
      />

      <Segmented<LogisticsView>
        value={view}
        onChange={setView}
        ariaLabel="Logistics view"
        options={[
          { value: 'rooms', label: `Rooms ${state.rooms.length}` },
          { value: 'staff', label: `Staff ${state.staff.length}` },
          { value: 'equipment', label: `Equipment ${state.equipment.length}` },
          { value: 'requests', label: attentionCount ? `Requests ${attentionCount}` : 'Requests' },
        ]}
      />

      {view === 'rooms' && (
        <RoomsLogisticsView
          state={state}
          controller={controller}
          rooms={filteredRooms}
          filter={filter}
          setFilter={setFilter}
          assignableRoomIds={assignableRoomIds}
          onNavigate={onNavigate}
          onAnnounce={onAnnounce}
          navigationTarget={navigationTarget}
          onClearNavigationTarget={onClearNavigationTarget}
          onEdit={(roomId) => setEditingRoomId(roomId)}
          onAdd={() => setEditingRoomId('new')}
        />
      )}

      {view === 'staff' && (
        <ResourceView
          title="Staff"
          description="People available for moderator, scorekeeper, runner, and HQ assignments."
          emptyTitle="No staff yet"
          emptyDescription="Add staff only when you want Director to track room assignments."
          addLabel="Add staff member"
          onAdd={() => setEditingStaffId('new')}
        >
          <SummaryList ariaLabel="Staff">
            {state.staff.map((member) => (
              <StaffSummary
                key={member.id}
                member={member}
                controller={controller}
                onAnnounce={onAnnounce}
                onEdit={() => setEditingStaffId(member.id)}
              />
            ))}
          </SummaryList>
        </ResourceView>
      )}

      {view === 'equipment' && (
        <ResourceView
          title="Equipment"
          description="Buzzers, scoring devices, and other resources that can be assigned to rooms."
          emptyTitle="No equipment yet"
          emptyDescription="Equipment tracking is optional until you need it."
          addLabel="Add equipment"
          onAdd={() => setEditingEquipmentId('new')}
        >
          <SummaryList ariaLabel="Equipment">
            {state.equipment.map((item) => (
              <EquipmentSummary
                key={item.id}
                item={item}
                controller={controller}
                onAnnounce={onAnnounce}
                onEdit={() => setEditingEquipmentId(item.id)}
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

      {nativeServer && (
        <AdvancedSection
          label={qbtcpRunning || qbtcpHasError ? 'QBTCP local network' : 'Set up QBTCP local network'}
          hint={
            qbtcpRunning
              ? `${qbtcpStatus?.pairedRooms ?? state.qbtcpSessions.length} paired room${(qbtcpStatus?.pairedRooms ?? state.qbtcpSessions.length) === 1 ? '' : 's'}`
              : qbtcpHasError
                ? 'Server needs attention'
                : 'Optional for network-connected scorekeepers'
          }
          icon="network"
          defaultOpen={qbtcpRunning || qbtcpHasError}
        >
          <QbtcpNetwork
            state={state}
            nativeServer={nativeServer}
            nativeDirector={nativeDirector}
            qbtcpLoading={qbtcpLoading}
            qbtcpRunning={qbtcpRunning}
            qbtcpHasError={qbtcpHasError}
            pairingRooms={pairingRooms}
            invitations={invitations}
            pairingRoomId={pairingRoomId}
            controller={controller}
            onToggle={() => void toggleServer()}
            onIssue={(roomId) => void issuePairing(roomId)}
            onCopy={(url, message) => void copyPairingLink(url, message)}
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
          member={editingStaffId === 'new' ? undefined : state.staff.find((member) => member.id === editingStaffId)}
          controller={controller}
          onAnnounce={onAnnounce}
          onClose={() => setEditingStaffId(null)}
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
  rooms,
  filter,
  setFilter,
  assignableRoomIds,
  onNavigate,
  onAnnounce,
  navigationTarget,
  onClearNavigationTarget,
  onEdit,
  onAdd,
}: {
  state: DirectorState;
  controller: DirectorController;
  rooms: DirectorState['rooms'];
  filter: RoomFilter;
  setFilter: (filter: RoomFilter) => void;
  assignableRoomIds: Set<string>;
  onNavigate?: (section: SectionId) => void;
  onAnnounce: (announcement: AnnounceInput) => void;
  navigationTarget?: DirectorNavigationTarget | null;
  onClearNavigationTarget?: () => void;
  onEdit: (roomId: string) => void;
  onAdd: () => void;
}) {
  if (state.rooms.length === 0) {
    return (
      <EmptyState title="No rooms yet" description="Add the rooms that can host games.">
        <Button variant="primary" icon="plus" onClick={onAdd}>
          Add first room
        </Button>
      </EmptyState>
    );
  }
  return (
    <Panel
      title="Rooms"
      description="Current work and future assignability are shown separately."
      actions={
        <Segmented<RoomFilter>
          value={filter}
          onChange={setFilter}
          ariaLabel="Room filter"
          options={[
            { value: 'all', label: 'All' },
            { value: 'assignable', label: `Assignable ${assignableRoomIds.size}` },
            {
              value: 'active',
              label: `Active ${state.rooms.filter((room) => state.scheduledGames.some((game) => game.roomId === room.id && !game.bye && !['accepted', 'cancelled'].includes(game.status))).length}`,
            },
            {
              value: 'attention',
              label: `Attention ${state.rooms.filter((room) => room.status === 'help' || room.status === 'offline' || state.qbtcpHelpRequests.some((request) => request.roomId === room.id && request.status === 'open')).length}`,
            },
          ]}
        />
      }
      flush
    >
      {rooms.length === 0 ? (
        <div className="director-empty-in-panel">
          <p className="director-empty-copy">No rooms match this filter.</p>
          <Button variant="quiet" onClick={() => setFilter('all')}>
            Show all rooms
          </Button>
        </div>
      ) : (
        <SummaryList ariaLabel="Rooms">
          {rooms.map((room) => (
            <RoomSummary
              key={room.id}
              state={state}
              room={room}
              controller={controller}
              onNavigate={onNavigate}
              onAnnounce={onAnnounce}
              navigationTarget={navigationTarget}
              onClearNavigationTarget={onClearNavigationTarget}
              onEdit={() => onEdit(room.id)}
            />
          ))}
        </SummaryList>
      )}
    </Panel>
  );
}

function RoomSummary({
  state,
  room,
  controller,
  onNavigate,
  onAnnounce,
  navigationTarget,
  onClearNavigationTarget,
  onEdit,
}: {
  state: DirectorState;
  room: DirectorState['rooms'][number];
  controller: DirectorController;
  onNavigate?: (section: SectionId) => void;
  onAnnounce: (announcement: AnnounceInput) => void;
  navigationTarget?: DirectorNavigationTarget | null;
  onClearNavigationTarget?: () => void;
  onEdit: () => void;
}) {
  const highlighted = useNavigationHighlight(
    navigationTarget,
    'rooms',
    'room',
    room.id,
    onClearNavigationTarget,
  );
  const assignable = roomIsAssignable(state, room.id);
  const activeGames = state.scheduledGames.filter(
    (game) => game.roomId === room.id && !game.bye && !['accepted', 'cancelled'].includes(game.status),
  );
  const openHelp = state.qbtcpHelpRequests.some(
    (request) => request.roomId === room.id && request.status === 'open',
  );
  const currentWork = activeGames[0]
    ? `${matchupLabel(state, activeGames[0])} · ${activeGames[0].status}`
    : room.status === 'live'
      ? 'Game in progress'
      : 'No unresolved game';
  const people = [
    staffName(state, room.moderatorId) ? `Moderator: ${staffName(state, room.moderatorId)}` : null,
    staffName(state, room.scorekeeperId) ? `Scorekeeper: ${staffName(state, room.scorekeeperId)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const location = [room.building, room.floor].filter(Boolean).join(' · ');

  return (
    <SummaryItem
      className={highlighted ? 'is-navigation-target' : ''}
      selected={openHelp}
      title={
        <strong data-director-navigation-id={room.id} data-director-navigation-focus tabIndex={-1}>
          {room.name}
        </strong>
      }
      status={
        <StateLabel
          state={openHelp ? 'help' : room.status}
          label={openHelp ? 'Needs help' : humanRoomStatus(room.status)}
        />
      }
      summary={
        <>
          <span>{location || 'No location details'}</span>
          <span> · Current: {currentWork}</span>
          <span> · Next round: {assignable ? 'Assignable' : room.available ? 'Waiting for current work' : 'Unavailable'}</span>
          {people && <span> · {people}</span>}
        </>
      }
      actions={
        <div className="director-actions">
          <Button variant="secondary" icon="edit" onClick={onEdit}>
            Edit
          </Button>
          <ActionMenu label={`${room.name} actions`} triggerLabel={`${room.name} actions`}>
            {(close) => (
              <>
                <MenuItem
                  icon={room.available ? 'pause' : 'play'}
                  onSelect={() => {
                    close();
                    if (controller.updateRoom(room.id, { available: !room.available })) {
                      onAnnounce(
                        `${room.name} marked ${room.available ? 'unavailable' : 'available'} for future assignment.`,
                      );
                    } else onAnnounce(errorNotice(`${room.name} was not changed; review the Director error.`));
                  }}
                >
                  {room.available ? 'Mark unavailable' : 'Mark available'}
                </MenuItem>
                {onNavigate && activeGames.length > 0 && (
                  <MenuItem
                    icon="upload"
                    onSelect={() => {
                      close();
                      onNavigate('transfers');
                    }}
                  >
                    Prepare assignment files
                  </MenuItem>
                )}
              </>
            )}
          </ActionMenu>
        </div>
      }
    >
      {(room.accessibility || room.directions || room.notes || roomQbtcpHasDetail(state, room.id)) && (
        <Diagnostics label="Room details & QBTCP" standalone={false} hint="Wayfinding, notes, and connection telemetry.">
          {room.accessibility && <p><strong>Accessibility:</strong> {room.accessibility}</p>}
          {room.directions && <p><strong>Directions:</strong> {room.directions}</p>}
          {room.notes && <p><strong>Notes:</strong> {room.notes}</p>}
          {roomQbtcpHasDetail(state, room.id) && <RoomQbtcpTelemetry state={state} roomId={room.id} />}
        </Diagnostics>
      )}
    </SummaryItem>
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
      onAnnounce(errorNotice(`The room could not be ${room ? 'updated' : 'added'}; review the Director error.`));
      return;
    }
    onAnnounce(`${draft.name.trim()} ${room ? 'updated' : 'added'}.`);
    onClose();
  };
  const moderatorOptions: SelectOption[] = [
    { value: '', label: 'Unassigned' },
    ...staffForRole(state, 'moderator', draft.moderatorId).map((member) => ({ value: member.id, label: member.name })),
  ];
  const scorekeeperOptions: SelectOption[] = [
    { value: '', label: 'Unassigned' },
    ...staffForRole(state, 'scorekeeper', draft.scorekeeperId).map((member) => ({ value: member.id, label: member.name })),
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
          <Field label="Room name"><TextInput value={draft.name} onChange={(event) => set('name', event.target.value)} /></Field>
          <Field label="Building" optional><TextInput value={draft.building} onChange={(event) => set('building', event.target.value)} /></Field>
          <Field label="Floor" optional><TextInput value={draft.floor} onChange={(event) => set('floor', event.target.value)} /></Field>
          <Field label="Accessibility" optional><TextInput value={draft.accessibility} onChange={(event) => set('accessibility', event.target.value)} placeholder="Step-free entrance" /></Field>
          <Field label="Directions" optional spanAll><TextInput value={draft.directions} onChange={(event) => set('directions', event.target.value)} placeholder="East stairwell, first door on the left" /></Field>
          <Field label="Notes" optional spanAll><TextArea rows={2} value={draft.notes} onChange={(event) => set('notes', event.target.value)} /></Field>
        </FieldGrid>
      </DialogSection>
      <DialogSection title="Assignments" description="Leave any resource unassigned when you do not want Director to track it.">
        <FieldGrid>
          <Field label="Moderator" render={({ id, describedBy }) => <Select id={id} ariaDescribedBy={describedBy} value={draft.moderatorId} options={moderatorOptions} onChange={(value) => set('moderatorId', value)} />} />
          <Field label="Scorekeeper" render={({ id, describedBy }) => <Select id={id} ariaDescribedBy={describedBy} value={draft.scorekeeperId} options={scorekeeperOptions} onChange={(value) => set('scorekeeperId', value)} />} />
          <Field label="Equipment" render={({ id, describedBy }) => <Select id={id} ariaDescribedBy={describedBy} value={draft.equipmentId} options={equipmentOptions} onChange={(value) => set('equipmentId', value)} />} />
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
      {hasItems ? children : (
        <EmptyState title={emptyTitle} description={emptyDescription}>
          <Button variant="primary" icon="plus" onClick={onAdd}>{addLabel}</Button>
        </EmptyState>
      )}
    </Panel>
  );
}

function StaffSummary({
  member,
  controller,
  onAnnounce,
  onEdit,
}: {
  member: DirectorState['staff'][number];
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
  onEdit: () => void;
}) {
  return (
    <SummaryItem
      title={<strong>{member.name}</strong>}
      status={<StateLabel state={member.available ? 'available' : 'offline'} label={member.available ? 'Available' : 'Unavailable'} />}
      summary={[member.roles.map(roleLabel).join(' · '), member.notes].filter(Boolean).join(' · ')}
      actions={
        <div className="director-actions">
          <Button variant="secondary" icon="edit" onClick={onEdit}>Edit</Button>
          <ActionMenu label={`${member.name} actions`} triggerLabel={`${member.name} actions`}>
            {(close) => (
              <MenuItem
                icon={member.available ? 'pause' : 'play'}
                onSelect={() => {
                  close();
                  if (controller.updateStaff(member.id, { available: !member.available })) {
                    onAnnounce(`${member.name} marked ${member.available ? 'unavailable' : 'available'} for future assignment.`);
                  } else onAnnounce(errorNotice(`${member.name} was not changed; review the Director error.`));
                }}
              >
                {member.available ? 'Mark unavailable' : 'Mark available'}
              </MenuItem>
            )}
          </ActionMenu>
        </div>
      }
    />
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
      ? { name: member.name, roles: member.roles.length ? [...member.roles] : ['moderator'], notes: member.notes ?? '', available: member.available }
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
    const payload = { name: draft.name.trim(), roles: draft.roles, notes: draft.notes, available: draft.available };
    const saved = member ? controller.updateStaff(member.id, payload) : controller.addStaff(payload);
    if (!saved) {
      onAnnounce(errorNotice(`The staff member could not be ${member ? 'updated' : 'added'}; review the Director error.`));
      return;
    }
    onAnnounce(`${draft.name.trim()} ${member ? 'updated' : 'added to staff'}.`);
    onClose();
  };
  return (
    <Dialog title={member ? `Edit ${member.name}` : 'Add staff member'} onClose={onClose} onSubmit={save} submitLabel={member ? 'Save changes' : 'Add staff member'}>
      <Field label="Name"><TextInput value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></Field>
      <StaffRoleField roles={draft.roles} onChange={(roles) => setDraft((current) => ({ ...current, roles }))} />
      <Field label="Notes" optional><TextArea rows={2} value={draft.notes} onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))} /></Field>
      <Checkbox checked={draft.available} label="Available for future assignment" onChange={(available) => setDraft((current) => ({ ...current, available }))} />
    </Dialog>
  );
}

function EquipmentSummary({
  item,
  controller,
  onAnnounce,
  onEdit,
}: {
  item: DirectorState['equipment'][number];
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
  onEdit: () => void;
}) {
  return (
    <SummaryItem
      title={<strong>{item.name}</strong>}
      status={<StateLabel state={item.available ? 'available' : 'offline'} label={item.available ? 'Available' : 'Unavailable'} />}
      summary={[equipmentKindLabel(item.kind), item.notes].filter(Boolean).join(' · ')}
      actions={
        <div className="director-actions">
          <Button variant="secondary" icon="edit" onClick={onEdit}>Edit</Button>
          <ActionMenu label={`${item.name} actions`} triggerLabel={`${item.name} actions`}>
            {(close) => (
              <MenuItem
                icon={item.available ? 'pause' : 'play'}
                onSelect={() => {
                  close();
                  if (controller.updateEquipment(item.id, { available: !item.available })) {
                    onAnnounce(`${item.name} marked ${item.available ? 'unavailable' : 'available'} for future assignment.`);
                  } else onAnnounce(errorNotice(`${item.name} was not changed; review the Director error.`));
                }}
              >
                {item.available ? 'Mark unavailable' : 'Mark available'}
              </MenuItem>
            )}
          </ActionMenu>
        </div>
      }
    />
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
    item ? { name: item.name, kind: item.kind, notes: item.notes ?? '', available: item.available } : blankEquipment(),
  );
  const save = () => {
    if (!draft.name.trim()) {
      onAnnounce(errorNotice('Enter an equipment name first.'));
      return;
    }
    const payload = { name: draft.name.trim(), kind: draft.kind, notes: draft.notes, available: draft.available };
    const saved = item ? controller.updateEquipment(item.id, payload) : controller.addEquipment(payload);
    if (!saved) {
      onAnnounce(errorNotice(`The equipment resource could not be ${item ? 'updated' : 'added'}; review the Director error.`));
      return;
    }
    onAnnounce(`${draft.name.trim()} ${item ? 'updated' : 'added to equipment'}.`);
    onClose();
  };
  return (
    <Dialog title={item ? `Edit ${item.name}` : 'Add equipment'} onClose={onClose} onSubmit={save} submitLabel={item ? 'Save changes' : 'Add equipment'}>
      <Field label="Name"><TextInput value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></Field>
      <Field label="Type" render={({ id, describedBy }) => (
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
      )} />
      <Field label="Notes" optional><TextArea rows={2} value={draft.notes} onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))} /></Field>
      <Checkbox checked={draft.available} label="Available for future assignment" onChange={(available) => setDraft((current) => ({ ...current, available }))} />
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
    return <EmptyState title="No operational requests" description="QBTCP help requests and roster amendments will appear here when a room sends one." />;
  }
  return (
    <div className="director-stack">
      {helpRequests.length > 0 && (
        <Panel title="Scorekeeper help" description="Requests from connected rooms that may need a director decision." flush>
          <SummaryList ariaLabel="Scorekeeper help requests">
            {helpRequests.map((request) => (
              <SummaryItem
                key={request.id}
                title={<strong>{request.roomName} · {request.category}</strong>}
                status={<StateLabel state={request.status === 'open' ? 'help' : 'finished'} label={request.status === 'open' ? 'Open' : request.status} />}
                summary={`${request.message} · ${formatTime(request.createdAt)}${request.operatorName ? ` · ${request.operatorName}` : ''}`}
                actions={request.status === 'open' ? (
                  <Button
                    variant="primary"
                    onClick={() => {
                      void controller.resolveQbtcpHelp(request.id).then((resolved) => {
                        if (resolved) onAnnounce(`${request.roomName} help request resolved.`);
                        else onAnnounce(errorNotice(`${request.roomName}'s help request was not resolved; review the Director error.`));
                      });
                    }}
                  >
                    Mark resolved
                  </Button>
                ) : undefined}
              >
                <Diagnostics label="Request details" standalone={false} items={[{ term: 'Device', value: request.deviceId, mono: true }]} />
              </SummaryItem>
            ))}
          </SummaryList>
        </Panel>
      )}
      {rosterAmendments.length > 0 && (
        <Panel title="Roster amendments" description="Reconcile scorekeeper-entered names with the canonical roster." flush>
          <SummaryList ariaLabel="Roster amendments">
            {rosterAmendments.map((entry) => {
              const playerName = stringField(entry.amendment.playerName) ?? 'Unrecognized player';
              const referencedTeamId = stringField(entry.amendment.teamId);
              const referencedTeamName = stringField(entry.amendment.teamName);
              const referencedTeam = referencedTeamId
                ? state.teams.find((candidate) => candidate.id === referencedTeamId)
                : referencedTeamName
                  ? state.teams.find((candidate) => candidate.displayName.trim().toLocaleLowerCase() === referencedTeamName.toLocaleLowerCase())
                  : undefined;
              const team = referencedTeam?.displayName ?? referencedTeamName ?? referencedTeamId ?? 'Team unresolved';
              const candidates = state.players.filter(
                (player) => player.active && (!referencedTeam || player.teamId === referencedTeam.id),
              );
              const selectedPlayerId = mappings[entry.id] ?? '';
              return (
                <SummaryItem
                  key={entry.id}
                  title={<strong>{playerName}</strong>}
                  status={<StateLabel state={entry.status === 'pending' ? 'review' : 'finished'} label={rosterAmendmentStatusLabel(entry.status)} />}
                  summary={`${team} · Original scorekeeper submission retained as evidence.${entry.decidedBy ? ` Decided by ${entry.decidedBy}.` : ''}`}
                  actions={entry.status === 'pending' ? (
                    <ActionMenu label={`${playerName} amendment actions`} triggerLabel="Resolve" triggerVariant="primary">
                      {(close) => (
                        <>
                          <MenuItem onSelect={() => {
                            close();
                            if (controller.approveRosterAmendmentAsNew(entry.id)) onAnnounce(`${playerName} approved as a new canonical player.`);
                            else onAnnounce(errorNotice(`${playerName} was not approved; review the Director error.`));
                          }}>Approve as new</MenuItem>
                          <MenuItem tone="danger" onSelect={() => {
                            close();
                            if (controller.rejectRosterAmendment(entry.id)) onAnnounce(`${playerName} roster amendment dismissed.`);
                            else onAnnounce(errorNotice(`${playerName}'s roster amendment was not dismissed; review the Director error.`));
                          }}>Reject amendment</MenuItem>
                        </>
                      )}
                    </ActionMenu>
                  ) : undefined}
                >
                  {entry.status === 'pending' && (
                    <div className="director-roster-amendment-map">
                      <Field
                        label="Map to existing player"
                        render={({ id, describedBy }) => (
                          <Combobox
                            id={id}
                            ariaDescribedBy={describedBy}
                            value={selectedPlayerId}
                            allowClear
                            placeholder="Search existing players…"
                            options={candidates.map((candidate) => ({
                              value: candidate.id,
                              label: candidate.name,
                              detail: teamName(state, candidate.teamId),
                            }))}
                            onChange={(value) => setMappings((previous) => ({ ...previous, [entry.id]: value }))}
                          />
                        )}
                      />
                      <Button
                        variant="secondary"
                        disabled={!selectedPlayerId}
                        onClick={() => {
                          if (controller.mapRosterAmendment(entry.id, selectedPlayerId)) onAnnounce(`${playerName} mapped to the canonical roster.`);
                          else onAnnounce(errorNotice(`${playerName} was not mapped; review the Director error.`));
                        }}
                      >
                        Map player
                      </Button>
                    </div>
                  )}
                  <Diagnostics label="Amendment details" standalone={false} items={[{ term: 'Session', value: entry.sessionId, mono: true }]} />
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
  qbtcpHasError,
  pairingRooms,
  invitations,
  pairingRoomId,
  controller,
  onToggle,
  onIssue,
  onCopy,
}: {
  state: DirectorState;
  nativeServer: NativeServerState;
  nativeDirector: boolean;
  qbtcpLoading: boolean;
  qbtcpRunning: boolean;
  qbtcpHasError: boolean;
  pairingRooms: DirectorState['rooms'];
  invitations: NonNullable<NativeServerState['status']>['pairingInvitations'];
  pairingRoomId: string | null;
  controller: DirectorController;
  onToggle: () => void;
  onIssue: (roomId: string) => void;
  onCopy: (url: string, message: string) => void;
}) {
  const status = nativeServer.status;
  return (
    <div className="director-stack">
      {qbtcpHasError && <Callout tone="danger" title="QBTCP server needs attention">{status?.message}</Callout>}
      {controller.qbtcpHealth.error && <Callout tone="danger">{controller.qbtcpHealth.error}</Callout>}
      <div className="director-actions">
        {nativeDirector ? (
          <Button variant={qbtcpRunning ? 'secondary' : 'primary'} icon={qbtcpRunning ? 'pause' : 'play'} disabled={qbtcpLoading} onClick={onToggle}>
            {qbtcpLoading ? 'Checking server' : qbtcpRunning ? 'Stop server' : 'Start server'}
          </Button>
        ) : (
          <Callout tone="info">Open the Tauri Director app to start the LAN server. Browser preview can still plan manual games.</Callout>
        )}
        {qbtcpRunning && status?.pairingUrl && invitations.length <= 1 && (
          <Button variant="secondary" icon="copy" onClick={() => onCopy(status.pairingUrl ?? '', 'Pairing link copied.')}>Copy pairing link</Button>
        )}
      </div>
      <Diagnostics
        defaultOpen={qbtcpHasError}
        standalone={false}
        items={[
          { term: 'Address', value: qbtcpRunning && status?.address ? `${status.address}${status.port ? `:${status.port}` : ''}` : 'Not listening', mono: true },
          { term: 'Paired rooms', value: qbtcpRunning ? (status?.pairedRooms ?? state.qbtcpSessions.length) : '—' },
          { term: 'Protocol', value: qbtcpRunning ? (status?.protocol ?? 'QBTCP v1') : '—' },
        ]}
      />
      {nativeDirector && qbtcpRunning && (
        <Panel title="Room invitations" description={`Each invitation is scoped to one room and expires after ${invitations[0]?.expiresInSeconds ?? 900} seconds.`} flush>
          <SummaryList ariaLabel="QBTCP room invitations">
            {pairingRooms.length === 0 ? (
              <div className="director-empty-in-panel"><p className="director-empty-copy">No assignable rooms are configured.</p></div>
            ) : pairingRooms.map((room) => {
              const invitation = invitations.find((entry) => entry.roomId === room.id);
              return (
                <SummaryItem
                  key={room.id}
                  title={<strong>{room.name}</strong>}
                  status={<StateLabel state={invitation ? 'paired' : 'waiting'} label={invitation ? 'Invitation active' : 'No invitation'} />}
                  summary={invitation ? `Code ${invitation.pairingCode}` : 'Issue a room-specific invitation when the scorekeeper is ready to connect.'}
                  actions={
                    <div className="director-actions">
                      {invitation?.pairingUrl && <Button variant="secondary" onClick={() => onCopy(invitation.pairingUrl ?? '', `${room.name} pairing link copied.`)}>Copy link</Button>}
                      <Button variant={invitation ? 'quiet' : 'primary'} disabled={pairingRoomId !== null} onClick={() => onIssue(room.id)}>
                        {pairingRoomId === room.id ? 'Issuing…' : invitation ? 'Issue new' : 'Issue pairing'}
                      </Button>
                    </div>
                  }
                />
              );
            })}
          </SummaryList>
        </Panel>
      )}
    </div>
  );
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
        const game = session.matchId ? state.scheduledGames.find((candidate) => candidate.id === session.matchId) : undefined;
        const lastSeen = new Date(session.lastSeenAt).getTime();
        const stale = Number.isFinite(lastSeen) && now - lastSeen > qbtcpStaleAfterMs;
        return (
          <div key={session.sessionId} className="director-inset director-inset-quiet">
            <StateLabel state={stale ? 'stale' : session.state} label={stale ? `${qbtcpSessionLabel(session.state)} · stale` : qbtcpSessionLabel(session.state)} />
            <p>{game ? matchupLabel(state, game) : 'No game linked'}{session.operatorName ? ` · ${session.operatorName}` : ''}</p>
            <small>Last seen {formatTime(session.lastSeenAt)}{session.resumable ? ' · Resumable' : ''}</small>
            <small className="director-mono">Session {session.sessionId}</small>
          </div>
        );
      })}
      {sessions.length === 0 && games.length === 0 && <p className="director-text-meta">No active QBTCP session.</p>}
    </div>
  );
}

function roomQbtcpHasDetail(state: DirectorState, roomId: string): boolean {
  return state.qbtcpSessions.some((session) => session.roomId === roomId) ||
    state.qbtcpHelpRequests.some((request) => request.roomId === roomId) ||
    state.scheduledGames.some((game) => game.roomId === roomId && !game.bye && !['accepted', 'cancelled'].includes(game.status));
}

const staffRoleOptions: Array<{ value: StaffRole; label: string }> = [
  { value: 'moderator', label: 'Moderator' },
  { value: 'scorekeeper', label: 'Scorekeeper' },
  { value: 'runner', label: 'Runner' },
  { value: 'hq', label: 'HQ staff' },
];

function StaffRoleField({ roles, onChange }: { roles: readonly StaffRole[]; onChange: (roles: StaffRole[]) => void }) {
  return (
    <CheckboxGroup legend="Roles" hint="A staff member can have more than one role." columns>
      {staffRoleOptions.map((role) => (
        <Checkbox
          key={role.value}
          checked={roles.includes(role.value)}
          label={role.label}
          onChange={(checked) => onChange(checked ? [...new Set([...roles, role.value])] : roles.filter((entry) => entry !== role.value))}
        />
      ))}
    </CheckboxGroup>
  );
}

function roleLabel(role: StaffRole): string {
  return staffRoleOptions.find((option) => option.value === role)?.label ?? role;
}
function equipmentKindLabel(kind: EquipmentKind): string {
  return kind === 'buzzer' ? 'Buzzer' : kind === 'device' ? 'Laptop / tablet' : 'Other';
}
function staffForRole(state: DirectorState, role: 'moderator' | 'scorekeeper', selectedId: string): DirectorState['staff'] {
  return state.staff.filter((member) => (member.roles.includes(role) && member.available) || member.id === selectedId);
}
function staffName(state: DirectorState, id: string | null): string {
  return id ? (state.staff.find((member) => member.id === id)?.name ?? '') : '';
}
function teamName(state: DirectorState, id: string): string {
  return state.teams.find((team) => team.id === id)?.displayName ?? 'Unknown team';
}
function matchupLabel(state: DirectorState, game: DirectorState['scheduledGames'][number]): string {
  return `${teamName(state, game.leftTeamId)} vs ${game.rightTeamId ? teamName(state, game.rightTeamId) : 'Bye'}`;
}
function humanRoomStatus(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1).replaceAll('-', ' ');
}
function qbtcpSessionLabel(state: DirectorState['qbtcpSessions'][number]['state']): string {
  return state === 'result-received' ? 'Result received' : state.charAt(0).toUpperCase() + state.slice(1);
}
function rosterAmendmentStatusLabel(status: DirectorState['qbtcpRosterAmendments'][number]['status']): string {
  switch (status) {
    case 'approved-new': return 'Approved as new';
    case 'mapped-existing': return 'Mapped to existing';
    case 'rejected': return 'Rejected';
    default: return 'Review';
  }
}
function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
