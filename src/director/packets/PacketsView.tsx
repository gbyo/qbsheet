import { useState } from 'react';
import type { DirectorState } from '../domain';
import type { DirectorController } from '../state/useDirectorController';
import { Button, EmptyState, FormField, PanelBody, PanelFooter, StateLabel } from '../components/Controls';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { importQbjText } from '../format/interchange';

export function PacketsView({
  state,
  controller,
  onAnnounce,
}: {
  state: DirectorState;
  controller: DirectorController;
  onAnnounce: (message: string) => void;
}) {
  const [showForm, setShowForm] = useState(false);
  const [detailsPacketId, setDetailsPacketId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const save = () => {
    if (!name.trim()) {
      onAnnounce('Enter a packet name first.');
      return;
    }
    controller.addPacket(name);
    onAnnounce(`${name.trim()} added to inventory.`);
    setName('');
    setShowForm(false);
  };
  const importQbj = async (file: File | undefined) => {
    if (!file) return;
    try {
      const report = importQbjText(await file.text());
      if (!report.ok || !report.state) {
        onAnnounce(report.errors.join(' ') || 'That QBJ file is not valid.');
        return;
      }
      if (report.state.packets.length === 0) {
        onAnnounce('That QBJ file does not contain packet inventory.');
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
      onAnnounce(reason instanceof Error ? reason.message : 'That QBJ file could not be read.');
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
                  accept=".qbj,application/json"
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
                <div className="director-form-grid director-form-grid-single">
                  <FormField label="Packet name">
                    <input
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="Round 1 · Set A"
                    />
                  </FormField>
                </div>
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
                {state.packets.filter((packet) => packet.usedGameIds.length === 0).length} unused
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
                    <tr key={packet.id}>
                      <td>
                        <strong>{packet.name}</strong>
                        {packet.tiebreaker && <small className="director-table-subtext">Tiebreaker</small>}
                      </td>
                      <td>{packet.source}</td>
                      <td>{packet.assignedRoundIds.length || '—'}</td>
                      <td>{packet.usedGameIds.length || '—'}</td>
                      <td>
                        <StateLabel
                          state={packet.usedGameIds.length > 0 ? 'finished' : 'available'}
                          label={packet.usedGameIds.length > 0 ? 'Used' : 'Available'}
                        />
                      </td>
                      <td>
                        <div className="director-row-actions">
                          <Button
                            variant={packet.id === state.tournament?.currentPacketId ? 'secondary' : 'quiet'}
                            onClick={() => {
                              const exists = state.packets.some((entry) => entry.id === packet.id);
                              if (!exists) {
                                onAnnounce('That packet is not in the current inventory.');
                                return;
                              }
                              if (!state.tournament) {
                                onAnnounce('Create a tournament before selecting a packet.');
                                return;
                              }
                              controller.selectPacket(packet.id);
                              onAnnounce(`${packet.name} selected for the next generated round.`);
                            }}
                          >
                            {packet.id === state.tournament?.currentPacketId ? 'Current' : 'Use next'}
                          </Button>
                          <button
                            type="button"
                            className="director-button director-button-quiet director-table-action"
                            aria-label={`View details for ${packet.name}`}
                            aria-expanded={detailsPacketId === packet.id}
                            onClick={() =>
                              setDetailsPacketId((current) => (current === packet.id ? null : packet.id))
                            }
                          >
                            <Icon name="file" size={14} />
                            <span>{detailsPacketId === packet.id ? 'Hide details' : 'Details'}</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {detailsPacketId && (
              <PacketDetails
                state={state}
                packet={state.packets.find((entry) => entry.id === detailsPacketId)}
              />
            )}
          </section>
        )}
      </div>
    </>
  );
}

function PacketDetails({
  state,
  packet,
}: {
  state: DirectorState;
  packet: DirectorState['packets'][number] | undefined;
}) {
  if (!packet) return null;
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
            state={packet.usedGameIds.length > 0 ? 'finished' : 'available'}
            label={packet.usedGameIds.length > 0 ? 'Used' : 'Available'}
          />
        </div>
        <dl className="director-packet-metadata">
          <div>
            <dt>Source</dt>
            <dd>{packet.source}</dd>
          </div>
          <div>
            <dt>Round assignments</dt>
            <dd>{packet.assignedRoundIds.length || 'None'}</dd>
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
