import { useState } from 'react';
import type { DirectorState } from '../domain';
import type { DirectorController } from '../state/useDirectorController';
import { Button, EmptyState, FormField, PanelBody, PanelFooter, StateLabel } from '../components/Controls';
import type { SectionId } from '../app/navigation';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';

export function RoomsView({
  state,
  controller,
  onNavigate,
  onAnnounce,
}: {
  state: DirectorState;
  controller: DirectorController;
  onNavigate?: (section: SectionId) => void;
  onAnnounce: (message: string) => void;
}) {
  const [showForm, setShowForm] = useState<'room' | 'staff' | 'equipment' | null>(null);
  const [name, setName] = useState('');
  const [building, setBuilding] = useState('');
  const [floor, setFloor] = useState('');
  const [staffRole, setStaffRole] = useState<'moderator' | 'scorekeeper' | 'runner' | 'hq'>('moderator');
  const [equipmentKind, setEquipmentKind] = useState<'buzzer' | 'device' | 'other'>('buzzer');
  const [filter, setFilter] = useState<'all' | 'available' | 'live' | 'help' | 'offline'>('all');
  const rooms = state.rooms.filter(
    (room) => filter === 'all' || (filter === 'available' ? room.available : room.status === filter),
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
    controller.addRoom({ name, building, floor });
    onAnnounce(`${name.trim()} added.`);
    setName('');
    setBuilding('');
    setFloor('');
    setShowForm(null);
  };
  const saveStaff = () => {
    if (!name.trim()) {
      onAnnounce('Enter a staff name first.');
      return;
    }
    controller.addStaff({ name, roles: [staffRole] });
    onAnnounce(`${name.trim()} added to staff.`);
    setName('');
    setShowForm(null);
  };
  const saveEquipment = () => {
    if (!name.trim()) {
      onAnnounce('Enter an equipment name first.');
      return;
    }
    controller.addEquipment({ name, kind: equipmentKind });
    onAnnounce(`${name.trim()} added to equipment.`);
    setName('');
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
            <Button variant="quiet" icon="plus" onClick={() => setShowForm('staff')}>
              Add staff
            </Button>
            <Button variant="quiet" icon="plus" onClick={() => setShowForm('equipment')}>
              Add equipment
            </Button>
            <Button variant="primary" icon="plus" onClick={() => setShowForm('room')}>
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
            <Button variant="primary" icon="plus" onClick={() => setShowForm('room')}>
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
                  {rooms.map((room) => (
                    <RoomRows
                      key={room.id}
                      state={state}
                      room={room}
                      controller={controller}
                      onNavigate={onNavigate}
                      onAnnounce={onAnnounce}
                    />
                  ))}
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
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {rosterAmendments.length > 0 && (
                <>
                  <p className="director-eyebrow director-operations-subheading">Roster amendments</p>
                  <ul className="director-activity-list">
                    {rosterAmendments.map((entry, index) => {
                      const playerName = stringField(entry.amendment.playerName) ?? 'Unrecognized player';
                      const team =
                        stringField(entry.amendment.teamName) ??
                        stringField(entry.amendment.teamId) ??
                        'Team unresolved';
                      return (
                        <li key={`${entry.sessionId}-${index}`}>
                          <div>
                            <strong>{playerName}</strong>
                            <span>
                              {team} · session {entry.sessionId}
                            </span>
                            <small className="director-table-subtext">
                              Review only; the canonical roster was not changed.
                            </small>
                          </div>
                          <StateLabel state="review" label="Review" />
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
                    {state.staff.length} available member{state.staff.length === 1 ? '' : 's'}
                  </h2>
                </div>
              </div>
              <PanelBody>
                <ul className="director-plain-list">
                  {state.staff.map((member) => (
                    <li key={member.id}>
                      <strong>{member.name}</strong>
                      <span>{member.roles.join(' · ')}</span>
                    </li>
                  ))}
                </ul>
              </PanelBody>
            </section>
            <section className="director-panel">
              <div className="director-panel-heading">
                <div>
                  <p className="director-eyebrow">Equipment</p>
                  <h2>
                    {state.equipment.length} resource{state.equipment.length === 1 ? '' : 's'}
                  </h2>
                </div>
              </div>
              <PanelBody>
                <ul className="director-plain-list">
                  {state.equipment.map((item) => (
                    <li key={item.id}>
                      <strong>{item.name}</strong>
                      <span>{item.kind}</span>
                    </li>
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
}: {
  state: DirectorState;
  room: DirectorState['rooms'][number];
  controller: DirectorController;
  onNavigate?: (section: SectionId) => void;
  onAnnounce: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(room.name);
  const [building, setBuilding] = useState(room.building ?? '');
  const [floor, setFloor] = useState(room.floor ?? '');
  const [moderatorId, setModeratorId] = useState(room.moderatorId ?? '');
  const [scorekeeperId, setScorekeeperId] = useState(room.scorekeeperId ?? '');
  const [equipmentId, setEquipmentId] = useState(room.equipmentId ?? '');
  const [available, setAvailable] = useState(room.available);
  const beginEdit = () => {
    setName(room.name);
    setBuilding(room.building ?? '');
    setFloor(room.floor ?? '');
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
    controller.updateRoom(room.id, {
      name: trimmedName,
      building: building.trim(),
      floor: floor.trim(),
      moderatorId: moderatorId || null,
      scorekeeperId: scorekeeperId || null,
      equipmentId: equipmentId || null,
      available,
    });
    setEditing(false);
    onAnnounce(`${trimmedName} updated.`);
  };
  return (
    <>
      <tr>
        <td>
          <strong>{room.name}</strong>
          <small className="director-table-subtext">{room.accessibility || 'No access notes'}</small>
        </td>
        <td>{[room.building, room.floor].filter(Boolean).join(' · ') || '—'}</td>
        <td>{staffName(state, room.moderatorId) || 'Unassigned'}</td>
        <td>{staffName(state, room.scorekeeperId) || 'Unassigned'}</td>
        <td>{equipmentName(state, room.equipmentId) || 'Unassigned'}</td>
        <td>
          <StateLabel state={room.status} />
          <small className="director-table-subtext">
            {room.available ? 'Available next round' : 'Unavailable next round'}
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
                controller.updateRoom(room.id, { available: !room.available });
                onAnnounce(
                  `${room.name} marked ${room.available ? 'unavailable' : 'available'} for the next round.`,
                );
              }}
            >
              <Icon name={room.available ? 'pause' : 'play'} size={14} />
              <span>{room.available ? 'Unavailable' : 'Available'}</span>
            </button>
            {onNavigate &&
              state.scheduledGames.some(
                (game) => game.roomId === room.id && !game.bye && game.status !== 'accepted',
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
                    {state.equipment.map((item) => (
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

function staffForRole(
  state: DirectorState,
  role: 'moderator' | 'scorekeeper',
  selectedId: string,
): DirectorState['staff'] {
  return state.staff.filter((member) => member.roles.includes(role) || member.id === selectedId);
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

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
