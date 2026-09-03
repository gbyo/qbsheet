import { useEffect, useMemo, useRef, useState } from 'react';
import type { DirectorController, NewPlayerInput } from '../state/useDirectorController';
import type { DirectorState } from '../domain';
import { Button, EmptyState, FormField, PanelBody, PanelFooter, StateLabel } from '../components/Controls';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { importTeamsCsv, type TeamRecord } from '@qbsheet/tournament-formats';
import type { DirectorNavigationTarget } from '../app/navigationTarget';
import { useNavigationHighlight } from '../app/useNavigationHighlight';
import { errorNotice, type AnnounceInput } from '../notices';

interface RosterDraft {
  key: number;
  name: string;
  captain: boolean;
  rosterNumber: string;
  notes: string;
}

let rosterDraftKey = 0;

function blankRosterDraft(): RosterDraft {
  rosterDraftKey += 1;
  return { key: rosterDraftKey, name: '', captain: false, rosterNumber: '', notes: '' };
}

function blankRoster(count: number): RosterDraft[] {
  return Array.from({ length: count }, blankRosterDraft);
}

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
  const [showSchools, setShowSchools] = useState(false);
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
  const visibleOrganizations = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return state.organizations.filter(
      (organization) =>
        !needle ||
        [
          organization.name,
          organization.shortName,
          organization.city,
          organization.notes,
          organization.archived ? 'archived' : 'active',
        ]
          .filter(Boolean)
          .join(' ')
          .toLocaleLowerCase()
          .includes(needle),
    );
  }, [search, state.organizations]);

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
      onAnnounce(errorNotice(reason instanceof Error ? reason.message : 'That CSV could not be read.'));
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="Plan"
        title="Teams"
        description={`${state.teams.length} team${state.teams.length === 1 ? '' : 's'} · changes persist locally as you work`}
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
              Paste teams
            </Button>
            <Button variant="quiet" icon="edit" onClick={() => setShowSchools((value) => !value)}>
              Manage schools &amp; clubs
            </Button>
            <Button variant="primary" icon="plus" onClick={() => setShowForm((value) => !value)}>
              Add team
            </Button>
          </>
        }
      />
      <div className="director-page-stack">
        {showForm && (
          <NewTeamForm
            state={state}
            controller={controller}
            onAnnounce={onAnnounce}
            onClose={() => setShowForm(false)}
          />
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
                  <h2>Paste teams from CSV</h2>
                </div>
                <Button variant="quiet" icon="x" onClick={() => setShowPaste(false)}>
                  Close
                </Button>
              </div>
              <PanelBody>
                <p className="director-panel-description">
                  Paste CSV with a header row. Use <code>team_name</code> for the team and{' '}
                  <code>organization_id</code> for either the School / club name or its stable import ID.
                  Player columns and existing CSV exports remain supported.
                </p>
                <textarea
                  aria-label="Team CSV"
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

        <datalist id="director-school-options">
          {state.organizations
            .filter((organization) => organization.archived !== true)
            .map((organization) => (
              <option key={organization.id} value={organization.name} />
            ))}
        </datalist>

        {state.teams.length === 0 ? (
          <EmptyState
            title="No teams yet"
            description="Add a team and its full roster in one step, paste team CSV, or import an existing file."
          >
            <Button variant="primary" icon="plus" onClick={() => setShowForm(true)}>
              Add first team
            </Button>
          </EmptyState>
        ) : (
          <section className="director-panel" data-testid="director-teams">
            <div className="director-panel-heading">
              <div>
                <p className="director-eyebrow">Teams</p>
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
                    <th>Team</th>
                    <th>School / club</th>
                    <th>Players</th>
                    <th>Seed</th>
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

        {showSchools && (
          <SchoolsPanel
            state={state}
            organizations={visibleOrganizations}
            controller={controller}
            onAnnounce={onAnnounce}
          />
        )}
      </div>
    </>
  );
}

function NewTeamForm({
  state,
  controller,
  onAnnounce,
  onClose,
}: {
  state: DirectorState;
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
  onClose: () => void;
}) {
  const [displayName, setDisplayName] = useState('');
  const [displayNameCustomized, setDisplayNameCustomized] = useState(false);
  const [organizationName, setOrganizationName] = useState('');
  const [teamLetter, setTeamLetter] = useState('');
  const [seed, setSeed] = useState('');
  const [notes, setNotes] = useState('');
  const [players, setPlayers] = useState(() => blankRoster(5));
  const [showRosterPaste, setShowRosterPaste] = useState(false);
  const [rosterPaste, setRosterPaste] = useState('');
  const focusKeyRef = useRef<number | null>(null);
  const rosterRegionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const focusKey = focusKeyRef.current;
    if (focusKey === null) return;
    rosterRegionRef.current?.querySelector<HTMLInputElement>(`input[data-roster-key="${focusKey}"]`)?.focus();
    focusKeyRef.current = null;
  }, [players.length]);

  const suggestedName = (school: string, letter: string) => {
    const match = state.organizations.find(
      (organization) =>
        !organization.archived &&
        organization.name.trim().toLocaleLowerCase() === school.trim().toLocaleLowerCase(),
    );
    return [match?.shortName || school.trim(), letter.trim()].filter(Boolean).join(' ');
  };
  const updateOrganizationName = (value: string) => {
    setOrganizationName(value);
    if (!displayNameCustomized) setDisplayName(suggestedName(value, teamLetter));
  };
  const updateTeamLetter = (value: string) => {
    setTeamLetter(value);
    if (!displayNameCustomized) setDisplayName(suggestedName(organizationName, value));
  };
  const updatePlayer = (key: number, changes: Partial<RosterDraft>) => {
    setPlayers((current) =>
      current.map((player) => {
        if (changes.captain && player.key !== key) return { ...player, captain: false };
        return player.key === key ? { ...player, ...changes } : player;
      }),
    );
  };
  const addPlayerRow = () => {
    const row = blankRosterDraft();
    focusKeyRef.current = row.key;
    setPlayers((current) => [...current, row]);
  };
  const pasteRoster = () => {
    const parsed = parseRosterPaste(rosterPaste);
    if (parsed.length === 0) {
      onAnnounce(errorNotice('Paste at least one player name.'));
      return;
    }
    const firstCaptain = parsed.findIndex((player) => player.captain);
    const exclusive = parsed.map((player, index) => ({ ...player, captain: index === firstCaptain }));
    setPlayers([...exclusive, ...blankRoster(Math.max(0, 5 - exclusive.length))]);
    setRosterPaste('');
    setShowRosterPaste(false);
    onAnnounce(`${parsed.length} player${parsed.length === 1 ? '' : 's'} added to the editable roster.`);
  };
  const submit = () => {
    const teamName = displayName.trim();
    if (!teamName) {
      onAnnounce(errorNotice('Enter a display name first.'));
      return;
    }
    const parsedSeed = seed.trim() ? Number(seed) : null;
    if (parsedSeed !== null && (!Number.isInteger(parsedSeed) || parsedSeed < 1)) {
      onAnnounce(errorNotice('Seed must be a positive whole number or blank.'));
      return;
    }
    const validation = validateRosterDrafts(players);
    if (validation) {
      onAnnounce(errorNotice(validation));
      return;
    }
    const roster = rosterInputs(players);
    if (
      !controller.addTeam({
        displayName: teamName,
        organizationName,
        teamLetter,
        seed: parsedSeed,
        notes,
        players: roster,
      })
    ) {
      onAnnounce(errorNotice('Team and roster were not saved; review the Director error.'));
      return;
    }
    onClose();
    onAnnounce(
      `${teamName} and ${roster.filter((player) => player.name.trim()).length} player${roster.filter((player) => player.name.trim()).length === 1 ? '' : 's'} added locally; saving now.`,
    );
  };

  return (
    <section className="director-panel director-form-panel director-team-registration">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="director-panel-heading">
          <div>
            <p className="director-eyebrow">New team</p>
            <h2>Team and roster</h2>
          </div>
          <Button variant="quiet" icon="x" onClick={onClose}>
            Close
          </Button>
        </div>
        <PanelBody>
          <fieldset className="director-fieldset">
            <legend>Team</legend>
            <div className="director-form-grid director-team-registration-grid">
              <FormField
                label="School / club"
                hint="Choose an existing school or type a new one. New schools are created automatically."
              >
                <input
                  list="director-school-options"
                  value={organizationName}
                  onChange={(event) => updateOrganizationName(event.target.value)}
                  placeholder="Northview High"
                  autoComplete="off"
                />
              </FormField>
              <FormField label="Team letter" hint="Optional, such as A, B, or C.">
                <input
                  value={teamLetter}
                  onChange={(event) => updateTeamLetter(event.target.value)}
                  placeholder="A"
                  maxLength={4}
                />
              </FormField>
              <FormField label="Display name" hint="Suggested automatically until you edit it.">
                <input
                  required
                  value={displayName}
                  onChange={(event) => {
                    setDisplayName(event.target.value);
                    setDisplayNameCustomized(true);
                  }}
                  placeholder="Northview A"
                />
              </FormField>
            </div>
            <details className="director-secondary-details">
              <summary>More team details</summary>
              <div className="director-form-grid director-form-grid-two">
                <FormField label="Seed">
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={seed}
                    onChange={(event) => setSeed(event.target.value)}
                    placeholder="Unseeded"
                  />
                </FormField>
                <FormField label="Team notes">
                  <input
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                    placeholder="Optional registration note"
                  />
                </FormField>
              </div>
            </details>
          </fieldset>

          <fieldset className="director-fieldset director-roster-fieldset">
            <legend>Players</legend>
            <div className="director-section-heading-inline">
              <p>Enter the initial roster now. Completely empty rows are ignored.</p>
              <Button variant="quiet" icon="clipboard" onClick={() => setShowRosterPaste((value) => !value)}>
                Paste roster
              </Button>
            </div>
            {showRosterPaste && (
              <div className="director-roster-paste">
                <FormField
                  label="Player names"
                  hint="One name per line. You can edit every row before saving."
                >
                  <textarea
                    className="director-textarea"
                    rows={5}
                    value={rosterPaste}
                    onChange={(event) => setRosterPaste(event.target.value)}
                    placeholder={'Alice Smith\nBob Jones\nCharlie Lee\nDana Patel'}
                  />
                </FormField>
                <Button variant="secondary" onClick={pasteRoster}>
                  Use pasted roster
                </Button>
              </div>
            )}
            <div className="director-roster-entry" ref={rosterRegionRef}>
              {players.map((player, index) => (
                <RosterDraftRow
                  key={player.key}
                  player={player}
                  index={index}
                  canRemove={players.length > 1}
                  onChange={(changes) => updatePlayer(player.key, changes)}
                  onRemove={() =>
                    setPlayers((current) => current.filter((entry) => entry.key !== player.key))
                  }
                />
              ))}
            </div>
            <Button variant="quiet" icon="plus" onClick={addPlayerRow}>
              Add player
            </Button>
          </fieldset>
        </PanelBody>
        <PanelFooter className="director-form-actions">
          <Button variant="primary" type="submit">
            Save team
          </Button>
          <span className="director-muted">The team, school, and roster are saved together.</span>
        </PanelFooter>
      </form>
    </section>
  );
}

function RosterDraftRow({
  player,
  index,
  canRemove,
  onChange,
  onRemove,
}: {
  player: RosterDraft;
  index: number;
  canRemove: boolean;
  onChange: (changes: Partial<RosterDraft>) => void;
  onRemove: () => void;
}) {
  const number = index + 1;
  return (
    <div className="director-roster-entry-row">
      <span className="director-roster-entry-number" aria-hidden="true">
        {number}
      </span>
      <label className="director-roster-name-field">
        <span className="director-visually-hidden">Player {number} name</span>
        <input
          data-roster-key={player.key}
          aria-label={`Player ${number} name`}
          value={player.name}
          onChange={(event) => onChange({ name: event.target.value })}
          placeholder="Player name"
        />
      </label>
      <label className="director-roster-number-field">
        <span className="director-visually-hidden">Player {number} roster number</span>
        <input
          aria-label={`Player ${number} roster number`}
          value={player.rosterNumber}
          onChange={(event) => onChange({ rosterNumber: event.target.value })}
          placeholder="No."
        />
      </label>
      <label className="director-checkbox-field director-roster-captain-field">
        <input
          aria-label={`Player ${number} captain`}
          type="checkbox"
          checked={player.captain}
          onChange={(event) => onChange({ captain: event.target.checked })}
        />
        <span>Captain</span>
      </label>
      <label className="director-roster-notes-field">
        <span className="director-visually-hidden">Player {number} notes</span>
        <input
          aria-label={`Player ${number} notes`}
          value={player.notes}
          onChange={(event) => onChange({ notes: event.target.value })}
          placeholder="Notes (optional)"
        />
      </label>
      <button
        type="button"
        className="director-inline-action director-roster-remove-action"
        aria-label={`Remove player row ${number}`}
        onClick={onRemove}
        disabled={!canRemove}
      >
        Remove
      </button>
    </div>
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
  const [editorOpen, setEditorOpen] = useState(false);
  if (!team) return null;
  const targetOpensRoster =
    navigationTarget?.section === 'teams' &&
    navigationTarget.entityType === 'player' &&
    navigationTarget.parentId === team.id;
  const players = state.players.filter((player) => player.teamId === team.id);
  const activePlayerCount = players.filter((player) => player.active).length;
  const inactivePlayerCount = players.length - activePlayerCount;
  const rosterLabel = inactivePlayerCount
    ? `${activePlayerCount} active · ${inactivePlayerCount} inactive`
    : `${activePlayerCount} player${activePlayerCount === 1 ? '' : 's'}`;
  const isOpen = editorOpen || targetOpensRoster;
  return (
    <>
      <tr
        tabIndex={-1}
        className={teamNavigation ? 'is-navigation-target' : undefined}
        data-director-navigation-id={team.id}
      >
        <td>
          <strong data-director-navigation-focus tabIndex={-1}>
            {team.displayName}
          </strong>
          {team.teamLetter && <small className="director-table-subtext">Team {team.teamLetter}</small>}
          {team.notes && <small className="director-table-subtext">{team.notes}</small>}
        </td>
        <td>{organizationNameFor(state, team.organizationId) || '—'}</td>
        <td>
          <button
            type="button"
            className="director-inline-action director-roster-open-action"
            aria-expanded={isOpen}
            aria-controls={`team-editor-${team.id}`}
            onClick={() => setEditorOpen((value) => !value)}
          >
            {rosterLabel}
          </button>
        </td>
        <td>{team.seed ?? '—'}</td>
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
              onClick={() => setEditorOpen(true)}
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
                  onAnnounce(errorNotice('Team status was not changed; review the Director error.'));
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
      {isOpen && (
        <tr className="director-table-edit-row director-team-editor-row">
          <td colSpan={6}>
            <TeamEditor
              id={`team-editor-${team.id}`}
              state={state}
              team={team}
              players={players}
              controller={controller}
              onAnnounce={onAnnounce}
              onClose={() => setEditorOpen(false)}
              navigationTarget={navigationTarget}
              onClearNavigationTarget={() => {
                if (targetOpensRoster) setEditorOpen(true);
                onClearNavigationTarget?.();
              }}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function TeamEditor({
  id,
  state,
  team,
  players,
  controller,
  onAnnounce,
  onClose,
  navigationTarget,
  onClearNavigationTarget,
}: {
  id: string;
  state: DirectorState;
  team: DirectorState['teams'][number];
  players: DirectorState['players'];
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
  onClose: () => void;
  navigationTarget?: DirectorNavigationTarget | null;
  onClearNavigationTarget?: () => void;
}) {
  const [displayName, setDisplayName] = useState(team.displayName);
  const [organizationName, setOrganizationName] = useState(organizationNameFor(state, team.organizationId));
  const [teamLetter, setTeamLetter] = useState(team.teamLetter);
  const [seed, setSeed] = useState(team.seed === null ? '' : String(team.seed));
  const [notes, setNotes] = useState(team.notes ?? '');
  const [newPlayers, setNewPlayers] = useState(() => blankRoster(2));
  const focusKeyRef = useRef<number | null>(null);
  const rosterRegionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const focusKey = focusKeyRef.current;
    if (focusKey === null) return;
    rosterRegionRef.current?.querySelector<HTMLInputElement>(`input[data-roster-key="${focusKey}"]`)?.focus();
    focusKeyRef.current = null;
  }, [newPlayers.length]);

  const updateNewPlayer = (key: number, changes: Partial<RosterDraft>) => {
    setNewPlayers((current) =>
      current.map((player) => {
        if (changes.captain && player.key !== key) return { ...player, captain: false };
        return player.key === key ? { ...player, ...changes } : player;
      }),
    );
  };
  const saveTeam = () => {
    const parsedSeed = seed.trim() ? Number(seed) : null;
    if (!displayName.trim()) {
      onAnnounce(errorNotice('Enter a display name first.'));
      return;
    }
    if (parsedSeed !== null && (!Number.isInteger(parsedSeed) || parsedSeed < 1)) {
      onAnnounce(errorNotice('Seed must be a positive whole number or blank.'));
      return;
    }
    if (
      !controller.updateTeam(team.id, { displayName, organizationName, teamLetter, seed: parsedSeed, notes })
    ) {
      onAnnounce(errorNotice('Team changes were not saved; review the Director error.'));
      return;
    }
    onAnnounce(`${displayName.trim()} updated.`);
  };
  const addPlayers = () => {
    const existingNames = new Set(
      players.filter((player) => player.active).map((player) => player.name.trim().toLocaleLowerCase()),
    );
    const validation = validateRosterDrafts(newPlayers, existingNames);
    if (validation) {
      onAnnounce(errorNotice(validation));
      return;
    }
    const inputs = rosterInputs(newPlayers).filter((player) => player.name.trim());
    if (inputs.length === 0) {
      onAnnounce(errorNotice('Enter at least one player name.'));
      return;
    }
    for (const player of inputs) {
      if (!controller.addPlayer(team.id, player.name, player.captain, player.rosterNumber, player.notes)) {
        onAnnounce(errorNotice('Roster changes were not saved; review the Director error.'));
        return;
      }
    }
    setNewPlayers(blankRoster(2));
    onAnnounce(`${inputs.length} player${inputs.length === 1 ? '' : 's'} added to ${team.displayName}.`);
  };

  return (
    <div id={id} className="director-team-editor">
      <div className="director-section-heading-inline">
        <div>
          <p className="director-eyebrow">Edit team</p>
          <h3>{team.displayName}</h3>
        </div>
        <Button variant="quiet" icon="x" onClick={onClose}>
          Close editor
        </Button>
      </div>
      <form
        className="director-inline-edit"
        onSubmit={(event) => {
          event.preventDefault();
          saveTeam();
        }}
      >
        <div className="director-form-grid director-team-edit-grid">
          <FormField label="Display name">
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </FormField>
          <FormField label="School / club">
            <input
              list="director-school-options"
              value={organizationName}
              onChange={(event) => setOrganizationName(event.target.value)}
            />
          </FormField>
          <FormField label="Team letter">
            <input value={teamLetter} onChange={(event) => setTeamLetter(event.target.value)} maxLength={4} />
          </FormField>
          <FormField label="Seed">
            <input
              type="number"
              min="1"
              step="1"
              value={seed}
              onChange={(event) => setSeed(event.target.value)}
              placeholder="Unseeded"
            />
          </FormField>
        </div>
        <FormField label="Team notes">
          <textarea
            className="director-textarea"
            rows={2}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Optional registration note"
          />
        </FormField>
        <Button variant="secondary" type="submit">
          Save team details
        </Button>
      </form>

      <section className="director-existing-roster" aria-labelledby={`${id}-roster-heading`}>
        <div className="director-section-heading-inline">
          <div>
            <p className="director-eyebrow">Roster</p>
            <h3 id={`${id}-roster-heading`}>
              {players.filter((player) => player.active).length} active player
              {players.filter((player) => player.active).length === 1 ? '' : 's'}
            </h3>
          </div>
        </div>
        {players.length > 0 ? (
          <div className="director-roster-list">
            {players.map((player) => (
              <PlayerRow
                key={player.id}
                player={player}
                teamName={team.displayName}
                controller={controller}
                onAnnounce={onAnnounce}
                navigationTarget={navigationTarget}
                onClearNavigationTarget={onClearNavigationTarget}
              />
            ))}
          </div>
        ) : (
          <p className="director-empty-copy">No players have been added yet.</p>
        )}
      </section>

      <form
        className="director-add-players-form"
        onSubmit={(event) => {
          event.preventDefault();
          addPlayers();
        }}
      >
        <h4>Add players</h4>
        <div className="director-roster-entry" ref={rosterRegionRef}>
          {newPlayers.map((player, index) => (
            <RosterDraftRow
              key={player.key}
              player={player}
              index={index}
              canRemove={newPlayers.length > 1}
              onChange={(changes) => updateNewPlayer(player.key, changes)}
              onRemove={() => setNewPlayers((current) => current.filter((entry) => entry.key !== player.key))}
            />
          ))}
        </div>
        <div className="director-row-actions director-roster-add-actions">
          <Button
            variant="quiet"
            icon="plus"
            onClick={() => {
              const row = blankRosterDraft();
              focusKeyRef.current = row.key;
              setNewPlayers((current) => [...current, row]);
            }}
          >
            Add another row
          </Button>
          <Button variant="primary" type="submit">
            Add players to roster
          </Button>
        </div>
      </form>
    </div>
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
    if (!name.trim()) {
      onAnnounce(errorNotice('Enter a player name first.'));
      return;
    }
    if (!controller.updatePlayer(player.id, { name, captain, rosterNumber, notes })) {
      onAnnounce(errorNotice('Player changes were not saved; review the Director error.'));
      return;
    }
    setEditing(false);
    onAnnounce(`${name.trim()} updated.`);
  };
  return (
    <div
      tabIndex={-1}
      data-director-navigation-id={player.id}
      className={`director-roster-player-card${player.active ? '' : ' is-inactive'}${playerNavigation ? ' is-navigation-target' : ''}`}
    >
      <div className="director-roster-player-summary" data-director-navigation-focus tabIndex={-1}>
        <strong>{player.name}</strong>
        <span>
          {player.captain ? 'Captain' : 'Player'}
          {player.rosterNumber !== undefined ? ` · No. ${player.rosterNumber}` : ''}
          {!player.active ? ' · inactive' : ''}
        </span>
        {player.notes && <small>{player.notes}</small>}
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
                onAnnounce(errorNotice('Player status was not changed; review the Director error.'));
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
                onAnnounce(errorNotice('Player could not be restored; review the Director error.'));
                return;
              }
              onAnnounce(`${player.name} restored to the active roster.`);
            }}
          >
            Restore
          </button>
        )}
      </div>
      {editing && (
        <form
          className="director-roster-player-edit"
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
            <input type="checkbox" checked={captain} onChange={(event) => setCaptain(event.target.checked)} />
            <span>Captain</span>
          </label>
          <FormField label="Player notes">
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
      )}
    </div>
  );
}

function SchoolsPanel({
  state,
  organizations,
  controller,
  onAnnounce,
}: {
  state: DirectorState;
  organizations: DirectorState['organizations'];
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState('');
  const [shortName, setShortName] = useState('');
  const [city, setCity] = useState('');
  const [notes, setNotes] = useState('');
  const submit = () => {
    if (!controller.addOrganization({ name, shortName, city, notes })) {
      onAnnounce(errorNotice('School or club was not added; review the Director error.'));
      return;
    }
    const label = name.trim();
    setName('');
    setShortName('');
    setCity('');
    setNotes('');
    setShowAdd(false);
    onAnnounce(`${label} added to Schools & clubs.`);
  };
  return (
    <section className="director-panel director-schools-panel" data-testid="director-schools-management">
      <div className="director-panel-heading">
        <div>
          <p className="director-eyebrow">Advanced cleanup</p>
          <h2>Schools &amp; clubs</h2>
          <p className="director-panel-description">
            Rename, archive, or merge records created through registration and imports.
          </p>
        </div>
        <div className="director-row-actions">
          <span className="director-muted">
            {state.organizations.filter((organization) => !organization.archived).length} active
          </span>
          <Button variant="quiet" icon="plus" onClick={() => setShowAdd((value) => !value)}>
            Add school
          </Button>
        </div>
      </div>
      {showAdd && (
        <form
          className="director-panel-body director-inline-edit"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="director-form-grid director-school-edit-grid">
            <FormField label="School / club name">
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Northview High"
              />
            </FormField>
            <FormField label="Display label" hint="Optional short label used in compact public views.">
              <input
                value={shortName}
                onChange={(event) => setShortName(event.target.value)}
                placeholder="Northview"
              />
            </FormField>
            <FormField label="City">
              <input
                value={city}
                onChange={(event) => setCity(event.target.value)}
                placeholder="Springfield"
              />
            </FormField>
            <FormField label="School notes">
              <input
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="Optional"
              />
            </FormField>
          </div>
          <div className="director-row-actions">
            <Button variant="primary" type="submit">
              Save school
            </Button>
            <Button variant="quiet" onClick={() => setShowAdd(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {state.organizations.length === 0 ? (
        <PanelBody>
          <p className="director-empty-copy">
            No schools or clubs yet. Adding a team creates its school or club automatically.
          </p>
        </PanelBody>
      ) : (
        <div className="director-table-wrap">
          <table className="director-table director-school-table">
            <thead>
              <tr>
                <th>School / club</th>
                <th>Location</th>
                <th>Teams</th>
                <th>Status</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {organizations.length > 0 ? (
                organizations.map((organization) => (
                  <OrganizationRow
                    key={organization.id}
                    organization={organization}
                    organizations={state.organizations}
                    teamCount={state.teams.filter((team) => team.organizationId === organization.id).length}
                    controller={controller}
                    onAnnounce={onAnnounce}
                  />
                ))
              ) : (
                <tr className="director-table-empty-row">
                  <td colSpan={5}>
                    <p className="director-empty-copy">No schools or clubs match the current search.</p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function OrganizationRow({
  organization,
  organizations,
  teamCount,
  controller,
  onAnnounce,
}: {
  organization: DirectorState['organizations'][number];
  organizations: DirectorState['organizations'];
  teamCount: number;
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [merging, setMerging] = useState(false);
  const [name, setName] = useState(organization.name);
  const [shortName, setShortName] = useState(organization.shortName ?? '');
  const [city, setCity] = useState(organization.city ?? '');
  const [notes, setNotes] = useState(organization.notes ?? '');
  const [mergeTargetId, setMergeTargetId] = useState('');
  const beginEdit = () => {
    setName(organization.name);
    setShortName(organization.shortName ?? '');
    setCity(organization.city ?? '');
    setNotes(organization.notes ?? '');
    setEditing(true);
    setMerging(false);
  };
  const save = () => {
    if (!name.trim()) {
      onAnnounce(errorNotice('Enter a school or club name first.'));
      return;
    }
    if (!controller.updateOrganization(organization.id, { name, shortName, city, notes })) {
      onAnnounce(errorNotice('School or club changes were not saved; review the Director error.'));
      return;
    }
    setEditing(false);
    onAnnounce(`${name.trim()} updated.`);
  };
  const toggleArchived = () => {
    const archived = organization.archived !== true;
    if (archived && !window.confirm(`Archive ${organization.name}? Historical team links will be retained.`))
      return;
    if (!controller.setOrganizationArchived(organization.id, archived)) {
      onAnnounce(errorNotice('School or club status was not changed; review the Director error.'));
      return;
    }
    onAnnounce(`${organization.name} ${archived ? 'archived' : 'reopened'}.`);
  };
  const merge = () => {
    const target = organizations.find((candidate) => candidate.id === mergeTargetId);
    if (!target) {
      onAnnounce(errorNotice('Choose the school or club record to keep.'));
      return;
    }
    if (
      !window.confirm(
        `Merge ${organization.name} into ${target.name}? ${teamCount} team${teamCount === 1 ? '' : 's'} will be reassigned and the duplicate archived.`,
      )
    )
      return;
    if (!controller.mergeOrganizations(organization.id, target.id)) {
      onAnnounce(errorNotice('Schools or clubs were not merged; review the Director error.'));
      return;
    }
    setMerging(false);
    setMergeTargetId('');
    onAnnounce(`${organization.name} merged into ${target.name}; team links were preserved.`);
  };
  return (
    <>
      <tr className={organization.archived ? 'is-inactive' : undefined}>
        <td>
          <strong>{organization.name}</strong>
          {organization.shortName && (
            <small className="director-table-subtext">Display label: {organization.shortName}</small>
          )}
          {organization.notes && <small className="director-table-subtext">{organization.notes}</small>}
        </td>
        <td>{organization.city || '—'}</td>
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
              aria-label={`Merge ${organization.name}`}
              onClick={() => {
                setMerging((value) => !value);
                setEditing(false);
              }}
            >
              <span>Merge</span>
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
      {(editing || merging) && (
        <tr className="director-table-edit-row">
          <td colSpan={5}>
            {editing ? (
              <form
                className="director-inline-edit"
                onSubmit={(event) => {
                  event.preventDefault();
                  save();
                }}
              >
                <div className="director-form-grid director-school-edit-grid">
                  <FormField label="School / club name">
                    <input value={name} onChange={(event) => setName(event.target.value)} />
                  </FormField>
                  <FormField label="Display label">
                    <input value={shortName} onChange={(event) => setShortName(event.target.value)} />
                  </FormField>
                  <FormField label="City">
                    <input value={city} onChange={(event) => setCity(event.target.value)} />
                  </FormField>
                  <FormField label="School notes">
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
            ) : (
              <div className="director-inline-edit director-merge-school">
                <FormField
                  label={`Merge ${organization.name} into`}
                  hint="All linked teams move to the record you keep. The duplicate remains archived for history."
                >
                  <select value={mergeTargetId} onChange={(event) => setMergeTargetId(event.target.value)}>
                    <option value="">Choose the record to keep</option>
                    {organizations
                      .filter((candidate) => candidate.id !== organization.id && !candidate.archived)
                      .map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>
                          {candidate.name}
                        </option>
                      ))}
                  </select>
                </FormField>
                <div className="director-row-actions">
                  <Button variant="danger" onClick={merge}>
                    Merge and archive duplicate
                  </Button>
                  <Button variant="quiet" onClick={() => setMerging(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function rosterInputs(players: RosterDraft[]): NewPlayerInput[] {
  return players.map((player) => ({
    name: player.name,
    captain: player.captain,
    rosterNumber: player.rosterNumber,
    notes: player.notes,
  }));
}

function validateRosterDrafts(players: RosterDraft[], existingNames = new Set<string>()): string | null {
  const names = new Set(existingNames);
  for (const [index, player] of players.entries()) {
    const name = player.name.trim();
    const hasSecondary =
      player.captain || Boolean(player.rosterNumber.trim()) || Boolean(player.notes.trim());
    if (!name && hasSecondary)
      return `Player row ${index + 1} has roster details but no name. Enter a name or clear that row.`;
    if (!name) continue;
    const key = name.toLocaleLowerCase();
    if (names.has(key)) return `“${name}” is already on this active roster.`;
    names.add(key);
  }
  return null;
}

function parseRosterPaste(value: string): RosterDraft[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name = '', rosterNumber = '', captain = '', notes = ''] = line.split('\t');
      return {
        ...blankRosterDraft(),
        name: name.trim(),
        rosterNumber: rosterNumber.trim(),
        captain: /^(?:captain|c|yes|true|1)$/i.test(captain.trim()),
        notes: notes.trim(),
      };
    });
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
  )
    return 'dropped';
  if (normalized === 'late' || normalized === 'waitlist') return 'waitlist';
  return 'confirmed';
}
