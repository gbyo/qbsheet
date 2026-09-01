import { useState } from 'react';
import type { DirectorState } from '../domain';
import type { DirectorController } from '../state/useDirectorController';
import { Button, EmptyState, FormField, StateLabel } from '../components/Controls';
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
      controller.addPackets(
        report.state.packets.map((packet) => ({
          name: packet.name,
          source: 'qbj' as const,
          tiebreaker: packet.tiebreaker,
          notes: packet.notes,
        })),
      );
      onAnnounce(
        `${report.state.packets.length} packet${report.state.packets.length === 1 ? '' : 's'} imported.`,
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
        description="Inventory is separate from rounds: replacements, tiebreakers, and per-game overrides stay explicit."
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
      {showForm && (
        <section className="director-panel director-form-panel">
          <div className="director-panel-heading">
            <div>
              <p className="director-eyebrow">New packet</p>
              <h2>Inventory item</h2>
            </div>
            <Button variant="quiet" icon="x" onClick={() => setShowForm(false)}>
              Close
            </Button>
          </div>
          <div className="director-form-grid">
            <FormField label="Packet name">
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Round 1 · Set A"
              />
            </FormField>
          </div>
          <div className="director-form-actions">
            <Button variant="primary" onClick={save}>
              Save packet
            </Button>
          </div>
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
                      <button
                        type="button"
                        className="director-icon-button"
                        aria-label={`Packet actions for ${packet.name}`}
                        onClick={() =>
                          onAnnounce(
                            `${packet.name}: ${packet.assignedGameIds.length} game assignment${packet.assignedGameIds.length === 1 ? '' : 's'}.`,
                          )
                        }
                      >
                        <Icon name="more" size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
