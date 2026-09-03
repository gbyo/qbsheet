import { useMemo, useState } from 'react';
import type { DirectorController } from '../state/useDirectorController';
import type { DirectorState } from '../domain';
import { Button, EmptyState, FormField, PanelBody, PanelFooter, StateLabel } from '../components/Controls';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { importQbj, importSqbsTeams, importTeamsCsv, type TeamRecord } from '@qbsheet/tournament-formats';
import { toImportedTeamInputs } from './teamImport';
import type { DirectorNavigationTarget } from '../app/navigationTarget';
import { useNavigationHighlight } from '../app/useNavigationHighlight';
import { errorNotice, type AnnounceInput } from '../notices';

export function TeamsView({
  state,
  controller,
  search,
  onAnnounce,
  navigationTarget,
  onClearNavigationTarget,
}: {
  state: DirectorState;
  controller: DirectorController;
  search: string;
  onAnnounce: (announcement: AnnounceInput) => void;
  navigationTarget?: DirectorNavigationTarget | null;
  onClearNavigationTarget?: () => void;
}) {
  const [showForm, setShowForm] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  const [showOrganizationForm, setShowOrganizationForm] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [teamLetter, setTeamLetter] = useState('');
  const [notes, setNotes] = useState('');
  const [paste, setPaste] = useState('');
  const [newOrganizationName, setNewOrganizationName] = useState('');
  const [newOrganizationShortName, setNewOrganizationShortName] = useState('');
  const [newOrganizationNotes, setNewOrganizationNotes] = useState('');
  const visibleTeams = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return state.teams.filter(
      (team) =>
        !needle ||
        [team.displayName, organizationNameFor(state, team.organizationId), team.teamLetter, team.status]
          .join(' ')
          .toLocaleLowerCase()
          .includes(needle),
    );
  }, [search, state]);
  const visibleOrganizations = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return state.organizations.filter(
      (organization) =>
        !needle ||
        [
          organization.name,
          organization.shortName,
          organization.notes,
          organization.archived ? 'archived' : 'active',
        ]
          .filter(Boolean)
          .join(' ')
          .toLocaleLowerCase()
          .includes(needle),
    );
  }, [search, state.organizations]);

  const submitTeam = () => {
    if (!displayName.trim()) {
      onAnnounce(errorNotice('Enter a team name first.'));
      return;
    }
    if (!controller.addTeam({ displayName, organizationName, teamLetter, notes })) return;
    setDisplayName('');
    setOrganizationName('');
    setTeamLetter('');
    setNotes('');
    setShowForm(false);
    onAnnounce(`${displayName.trim()} added locally; saving now.`);
  };

  const addImportedRows = (teams: TeamRecord[], warningCount: number) => {
    const result = controller.addImportedTeams(toImportedTeamInputs(teams));
    const importedLabel = `${result.inserted} team${result.inserted === 1 ? '' : 's'}`;
    const duplicateLabel = result.skipped
      ? `; ${result.skipped} duplicate${result.skipped === 1 ? '' : 's'} skipped`
      : '';
    const warningLabel = warningCount
      ? ` ${warningCount} warning${warningCount === 1 ? '' : 's'} retained.`
      : result.inserted
        ? ' Saving now.'
        : '';
    onAnnounce(`${importedLabel} imported locally${duplicateLabel}.${warningLabel}`);
  };

  const importPaste = () => {
    const report = importTeamsCsv(paste);
    if (!report.ok) {
      onAnnounce(
        errorNotice(report.errors.map((entry) => entry.message).join(' ') || 'That CSV is not valid.'),
      );
      return;
    }
    if (report.value.length === 0) {
      onAnnounce('No team rows found.');
      return;
    }
    addImportedRows(report.value, report.warnings.length);
    setPaste('');
    setShowPaste(false);
  };

  const submitOrganization = () => {
    if (
      !controller.addOrganization({
        name: newOrganizationName,
        shortName: newOrganizationShortName,
        notes: newOrganizationNotes,
      })
    ) {
      onAnnounce(controller.error ?? 'Organization was not added; review the Director error.');
      return;
    }
    const label = newOrganizationName.trim();
    setNewOrganizationName('');
    setNewOrganizationShortName('');
    setNewOrganizationNotes('');
    setShowOrganizationForm(false);
    onAnnounce(`${label} added as an organization.`);
  };

  const importCsv = async (file: File | undefined) => {
    if (!file) return;
    try {
      const report = importTeamsCsv(await file.text());
      if (!report.ok) {
        onAnnounce(
          errorNotice(report.errors.map((entry) => entry.message).join(' ') || 'That CSV is not valid.'),
        );
        return;
      }
      if (report.value.length === 0) {
        onAnnounce('No team rows found.');
        return;
      }
      addImportedRows(report.value, report.warnings.length);
    } catch (reason: unknown) {
      onAnnounce(reason instanceof Error ? reason.message : 'That CSV could not be read.');
    }
  };

  const importSqbs = async (file: File | undefined) => {
    if (!file) return;
    try {
      const report = importSqbsTeams(await file.text());
      if (!report.ok) {
        onAnnounce(
          errorNotice(
            report.errors.map((entry) => entry.message).join(' ') || 'That SQBS file is not valid.',
          ),
        );
        return;
      }
      if (report.value.length === 0) {
        onAnnounce('No teams found in that SQBS file.');
        return;
      }
      addImportedRows(report.value, report.warnings.length);
    } catch (reason: unknown) {
      onAnnounce(reason instanceof Error ? reason.message : 'That SQBS file could not be read.');
    }
  };

  const importQbjRoster = async (file: File | undefined) => {
    if (!file) return;
    try {
      const report = importQbj(await file.text());
      if (!report.ok) {
        onAnnounce(
          errorNotice(report.errors.map((entry) => entry.message).join(' ') || 'That QBJ file is not valid.'),
        );
        return;
      }
      if (report.value.tournament.teams.length === 0) {
        onAnnounce('No teams found in that QBJ file.');
        return;
      }
      addImportedRows(report.value.tournament.teams, report.warnings.length);
    } catch (reason: unknown) {
      onAnnounce(reason instanceof Error ? reason.message : 'That QBJ file could not be read.');
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="Plan"
        title="Teams"
        description={`${state.teams.length} team record${state.teams.length === 1 ? '' : 's'} · changes persist locally as you work`}
        actions={
          <>
            <label className="director-button director-button-secondary">
              <Icon name="upload" size={15} />
              <span>
                Import CSV
                <input
                  className="director-visually-hidden-input"
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(event) => {
                    void importCsv(event.target.files?.[0]);
                    event.currentTarget.value = '';
                  }}
                />
              </span>
            </label>
            <label className="director-button director-button-secondary">
              <Icon name="upload" size={15} />
              <span>
                Import SQBS
                <input
                  className="director-visually-hidden-input"
                  type="file"
                  accept=".sqbs,.txt,text/plain"
                  onChange={(event) => {
                    void importSqbs(event.target.files?.[0]);
                    event.currentTarget.value = '';
                  }}
                />
              </span>
            </label>
            <label className="director-button director-button-secondary">
              <Icon name="upload" size={15} />
              <span>
                Import QBJ
                <input
                  className="director-visually-hidden-input"
                  type="file"
                  accept=".qbj,application/json"
                  onChange={(event) => {
                    void importQbjRoster(event.target.files?.[0]);
                    event.currentTarget.value = '';
                  }}
                />
              </span>
            </label>
            <Button variant="secondary" icon="clipboard" onClick={() => setShowPaste((value) => !value)}>
              Paste
            </Button>
            <Button variant="primary" icon="plus" onClick={() => setShowForm((value) => !value)}>
              Add team
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
                submitTeam();
              }}
            >
              <div className="director-panel-heading">
                <div>
                  <p className="director-eyebrow">New team</p>
                  <h2>Registration</h2>
                </div>
                <Button variant="quiet" icon="x" onClick={() => setShowForm(false)}>
                  Close
                </Button>
              </div>
              <PanelBody>
                <div className="director-form-grid director-form-grid-three">
                  <FormField label="Display name">
                    <input
                      value={displayName}
                      onChange={(event) => setDisplayName(event.target.value)}
                      placeholder="Northview A"
                    />
                  </FormField>
                  <FormField label="School / organization">
                    <input
                      list="director-organization-options"
                      value={organizationName}
                      onChange={(event) => setOrganizationName(event.target.value)}
                      placeholder="Northview High"
                    />
                  </FormField>
                  <FormField label="Team letter">
                    <input
                      value={teamLetter}
                      onChange={(event) => setTeamLetter(event.target.value)}
                      placeholder="A"
                      maxLength={4}
                    />
                  </FormField>
                </div>
                <FormField
                  label="Notes"
                  hint="Optional registration or operations notes for the director team."
                >
                  <textarea
                    className="director-textarea"
                    rows={2}
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                    placeholder="Needs a late check-in"
                  />
                </FormField>
              </PanelBody>
              <PanelFooter className="director-form-actions">
                <Button variant="primary" type="submit">
                  Save team
                </Button>
              </PanelFooter>
            </form>
          </section>
        )}

        {showPaste && (
          <section className="director-panel director-form-panel">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                importPaste();
              }}
            >
              <div className="director-panel-heading">
                <div>
                  <p className="director-eyebrow">Bulk entry</p>
                  <h2>Paste teams</h2>
                </div>
                <Button variant="quiet" icon="x" onClick={() => setShowPaste(false)}>
                  Close
                </Button>
              </div>
              <PanelBody>
                <p className="director-panel-description">
                  Paste RFC 4180 CSV with a header row. Quoted commas and line breaks are supported; use
                  team_name, organization_id, and letter for the basic columns.
                </p>
                <textarea
                  className="director-textarea"
                  value={paste}
                  onChange={(event) => setPaste(event.target.value)}
                  placeholder={
                    'team_name,organization_id,letter\nNorthview A,Northview High,A\nRiverside A,Riverside School,A'
                  }
                  rows={5}
                />
              </PanelBody>
              <PanelFooter className="director-form-actions">
                <Button variant="primary" type="submit">
                  Add pasted teams
                </Button>
              </PanelFooter>
            </form>
          </section>
        )}

        <section className="director-panel" data-testid="director-organizations">
          <div className="director-panel-heading">
            <div>
              <p className="director-eyebrow">Organizations</p>
              <h2>{visibleOrganizations.length} shown</h2>
            </div>
            <div className="director-row-actions">
              <span className="director-muted">
                {state.organizations.filter((organization) => !organization.archived).length} active
              </span>
              <Button variant="quiet" icon="plus" onClick={() => setShowOrganizationForm((value) => !value)}>
                Add organization
              </Button>
            </div>
          </div>
          {showOrganizationForm && (
            <form
              className="director-panel-body director-inline-edit"
              onSubmit={(event) => {
                event.preventDefault();
                submitOrganization();
              }}
            >
              <div className="director-form-grid director-form-grid-three">
                <FormField label="Organization name">
                  <input
                    aria-label="Organization name"
                    value={newOrganizationName}
                    onChange={(event) => setNewOrganizationName(event.target.value)}
                    placeholder="Northview High"
                  />
                </FormField>
                <FormField label="Short name">
                  <input
                    value={newOrganizationShortName}
                    onChange={(event) => setNewOrganizationShortName(event.target.value)}
                    placeholder="Northview"
                  />
                </FormField>
                <FormField label="Notes">
                  <input
                    value={newOrganizationNotes}
                    onChange={(event) => setNewOrganizationNotes(event.target.value)}
                    placeholder="Optional"
                  />
                </FormField>
              </div>
              <div className="director-row-actions">
                <Button variant="primary" type="submit">
                  Save organization
                </Button>
                <Button variant="quiet" onClick={() => setShowOrganizationForm(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          )}
          {state.organizations.length === 0 ? (
            <PanelBody>
              <p className="director-empty-copy">
                No organizations yet. Teams can also create one as they are registered.
              </p>
            </PanelBody>
          ) : (
            <div className="director-table-wrap">
              <table className="director-table">
                <thead>
                  <tr>
                    <th>Organization</th>
                    <th>Short name</th>
                    <th>Teams</th>
                    <th>Status</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {visibleOrganizations.length > 0 ? (
                    visibleOrganizations.map((organization) => (
                      <OrganizationRow
                        key={organization.id}
                        organization={organization}
                        teamCount={
                          state.teams.filter((team) => team.organizationId === organization.id).length
                        }
                        controller={controller}
                        onAnnounce={onAnnounce}
                      />
                    ))
                  ) : (
                    <tr className="director-table-empty-row">
                      <td colSpan={5}>
                        <p className="director-empty-copy">No organizations match the current search.</p>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <datalist id="director-organization-options">
          {state.organizations
            .filter((organization) => organization.archived !== true)
            .map((organization) => (
              <option key={organization.id} value={organization.name} />
            ))}
        </datalist>

        {state.teams.length === 0 ? (
          <EmptyState
            title="No teams yet"
            description="Add registrations one at a time, paste a roster, or import a CSV. Teams stay editable after the schedule is generated."
          >
            <Button variant="primary" icon="plus" onClick={() => setShowForm(true)}>
              Add first team
            </Button>
          </EmptyState>
        ) : (
          <section className="director-panel">
            <div className="director-panel-heading">
              <div>
                <p className="director-eyebrow">Registrations</p>
                <h2>{visibleTeams.length} shown</h2>
              </div>
              <span className="director-muted">
                {state.teams.filter((team) => team.status === 'confirmed').length} confirmed
              </span>
            </div>
            <div className="director-table-wrap">
              <table className="director-table director-team-table">
                <thead>
                  <tr>
                    <th>Seed</th>
                    <th>Team</th>
                    <th>School</th>
                    <th>Roster</th>
                    <th>Status</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {visibleTeams.length > 0 ? (
                    visibleTeams.map((team) => (
                      <TeamRow
                        key={team.id}
                        state={state}
                        teamId={team.id}
                        controller={controller}
                        onAnnounce={onAnnounce}
                        navigationTarget={navigationTarget}
                        onClearNavigationTarget={onClearNavigationTarget}
                      />
                    ))
                  ) : (
                    <tr className="director-table-empty-row">
                      <td colSpan={6}>
                        <p className="director-empty-copy">No teams match the current search.</p>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </>
  );
}

function TeamRow({
  state,
  teamId,
  controller,
  onAnnounce,
  navigationTarget,
  onClearNavigationTarget,
}: {
  state: DirectorState;
  teamId: string;
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
  navigationTarget?: DirectorNavigationTarget | null;
  onClearNavigationTarget?: () => void;
}) {
  const team = state.teams.find((entry) => entry.id === teamId);
  const teamNavigation = useNavigationHighlight(
    navigationTarget,
    'teams',
    'team',
    teamId,
    onClearNavigationTarget,
  );
  const [playerName, setPlayerName] = useState('');
  const [playerCaptain, setPlayerCaptain] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editDisplayName, setEditDisplayName] = useState('');
  const [editOrganizationName, setEditOrganizationName] = useState('');
  const [editTeamLetter, setEditTeamLetter] = useState('');
  const [editSeed, setEditSeed] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [rosterOpen, setRosterOpen] = useState(false);
  if (!team) return null;
  const targetOpensRoster =
    navigationTarget?.section === 'teams' &&
    navigationTarget.entityType === 'player' &&
    navigationTarget.parentId === team.id;
  const players = state.players.filter((player) => player.teamId === team.id);
  const activePlayerCount = players.filter((player) => player.active).length;
  const inactivePlayerCount = players.length - activePlayerCount;
  const beginEdit = () => {
    setEditDisplayName(team.displayName);
    setEditOrganizationName(organizationNameFor(state, team.organizationId));
    setEditTeamLetter(team.teamLetter);
    setEditSeed(team.seed === null ? '' : String(team.seed));
    setEditNotes(team.notes ?? '');
    setEditing(true);
  };
  const saveEdit = () => {
    const displayName = editDisplayName.trim();
    if (!displayName) {
      onAnnounce(errorNotice('Enter a team name first.'));
      return;
    }
    const seedText = editSeed.trim();
    const seed = seedText ? Number(seedText) : null;
    if (seed !== null && (!Number.isInteger(seed) || seed < 1)) {
      onAnnounce(errorNotice('Seed must be a positive whole number or blank.'));
      return;
    }
    const updated = controller.updateTeam(team.id, {
      displayName,
      organizationName: editOrganizationName,
      teamLetter: editTeamLetter,
      seed,
      notes: editNotes,
    });
    if (!updated) {
      onAnnounce('Team changes were not saved; review the Director error.');
      return;
    }
    setEditing(false);
    onAnnounce(`${displayName} updated.`);
  };
  return (
    <>
      <tr
        tabIndex={-1}
        className={teamNavigation ? 'is-navigation-target' : undefined}
        data-director-navigation-id={team.id}
      >
        <td>
          <span data-director-navigation-focus tabIndex={-1}>
            {team.seed ?? '—'}
          </span>
        </td>
        <td>
          <strong>{team.displayName}</strong>
          {team.teamLetter && <small className="director-table-subtext">Team {team.teamLetter}</small>}
          {team.notes && <small className="director-table-subtext">{team.notes}</small>}
        </td>
        <td>{organizationNameFor(state, team.organizationId) || '—'}</td>
        <td>
          <details
            className="director-roster-details"
            open={rosterOpen || targetOpensRoster}
            onToggle={(event) => setRosterOpen(event.currentTarget.open)}
          >
            <summary className="director-roster-summary">
              {inactivePlayerCount > 0
                ? `${activePlayerCount} active · ${inactivePlayerCount} inactive`
                : `${activePlayerCount} player${activePlayerCount === 1 ? '' : 's'}`}
            </summary>
            <div className="director-roster-editor">
              {players.length > 0 && (
                <ul className="director-list director-roster-list">
                  {players.map((player) => (
                    <PlayerRow
                      key={player.id}
                      player={player}
                      teamName={team.displayName}
                      controller={controller}
                      onAnnounce={onAnnounce}
                      navigationTarget={navigationTarget}
                      onClearNavigationTarget={() => {
                        if (targetOpensRoster) setRosterOpen(true);
                        onClearNavigationTarget?.();
                      }}
                    />
                  ))}
                </ul>
              )}
              <form
                className="director-inline-form director-roster-add-row"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!playerName.trim()) {
                    onAnnounce('Enter a player name first.');
                    return;
                  }
                  if (!controller.addPlayer(team.id, playerName, playerCaptain)) return;
                  setPlayerName('');
                  setPlayerCaptain(false);
                  onAnnounce(`Player added to ${team.displayName}.`);
                }}
              >
                <input
                  aria-label={`Add player to ${team.displayName}`}
                  value={playerName}
                  onChange={(event) => setPlayerName(event.target.value)}
                  placeholder="Add player"
                />
                <label className="director-checkbox-field director-roster-captain-field">
                  <input
                    type="checkbox"
                    checked={playerCaptain}
                    onChange={(event) => setPlayerCaptain(event.target.checked)}
                  />
                  <span>Captain</span>
                </label>
                <button type="submit" className="director-inline-action director-roster-add-action">
                  Add
                </button>
              </form>
            </div>
          </details>
        </td>
        <td>
          <StateLabel
            state={team.status}
            label={
              team.status === 'confirmed' ? 'Confirmed' : team.status === 'waitlist' ? 'Waitlist' : 'Dropped'
            }
          />
        </td>
        <td>
          <div className="director-row-actions">
            <button
              type="button"
              className="director-button director-button-quiet director-table-action"
              aria-label={`Edit ${team.displayName}`}
              onClick={beginEdit}
            >
              <Icon name="edit" size={14} />
              <span>Edit</span>
            </button>
            <button
              type="button"
              className="director-button director-button-quiet director-table-action"
              aria-label={`${team.status === 'dropped' ? 'Restore' : 'Drop'} ${team.displayName}`}
              onClick={() => {
                const updated =
                  team.status === 'dropped' ? controller.restoreTeam(team.id) : controller.dropTeam(team.id);
                if (!updated) {
                  onAnnounce('Team status was not changed; review the Director error.');
                  return;
                }
                onAnnounce(
                  team.status === 'dropped'
                    ? `${team.displayName} restored.`
                    : `${team.displayName} dropped; schedule repair may be needed.`,
                );
              }}
            >
              <Icon name={team.status === 'dropped' ? 'refresh' : 'x'} size={15} />
              <span>{team.status === 'dropped' ? 'Restore' : 'Drop'}</span>
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
                saveEdit();
              }}
            >
              <div className="director-form-grid director-form-grid-three">
                <FormField label="Display name">
                  <input
                    value={editDisplayName}
                    onChange={(event) => setEditDisplayName(event.target.value)}
                  />
                </FormField>
                <FormField label="School / organization">
                  <input
                    list="director-organization-options"
                    value={editOrganizationName}
                    onChange={(event) => setEditOrganizationName(event.target.value)}
                  />
                </FormField>
                <FormField label="Team letter">
                  <input
                    value={editTeamLetter}
                    onChange={(event) => setEditTeamLetter(event.target.value)}
                    maxLength={4}
                  />
                </FormField>
                <FormField label="Seed">
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={editSeed}
                    onChange={(event) => setEditSeed(event.target.value)}
                    placeholder="Unseeded"
                  />
                </FormField>
              </div>
              <FormField
                label="Notes"
                hint="Optional registration or operations notes for the director team."
              >
                <textarea
                  className="director-textarea"
                  rows={2}
                  value={editNotes}
                  onChange={(event) => setEditNotes(event.target.value)}
                  placeholder="Needs a late check-in"
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

function OrganizationRow({
  organization,
  teamCount,
  controller,
  onAnnounce,
}: {
  organization: DirectorState['organizations'][number];
  teamCount: number;
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(organization.name);
  const [shortName, setShortName] = useState(organization.shortName ?? '');
  const [notes, setNotes] = useState(organization.notes ?? '');
  const beginEdit = () => {
    setName(organization.name);
    setShortName(organization.shortName ?? '');
    setNotes(organization.notes ?? '');
    setEditing(true);
  };
  const save = () => {
    const nextName = name.trim();
    if (!nextName) {
      onAnnounce('Enter an organization name first.');
      return;
    }
    if (!controller.updateOrganization(organization.id, { name: nextName, shortName, notes })) {
      onAnnounce(controller.error ?? 'Organization changes were not saved.');
      return;
    }
    setEditing(false);
    onAnnounce(`${nextName} updated.`);
  };
  const toggleArchived = () => {
    const archived = organization.archived !== true;
    if (archived && !window.confirm(`Archive ${organization.name}? Historical team links will be retained.`))
      return;
    if (!controller.setOrganizationArchived(organization.id, archived)) {
      onAnnounce(controller.error ?? 'Organization status was not changed.');
      return;
    }
    onAnnounce(`${organization.name} ${archived ? 'archived' : 'reopened'}.`);
  };
  return (
    <>
      <tr className={organization.archived ? 'is-inactive' : undefined}>
        <td>
          <strong>{organization.name}</strong>
          {organization.notes && <small className="director-table-subtext">{organization.notes}</small>}
        </td>
        <td>{organization.shortName || '—'}</td>
        <td>{teamCount}</td>
        <td>
          <StateLabel
            state={organization.archived ? 'archived' : 'active'}
            label={organization.archived ? 'Archived' : 'Active'}
          />
        </td>
        <td>
          <div className="director-row-actions">
            <button
              type="button"
              className="director-button director-button-quiet director-table-action"
              aria-label={`Edit ${organization.name}`}
              onClick={beginEdit}
            >
              <Icon name="edit" size={14} />
              <span>Edit</span>
            </button>
            <button
              type="button"
              className="director-button director-button-quiet director-table-action"
              aria-label={`${organization.archived ? 'Reopen' : 'Archive'} ${organization.name}`}
              onClick={toggleArchived}
            >
              <Icon name={organization.archived ? 'refresh' : 'x'} size={14} />
              <span>{organization.archived ? 'Reopen' : 'Archive'}</span>
            </button>
          </div>
        </td>
      </tr>
      {editing && (
        <tr className="director-table-edit-row">
          <td colSpan={5}>
            <form
              className="director-inline-edit"
              onSubmit={(event) => {
                event.preventDefault();
                save();
              }}
            >
              <div className="director-form-grid director-form-grid-three">
                <FormField label="Organization name">
                  <input value={name} onChange={(event) => setName(event.target.value)} />
                </FormField>
                <FormField label="Short name">
                  <input value={shortName} onChange={(event) => setShortName(event.target.value)} />
                </FormField>
                <FormField label="Notes">
                  <input value={notes} onChange={(event) => setNotes(event.target.value)} />
                </FormField>
              </div>
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

function PlayerRow({
  player,
  teamName,
  controller,
  onAnnounce,
  navigationTarget,
  onClearNavigationTarget,
}: {
  player: DirectorState['players'][number];
  teamName: string;
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
  navigationTarget?: DirectorNavigationTarget | null;
  onClearNavigationTarget?: () => void;
}) {
  const playerNavigation = useNavigationHighlight(
    navigationTarget,
    'teams',
    'player',
    player.id,
    onClearNavigationTarget,
  );
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(player.name);
  const [captain, setCaptain] = useState(player.captain);
  const [rosterNumber, setRosterNumber] = useState(
    player.rosterNumber === undefined ? '' : String(player.rosterNumber),
  );
  const [notes, setNotes] = useState(player.notes ?? '');
  const beginEdit = () => {
    setName(player.name);
    setCaptain(player.captain);
    setRosterNumber(player.rosterNumber === undefined ? '' : String(player.rosterNumber));
    setNotes(player.notes ?? '');
    setEditing(true);
  };
  const save = () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      onAnnounce('Enter a player name first.');
      return;
    }
    if (
      !controller.updatePlayer(player.id, {
        name: trimmedName,
        captain,
        rosterNumber: rosterNumber.trim(),
        notes,
      })
    ) {
      onAnnounce('Player changes were not saved; review the Director error.');
      return;
    }
    setEditing(false);
    onAnnounce(`${trimmedName} updated.`);
  };
  return (
    <>
      <li
        tabIndex={-1}
        data-director-navigation-id={player.id}
        className={`director-list-row director-roster-row${player.active ? '' : ' is-inactive'}${playerNavigation ? ' is-navigation-target' : ''}`}
      >
        <div className="director-roster-player-summary">
          <span>
            {player.name}
            {player.captain ? ' · captain' : ''}
            {!player.active && <em className="director-roster-status"> · inactive</em>}
          </span>
          {(player.rosterNumber !== undefined || player.notes) && (
            <small className="director-table-subtext">
              {player.rosterNumber !== undefined ? `Roster ${player.rosterNumber}` : ''}
              {player.rosterNumber !== undefined && player.notes ? ' · ' : ''}
              {player.notes ?? ''}
            </small>
          )}
        </div>
        <div className="director-row-actions">
          <button
            type="button"
            className="director-inline-action"
            aria-label={`Edit ${player.name}`}
            onClick={beginEdit}
          >
            <Icon name="edit" size={13} />
            <span>Edit</span>
          </button>
          {player.active ? (
            <button
              type="button"
              className="director-inline-action director-roster-remove-action"
              aria-label={`Remove ${player.name} from ${teamName}`}
              onClick={() => {
                if (!controller.removePlayer(player.id)) {
                  onAnnounce('Player status was not changed; review the Director error.');
                  return;
                }
                setEditing(false);
                onAnnounce(`${player.name} removed from the active roster.`);
              }}
            >
              Remove
            </button>
          ) : (
            <button
              type="button"
              className="director-inline-action"
              aria-label={`Restore ${player.name} to ${teamName}`}
              onClick={() => {
                if (!controller.updatePlayer(player.id, { active: true })) {
                  onAnnounce('Player could not be restored; review the Director error.');
                  return;
                }
                onAnnounce(`${player.name} restored to the active roster.`);
              }}
            >
              Restore
            </button>
          )}
        </div>
      </li>
      {editing && (
        <li className="director-roster-player-edit">
          <form
            className="director-inline-edit"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <div className="director-form-grid director-form-grid-two">
              <FormField label="Name">
                <input value={name} onChange={(event) => setName(event.target.value)} />
              </FormField>
              <FormField label="Roster number">
                <input
                  value={rosterNumber}
                  onChange={(event) => setRosterNumber(event.target.value)}
                  placeholder="Optional"
                />
              </FormField>
            </div>
            <label className="director-checkbox-field">
              <input
                type="checkbox"
                checked={captain}
                onChange={(event) => setCaptain(event.target.checked)}
              />
              <span>Captain</span>
            </label>
            <FormField label="Notes">
              <textarea
                className="director-textarea"
                rows={2}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="Optional roster note"
              />
            </FormField>
            <div className="director-row-actions">
              <Button variant="primary" type="submit">
                Save player
              </Button>
              <Button variant="quiet" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </form>
        </li>
      )}
    </>
  );
}

function organizationNameFor(state: DirectorState, organizationId: string | null): string {
  return organizationId
    ? (state.organizations.find((organization) => organization.id === organizationId)?.name ?? '')
    : '';
}
