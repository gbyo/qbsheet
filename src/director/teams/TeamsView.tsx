import { useEffect, useMemo, useRef, useState } from 'react';
import type { DirectorController, NewPlayerInput } from '../state/useDirectorController';
import type { DirectorState } from '../domain';
import { Button, EmptyState, FormField, PanelBody, PanelFooter, StateLabel } from '../components/Controls';
import { DirectorMenu } from '../components/DirectorMenu';
import { PageHeader } from '../components/PageHeader';
import { importQbj, importSqbsTeams, importTeamsCsv, type TeamRecord } from '@qbsheet/tournament-formats';
import { toImportedTeamInputs } from './teamImport';
import type { DirectorNavigationTarget } from '../app/navigationTarget';
import { errorNotice, type AnnounceInput } from '../notices';
import { dropTeamFlexibly } from '../state/flexibleEditing';

interface PlayerDraft {
  key: string;
  id?: string;
  name: string;
  captain: boolean;
  active: boolean;
  rosterNumber: string;
  notes: string;
  removed?: boolean;
}

function newPlayerDraft(): PlayerDraft {
  return {
    key: `new-${crypto.randomUUID()}`,
    name: '',
    captain: false,
    active: true,
    rosterNumber: '',
    notes: '',
  };
}

const dialogStyle = {
  width: 'min(960px, calc(100vw - 32px))',
  maxWidth: 960,
  maxHeight: 'calc(100vh - 32px)',
  overflow: 'auto',
};

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
  const [teamDialog, setTeamDialog] = useState<{ mode: 'new' } | { mode: 'edit'; teamId: string } | null>(
    null,
  );
  const [pasteOpen, setPasteOpen] = useState(false);
  const [schoolsOpen, setSchoolsOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const importOpenerRef = useRef<HTMLElement | null>(null);
  const csvInputRef = useRef<HTMLInputElement>(null);
  const sqbsInputRef = useRef<HTMLInputElement>(null);
  const qbjInputRef = useRef<HTMLInputElement>(null);

  const visibleTeams = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return state.teams.filter((team) => {
      if (!needle) return true;
      return [team.displayName, organizationNameFor(state, team.organizationId), team.teamLetter, team.status]
        .join(' ')
        .toLocaleLowerCase()
        .includes(needle);
    });
  }, [search, state]);

  const navigationTeamId =
    navigationTarget?.section === 'teams'
      ? navigationTarget.entityType === 'player'
        ? navigationTarget.parentId
        : navigationTarget.entityId
      : undefined;
  const activeTeamDialog =
    navigationTeamId && state.teams.some((team) => team.id === navigationTeamId)
      ? { mode: 'edit' as const, teamId: navigationTeamId }
      : teamDialog;
  const openTeamDialog = (dialog: NonNullable<typeof teamDialog>) => {
    onClearNavigationTarget?.();
    setTeamDialog(dialog);
  };
  const closeTeamDialog = () => {
    onClearNavigationTarget?.();
    setTeamDialog(null);
  };

  const addImportedRows = (teams: TeamRecord[], warningCount: number) => {
    const result = controller.addImportedTeams(toImportedTeamInputs(teams));
    const duplicate = result.skipped
      ? ` ${result.skipped} duplicate${result.skipped === 1 ? '' : 's'} skipped.`
      : '';
    const warnings = warningCount ? ` ${warningCount} warning${warningCount === 1 ? '' : 's'} retained.` : '';
    onAnnounce(`${result.inserted} team${result.inserted === 1 ? '' : 's'} imported.${duplicate}${warnings}`);
  };

  const importCsv = async (file?: File) => {
    if (!file) return;
    try {
      const report = importTeamsCsv(await file.text());
      if (!report.ok) {
        onAnnounce(
          errorNotice(report.errors.map((entry) => entry.message).join(' ') || 'That CSV is not valid.'),
        );
        return;
      }
      addImportedRows(report.value, report.warnings.length);
    } catch (reason: unknown) {
      onAnnounce(errorNotice(reason instanceof Error ? reason.message : 'That CSV could not be read.'));
    }
  };

  const importSqbs = async (file?: File) => {
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
      addImportedRows(report.value, report.warnings.length);
    } catch (reason: unknown) {
      onAnnounce(errorNotice(reason instanceof Error ? reason.message : 'That SQBS file could not be read.'));
    }
  };

  const importQbjRoster = async (file?: File) => {
    if (!file) return;
    try {
      const report = importQbj(await file.text());
      if (!report.ok) {
        onAnnounce(
          errorNotice(report.errors.map((entry) => entry.message).join(' ') || 'That QBJ file is not valid.'),
        );
        return;
      }
      addImportedRows(report.value.tournament.teams, report.warnings.length);
    } catch (reason: unknown) {
      onAnnounce(errorNotice(reason instanceof Error ? reason.message : 'That QBJ file could not be read.'));
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
            <Button variant="primary" icon="plus" onClick={() => openTeamDialog({ mode: 'new' })}>
              Add team
            </Button>
            <span
              ref={(node) => {
                importOpenerRef.current = node;
              }}
            >
              <Button
                variant="secondary"
                icon="upload"
                aria-haspopup="menu"
                aria-expanded={importOpen}
                onClick={() => setImportOpen((open) => !open)}
              >
                Import
              </Button>
            </span>
            {importOpen && (
              <DirectorMenu
                label="Import teams"
                openerRef={importOpenerRef}
                onClose={() => setImportOpen(false)}
              >
                <button
                  type="button"
                  role="menuitem"
                  className="director-menu-item"
                  onClick={() => {
                    setImportOpen(false);
                    setPasteOpen(true);
                  }}
                >
                  Paste teams…
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="director-menu-item"
                  onClick={() => {
                    setImportOpen(false);
                    csvInputRef.current?.click();
                  }}
                >
                  CSV file…
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="director-menu-item"
                  onClick={() => {
                    setImportOpen(false);
                    sqbsInputRef.current?.click();
                  }}
                >
                  SQBS file…
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="director-menu-item"
                  onClick={() => {
                    setImportOpen(false);
                    qbjInputRef.current?.click();
                  }}
                >
                  QBJ file…
                </button>
              </DirectorMenu>
            )}
            <Button variant="quiet" onClick={() => setSchoolsOpen(true)}>
              Schools &amp; clubs
            </Button>
            <input
              ref={csvInputRef}
              className="director-visually-hidden-input"
              type="file"
              accept=".csv,text/csv"
              onChange={(event) => {
                void importCsv(event.target.files?.[0]);
                event.currentTarget.value = '';
              }}
            />
            <input
              ref={sqbsInputRef}
              className="director-visually-hidden-input"
              type="file"
              accept=".sqbs,.txt,text/plain"
              onChange={(event) => {
                void importSqbs(event.target.files?.[0]);
                event.currentTarget.value = '';
              }}
            />
            <input
              ref={qbjInputRef}
              className="director-visually-hidden-input"
              type="file"
              accept=".qbj,application/json"
              onChange={(event) => {
                void importQbjRoster(event.target.files?.[0]);
                event.currentTarget.value = '';
              }}
            />
          </>
        }
      />

      <datalist id="director-school-options">
        {state.organizations
          .filter((organization) => !organization.archived)
          .map((organization) => (
            <option key={organization.id} value={organization.name} />
          ))}
      </datalist>

      <div className="director-page-stack">
        {state.teams.length === 0 ? (
          <EmptyState title="No teams yet" description="Add a team or import an existing roster.">
            <Button variant="primary" icon="plus" onClick={() => openTeamDialog({ mode: 'new' })}>
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
                  {visibleTeams.length ? (
                    visibleTeams.map((team) => (
                      <TeamRow
                        key={team.id}
                        state={state}
                        team={team}
                        controller={controller}
                        onEdit={() => openTeamDialog({ mode: 'edit', teamId: team.id })}
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

      {activeTeamDialog && (
        <TeamDialog
          key={activeTeamDialog.mode === 'edit' ? activeTeamDialog.teamId : 'new-team'}
          state={state}
          controller={controller}
          teamId={activeTeamDialog.mode === 'edit' ? activeTeamDialog.teamId : undefined}
          onAnnounce={onAnnounce}
          onClose={closeTeamDialog}
        />
      )}
      {pasteOpen && (
        <PasteTeamsDialog
          controller={controller}
          onAnnounce={onAnnounce}
          onClose={() => setPasteOpen(false)}
        />
      )}
      {schoolsOpen && (
        <SchoolsDialog
          state={state}
          controller={controller}
          onAnnounce={onAnnounce}
          onClose={() => setSchoolsOpen(false)}
        />
      )}
    </>
  );
}

function TeamRow({
  state,
  team,
  controller,
  onEdit,
  onAnnounce,
}: {
  state: DirectorState;
  team: DirectorState['teams'][number];
  controller: DirectorController;
  onEdit: () => void;
  onAnnounce: (announcement: AnnounceInput) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const openerRef = useRef<HTMLElement | null>(null);
  const players = state.players.filter((player) => player.teamId === team.id);
  const activePlayers = players.filter((player) => player.active).length;
  return (
    <tr>
      <td>
        <button type="button" className="director-inline-action" onClick={onEdit}>
          <strong>{team.displayName}</strong>
        </button>
        {team.teamLetter && <small className="director-table-subtext">Team {team.teamLetter}</small>}
        {team.notes && <small className="director-table-subtext">{team.notes}</small>}
      </td>
      <td>{organizationNameFor(state, team.organizationId) || '—'}</td>
      <td>
        <button type="button" className="director-inline-action" onClick={onEdit}>
          {activePlayers} player{activePlayers === 1 ? '' : 's'}
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
        <span
          ref={(node) => {
            openerRef.current = node;
          }}
        >
          <button
            type="button"
            className="director-button director-button-quiet director-table-action"
            aria-label={`Actions for ${team.displayName}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span aria-hidden="true">•••</span>
          </button>
        </span>
        {menuOpen && (
          <DirectorMenu
            label={`Actions for ${team.displayName}`}
            openerRef={openerRef}
            onClose={() => setMenuOpen(false)}
          >
            <button
              type="button"
              role="menuitem"
              className="director-menu-item"
              onClick={() => {
                setMenuOpen(false);
                onEdit();
              }}
            >
              Edit team…
            </button>
            <button
              type="button"
              role="menuitem"
              className="director-menu-item"
              onClick={async () => {
                setMenuOpen(false);
                const affected = state.scheduledGames.filter((game) => {
                  const round = state.rounds.find((entry) => entry.id === game.roundId);
                  return (
                    round?.status !== 'closed' &&
                    !game.bye &&
                    game.status !== 'cancelled' &&
                    game.status !== 'accepted' &&
                    (game.leftTeamId === team.id || game.rightTeamId === team.id)
                  );
                }).length;
                const changed =
                  team.status === 'dropped'
                    ? controller.restoreTeam(team.id)
                    : await dropTeamFlexibly(controller, team.id);
                if (!changed) {
                  onAnnounce(errorNotice('Team status was not changed; review the Director error.'));
                  return;
                }
                onAnnounce(
                  team.status === 'dropped'
                    ? `${team.displayName} restored. Future pool or round assignments can now be repaired as needed.`
                    : `${team.displayName} dropped.${affected ? ` ${affected} future game${affected === 1 ? '' : 's'} cancelled; repair those rounds when ready.` : ''}`,
                );
              }}
            >
              {team.status === 'dropped' ? 'Restore team' : 'Drop team'}
            </button>
          </DirectorMenu>
        )}
      </td>
    </tr>
  );
}

function TeamDialog({
  state,
  controller,
  teamId,
  onAnnounce,
  onClose,
}: {
  state: DirectorState;
  controller: DirectorController;
  teamId?: string;
  onAnnounce: (announcement: AnnounceInput) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const team = teamId ? state.teams.find((entry) => entry.id === teamId) : undefined;
  const [organizationName, setOrganizationName] = useState(() =>
    team ? organizationNameFor(state, team.organizationId) : '',
  );
  const [teamLetter, setTeamLetter] = useState(team?.teamLetter ?? '');
  const [displayName, setDisplayName] = useState(team?.displayName ?? '');
  const [displayNameCustomized, setDisplayNameCustomized] = useState(Boolean(team));
  const [seed, setSeed] = useState(team?.seed == null ? '' : String(team.seed));
  const [notes, setNotes] = useState(team?.notes ?? '');
  const [players, setPlayers] = useState<PlayerDraft[]>(() => {
    const existing = team
      ? state.players
          .filter((player) => player.teamId === team.id)
          .map((player) => ({
            key: player.id,
            id: player.id,
            name: player.name,
            captain: player.captain,
            active: player.active,
            rosterNumber: player.rosterNumber == null ? '' : String(player.rosterNumber),
            notes: player.notes ?? '',
          }))
      : [];
    return [...existing, ...Array.from({ length: Math.max(2, 5 - existing.length) }, newPlayerDraft)];
  });
  const [rosterPaste, setRosterPaste] = useState('');

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    const cancel = (event: Event) => {
      event.preventDefault();
      onClose();
    };
    dialog.addEventListener('cancel', cancel);
    return () => dialog.removeEventListener('cancel', cancel);
  }, [onClose]);

  const suggestedName = (school: string, letter: string) => {
    const organization = state.organizations.find(
      (entry) =>
        !entry.archived && entry.name.trim().toLocaleLowerCase() === school.trim().toLocaleLowerCase(),
    );
    return [organization?.shortName || school.trim(), letter.trim()].filter(Boolean).join(' ');
  };

  const updatePlayer = (key: string, changes: Partial<PlayerDraft>) => {
    setPlayers((current) =>
      current.map((player) => {
        if (changes.captain && player.key !== key) return { ...player, captain: false };
        return player.key === key ? { ...player, ...changes } : player;
      }),
    );
  };

  const pasteRoster = () => {
    const names = rosterPaste
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (!names.length) {
      onAnnounce(errorNotice('Paste at least one player name.'));
      return;
    }
    setPlayers((current) => [
      ...current.filter((player) => player.id || !player.removed),
      ...names.map((name) => ({ ...newPlayerDraft(), name })),
    ]);
    setRosterPaste('');
  };

  const save = () => {
    const name = displayName.trim();
    if (!name) {
      onAnnounce(errorNotice('Enter a display name first.'));
      return;
    }
    const parsedSeed = seed.trim() ? Number(seed) : null;
    if (parsedSeed !== null && (!Number.isInteger(parsedSeed) || parsedSeed < 1)) {
      onAnnounce(errorNotice('Seed must be a positive whole number or blank.'));
      return;
    }
    const activeNames = players
      .filter((player) => !player.removed && player.name.trim())
      .map((player) => player.name.trim().toLocaleLowerCase());
    if (new Set(activeNames).size !== activeNames.length) {
      onAnnounce(errorNotice('The active roster contains duplicate player names.'));
      return;
    }

    if (!team) {
      const initialPlayers: NewPlayerInput[] = players
        .filter((player) => !player.removed && player.name.trim())
        .map((player) => ({
          name: player.name.trim(),
          captain: player.captain,
          rosterNumber: player.rosterNumber.trim() || undefined,
          notes: player.notes.trim() || undefined,
        }));
      if (
        !controller.addTeam({
          displayName: name,
          organizationName,
          teamLetter,
          seed: parsedSeed,
          notes,
          players: initialPlayers,
        })
      ) {
        onAnnounce(errorNotice('Team and roster were not saved; review the Director error.'));
        return;
      }
      onAnnounce(
        `${name} added with ${initialPlayers.length} player${initialPlayers.length === 1 ? '' : 's'}.`,
      );
      onClose();
      return;
    }

    if (
      !controller.updateTeam(team.id, {
        displayName: name,
        organizationName,
        teamLetter,
        seed: parsedSeed,
        notes,
      })
    ) {
      onAnnounce(errorNotice('Team details were not saved; review the Director error.'));
      return;
    }
    for (const player of players) {
      if (player.id) {
        if (player.removed) {
          if (!controller.removePlayer(player.id)) {
            onAnnounce(
              errorNotice(`Could not remove ${player.name || 'that player'}; review the Director error.`),
            );
            return;
          }
        } else if (
          !controller.updatePlayer(player.id, {
            name: player.name,
            captain: player.captain,
            active: player.active,
            rosterNumber: player.rosterNumber || undefined,
            notes: player.notes || undefined,
          })
        ) {
          onAnnounce(
            errorNotice(`Could not save ${player.name || 'that player'}; review the Director error.`),
          );
          return;
        }
      } else if (!player.removed && player.name.trim()) {
        if (
          !controller.addPlayer(
            team.id,
            player.name,
            player.captain,
            player.rosterNumber || undefined,
            player.notes || undefined,
          )
        ) {
          onAnnounce(errorNotice(`Could not add ${player.name}; review the Director error.`));
          return;
        }
      }
    }
    onAnnounce(`${name} updated.`);
    onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      className="director-operator-dialog"
      style={dialogStyle}
      aria-labelledby="team-dialog-title"
    >
      <div className="director-help-dialog-header">
        <div>
          <p className="director-eyebrow">{team ? 'Edit team' : 'New team'}</p>
          <h2 id="team-dialog-title">{team ? team.displayName : 'Team and roster'}</h2>
        </div>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <PanelBody>
          <fieldset className="director-fieldset">
            <legend>Team details</legend>
            <div className="director-form-grid director-team-registration-grid">
              <FormField label="School / club">
                <input
                  list="director-school-options"
                  value={organizationName}
                  onChange={(event) => {
                    setOrganizationName(event.target.value);
                    if (!displayNameCustomized) setDisplayName(suggestedName(event.target.value, teamLetter));
                  }}
                />
              </FormField>
              <FormField label="Team letter">
                <input
                  value={teamLetter}
                  maxLength={4}
                  onChange={(event) => {
                    setTeamLetter(event.target.value);
                    if (!displayNameCustomized)
                      setDisplayName(suggestedName(organizationName, event.target.value));
                  }}
                />
              </FormField>
              <FormField label="Display name">
                <input
                  required
                  value={displayName}
                  onChange={(event) => {
                    setDisplayName(event.target.value);
                    setDisplayNameCustomized(true);
                  }}
                />
              </FormField>
              <FormField label="Seed">
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={seed}
                  onChange={(event) => setSeed(event.target.value)}
                />
              </FormField>
              <FormField label="Notes">
                <input value={notes} onChange={(event) => setNotes(event.target.value)} />
              </FormField>
            </div>
          </fieldset>

          <fieldset className="director-fieldset director-roster-fieldset">
            <legend>Roster</legend>
            <div className="director-form-grid director-form-grid-two">
              <FormField label="Paste player names" hint="One player per line.">
                <textarea
                  className="director-textarea"
                  rows={3}
                  value={rosterPaste}
                  onChange={(event) => setRosterPaste(event.target.value)}
                />
              </FormField>
              <div className="director-row-actions">
                <Button variant="secondary" type="button" onClick={pasteRoster}>
                  Add pasted names
                </Button>
              </div>
            </div>
            <div className="director-roster-entry">
              {players
                .filter((player) => !player.removed)
                .map((player, index) => (
                  <div className="director-roster-entry-row" key={player.key}>
                    <span className="director-roster-entry-number" aria-hidden="true">
                      {index + 1}
                    </span>
                    <label className="director-roster-name-field">
                      <span className="director-visually-hidden">Player {index + 1} name</span>
                      <input
                        value={player.name}
                        onChange={(event) => updatePlayer(player.key, { name: event.target.value })}
                        placeholder="Player name"
                      />
                    </label>
                    <label className="director-roster-number-field">
                      <span className="director-visually-hidden">Roster number</span>
                      <input
                        value={player.rosterNumber}
                        onChange={(event) => updatePlayer(player.key, { rosterNumber: event.target.value })}
                        placeholder="No."
                      />
                    </label>
                    <label className="director-checkbox-field director-roster-captain-field">
                      <input
                        type="checkbox"
                        checked={player.captain}
                        onChange={(event) => updatePlayer(player.key, { captain: event.target.checked })}
                      />
                      <span>Captain</span>
                    </label>
                    {player.id && (
                      <label className="director-checkbox-field">
                        <input
                          type="checkbox"
                          checked={player.active}
                          onChange={(event) => updatePlayer(player.key, { active: event.target.checked })}
                        />
                        <span>Active</span>
                      </label>
                    )}
                    <label className="director-roster-notes-field">
                      <span className="director-visually-hidden">Player notes</span>
                      <input
                        value={player.notes}
                        onChange={(event) => updatePlayer(player.key, { notes: event.target.value })}
                        placeholder="Notes"
                      />
                    </label>
                    <button
                      type="button"
                      className="director-inline-action"
                      onClick={() => updatePlayer(player.key, { removed: true })}
                    >
                      Remove
                    </button>
                  </div>
                ))}
            </div>
            <Button
              variant="quiet"
              type="button"
              icon="plus"
              onClick={() => {
                setPlayers((current) => [...current, newPlayerDraft()]);
                requestAnimationFrame(() => {
                  const fields = dialogRef.current?.querySelectorAll<HTMLInputElement>(
                    '.director-roster-name-field input',
                  );
                  fields?.[fields.length - 1]?.focus();
                });
              }}
            >
              Add player
            </Button>
          </fieldset>
        </PanelBody>
        <PanelFooter className="director-form-actions">
          <Button variant="primary" type="submit">
            {team ? 'Save changes' : 'Add team'}
          </Button>
          <span className="director-muted">
            Editing stays in this dialog; the team list never shifts underneath you.
          </span>
        </PanelFooter>
      </form>
    </dialog>
  );
}

function PasteTeamsDialog({
  controller,
  onAnnounce,
  onClose,
}: {
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [paste, setPaste] = useState('');
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    const cancel = (event: Event) => {
      event.preventDefault();
      onClose();
    };
    dialog.addEventListener('cancel', cancel);
    return () => dialog.removeEventListener('cancel', cancel);
  }, [onClose]);
  const importPaste = () => {
    const report = importTeamsCsv(paste);
    if (!report.ok) {
      onAnnounce(
        errorNotice(report.errors.map((entry) => entry.message).join(' ') || 'That CSV is not valid.'),
      );
      return;
    }
    const result = controller.addImportedTeams(toImportedTeamInputs(report.value));
    onAnnounce(
      `${result.inserted} team${result.inserted === 1 ? '' : 's'} imported${result.skipped ? `; ${result.skipped} duplicate${result.skipped === 1 ? '' : 's'} skipped` : ''}.`,
    );
    onClose();
  };
  return (
    <dialog
      ref={dialogRef}
      className="director-operator-dialog"
      style={dialogStyle}
      aria-labelledby="paste-teams-title"
    >
      <div className="director-help-dialog-header">
        <div>
          <p className="director-eyebrow">Import</p>
          <h2 id="paste-teams-title">Paste teams</h2>
        </div>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          importPaste();
        }}
      >
        <PanelBody>
          <p className="director-panel-description">
            Paste RFC 4180 CSV with a header row. Use <code>team_name</code>, <code>organization_id</code>,
            and <code>letter</code> for the basic columns.
          </p>
          <textarea
            className="director-textarea"
            rows={9}
            value={paste}
            onChange={(event) => setPaste(event.target.value)}
            aria-label="Team CSV"
          />
        </PanelBody>
        <PanelFooter>
          <Button variant="primary" type="submit">
            Import teams
          </Button>
        </PanelFooter>
      </form>
    </dialog>
  );
}

function SchoolsDialog({
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
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(state.organizations[0]?.id ?? null);
  const selected = state.organizations.find((organization) => organization.id === selectedId);
  const [newName, setNewName] = useState('');
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    const cancel = (event: Event) => {
      event.preventDefault();
      onClose();
    };
    dialog.addEventListener('cancel', cancel);
    return () => dialog.removeEventListener('cancel', cancel);
  }, [onClose]);
  return (
    <dialog
      ref={dialogRef}
      className="director-operator-dialog"
      style={dialogStyle}
      aria-labelledby="schools-title"
    >
      <div className="director-help-dialog-header">
        <div>
          <p className="director-eyebrow">Teams</p>
          <h2 id="schools-title">Schools &amp; clubs</h2>
        </div>
        <Button variant="secondary" onClick={onClose}>
          Done
        </Button>
      </div>
      <PanelBody>
        <div className="director-form-grid director-form-grid-two">
          <div>
            {state.organizations.length ? (
              state.organizations.map((organization) => (
                <button
                  key={organization.id}
                  type="button"
                  className="director-inline-action"
                  onClick={() => setSelectedId(organization.id)}
                >
                  {organization.name}
                  {organization.archived ? ' · archived' : ''}
                </button>
              ))
            ) : (
              <p className="director-empty-copy">No schools or clubs yet.</p>
            )}
          </div>
          <div>
            {selected ? (
              <OrganizationEditor
                key={selected.id}
                organization={selected}
                controller={controller}
                onAnnounce={onAnnounce}
              />
            ) : null}
            <hr />
            <FormField label="Add school or club">
              <input value={newName} onChange={(event) => setNewName(event.target.value)} />
            </FormField>
            <Button
              variant="secondary"
              type="button"
              onClick={() => {
                if (!newName.trim()) return;
                if (controller.addOrganization({ name: newName })) {
                  onAnnounce(`${newName.trim()} added.`);
                  setNewName('');
                }
              }}
            >
              Add
            </Button>
          </div>
        </div>
      </PanelBody>
    </dialog>
  );
}

function OrganizationEditor({
  organization,
  controller,
  onAnnounce,
}: {
  organization: DirectorState['organizations'][number];
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
}) {
  const [name, setName] = useState(organization.name);
  const [shortName, setShortName] = useState(organization.shortName ?? '');
  const [city, setCity] = useState(organization.city ?? '');
  const [notes, setNotes] = useState(organization.notes ?? '');
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (controller.updateOrganization(organization.id, { name, shortName, city, notes }))
          onAnnounce(`${name.trim()} updated.`);
      }}
    >
      <div className="director-form-grid director-form-grid-two">
        <FormField label="Name">
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </FormField>
        <FormField label="Short name">
          <input value={shortName} onChange={(event) => setShortName(event.target.value)} />
        </FormField>
        <FormField label="City">
          <input value={city} onChange={(event) => setCity(event.target.value)} />
        </FormField>
        <FormField label="Notes">
          <input value={notes} onChange={(event) => setNotes(event.target.value)} />
        </FormField>
      </div>
      <div className="director-row-actions">
        <Button variant="primary" type="submit">
          Save
        </Button>
        <Button
          variant="quiet"
          type="button"
          onClick={() => {
            const archived = !organization.archived;
            if (controller.setOrganizationArchived(organization.id, archived))
              onAnnounce(`${organization.name} ${archived ? 'archived' : 'restored'}.`);
          }}
        >
          {organization.archived ? 'Restore' : 'Archive'}
        </Button>
      </div>
    </form>
  );
}

function organizationNameFor(state: DirectorState, organizationId: string | null): string {
  if (!organizationId) return '';
  return state.organizations.find((organization) => organization.id === organizationId)?.name ?? '';
}
