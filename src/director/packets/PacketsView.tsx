import { useState } from 'react';
import type { DirectorState } from '../domain';
import type { DirectorController } from '../state/useDirectorController';
import { Button, EmptyState, FormField, PanelBody, PanelFooter, StateLabel } from '../components/Controls';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { importQbjText } from '../format/interchange';
import type { DirectorNavigationTarget } from '../app/navigationTarget';
import { useNavigationHighlight } from '../app/useNavigationHighlight';
import { errorNotice, type AnnounceInput } from '../notices';

export function PacketsView({
  state,
  controller,
  onNavigate,
  onAnnounce,
  navigationTarget,
  onClearNavigationTarget,
}: {
  state: DirectorState;
  controller: DirectorController;
  onNavigate?: (section: import('../app/navigation').SectionId) => void;
  onAnnounce: (announcement: AnnounceInput) => void;
  navigationTarget?: DirectorNavigationTarget | null;
  onClearNavigationTarget?: () => void;
}) {
  const [showForm, setShowForm] = useState(false);
  const [detailsPacketId, setDetailsPacketId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [tiebreaker, setTiebreaker] = useState(false);
  const [notes, setNotes] = useState('');
  const save = () => {
    if (!name.trim()) {
      onAnnounce(errorNotice('Enter a packet name first.'));
      return;
    }
    if (!controller.addPacket(name, 'manual', { tiebreaker, notes })) {
      onAnnounce(errorNotice('Packet was not added; review the Director error.'));
      return;
    }
    onAnnounce(`${name.trim()} added to inventory.`);
    setName('');
    setTiebreaker(false);
    setNotes('');
    setShowForm(false);
  };
  const importQbj = async (file: File | undefined) => {
    if (!file) return;
    try {
      const report = importQbjText(await file.text());
      if (!report.ok || !report.state) {
        onAnnounce(errorNotice(report.errors.join(' ') || 'That QBJ file is not valid.'));
        return;
      }
      if (report.state.packets.length === 0) {
        onAnnounce(errorNotice('That QBJ file does not contain packet inventory.'));
        return;
      }
      const result = controller.addPackets(
        report.state.packets.map((packet) => ({
          name: packet.name,
          source: 'qbj' as const,
          tiebreaker: packet.tiebreaker,
          notes: packet.notes,
        })),
      );
      onAnnounce(
        `${result.inserted} packet${result.inserted === 1 ? '' : 's'} imported${
          result.skipped ? `; ${result.skipped} duplicate${result.skipped === 1 ? '' : 's'} skipped` : ''
        }.${report.warnings.length ? ` ${report.warnings.length} warning${report.warnings.length === 1 ? '' : 's'} retained.` : ''}`,
      );
    } catch (reason: unknown) {
      onAnnounce(errorNotice(reason instanceof Error ? reason.message : 'That QBJ file could not be read.'));
    }
  };
  return (
    <>
      <PageHeader
        eyebrow="Plan"
        title="Packets"
        description="Inventory is separate from rounds: replacements, tiebreakers, and assignment history stay visible."
        actions={
          <>
            <label className="director-button director-button-secondary">
              <Icon name="upload" size={15} />
              <span>
                Import QBJ
                <input
                  className="director-visually-hidden-input"
                  type="file"
                  /*
                    What this button actually reads. It used to accept `application/json`, which
                    put every settings file and every unrelated export on the machine in front of a
                    director looking for a packet list, all of them refused after being chosen.
                  */
                  accept=".qbj,application/vnd.quizbowl.qbj+json"
                  onChange={(event) => {
                    void importQbj(event.target.files?.[0]);
                    event.currentTarget.value = '';
                  }}
                />
              </span>
            </label>
            <Button variant="primary" icon="plus" onClick={() => setShowForm((value) => !value)}>
              Add packet
            </Button>
          </>
        }
      />
      <div className="director-page-stack">
        {showForm && (
          <section className="director-panel director-form-panel">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                save();
              }}
            >
              <div className="director-panel-heading">
                <div>
                  <p className="director-eyebrow">New packet</p>
                  <h2>Inventory item</h2>
                </div>
                <Button variant="quiet" icon="x" onClick={() => setShowForm(false)}>
                  Close
                </Button>
              </div>
              <PanelBody>
                <div className="director-form-grid director-form-grid-two">
                  <FormField label="Packet name">
                    <input
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="Round 1 · Set A"
                    />
                  </FormField>
                  <label className="director-checkbox-field">
                    <input
                      type="checkbox"
                      checked={tiebreaker}
                      onChange={(event) => setTiebreaker(event.target.checked)}
                    />
                    <span>Tiebreaker packet</span>
                  </label>
                </div>
                <FormField label="Notes" hint="Optional handling or assignment notes for this packet.">
                  <textarea
                    className="director-textarea"
                    rows={2}
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                    placeholder="Keep sealed until the final tiebreaker"
                  />
                </FormField>
              </PanelBody>
              <PanelFooter className="director-form-actions">
                <Button variant="primary" type="submit">
                  Save packet
                </Button>
              </PanelFooter>
            </form>
          </section>
        )}
        {state.packets.length === 0 ? (
          <EmptyState
            title="No packets in inventory"
            description="Add packet names now or import QBJ assignment data. Director warns when a packet is reused."
          >
            <Button variant="primary" icon="plus" onClick={() => setShowForm(true)}>
              Add first packet
            </Button>
          </EmptyState>
        ) : (
          <section className="director-panel">
            <div className="director-panel-heading">
              <div>
                <p className="director-eyebrow">Inventory</p>
                <h2>
                  {state.packets.length} packet{state.packets.length === 1 ? '' : 's'}
                </h2>
              </div>
              <span className="director-muted">
                {
                  state.packets.filter((packet) => packet.retired !== true && packet.usedGameIds.length === 0)
                    .length
                }{' '}
                unused · {state.packets.filter((packet) => packet.retired === true).length} retired
              </span>
            </div>
            <div className="director-table-wrap">
              <table className="director-table">
                <thead>
                  <tr>
                    <th>Packet</th>
                    <th>Source</th>
                    <th>Round assignments</th>
                    <th>Games used</th>
                    <th>Status</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {state.packets.map((packet) => (
                    <PacketRow
                      key={packet.id}
                      state={state}
                      packet={packet}
                      controller={controller}
                      onAnnounce={onAnnounce}
                      detailsOpen={detailsPacketId === packet.id}
                      onToggleDetails={() =>
                        setDetailsPacketId((current) => (current === packet.id ? null : packet.id))
                      }
                      navigationTarget={navigationTarget}
                      onClearNavigationTarget={() => {
                        if (
                          navigationTarget?.section === 'packets' &&
                          navigationTarget.entityType === 'packet' &&
                          navigationTarget.entityId === packet.id
                        ) {
                          setDetailsPacketId(packet.id);
                        }
                        onClearNavigationTarget?.();
                      }}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            {detailsPacketId && (
              <PacketDetails
                state={state}
                packet={state.packets.find((entry) => entry.id === detailsPacketId)}
                onNavigate={onNavigate}
              />
            )}
          </section>
        )}
      </div>
    </>
  );
}

function PacketRow({
  state,
  packet,
  controller,
  onAnnounce,
  detailsOpen,
  onToggleDetails,
  navigationTarget,
  onClearNavigationTarget,
}: {
  state: DirectorState;
  packet: DirectorState['packets'][number];
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
  detailsOpen: boolean;
  onToggleDetails: () => void;
  navigationTarget?: DirectorNavigationTarget | null;
  onClearNavigationTarget?: () => void;
}) {
  const packetNavigation = useNavigationHighlight(
    navigationTarget,
    'packets',
    'packet',
    packet.id,
    onClearNavigationTarget,
  );
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(packet.name);
  const [tiebreaker, setTiebreaker] = useState(packet.tiebreaker);
  const [notes, setNotes] = useState(packet.notes ?? '');

  const beginEdit = () => {
    setName(packet.name);
    setTiebreaker(packet.tiebreaker);
    setNotes(packet.notes ?? '');
    setEditing(true);
  };

  const save = () => {
    const normalizedName = name.trim();
    if (!normalizedName) {
      onAnnounce(errorNotice('Enter a packet name first.'));
      return;
    }
    if (!controller.updatePacket(packet.id, { name: normalizedName, tiebreaker, notes })) {
      onAnnounce(errorNotice('Packet was not changed; review the Director error.'));
      return;
    }
    setEditing(false);
    onAnnounce(`${normalizedName} updated.`);
  };

  return (
    <>
      <tr
        tabIndex={-1}
        className={packetNavigation ? 'is-navigation-target' : undefined}
        data-director-navigation-id={packet.id}
      >
        <td>
          <span data-director-navigation-focus tabIndex={-1}>
            <strong>{packet.name}</strong>
            {packet.tiebreaker && <small className="director-table-subtext">Tiebreaker</small>}
            {packet.notes && <small className="director-table-subtext">Has notes</small>}
          </span>
        </td>
        <td>{packet.source}</td>
        <td>{packet.assignedRoundIds.length || '—'}</td>
        <td>{packet.usedGameIds.length || '—'}</td>
        <td>
          <StateLabel
            state={packet.retired ? 'archived' : packet.usedGameIds.length > 0 ? 'finished' : 'available'}
            label={packet.retired ? 'Retired' : packet.usedGameIds.length > 0 ? 'Used' : 'Available'}
          />
        </td>
        <td>
          <div className="director-row-actions">
            {/*
              The packet already in force is a status, not an action. It used to be a button reading
              `Current` whose only effect was to select the packet that was already selected — a
              control that looks pressable, announces a change, and changes nothing.
            */}
            {packet.id === state.tournament?.currentPacketId ? (
              <StateLabel state="live" label="Current" />
            ) : (
              <Button
                variant="quiet"
                onClick={() => {
                  const exists = state.packets.some((entry) => entry.id === packet.id);
                  if (!exists) {
                    onAnnounce(errorNotice('That packet is not in the current inventory.'));
                    return;
                  }
                  if (!state.tournament) {
                    onAnnounce(errorNotice('Create a tournament before selecting a packet.'));
                    return;
                  }
                  if (packet.retired) {
                    onAnnounce(errorNotice('Retired packets cannot be selected; restore it first.'));
                    return;
                  }
                  controller.selectPacket(packet.id);
                  onAnnounce(`${packet.name} selected for the next generated round.`);
                }}
              >
                Use next
              </Button>
            )}
            <Button
              variant="quiet"
              onClick={() => {
                if (!packet.retired && !confirm(`Retire ${packet.name}? Its assignment history will remain.`))
                  return;
                const changed = controller.setPacketRetired(packet.id, !packet.retired);
                if (changed) onAnnounce(`${packet.name} ${packet.retired ? 'restored' : 'retired'}.`);
                else onAnnounce(errorNotice('The packet was not changed; review the Director error.'));
              }}
            >
              {packet.retired ? 'Restore' : 'Retire'}
            </Button>
            <button
              type="button"
              className="director-button director-button-quiet director-table-action"
              aria-label={`Edit ${packet.name}`}
              onClick={beginEdit}
            >
              <Icon name="edit" size={14} />
              <span>Edit</span>
            </button>
            <button
              type="button"
              className="director-button director-button-quiet director-table-action"
              aria-label={`View details for ${packet.name}`}
              aria-expanded={detailsOpen}
              onClick={onToggleDetails}
            >
              <Icon name="file" size={14} />
              <span>{detailsOpen ? 'Hide details' : 'Details'}</span>
            </button>
          </div>
        </td>
      </tr>
      {editing && (
        <tr className="director-table-edit-row">
          <td colSpan={6}>
            <form
              className="director-inline-edit"
              onSubmit={(event) => {
                event.preventDefault();
                save();
              }}
            >
              <div className="director-form-grid director-form-grid-two">
                <FormField label="Packet name">
                  <input value={name} onChange={(event) => setName(event.target.value)} />
                </FormField>
                <label className="director-checkbox-field">
                  <input
                    type="checkbox"
                    checked={tiebreaker}
                    onChange={(event) => setTiebreaker(event.target.checked)}
                  />
                  <span>Tiebreaker packet</span>
                </label>
              </div>
              <FormField label="Notes" hint="Optional handling or assignment notes for this packet.">
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
          </td>
        </tr>
      )}
    </>
  );
}

function PacketDetails({
  state,
  packet,
  onNavigate,
}: {
  state: DirectorState;
  packet: DirectorState['packets'][number] | undefined;
  onNavigate?: (
    section: import('../app/navigation').SectionId,
    target?: import('../app/navigationTarget').DirectorNavigationTarget | null,
  ) => void;
}) {
  if (!packet) return null;
  const usingRounds = packet.assignedRoundIds
    .map((roundId) => state.rounds.find((entry) => entry.id === roundId))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  const scheduledById = new Map(state.scheduledGames.map((game) => [game.id, game]));
  const recordsById = new Map(state.games.map((game) => [game.id, game]));
  const assignments = packet.assignedGameIds.map((assignmentId) => {
    const scheduled = scheduledById.get(assignmentId);
    const record = recordsById.get(assignmentId);
    const resolvedScheduled = scheduled ?? (record ? scheduledById.get(record.scheduledGameId) : undefined);
    return {
      assignmentId,
      scheduled: resolvedScheduled,
      record,
    };
  });
  const unknownAssignments = assignments.filter((assignment) => !assignment.scheduled && !assignment.record);
  const replacement = packet.replacementForPacketId
    ? state.packets.find((entry) => entry.id === packet.replacementForPacketId)
    : undefined;
  return (
    <div className="director-packet-details" role="region" aria-label={`${packet.name} details`}>
      <div className="director-panel-body">
        <div className="director-panel-heading director-panel-heading-compact">
          <div>
            <p className="director-eyebrow">Packet details</p>
            <h3>{packet.name}</h3>
          </div>
          <StateLabel
            state={packet.retired ? 'archived' : packet.usedGameIds.length > 0 ? 'finished' : 'available'}
            label={packet.retired ? 'Retired' : packet.usedGameIds.length > 0 ? 'Used' : 'Available'}
          />
        </div>
        <dl className="director-packet-metadata">
          <div>
            <dt>Source</dt>
            <dd>{packet.source}</dd>
          </div>
          <div>
            <dt>Round assignments</dt>
            <dd>
              {usingRounds.length === 0
                ? 'None'
                : usingRounds.map((round, index) => (
                    <span key={round.id}>
                      {index > 0 ? ', ' : ''}
                      <button
                        type="button"
                        className="director-inline-action"
                        onClick={() =>
                          onNavigate?.('schedule', {
                            section: 'schedule',
                            entityType: 'round',
                            entityId: round.id,
                          })
                        }
                      >
                        {round.name}
                      </button>
                    </span>
                  ))}
            </dd>
          </div>
          <div>
            <dt>Game assignments</dt>
            <dd>{packet.assignedGameIds.length || 'None'}</dd>
          </div>
          <div>
            <dt>Replacement</dt>
            <dd>
              {replacement
                ? `Replaces ${replacement.name}`
                : packet.replacementForPacketId
                  ? 'Unknown packet'
                  : 'None'}
            </dd>
          </div>
        </dl>
        {packet.tiebreaker && <p className="director-table-subtext">Marked as a tiebreaker packet.</p>}
        {packet.notes && <p className="director-packet-notes">{packet.notes}</p>}
        {assignments.length > 0 && (
          <div className="director-packet-assignments">
            <p className="director-eyebrow">Assigned games</p>
            <ul className="director-plain-list">
              {assignments.map(({ assignmentId, scheduled, record }) => {
                const resolvedAssignmentId = scheduled?.id ?? assignmentId;
                const used =
                  packet.usedGameIds.includes(assignmentId) ||
                  packet.usedGameIds.includes(resolvedAssignmentId) ||
                  Boolean(record?.acceptedAt);
                const round = scheduled
                  ? state.rounds.find((entry) => entry.id === scheduled.roundId)
                  : undefined;
                const status = record?.status ?? scheduled?.status;
                return (
                  <li key={assignmentId}>
                    <div>
                      <strong>
                        {scheduled
                          ? `${teamName(state, scheduled.leftTeamId)} · ${teamName(state, scheduled.rightTeamId)}`
                          : `Assignment ${assignmentId}`}
                      </strong>
                      <span>
                        {round?.name ?? 'Unresolved round'} · {status ?? 'Unresolved assignment'}
                        {scheduled?.roomId ? ` · ${roomName(state, scheduled.roomId)}` : ''}
                      </span>
                    </div>
                    <StateLabel state={used ? 'finished' : 'scheduled'} label={used ? 'Used' : 'Assigned'} />
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {unknownAssignments.length > 0 && (
          <p className="director-warning-copy">
            {unknownAssignments.length} assignment{unknownAssignments.length === 1 ? '' : 's'} could not be
            resolved to a scheduled game or result record.
          </p>
        )}
      </div>
    </div>
  );
}

function teamName(state: DirectorState, teamId: string | null): string {
  return teamId ? (state.teams.find((team) => team.id === teamId)?.displayName ?? 'Unknown team') : 'Bye';
}

function roomName(state: DirectorState, roomId: string): string {
  return state.rooms.find((room) => room.id === roomId)?.name ?? 'Unknown room';
}
