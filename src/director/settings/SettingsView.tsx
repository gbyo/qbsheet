import { useState } from 'react';
import { availableTimeZones, isValidTimeZone, timeZoneLabel, type DirectorState } from '../domain';
import type { DirectorController } from '../state/useDirectorController';
import type { OperatorProfile } from '../operator/operatorProfile';
import { Button, FormField, PanelBody, PanelFooter, StateLabel } from '../components/Controls';
import { PageHeader } from '../components/PageHeader';
import type { AnnounceInput } from '../notices';

/** How many audit rows a first look at Settings draws, and how many each `Load more` adds. */
export const auditPageSize = 100;

export function SettingsView({
  state,
  controller,
  onAnnounce,
  operatorProfile,
  onSaveOperator,
}: {
  state: DirectorState;
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
  operatorProfile?: OperatorProfile;
  onSaveOperator?: (profile: OperatorProfile) => void;
}) {
  const tournamentDraftKey = [
    state.tournament?.id ?? '',
    state.tournament?.name ?? '',
    state.tournament?.date ?? '',
    state.tournament?.venue ?? '',
    state.tournament?.organizer ?? '',
    state.tournament?.timeZone ?? 'UTC',
  ].join('|');
  /*
   * How much of the audit history is on screen.
   *
   * The table is newest-first over the whole history, and the history only grows: a tournament that
   * has run all day arrives at Settings with thousands of rows, every one of which was being built
   * and laid out before the page could paint. Nothing is dropped -- the count above the table is
   * still `state.audit.length` -- but the rows come in pages, which is a `Load more` press for the
   * rare director who is reading back through the morning and nothing at all for everybody else.
   */
  const [auditShown, setAuditShown] = useState(auditPageSize);
  const [tournamentDraft, setTournamentDraft] = useState({
    key: tournamentDraftKey,
    name: state.tournament?.name ?? '',
    date: state.tournament?.date ?? '',
    venue: state.tournament?.venue ?? '',
    organizer: state.tournament?.organizer ?? '',
    timeZone: state.tournament?.timeZone ?? 'UTC',
  });
  const details =
    tournamentDraft.key === tournamentDraftKey
      ? tournamentDraft
      : {
          key: tournamentDraftKey,
          name: state.tournament?.name ?? '',
          date: state.tournament?.date ?? '',
          venue: state.tournament?.venue ?? '',
          organizer: state.tournament?.organizer ?? '',
          timeZone: state.tournament?.timeZone ?? 'UTC',
        };
  const updateDetails = (changes: Partial<Omit<typeof details, 'key'>>) =>
    setTournamentDraft({ ...details, ...changes, key: tournamentDraftKey });
  const operatorDraftKey = `${operatorProfile?.displayName ?? ''}|${operatorProfile?.role ?? ''}`;
  const [operatorDraft, setOperatorDraft] = useState({
    key: operatorDraftKey,
    name: operatorProfile?.displayName ?? 'Local operator',
    role: operatorProfile?.role ?? '',
  });
  const operator =
    operatorDraft.key === operatorDraftKey
      ? operatorDraft
      : {
          key: operatorDraftKey,
          name: operatorProfile?.displayName ?? 'Local operator',
          role: operatorProfile?.role ?? '',
        };
  const save = () => {
    if (!details.name.trim()) {
      onAnnounce('Enter a tournament name first.');
      return;
    }
    if (!isValidTimeZone(details.timeZone)) {
      onAnnounce('Choose a recognized IANA timezone.');
      return;
    }
    if (
      !controller.updateTournament({
        name: details.name,
        date: details.date,
        venue: details.venue,
        organizer: details.organizer,
        timeZone: details.timeZone,
      })
    ) {
      onAnnounce('Tournament details were not updated; review the Director error.');
      return;
    }
    onAnnounce('Tournament details updated locally; saving now.');
  };
  /*
   * Newest first, then the page. Slicing from the end and reversing that slice keeps the ordering
   * identical to reversing the whole array and taking the head, without building the whole array.
   */
  const visibleAudit = state.audit.slice(Math.max(0, state.audit.length - auditShown)).reverse();
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
                      <input
                        value={details.name}
                        onChange={(event) => updateDetails({ name: event.target.value })}
                      />
                    </FormField>
                    <FormField label="Date">
                      <input
                        type="date"
                        value={details.date}
                        onChange={(event) => updateDetails({ date: event.target.value })}
                      />
                    </FormField>
                    <FormField label="Venue">
                      <input
                        value={details.venue}
                        onChange={(event) => updateDetails({ venue: event.target.value })}
                      />
                    </FormField>
                    <FormField label="Organizer">
                      <input
                        value={details.organizer}
                        onChange={(event) => updateDetails({ organizer: event.target.value })}
                      />
                    </FormField>
                    <FormField
                      label="Tournament timezone"
                      hint={`${timeZoneLabel(details.timeZone)}. Changing this affects how future schedule inputs are interpreted; stored instants are not shifted.`}
                    >
                      <input
                        list="director-time-zone-options"
                        value={details.timeZone}
                        onChange={(event) => updateDetails({ timeZone: event.target.value })}
                        aria-label="Tournament timezone"
                      />
                    </FormField>
                    <datalist id="director-time-zone-options">
                      {availableTimeZones().map((zone) => (
                        <option key={zone} value={zone}>
                          {timeZoneLabel(zone)}
                        </option>
                      ))}
                    </datalist>
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
          <div className="director-page-stack">
            <section className="director-panel">
              <div className="director-panel-heading">
                <div>
                  <p className="director-eyebrow">Operator</p>
                  <h2>Local identity</h2>
                </div>
                <StateLabel state="info" label="App setting" />
              </div>
              <PanelBody>
                <p className="director-panel-footnote">
                  Used to attribute new Director decisions. It is not authentication and is never copied into
                  QBJ, tournament archives, or QBSheet Live.
                </p>
                <div className="director-form-grid director-form-grid-two">
                  <FormField label="Display name">
                    <input
                      value={operator.name}
                      onChange={(event) =>
                        setOperatorDraft({ ...operator, key: operatorDraftKey, name: event.target.value })
                      }
                    />
                  </FormField>
                  <FormField label="Role">
                    <input
                      value={operator.role}
                      onChange={(event) =>
                        setOperatorDraft({ ...operator, key: operatorDraftKey, role: event.target.value })
                      }
                      placeholder="Tournament director"
                    />
                  </FormField>
                </div>
              </PanelBody>
              <PanelFooter>
                <Button
                  variant="secondary"
                  disabled={!onSaveOperator || !operator.name.trim()}
                  onClick={() => {
                    onSaveOperator?.({
                      displayName: operator.name.trim(),
                      role: operator.role.trim() || undefined,
                    });
                    onAnnounce('Operator identity saved locally.');
                  }}
                >
                  Save operator
                </Button>
              </PanelFooter>
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
                        onAnnounce(
                          reason instanceof Error ? reason.message : 'Checkpoint could not be saved.',
                        ),
                      );
                  }}
                >
                  Create checkpoint
                </Button>
              </PanelFooter>
            </section>
          </div>
        </div>
        <section className="director-panel">
          <div className="director-panel-heading">
            <div>
              <p className="director-eyebrow">Audit history</p>
              <h2>All meaningful changes</h2>
            </div>
            <span className="director-muted">
              {visibleAudit.length === state.audit.length
                ? `${state.audit.length} event${state.audit.length === 1 ? '' : 's'}`
                : `${visibleAudit.length} of ${state.audit.length} events`}
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
                  {visibleAudit.map((event) => (
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
          {visibleAudit.length < state.audit.length && (
            <PanelFooter>
              <Button variant="secondary" onClick={() => setAuditShown((shown) => shown + auditPageSize)}>
                Load more
              </Button>
              <span className="director-muted">
                {state.audit.length - visibleAudit.length} earlier event
                {state.audit.length - visibleAudit.length === 1 ? '' : 's'}
              </span>
            </PanelFooter>
          )}
        </section>
        <div className="director-two-column">
          <section className="director-panel">
            <div className="director-panel-heading">
              <div>
                <p className="director-eyebrow">Storage & recovery</p>
                <h2>Local durability</h2>
              </div>
            </div>
            <PanelBody>
              <p>
                Director checkpoints the active tournament locally. Browser preview uses IndexedDB; the
                desktop app uses SQLite. Portable archives contain tournament data only, not the operator
                profile or Live credential.
              </p>
            </PanelBody>
          </section>
          <section className="director-panel">
            <div className="director-panel-heading">
              <div>
                <p className="director-eyebrow">Local network</p>
                <h2>QBTCP and Live</h2>
              </div>
            </div>
            <PanelBody>
              <p>
                QBTCP room control and the optional local QBSheet Live server are separate listeners. Start
                and inspect them from their operational sections; spectator URLs never contain management
                credentials.
              </p>
            </PanelBody>
          </section>
        </div>
        <section className="director-panel">
          <div className="director-panel-heading">
            <div>
              <p className="director-eyebrow">About & diagnostics</p>
              <h2>Build information</h2>
            </div>
          </div>
          <PanelBody>
            <p>
              Director schema v{state.schemaVersion} · {controller.repositoryKind}. If support is needed,
              export diagnostics from the desktop app without sending private tournament content unless
              requested.
            </p>
          </PanelBody>
        </section>
      </div>
    </>
  );
}
