import { useState } from 'react';
import type { DirectorState } from '../domain';
import type { DirectorController } from '../state/useDirectorController';
import { Button, FormField, PanelBody, PanelFooter, StateLabel } from '../components/Controls';
import { PageHeader } from '../components/PageHeader';

export function SettingsView({
  state,
  controller,
  onAnnounce,
}: {
  state: DirectorState;
  controller: DirectorController;
  onAnnounce: (message: string) => void;
}) {
  const [name, setName] = useState(state.tournament?.name ?? '');
  const [date, setDate] = useState(state.tournament?.date ?? '');
  const [venue, setVenue] = useState(state.tournament?.venue ?? '');
  const [organizer, setOrganizer] = useState(state.tournament?.organizer ?? '');
  const save = () => {
    if (!name.trim()) {
      onAnnounce('Enter a tournament name first.');
      return;
    }
    if (!controller.updateTournament({ name, date, venue, organizer })) {
      onAnnounce('Tournament details were not updated; review the Director error.');
      return;
    }
    onAnnounce('Tournament details updated locally; saving now.');
  };
  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Settings"
        description="Tournament identity, storage, and the local Director runtime."
      />
      <div className="director-page-stack">
        <div className="director-two-column">
          <section className="director-panel">
            <div className="director-panel-heading">
              <div>
                <p className="director-eyebrow">Tournament</p>
                <h2>Details</h2>
              </div>
            </div>
            {state.tournament ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  save();
                }}
              >
                <PanelBody>
                  <div className="director-form-grid director-form-grid-single">
                    <FormField label="Name">
                      <input value={name} onChange={(event) => setName(event.target.value)} />
                    </FormField>
                    <FormField label="Date">
                      <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
                    </FormField>
                    <FormField label="Venue">
                      <input value={venue} onChange={(event) => setVenue(event.target.value)} />
                    </FormField>
                    <FormField label="Organizer">
                      <input value={organizer} onChange={(event) => setOrganizer(event.target.value)} />
                    </FormField>
                  </div>
                </PanelBody>
                <PanelFooter className="director-form-actions">
                  <Button variant="primary" type="submit">
                    Save details
                  </Button>
                </PanelFooter>
              </form>
            ) : (
              <PanelBody>
                <p className="director-empty-copy">No tournament is open.</p>
              </PanelBody>
            )}
          </section>
          <section className="director-panel">
            <div className="director-panel-heading">
              <div>
                <p className="director-eyebrow">Storage</p>
                <h2>
                  {controller.repositoryKind === 'tauri-sqlite'
                    ? 'SQLite'
                    : controller.repositoryKind === 'indexeddb'
                      ? 'IndexedDB'
                      : 'Memory'}
                </h2>
              </div>
              <StateLabel
                state={controller.error ? 'help' : 'finished'}
                label={controller.error ? 'Needs attention' : controller.saving ? 'Saving' : 'Healthy'}
              />
            </div>
            <PanelBody>
              <dl className="director-detail-list director-detail-list-large">
                <div>
                  <dt>Last saved</dt>
                  <dd>
                    {state.metadata.lastSavedAt
                      ? new Date(state.metadata.lastSavedAt).toLocaleString()
                      : 'Not yet'}
                  </dd>
                </div>
                <div>
                  <dt>Last checkpoint</dt>
                  <dd>
                    {state.metadata.lastCheckpointAt
                      ? new Date(state.metadata.lastCheckpointAt).toLocaleString()
                      : 'Not yet'}
                  </dd>
                </div>
                <div>
                  <dt>Schema</dt>
                  <dd>Director v{state.schemaVersion}</dd>
                </div>
              </dl>
              {controller.error && <p className="director-error-copy">{controller.error}</p>}
            </PanelBody>
            <PanelFooter>
              <Button
                variant="secondary"
                icon="clipboard"
                onClick={() => {
                  void controller
                    .checkpoint('manual settings checkpoint')
                    .then(() => onAnnounce('Checkpoint created.'))
                    .catch((reason: unknown) =>
                      onAnnounce(reason instanceof Error ? reason.message : 'Checkpoint could not be saved.'),
                    );
                }}
              >
                Create checkpoint
              </Button>
            </PanelFooter>
          </section>
        </div>
        <section className="director-panel">
          <div className="director-panel-heading">
            <div>
              <p className="director-eyebrow">Audit history</p>
              <h2>All meaningful changes</h2>
            </div>
            <span className="director-muted">
              {state.audit.length} event{state.audit.length === 1 ? '' : 's'}
            </span>
          </div>
          {state.audit.length === 0 ? (
            <PanelBody>
              <p className="director-empty-copy">No changes recorded yet.</p>
            </PanelBody>
          ) : (
            <div className="director-table-wrap">
              <table className="director-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Action</th>
                    <th>Actor</th>
                    <th>Entity</th>
                  </tr>
                </thead>
                <tbody>
                  {[...state.audit].reverse().map((event) => (
                    <tr key={event.id}>
                      <td>{new Date(event.at).toLocaleString()}</td>
                      <td>
                        <strong>{event.summary}</strong>
                      </td>
                      <td>{event.actor}</td>
                      <td className="director-mono">{event.entityId ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
