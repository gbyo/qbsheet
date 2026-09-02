import { useMemo, useState } from 'react';
import type { DirectorController } from '../state/useDirectorController';
import type { DirectorState } from '../domain';
import { Button, EmptyState, FormField, PanelBody, PanelFooter, StateLabel } from '../components/Controls';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { importTeamsCsv, type TeamRecord } from '@qbsheet/tournament-formats';

export function TeamsView({
  state,
  controller,
  search,
  onAnnounce,
}: {
  state: DirectorState;
  controller: DirectorController;
  search: string;
  onAnnounce: (message: string) => void;
}) {
  const [showForm, setShowForm] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [teamLetter, setTeamLetter] = useState('');
  const [notes, setNotes] = useState('');
  const [paste, setPaste] = useState('');
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

  const submitTeam = () => {
    if (!displayName.trim()) {
      onAnnounce('Enter a team name first.');
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
    const result = controller.addImportedTeams(
      teams.map((team) => ({
        id: team.id,
        displayName: team.displayName ?? team.name,
        organizationId: team.organizationId,
        teamLetter: team.letter,
        seed: team.seed ?? null,
        status: importedTeamStatus(team.status),
        notes: team.notes,
        players: team.players?.map((player) => ({
          id: player.id,
          name: player.name,
          captain: player.captain,
          rosterNumber: player.rosterNumber,
          notes: player.notes,
        })),
      })),
    );
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
      onAnnounce(report.errors.map((entry) => entry.message).join(' ') || 'That CSV is not valid.');
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

  const importCsv = async (file: File | undefined) => {
    if (!file) return;
    try {
      const report = importTeamsCsv(await file.text());
      if (!report.ok) {
        onAnnounce(report.errors.map((entry) => entry.message).join(' ') || 'That CSV is not valid.');
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
                <FormField label="Notes" hint="Optional registration or operations notes for the director team.">
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
}: {
  state: DirectorState;
  teamId: string;
  controller: DirectorController;
  onAnnounce: (message: string) => void;
}) {
  const team = state.teams.find((entry) => entry.id === teamId);
  const [playerName, setPlayerName] = useState('');
  const [playerCaptain, setPlayerCaptain] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editDisplayName, setEditDisplayName] = useState('');
  const [editOrganizationName, setEditOrganizationName] = useState('');
  const [editTeamLetter, setEditTeamLetter] = useState('');
  const [editSeed, setEditSeed] = useState('');
  const [editNotes, setEditNotes] = useState('');
  if (!team) return null;
  const players = state.players.filter((player) => player.teamId === team.id && player.active);
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
      onAnnounce('Enter a team name first.');
      return;
    }
    const seedText = editSeed.trim();
    const seed = seedText ? Number(seedText) : null;
    if (seed !== null && (!Number.isInteger(seed) || seed < 1)) {
      onAnnounce('Seed must be a positive whole number or blank.');
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
      <tr>
        <td>{team.seed ?? '—'}</td>
        <td>
          <strong>{team.displayName}</strong>
          {team.teamLetter && <small className="director-table-subtext">Team {team.teamLetter}</small>}
          {team.notes && <small className="director-table-subtext">{team.notes}</small>}
        </td>
        <td>{organizationNameFor(state, team.organizationId) || '—'}</td>
        <td>
          <details className="director-roster-details">
            <summary className="director-roster-summary">
              {players.length} player{players.length === 1 ? '' : 's'}
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
              <FormField label="Notes" hint="Optional registration or operations notes for the director team.">
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

function PlayerRow({
  player,
  teamName,
  controller,
  onAnnounce,
}: {
  player: DirectorState['players'][number];
  teamName: string;
  controller: DirectorController;
  onAnnounce: (message: string) => void;
}) {
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
      <li className="director-list-row director-roster-row">
        <div className="director-roster-player-summary">
          <span>
            {player.name}
            {player.captain ? ' · captain' : ''}
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
          <button
            type="button"
            className="director-inline-action director-roster-remove-action"
            aria-label={`Remove ${player.name} from ${teamName}`}
            onClick={() => controller.removePlayer(player.id)}
          >
            Remove
          </button>
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

function importedTeamStatus(status: string | undefined): 'confirmed' | 'waitlist' | 'dropped' {
  const normalized = typeof status === 'string' ? status.trim().toLowerCase() : '';
  if (
    normalized === 'dropped' ||
    normalized === 'withdrawn' ||
    normalized === 'no-show' ||
    normalized === 'forfeit'
  ) {
    return 'dropped';
  }
  if (normalized === 'late' || normalized === 'waitlist') return 'waitlist';
  return 'confirmed';
}
