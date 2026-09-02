import { useState } from 'react';
import type { DirectorState, StaffRole } from '../domain';
import type { DirectorController } from '../state/useDirectorController';
import { Button, EmptyState, FormField, PanelBody, PanelFooter, StateLabel } from '../components/Controls';
import type { SectionId } from '../app/navigation';
import type { DirectorNavigationTarget } from '../app/navigationTarget';
import { useNavigationHighlight } from '../app/useNavigationHighlight';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';

export function RoomsView({
  state,
  controller,
  onNavigate,
  onAnnounce,
  navigationTarget,
  onClearNavigationTarget,
}: {
  state: DirectorState;
  controller: DirectorController;
  onNavigate?: (section: SectionId) => void;
  onAnnounce: (message: string) => void;
  navigationTarget?: DirectorNavigationTarget | null;
  onClearNavigationTarget?: () => void;
}) {
  const [showForm, setShowForm] = useState<'room' | 'staff' | 'equipment' | null>(null);
  const [name, setName] = useState('');
  const [building, setBuilding] = useState('');
  const [floor, setFloor] = useState('');
  const [accessibility, setAccessibility] = useState('');
  const [directions, setDirections] = useState('');
  const [notes, setNotes] = useState('');
  const [staffRole, setStaffRole] = useState<'moderator' | 'scorekeeper' | 'runner' | 'hq'>('moderator');
  const [equipmentKind, setEquipmentKind] = useState<'buzzer' | 'device' | 'other'>('buzzer');
  const [filter, setFilter] = useState<'all' | 'available' | 'live' | 'help' | 'offline'>('all');
  const [amendmentMappings, setAmendmentMappings] = useState<Record<string, string>>({});
  const openForm = (kind: 'room' | 'staff' | 'equipment') => {
    setShowForm(kind);
    setName('');
    setBuilding('');
    setFloor('');
    setAccessibility('');
    setDirections('');
    setNotes('');
    if (kind === 'staff') setStaffRole('moderator');
    if (kind === 'equipment') setEquipmentKind('buzzer');
  };
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
    if (!name.trim()) {
      onAnnounce('Enter a room name first.');
      return;
    }
    if (!controller.addRoom({ name, building, floor, accessibility, directions, notes })) {
      onAnnounce('The room could not be added; review the Director error.');
      return;
    }
    onAnnounce(`${name.trim()} added.`);
    setName('');
    setBuilding('');
    setFloor('');
    setAccessibility('');
    setDirections('');
    setNotes('');
    setShowForm(null);
  };
  const saveStaff = () => {
    if (!name.trim()) {
      onAnnounce('Enter a staff name first.');
      return;
    }
    if (!controller.addStaff({ name, roles: [staffRole], notes })) {
      onAnnounce('The staff member could not be added; review the Director error.');
      return;
    }
    onAnnounce(`${name.trim()} added to staff.`);
    setName('');
    setNotes('');
    setShowForm(null);
  };
  const saveEquipment = () => {
    if (!name.trim()) {
      onAnnounce('Enter an equipment name first.');
      return;
    }
    if (!controller.addEquipment({ name, kind: equipmentKind, notes })) {
      onAnnounce('The equipment resource could not be added; review the Director error.');
      return;
    }
    onAnnounce(`${name.trim()} added to equipment.`);
    setName('');
    setNotes('');
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
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="Room 101"
                    />
                  </FormField>
                  <FormField label="Building">
                    <input
                      value={building}
                      onChange={(event) => setBuilding(event.target.value)}
                      placeholder="Main building"
                    />
                  </FormField>
                  <FormField label="Floor">
                    <input
                      value={floor}
                      onChange={(event) => setFloor(event.target.value)}
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
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="Alex Morgan"
                    />
                  </FormField>
                  <FormField label="Primary role">
                    <select
                      value={staffRole}
                      onChange={(event) => setStaffRole(event.target.value as typeof staffRole)}
                    >
                      <option value="moderator">Moderator</option>
                      <option value="scorekeeper">Scorekeeper</option>
                      <option value="runner">Runner</option>
                      <option value="hq">HQ staff</option>
                    </select>
                  </FormField>
                </div>
                <FormField label="Notes" hint="Optional handoff or contact details for the director team.">
                  <textarea
                    className="director-textarea"
                    rows={2}
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
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
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="Buzzer set 1"
                    />
                  </FormField>
                  <FormField label="Type">
                    <select
                      value={equipmentKind}
                      onChange={(event) => setEquipmentKind(event.target.value as typeof equipmentKind)}
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
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
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
              <div className="director-filter-tabs" role="tablist" aria-label="Room status">
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
  onAnnounce: (message: string) => void;
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

function StaffResourceRow({
  member,
  controller,
  onAnnounce,
  navigationTarget: _navigationTarget,
  onClearNavigationTarget: _onClearNavigationTarget,
}: {
  member: DirectorState['staff'][number];
  controller: DirectorController;
  onAnnounce: (message: string) => void;
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
            <fieldset className="director-resource-role-field">
              <legend>Roles</legend>
              <div className="director-resource-role-grid">
                {staffRoleOptions.map((role) => (
                  <label className="director-checkbox-field" key={role.value}>
                    <input
                      type="checkbox"
                      checked={roles.includes(role.value)}
                      onChange={(event) => {
                        setRoles((current) =>
                          event.target.checked
                            ? current.includes(role.value)
                              ? current
                              : [...current, role.value]
                            : current.filter((entry) => entry !== role.value),
                        );
                      }}
                    />
                    <span>{role.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
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
  onAnnounce: (message: string) => void;
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
      role="tab"
      aria-selected={active}
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
