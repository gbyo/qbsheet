import { useState } from 'react';
import type { DirectorState, StaffRole } from '../domain';
import type { DirectorController } from '../state/useDirectorController';
import { Button, EmptyState, FormField, PanelBody, PanelFooter, StateLabel } from '../components/Controls';
import type { SectionId } from '../app/navigation';
import type { DirectorNavigationTarget } from '../app/navigationTarget';
import { useNavigationHighlight } from '../app/useNavigationHighlight';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { isNativeDirector, issueNativeRoomPairing } from '../platform/native';
import type { NativeServerState } from '../server/useNativeServerStatus';
import { errorNotice, type AnnounceInput } from '../notices';

type EquipmentKind = DirectorState['equipment'][number]['kind'];

interface RoomDraft {
  name: string;
  building: string;
  floor: string;
  accessibility: string;
  directions: string;
  notes: string;
}
interface StaffDraft {
  name: string;
  roles: StaffRole[];
  notes: string;
}
interface EquipmentDraft {
  name: string;
  kind: EquipmentKind;
  notes: string;
}

/*
 * The three empty drafts, module-level so a save can restore one by identity rather than by
 * retyping the shape.
 */
const emptyRoomDraft: RoomDraft = {
  name: '',
  building: '',
  floor: '',
  accessibility: '',
  directions: '',
  notes: '',
};
/** Fresh each time, so the module-level default cannot be reached through a draft's array. */
const emptyStaffDraft = (): StaffDraft => ({
  name: '',
  /** At least one, because the domain expects at least one. Moderator is the commonest. */
  roles: ['moderator'],
  notes: '',
});
const emptyEquipmentDraft: EquipmentDraft = { name: '', kind: 'buzzer', notes: '' };

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
  /** The shared native QBTCP snapshot owned by the Director shell. Absent in tests. */
  server?: NativeServerState;
}) {
  const qbtcpStatus = nativeServer?.status ?? null;
  const qbtcpLoading = nativeServer?.loading ?? false;
  const [pairingRoomId, setPairingRoomId] = useState<string | null>(null);
  const nativeDirector = isNativeDirector();
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
  const qbtcpRunning = qbtcpStatus?.running ?? false;
  const qbtcpHasError = !qbtcpLoading && nativeDirector && !qbtcpRunning && Boolean(qbtcpStatus?.message);
  const qbtcpStateLabel = qbtcpLoading
    ? 'Checking'
    : qbtcpHasError
      ? 'Error'
      : qbtcpRunning
        ? 'Running'
        : 'Stopped';
  const qbtcpState = qbtcpLoading
    ? 'waiting'
    : qbtcpHasError
      ? 'error'
      : qbtcpRunning
        ? 'connected'
        : 'not-started';
  const pairingRooms = state.rooms.filter((room) => room.available && room.status === 'available');
  const invitations = qbtcpStatus?.pairingInvitations ?? [];
  const [showForm, setShowForm] = useState<'room' | 'staff' | 'equipment' | null>(null);
  /*
   * Three drafts, because there are three forms.
   *
   * The Add room / Add staff / Add equipment buttons all opened one shared set of fields and cleared
   * them on the way in, so a director halfway through typing a room's directions who pressed Add
   * staff to check something lost the lot — silently, with no way back. They are small independent
   * forms and switching between them should cost nothing, which is what separate state buys without
   * a confirmation dialog standing between somebody and a button they meant to press.
   *
   * A draft survives closing the form as well as switching away from it, for the same reason: the
   * only thing that empties one is the save that consumed it.
   */
  const [roomDraft, setRoomDraft] = useState(emptyRoomDraft);
  const [staffDraft, setStaffDraft] = useState<StaffDraft>(emptyStaffDraft);
  const [equipmentDraft, setEquipmentDraft] = useState(emptyEquipmentDraft);
  const [filter, setFilter] = useState<'all' | 'available' | 'live' | 'help' | 'offline'>('all');
  const [amendmentMappings, setAmendmentMappings] = useState<Record<string, string>>({});
  const openForm = (kind: 'room' | 'staff' | 'equipment') => setShowForm(kind);
  const targetRoomId =
    navigationTarget?.section === 'rooms' && navigationTarget.entityType === 'room'
      ? navigationTarget.entityId
      : undefined;
  const rooms = state.rooms.filter(
    (room) =>
      room.id === targetRoomId ||
      filter === 'all' ||
      (filter === 'available' ? room.available : room.status === filter),
  );
  const helpRequests = [...state.qbtcpHelpRequests].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
  const rosterAmendments = [...state.qbtcpRosterAmendments].reverse();
  const openHelpCount = helpRequests.filter((request) => request.status === 'open').length;
  const save = () => {
    if (!roomDraft.name.trim()) {
      onAnnounce('Enter a room name first.');
      return;
    }
    if (!controller.addRoom(roomDraft)) {
      onAnnounce('The room could not be added; review the Director error.');
      return;
    }
    onAnnounce(`${roomDraft.name.trim()} added.`);
    // Only this form's draft. A staff or equipment draft left open beside it is untouched.
    setRoomDraft(emptyRoomDraft);
    setShowForm(null);
  };
  const saveStaff = () => {
    if (!staffDraft.name.trim()) {
      onAnnounce('Enter a staff name first.');
      return;
    }
    if (staffDraft.roles.length === 0) {
      onAnnounce('Choose at least one staff role.');
      return;
    }
    if (!controller.addStaff({ name: staffDraft.name, roles: staffDraft.roles, notes: staffDraft.notes })) {
      onAnnounce('The staff member could not be added; review the Director error.');
      return;
    }
    onAnnounce(`${staffDraft.name.trim()} added to staff.`);
    setStaffDraft(emptyStaffDraft());
    setShowForm(null);
  };
  const saveEquipment = () => {
    if (!equipmentDraft.name.trim()) {
      onAnnounce('Enter an equipment name first.');
      return;
    }
    if (
      !controller.addEquipment({
        name: equipmentDraft.name,
        kind: equipmentDraft.kind,
        notes: equipmentDraft.notes,
      })
    ) {
      onAnnounce('The equipment resource could not be added; review the Director error.');
      return;
    }
    onAnnounce(`${equipmentDraft.name.trim()} added to equipment.`);
    setEquipmentDraft(emptyEquipmentDraft);
    setShowForm(null);
  };
  return (
    <>
      <PageHeader
        eyebrow="Plan"
        title="Rooms & staff"
        description={`${state.rooms.length} room${state.rooms.length === 1 ? '' : 's'} · staff and equipment assignments stay optional`}
        actions={
          <div className="director-row-actions">
            <Button variant="quiet" icon="plus" onClick={() => openForm('staff')}>
              Add staff
            </Button>
            <Button variant="quiet" icon="plus" onClick={() => openForm('equipment')}>
              Add equipment
            </Button>
            <Button variant="primary" icon="plus" onClick={() => openForm('room')}>
              Add room
            </Button>
          </div>
        }
      />
      <div className="director-page-stack">
        {nativeServer && (
          <section className="director-panel" aria-labelledby="director-qbtcp-title">
            <div className="director-panel-heading">
              <div>
                <p className="director-eyebrow">QBTCP server</p>
                <h2 id="director-qbtcp-title">Local network</h2>
              </div>
              <StateLabel state={qbtcpState} label={qbtcpStateLabel} />
            </div>
            <div className="director-panel-body">
              <dl className="director-detail-list director-detail-list-large">
                <div>
                  <dt>Address</dt>
                  <dd className="director-mono">
                    {qbtcpRunning && qbtcpStatus?.address
                      ? `${qbtcpStatus.address}${qbtcpStatus.port ? `:${qbtcpStatus.port}` : ''}`
                      : 'Not listening'}
                  </dd>
                </div>
                <div>
                  <dt>Paired rooms</dt>
                  <dd>{qbtcpRunning ? (qbtcpStatus?.pairedRooms ?? state.qbtcpSessions.length) : '—'}</dd>
                </div>
                <div>
                  <dt>Protocol</dt>
                  <dd>{qbtcpRunning ? (qbtcpStatus?.protocol ?? 'QBTCP v1') : '—'}</dd>
                </div>
              </dl>
              {qbtcpHasError && (
                <p className="director-error-copy" role="alert">
                  {qbtcpStatus?.message}
                </p>
              )}
              {controller.qbtcpHealth.error && (
                <p className="director-error-copy" role="alert">
                  {controller.qbtcpHealth.error}
                </p>
              )}
              {!nativeDirector && (
                <p className="director-panel-footnote">
                  The browser preview can plan and score manual games. Start the Tauri Director app for the
                  native LAN server.
                </p>
              )}
            </div>
            <div className="director-panel-footer">
              {nativeDirector ? (
                <Button
                  variant={qbtcpRunning ? 'secondary' : 'primary'}
                  icon={qbtcpRunning ? 'pause' : 'play'}
                  disabled={qbtcpLoading}
                  onClick={() => {
                    void toggleServer();
                  }}
                >
                  {qbtcpLoading ? 'Checking server' : qbtcpRunning ? 'Stop server' : 'Start server'}
                </Button>
              ) : (
                <span className="director-muted">Desktop app required to start the LAN server</span>
              )}
              {!qbtcpLoading && qbtcpStatus?.pairingUrl && invitations.length <= 1 && (
                <Button
                  variant="quiet"
                  onClick={() => void copyPairingLink(qbtcpStatus?.pairingUrl ?? '', 'Pairing link copied.')}
                >
                  Copy pairing link
                </Button>
              )}
            </div>
          </section>
        )}
        {nativeDirector && qbtcpRunning && (
          <section className="director-panel director-pairing-panel" aria-labelledby="director-pairing-title">
            <div className="director-panel-heading">
              <div>
                <p className="director-eyebrow">Pairing</p>
                <h2 id="director-pairing-title">Room invitations</h2>
              </div>
              <StateLabel state="paired" label="Room-specific" />
            </div>
            <div className="director-panel-body director-panel-body-list">
              <p className="director-panel-footnote">
                Each invitation is scoped to one room. Codes expire after{' '}
                {invitations[0]?.expiresInSeconds ?? 900} seconds and are not persisted in QBJ.
              </p>
              <ul className="director-list">
                {pairingRooms.length === 0 ? (
                  <li>
                    <span>No available rooms are configured.</span>
                  </li>
                ) : (
                  pairingRooms.map((room) => {
                    const invitation = invitations.find((entry) => entry.roomId === room.id);
                    return (
                      <li key={room.id}>
                        <div>
                          <strong>{room.name}</strong>
                          {invitation ? (
                            <small className="director-mono">{invitation.pairingCode}</small>
                          ) : (
                            <small>No active invitation</small>
                          )}
                        </div>
                        <div className="director-row-actions">
                          {invitation?.pairingUrl && (
                            <Button
                              variant="quiet"
                              onClick={() =>
                                void copyPairingLink(
                                  invitation.pairingUrl ?? '',
                                  `${room.name} pairing link copied.`,
                                )
                              }
                            >
                              Copy link
                            </Button>
                          )}
                          {invitation && !invitation.pairingUrl && (
                            <small className="director-muted">Code only; no LAN address found</small>
                          )}
                          <Button
                            variant={invitation ? 'quiet' : 'primary'}
                            disabled={pairingRoomId !== null}
                            onClick={() => void issuePairing(room.id)}
                          >
                            {pairingRoomId === room.id
                              ? 'Issuing…'
                              : invitation
                                ? 'Issue new'
                                : 'Issue pairing'}
                          </Button>
                        </div>
                      </li>
                    );
                  })
                )}
              </ul>
            </div>
          </section>
        )}
        {showForm === 'room' && (
          <section className="director-panel director-form-panel">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                save();
              }}
            >
              <div className="director-panel-heading">
                <div>
                  <p className="director-eyebrow">New room</p>
                  <h2>Room details</h2>
                </div>
                <Button variant="quiet" icon="x" onClick={() => setShowForm(null)}>
                  Close
                </Button>
              </div>
              <PanelBody>
                <div className="director-form-grid director-form-grid-three">
                  <FormField label="Room name">
                    <input
                      value={roomDraft.name}
                      onChange={(event) => setRoomDraft((draft) => ({ ...draft, name: event.target.value }))}
                      placeholder="Room 101"
                    />
                  </FormField>
                  <FormField label="Building">
                    <input
                      value={roomDraft.building}
                      onChange={(event) =>
                        setRoomDraft((draft) => ({ ...draft, building: event.target.value }))
                      }
                      placeholder="Main building"
                    />
                  </FormField>
                  <FormField label="Floor">
                    <input
                      value={roomDraft.floor}
                      onChange={(event) => setRoomDraft((draft) => ({ ...draft, floor: event.target.value }))}
                      placeholder="First"
                    />
                  </FormField>
                </div>
                <div className="director-form-grid director-form-grid-two">
                  <FormField
                    label="Accessibility notes"
                    hint="For example: step-free entrance or hearing loop."
                  >
                    <input
                      value={roomDraft.accessibility}
                      onChange={(event) =>
                        setRoomDraft((draft) => ({ ...draft, accessibility: event.target.value }))
                      }
                      placeholder="Step-free entrance"
                    />
                  </FormField>
                  <FormField label="Directions" hint="Give staff a short wayfinding note.">
                    <input
                      value={roomDraft.directions}
                      onChange={(event) =>
                        setRoomDraft((draft) => ({ ...draft, directions: event.target.value }))
                      }
                      placeholder="East stairwell, first door on the left"
                    />
                  </FormField>
                </div>
                <FormField label="Room notes">
                  <textarea
                    className="director-textarea"
                    rows={2}
                    value={roomDraft.notes}
                    onChange={(event) => setRoomDraft((draft) => ({ ...draft, notes: event.target.value }))}
                    placeholder="Anything the director or runners should know"
                  />
                </FormField>
              </PanelBody>
              <PanelFooter className="director-form-actions">
                <Button variant="primary" type="submit">
                  Save room
                </Button>
              </PanelFooter>
            </form>
          </section>
        )}
        {showForm === 'staff' && (
          <section className="director-panel director-form-panel">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                saveStaff();
              }}
            >
              <div className="director-panel-heading">
                <div>
                  <p className="director-eyebrow">New staff member</p>
                  <h2>Staff details</h2>
                </div>
                <Button variant="quiet" icon="x" onClick={() => setShowForm(null)}>
                  Close
                </Button>
              </div>
              <PanelBody>
                <div className="director-form-grid director-form-grid-two">
                  <FormField label="Name">
                    <input
                      value={staffDraft.name}
                      onChange={(event) => setStaffDraft((draft) => ({ ...draft, name: event.target.value }))}
                      placeholder="Alex Morgan"
                    />
                  </FormField>
                  {/*
                    The same checkboxes editing a staff member offers, rather than a single
                    "Primary role" select. Somebody who moderates and keeps score is one person with
                    two roles in the domain, and entering them used to require saving them wrong and
                    editing them straight afterwards.
                  */}
                  <StaffRoleField
                    roles={staffDraft.roles}
                    onChange={(roles) => setStaffDraft((draft) => ({ ...draft, roles }))}
                    idPrefix="new-staff"
                  />
                </div>
                <FormField label="Notes" hint="Optional handoff or contact details for the director team.">
                  <textarea
                    className="director-textarea"
                    rows={2}
                    value={staffDraft.notes}
                    onChange={(event) => setStaffDraft((draft) => ({ ...draft, notes: event.target.value }))}
                    placeholder="Prefers early rounds; call from HQ if reassigned"
                  />
                </FormField>
              </PanelBody>
              <PanelFooter className="director-form-actions">
                <Button variant="primary" type="submit">
                  Save staff member
                </Button>
              </PanelFooter>
            </form>
          </section>
        )}
        {showForm === 'equipment' && (
          <section className="director-panel director-form-panel">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                saveEquipment();
              }}
            >
              <div className="director-panel-heading">
                <div>
                  <p className="director-eyebrow">New resource</p>
                  <h2>Equipment details</h2>
                </div>
                <Button variant="quiet" icon="x" onClick={() => setShowForm(null)}>
                  Close
                </Button>
              </div>
              <PanelBody>
                <div className="director-form-grid director-form-grid-two">
                  <FormField label="Name">
                    <input
                      value={equipmentDraft.name}
                      onChange={(event) =>
                        setEquipmentDraft((draft) => ({ ...draft, name: event.target.value }))
                      }
                      placeholder="Buzzer set 1"
                    />
                  </FormField>
                  <FormField label="Type">
                    <select
                      value={equipmentDraft.kind}
                      onChange={(event) =>
                        setEquipmentDraft((draft) => ({
                          ...draft,
                          kind: event.target.value as EquipmentKind,
                        }))
                      }
                    >
                      <option value="buzzer">Buzzer</option>
                      <option value="device">Laptop / tablet</option>
                      <option value="other">Other</option>
                    </select>
                  </FormField>
                </div>
                <FormField label="Notes" hint="Optional handoff or contact details for the director team.">
                  <textarea
                    className="director-textarea"
                    rows={2}
                    value={equipmentDraft.notes}
                    onChange={(event) =>
                      setEquipmentDraft((draft) => ({ ...draft, notes: event.target.value }))
                    }
                    placeholder="Bring the spare buzzer to HQ"
                  />
                </FormField>
              </PanelBody>
              <PanelFooter className="director-form-actions">
                <Button variant="primary" type="submit">
                  Save equipment
                </Button>
              </PanelFooter>
            </form>
          </section>
        )}
        {state.rooms.length === 0 ? (
          <EmptyState
            title="No rooms yet"
            description="Add the rooms that can host games. Room availability and assignments are persisted with the tournament."
          >
            <Button variant="primary" icon="plus" onClick={() => openForm('room')}>
              Add first room
            </Button>
          </EmptyState>
        ) : (
          <section className="director-panel">
            <PanelBody className="director-filter-panel-body">
              <div className="director-filter-tabs" role="group" aria-label="Room status">
                <FilterButton active={filter === 'all'} onClick={() => setFilter('all')}>
                  All <span>{state.rooms.length}</span>
                </FilterButton>
                <FilterButton active={filter === 'available'} onClick={() => setFilter('available')}>
                  Available <span>{state.rooms.filter((room) => room.available).length}</span>
                </FilterButton>
                <FilterButton active={filter === 'live'} onClick={() => setFilter('live')}>
                  Live <span>{state.rooms.filter((room) => room.status === 'live').length}</span>
                </FilterButton>
                <FilterButton active={filter === 'help'} onClick={() => setFilter('help')}>
                  Help <span>{state.rooms.filter((room) => room.status === 'help').length}</span>
                </FilterButton>
                <FilterButton active={filter === 'offline'} onClick={() => setFilter('offline')}>
                  Offline <span>{state.rooms.filter((room) => room.status === 'offline').length}</span>
                </FilterButton>
              </div>
            </PanelBody>
            <div className="director-table-wrap">
              <table className="director-table">
                <thead>
                  <tr>
                    <th>Room</th>
                    <th>Location</th>
                    <th>Moderator</th>
                    <th>Scorekeeper</th>
                    <th>Equipment</th>
                    <th>Status</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {rooms.length > 0 ? (
                    rooms.map((room) => (
                      <RoomRows
                        key={room.id}
                        state={state}
                        room={room}
                        controller={controller}
                        onNavigate={onNavigate}
                        onAnnounce={onAnnounce}
                        navigationTarget={navigationTarget}
                        onClearNavigationTarget={onClearNavigationTarget}
                      />
                    ))
                  ) : (
                    <tr className="director-table-empty-row">
                      <td colSpan={7}>
                        <p className="director-empty-copy">No rooms match this filter.</p>
                        <button
                          type="button"
                          className="director-inline-action"
                          onClick={() => setFilter('all')}
                        >
                          Show all rooms
                        </button>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        )}
        {(helpRequests.length > 0 || rosterAmendments.length > 0) && (
          <section className="director-panel">
            <div className="director-panel-heading">
              <div>
                <p className="director-eyebrow">QBTCP operations</p>
                <h2>Requests & roster amendments</h2>
              </div>
              <span className="director-muted">
                {openHelpCount
                  ? `${openHelpCount} help request${openHelpCount === 1 ? '' : 's'} open`
                  : 'No help requests open'}
              </span>
            </div>
            <PanelBody>
              {helpRequests.length > 0 && (
                <>
                  <p className="director-eyebrow">Scorekeeper help</p>
                  <ul className="director-activity-list">
                    {helpRequests.map((request) => (
                      <li key={request.id}>
                        <div>
                          <strong>
                            {request.roomName} · {request.category}
                          </strong>
                          <span>{request.message}</span>
                          <small className="director-table-subtext">
                            {request.deviceId}
                            {request.operatorName ? ` · ${request.operatorName}` : ''} ·{' '}
                            {formatTime(request.createdAt)}
                          </small>
                        </div>
                        <StateLabel
                          state={request.status === 'open' ? 'help' : 'finished'}
                          label={request.status === 'open' ? 'Open' : request.status}
                        />
                        {request.status === 'open' && (
                          <Button
                            variant="quiet"
                            onClick={() => {
                              void controller.resolveQbtcpHelp(request.id).then((resolved) => {
                                if (resolved) onAnnounce(`${request.roomName} help request resolved.`);
                              });
                            }}
                          >
                            Mark resolved
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {rosterAmendments.length > 0 && (
                <>
                  <p className="director-eyebrow director-operations-subheading">Roster amendments</p>
                  <ul className="director-activity-list">
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
                        referencedTeam?.displayName ??
                        referencedTeamName ??
                        referencedTeamId ??
                        'Team unresolved';
                      const candidates = state.players.filter(
                        (player) => player.active && (!referencedTeam || player.teamId === referencedTeam.id),
                      );
                      const selectedPlayerId = amendmentMappings[entry.id] ?? '';
                      return (
                        <li key={entry.id}>
                          <div>
                            <strong>{playerName}</strong>
                            <span>
                              {team} · session {entry.sessionId}
                            </span>
                            <small className="director-table-subtext">
                              Original scorekeeper submission retained as evidence.
                              {entry.decidedBy ? ` Decided by ${entry.decidedBy}.` : ''}
                            </small>
                          </div>
                          <StateLabel
                            state={entry.status === 'pending' ? 'review' : 'finished'}
                            label={rosterAmendmentStatusLabel(entry.status)}
                          />
                          {entry.status === 'pending' && (
                            <div className="director-row-actions director-roster-amendment-actions">
                              <Button
                                variant="quiet"
                                onClick={() => {
                                  if (controller.approveRosterAmendmentAsNew(entry.id)) {
                                    onAnnounce(`${playerName} approved as a new canonical player.`);
                                  }
                                }}
                              >
                                Approve as new
                              </Button>
                              <select
                                aria-label={`Map ${playerName} to an existing player`}
                                value={selectedPlayerId}
                                onChange={(event) =>
                                  setAmendmentMappings((previous) => ({
                                    ...previous,
                                    [entry.id]: event.target.value,
                                  }))
                                }
                              >
                                <option value="">Map to existing…</option>
                                {candidates.map((candidate) => (
                                  <option key={candidate.id} value={candidate.id}>
                                    {candidate.name} · {teamName(state, candidate.teamId)}
                                  </option>
                                ))}
                              </select>
                              <Button
                                variant="quiet"
                                disabled={!selectedPlayerId}
                                onClick={() => {
                                  if (controller.mapRosterAmendment(entry.id, selectedPlayerId)) {
                                    onAnnounce(`${playerName} mapped to the canonical roster.`);
                                  }
                                }}
                              >
                                Map
                              </Button>
                              <Button
                                variant="quiet"
                                onClick={() => {
                                  if (controller.rejectRosterAmendment(entry.id)) {
                                    onAnnounce(`${playerName} roster amendment dismissed.`);
                                  }
                                }}
                              >
                                Reject
                              </Button>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </PanelBody>
          </section>
        )}
        {(state.staff.length > 0 || state.equipment.length > 0) && (
          <div className="director-two-column">
            <section className="director-panel">
              <div className="director-panel-heading">
                <div>
                  <p className="director-eyebrow">Staff</p>
                  <h2>
                    {state.staff.length} member{state.staff.length === 1 ? '' : 's'} ·{' '}
                    {state.staff.filter((member) => member.available).length} available
                  </h2>
                </div>
              </div>
              <PanelBody>
                <ul className="director-plain-list">
                  {state.staff.map((member) => (
                    <StaffResourceRow
                      key={member.id}
                      member={member}
                      controller={controller}
                      onAnnounce={onAnnounce}
                    />
                  ))}
                </ul>
              </PanelBody>
            </section>
            <section className="director-panel">
              <div className="director-panel-heading">
                <div>
                  <p className="director-eyebrow">Equipment</p>
                  <h2>
                    {state.equipment.length} resource{state.equipment.length === 1 ? '' : 's'} ·{' '}
                    {state.equipment.filter((item) => item.available).length} available
                  </h2>
                </div>
              </div>
              <PanelBody>
                <ul className="director-plain-list">
                  {state.equipment.map((item) => (
                    <EquipmentResourceRow
                      key={item.id}
                      item={item}
                      controller={controller}
                      onAnnounce={onAnnounce}
                    />
                  ))}
                </ul>
              </PanelBody>
            </section>
          </div>
        )}
      </div>
    </>
  );
}

function RoomRows({
  state,
  room,
  controller,
  onNavigate,
  onAnnounce,
  navigationTarget,
  onClearNavigationTarget,
}: {
  state: DirectorState;
  room: DirectorState['rooms'][number];
  controller: DirectorController;
  onNavigate?: (section: SectionId) => void;
  onAnnounce: (announcement: AnnounceInput) => void;
  navigationTarget?: DirectorNavigationTarget | null;
  onClearNavigationTarget?: () => void;
}) {
  const roomNavigation = useNavigationHighlight(
    navigationTarget,
    'rooms',
    'room',
    room.id,
    onClearNavigationTarget,
  );
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(room.name);
  const [building, setBuilding] = useState(room.building ?? '');
  const [floor, setFloor] = useState(room.floor ?? '');
  const [accessibility, setAccessibility] = useState(room.accessibility ?? '');
  const [directions, setDirections] = useState(room.directions ?? '');
  const [notes, setNotes] = useState(room.notes ?? '');
  const [moderatorId, setModeratorId] = useState(room.moderatorId ?? '');
  const [scorekeeperId, setScorekeeperId] = useState(room.scorekeeperId ?? '');
  const [equipmentId, setEquipmentId] = useState(room.equipmentId ?? '');
  const [available, setAvailable] = useState(room.available);
  const beginEdit = () => {
    setName(room.name);
    setBuilding(room.building ?? '');
    setFloor(room.floor ?? '');
    setAccessibility(room.accessibility ?? '');
    setDirections(room.directions ?? '');
    setNotes(room.notes ?? '');
    setModeratorId(room.moderatorId ?? '');
    setScorekeeperId(room.scorekeeperId ?? '');
    setEquipmentId(room.equipmentId ?? '');
    setAvailable(room.available);
    setEditing(true);
  };
  const save = () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      onAnnounce('Enter a room name first.');
      return;
    }
    const updated = controller.updateRoom(room.id, {
      name: trimmedName,
      building: building.trim(),
      floor: floor.trim(),
      accessibility,
      directions,
      notes,
      moderatorId: moderatorId || null,
      scorekeeperId: scorekeeperId || null,
      equipmentId: equipmentId || null,
      available,
    });
    if (!updated) {
      onAnnounce('The room could not be updated; review the Director error.');
      return;
    }
    setEditing(false);
    onAnnounce(`${trimmedName} updated.`);
  };
  return (
    <>
      <tr
        tabIndex={-1}
        className={roomNavigation ? 'is-navigation-target' : undefined}
        data-director-navigation-id={room.id}
      >
        <td>
          <span data-director-navigation-focus tabIndex={-1}>
            <strong>{room.name}</strong>
            <small className="director-table-subtext">{room.accessibility || 'No access notes'}</small>
            {room.directions && <small className="director-table-subtext">{room.directions}</small>}
            {room.notes && <small className="director-table-subtext">{room.notes}</small>}
          </span>
        </td>
        <td>{[room.building, room.floor].filter(Boolean).join(' · ') || '—'}</td>
        <td>{staffName(state, room.moderatorId) || 'Unassigned'}</td>
        <td>{staffName(state, room.scorekeeperId) || 'Unassigned'}</td>
        <td>{equipmentName(state, room.equipmentId) || 'Unassigned'}</td>
        <td>
          <StateLabel state={room.status} />
          <small className="director-table-subtext">
            {room.available
              ? room.status === 'available'
                ? 'Ready for assignment'
                : room.status === 'finished'
                  ? 'Marked available after round closes'
                  : 'Marked available after current session'
              : 'Unavailable for future rounds'}
          </small>
        </td>
        <td>
          <div className="director-row-actions">
            <Button variant="quiet" icon="edit" onClick={beginEdit}>
              Edit
            </Button>
            <button
              type="button"
              className="director-button director-button-quiet director-table-action"
              aria-label={`${room.available ? 'Mark' : 'Make'} ${room.name} ${room.available ? 'unavailable' : 'available'}`}
              onClick={() => {
                if (controller.updateRoom(room.id, { available: !room.available })) {
                  onAnnounce(
                    `${room.name} marked ${room.available ? 'unavailable' : 'available'} for the next round.`,
                  );
                }
              }}
            >
              <Icon name={room.available ? 'pause' : 'play'} size={14} />
              <span>{room.available ? 'Unavailable' : 'Available'}</span>
            </button>
            {onNavigate &&
              state.scheduledGames.some(
                (game) =>
                  game.roomId === room.id && !game.bye && !['accepted', 'cancelled'].includes(game.status),
              ) && (
                <Button variant="quiet" icon="upload" onClick={() => onNavigate('transfers')}>
                  Prepare game file
                </Button>
              )}
          </div>
        </td>
      </tr>
      {editing && (
        <tr className="director-table-edit-row">
          <td colSpan={7}>
            <form
              className="director-inline-edit"
              onSubmit={(event) => {
                event.preventDefault();
                save();
              }}
            >
              <div className="director-form-grid director-form-grid-three">
                <FormField label="Room name">
                  <input value={name} onChange={(event) => setName(event.target.value)} />
                </FormField>
                <FormField label="Building">
                  <input value={building} onChange={(event) => setBuilding(event.target.value)} />
                </FormField>
                <FormField label="Floor">
                  <input value={floor} onChange={(event) => setFloor(event.target.value)} />
                </FormField>
              </div>
              <div className="director-form-grid director-form-grid-two">
                <FormField
                  label="Accessibility notes"
                  hint="For example: step-free entrance or hearing loop."
                >
                  <input
                    value={accessibility}
                    onChange={(event) => setAccessibility(event.target.value)}
                    placeholder="Step-free entrance"
                  />
                </FormField>
                <FormField label="Directions" hint="Give staff a short wayfinding note.">
                  <input
                    value={directions}
                    onChange={(event) => setDirections(event.target.value)}
                    placeholder="East stairwell, first door on the left"
                  />
                </FormField>
              </div>
              <FormField label="Room notes">
                <textarea
                  className="director-textarea"
                  rows={2}
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  placeholder="Anything the director or runners should know"
                />
              </FormField>
              <div className="director-form-grid director-form-grid-three">
                <FormField label="Moderator">
                  <select value={moderatorId} onChange={(event) => setModeratorId(event.target.value)}>
                    <option value="">Unassigned</option>
                    {staffForRole(state, 'moderator', moderatorId).map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.name}
                      </option>
                    ))}
                  </select>
                </FormField>
                <FormField label="Scorekeeper">
                  <select value={scorekeeperId} onChange={(event) => setScorekeeperId(event.target.value)}>
                    <option value="">Unassigned</option>
                    {staffForRole(state, 'scorekeeper', scorekeeperId).map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.name}
                      </option>
                    ))}
                  </select>
                </FormField>
                <FormField label="Equipment">
                  <select value={equipmentId} onChange={(event) => setEquipmentId(event.target.value)}>
                    <option value="">Unassigned</option>
                    {state.equipment
                      .filter((item) => item.available || item.id === equipmentId)
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                  </select>
                </FormField>
              </div>
              <label className="director-checkbox-field">
                <input
                  type="checkbox"
                  checked={available}
                  onChange={(event) => setAvailable(event.target.checked)}
                />
                <span>Available for future assignment</span>
              </label>
              <div className="director-row-actions">
                <Button variant="primary" type="submit">
                  Save changes
                </Button>
                <Button variant="quiet" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          </td>
        </tr>
      )}
    </>
  );
}

const staffRoleOptions: Array<{ value: StaffRole; label: string }> = [
  { value: 'moderator', label: 'Moderator' },
  { value: 'scorekeeper', label: 'Scorekeeper' },
  { value: 'runner', label: 'Runner' },
  { value: 'hq', label: 'HQ staff' },
];

/**
 * Which roles somebody has, asked the same way wherever it is asked.
 *
 * Creating a staff member and editing one are the same question about the same field, and they used
 * to be two different controls: a single-choice "Primary role" select on the way in, checkboxes
 * afterwards. Somebody who both moderates and keeps score could not be entered as such, so the
 * mental model a director learned on the first screen was wrong by the second.
 */
function StaffRoleField({
  roles,
  onChange,
  idPrefix,
}: {
  roles: readonly StaffRole[];
  onChange: (roles: StaffRole[]) => void;
  /** Distinguishes this group's checkboxes from another instance rendered on the same page. */
  idPrefix: string;
}) {
  return (
    <fieldset className="director-resource-role-field">
      <legend>Roles</legend>
      <div className="director-resource-role-grid">
        {staffRoleOptions.map((role) => (
          <label className="director-checkbox-field" key={role.value} htmlFor={`${idPrefix}-${role.value}`}>
            <input
              id={`${idPrefix}-${role.value}`}
              type="checkbox"
              checked={roles.includes(role.value)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? roles.includes(role.value)
                      ? [...roles]
                      : [...roles, role.value]
                    : roles.filter((entry) => entry !== role.value),
                )
              }
            />
            <span>{role.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function StaffResourceRow({
  member,
  controller,
  onAnnounce,
  navigationTarget: _navigationTarget,
  onClearNavigationTarget: _onClearNavigationTarget,
}: {
  member: DirectorState['staff'][number];
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
  navigationTarget?: DirectorNavigationTarget | null;
  onClearNavigationTarget?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(member.name);
  const [roles, setRoles] = useState<StaffRole[]>(member.roles.length ? [...member.roles] : ['moderator']);
  const [notes, setNotes] = useState(member.notes ?? '');
  const beginEdit = () => {
    setName(member.name);
    setRoles(member.roles.length ? [...member.roles] : ['moderator']);
    setNotes(member.notes ?? '');
    setEditing(true);
  };
  const save = () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      onAnnounce('Enter a staff name first.');
      return;
    }
    if (roles.length === 0) {
      onAnnounce('Choose at least one staff role.');
      return;
    }
    if (
      !controller.updateStaff(member.id, {
        name: trimmedName,
        roles,
        notes,
      })
    ) {
      onAnnounce('The staff member could not be updated; review the Director error.');
      return;
    }
    setEditing(false);
    onAnnounce(`${trimmedName} updated.`);
  };
  return (
    <li className="director-resource-item">
      <div className="director-resource-summary">
        <strong>{member.name}</strong>
        <span>{member.roles.map(roleLabel).join(' · ') || 'No role assigned'}</span>
        {member.notes && <small className="director-table-subtext">{member.notes}</small>}
      </div>
      <div className="director-row-actions">
        <StateLabel
          state={member.available ? 'available' : 'offline'}
          label={member.available ? 'Available' : 'Unavailable'}
        />
        <Button variant="quiet" icon="edit" onClick={beginEdit}>
          Edit
        </Button>
        <Button
          variant="quiet"
          icon={member.available ? 'pause' : 'play'}
          onClick={() => {
            const updated = controller.updateStaff(member.id, {
              available: !member.available,
            });
            if (updated) {
              onAnnounce(
                `${member.name} marked ${member.available ? 'unavailable' : 'available'} for future assignment.`,
              );
            }
          }}
        >
          {member.available ? 'Mark unavailable' : 'Mark available'}
        </Button>
      </div>
      {editing && (
        <form
          className="director-resource-edit"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <div className="director-form-grid director-form-grid-two">
            <FormField label="Name">
              <input value={name} onChange={(event) => setName(event.target.value)} />
            </FormField>
            <StaffRoleField roles={roles} onChange={setRoles} idPrefix={`staff-${member.id}`} />
          </div>
          <FormField label="Notes" hint="Optional handoff or contact details for the director team.">
            <textarea
              className="director-textarea"
              rows={2}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </FormField>
          <div className="director-row-actions">
            <Button variant="primary" type="submit">
              Save changes
            </Button>
            <Button variant="quiet" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </li>
  );
}

function EquipmentResourceRow({
  item,
  controller,
  onAnnounce,
  navigationTarget: _navigationTarget,
  onClearNavigationTarget: _onClearNavigationTarget,
}: {
  item: DirectorState['equipment'][number];
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
  navigationTarget?: DirectorNavigationTarget | null;
  onClearNavigationTarget?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(item.name);
  const [kind, setKind] = useState<DirectorState['equipment'][number]['kind']>(item.kind);
  const [notes, setNotes] = useState(item.notes ?? '');
  const beginEdit = () => {
    setName(item.name);
    setKind(item.kind);
    setNotes(item.notes ?? '');
    setEditing(true);
  };
  const save = () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      onAnnounce('Enter an equipment name first.');
      return;
    }
    if (
      !controller.updateEquipment(item.id, {
        name: trimmedName,
        kind,
        notes,
      })
    ) {
      onAnnounce('The equipment resource could not be updated; review the Director error.');
      return;
    }
    setEditing(false);
    onAnnounce(`${trimmedName} updated.`);
  };
  return (
    <li className="director-resource-item">
      <div className="director-resource-summary">
        <strong>{item.name}</strong>
        <span>{equipmentKindLabel(item.kind)}</span>
        {item.notes && <small className="director-table-subtext">{item.notes}</small>}
      </div>
      <div className="director-row-actions">
        <StateLabel
          state={item.available ? 'available' : 'offline'}
          label={item.available ? 'Available' : 'Unavailable'}
        />
        <Button variant="quiet" icon="edit" onClick={beginEdit}>
          Edit
        </Button>
        <Button
          variant="quiet"
          icon={item.available ? 'pause' : 'play'}
          onClick={() => {
            const updated = controller.updateEquipment(item.id, {
              available: !item.available,
            });
            if (updated) {
              onAnnounce(
                `${item.name} marked ${item.available ? 'unavailable' : 'available'} for future assignment.`,
              );
            }
          }}
        >
          {item.available ? 'Mark unavailable' : 'Mark available'}
        </Button>
      </div>
      {editing && (
        <form
          className="director-resource-edit"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <div className="director-form-grid director-form-grid-two">
            <FormField label="Name">
              <input value={name} onChange={(event) => setName(event.target.value)} />
            </FormField>
            <FormField label="Type">
              <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
                <option value="buzzer">Buzzer</option>
                <option value="device">Laptop / tablet</option>
                <option value="other">Other</option>
              </select>
            </FormField>
          </div>
          <FormField label="Notes" hint="Optional handoff or contact details for the director team.">
            <textarea
              className="director-textarea"
              rows={2}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </FormField>
          <div className="director-row-actions">
            <Button variant="primary" type="submit">
              Save changes
            </Button>
            <Button variant="quiet" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </li>
  );
}

function roleLabel(role: StaffRole): string {
  return staffRoleOptions.find((option) => option.value === role)?.label ?? role;
}

function equipmentKindLabel(kind: DirectorState['equipment'][number]['kind']): string {
  return kind === 'buzzer' ? 'Buzzer' : kind === 'device' ? 'Laptop / tablet' : 'Other';
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

function FilterButton({
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
      aria-pressed={active}
      className={`director-filter-tab ${active ? 'is-active' : ''}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
function staffName(state: DirectorState, id: string | null): string {
  return id ? (state.staff.find((member) => member.id === id)?.name ?? '') : '';
}
function equipmentName(state: DirectorState, id: string | null): string {
  return id ? (state.equipment.find((item) => item.id === id)?.name ?? '') : '';
}

function teamName(state: DirectorState, id: string): string {
  return state.teams.find((team) => team.id === id)?.displayName ?? 'Unknown team';
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
