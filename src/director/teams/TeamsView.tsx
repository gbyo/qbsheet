import { useMemo, useState } from 'react';
import type { DirectorController } from '../state/useDirectorController';
import type { DirectorState } from '../domain';
import { Button, EmptyState, FormField, PanelBody, PanelFooter, StateLabel } from '../components/Controls';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';

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
    controller.addTeam({ displayName, organizationName, teamLetter });
    setDisplayName('');
    setTeamLetter('');
    setShowForm(false);
    onAnnounce(`${displayName.trim()} added.`);
  };

  const importPaste = () => {
    const rows = paste
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    let added = 0;
    for (const row of rows) {
      const [name, school = '', letter = ''] = row.split(/\t|,/).map((part) => part.trim());
      if (!name) continue;
      controller.addTeam({ displayName: name, organizationName: school, teamLetter: letter });
      added += 1;
    }
    setPaste('');
    setShowPaste(false);
    onAnnounce(
      added ? `${added} team${added === 1 ? '' : 's'} added from pasted rows.` : 'No team rows found.',
    );
  };

  const importCsv = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    const rows = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    let added = 0;
    for (const row of rows.slice(rowLooksLikeHeader(rows[0]) ? 1 : 0)) {
      const columns = parseCsvLine(row);
      if (!columns[0]) continue;
      controller.addTeam({ displayName: columns[0], organizationName: columns[1], teamLetter: columns[2] });
      added += 1;
    }
    onAnnounce(
      added ? `${added} team${added === 1 ? '' : 's'} imported.` : 'No team rows found in that file.',
    );
  };

  return (
    <>
      <PageHeader
        eyebrow="Plan"
        title="Teams"
        description={`${state.teams.length} team record${state.teams.length === 1 ? '' : 's'} · changes save immediately`}
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
            </PanelBody>
            <PanelFooter className="director-form-actions">
              <Button variant="primary" onClick={submitTeam}>
                Save team
              </Button>
            </PanelFooter>
          </section>
        )}

        {showPaste && (
          <section className="director-panel director-form-panel">
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
                One team per line. Use columns for team name, school, and team letter.
              </p>
              <textarea
                className="director-textarea"
                value={paste}
                onChange={(event) => setPaste(event.target.value)}
                placeholder={'Northview A\tNorthview High\tA\nRiverside A\tRiverside School\tA'}
                rows={5}
              />
            </PanelBody>
            <PanelFooter className="director-form-actions">
              <Button variant="primary" onClick={importPaste}>
                Add pasted teams
              </Button>
            </PanelFooter>
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
  if (!team) return null;
  const players = state.players.filter((player) => player.teamId === team.id && player.active);
  return (
    <tr>
      <td>{team.seed ?? '—'}</td>
      <td>
        <strong>{team.displayName}</strong>
        {team.teamLetter && <small className="director-table-subtext">Team {team.teamLetter}</small>}
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
                  <li key={player.id} className="director-list-row director-roster-row">
                    <span>
                      {player.name}
                      {player.captain ? ' · captain' : ''}
                    </span>
                    <button
                      type="button"
                      className="director-inline-action director-roster-remove-action"
                      aria-label={`Remove ${player.name} from ${team.displayName}`}
                      onClick={() => controller.removePlayer(player.id)}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="director-inline-form director-roster-add-row">
              <input
                aria-label={`Add player to ${team.displayName}`}
                value={playerName}
                onChange={(event) => setPlayerName(event.target.value)}
                placeholder="Add player"
              />
              <button
                type="button"
                className="director-inline-action director-roster-add-action"
                onClick={() => {
                  controller.addPlayer(team.id, playerName);
                  setPlayerName('');
                  onAnnounce(`Player added to ${team.displayName}.`);
                }}
              >
                Add
              </button>
            </div>
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
        <button
          type="button"
          className="director-button director-button-quiet director-table-action"
          aria-label={`${team.status === 'dropped' ? 'Restore' : 'Drop'} ${team.displayName}`}
          onClick={() => {
            if (team.status === 'dropped') controller.restoreTeam(team.id);
            else controller.dropTeam(team.id);
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
      </td>
    </tr>
  );
}

function organizationNameFor(state: DirectorState, organizationId: string | null): string {
  return organizationId
    ? (state.organizations.find((organization) => organization.id === organizationId)?.name ?? '')
    : '';
}

function rowLooksLikeHeader(row: string | undefined): boolean {
  return Boolean(row && /team|school|organization/i.test(row));
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"' && line[index + 1] === '"' && quoted) {
      current += '"';
      index += 1;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (character === ',' && !quoted) {
      values.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  values.push(current.trim());
  return values;
}
