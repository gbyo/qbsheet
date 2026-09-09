import { useRef, useMemo, useState } from 'react';
import type { DirectorController, NewPlayerInput } from '../state/useDirectorController';
import { unresolvedScheduledGameForTeam, type DirectorState } from '../domain';
import {
  ActionMenu,
  Button,
  Checkbox,
  Combobox,
  DataTable,
  Dialog,
  DialogSection,
  EmptyState,
  Field,
  FieldGrid,
  IdentityCell,
  MenuFileItem,
  MenuItem,
  NumberInput,
  Page,
  PageHeader,
  Panel,
  SearchField,
  StateLabel,
  TextArea,
  TextInput,
  Toolbar,
  normalizeSearchText,
  useConfirm,
  type Column,
} from '../components';
import { importQbj, importSqbsTeams, importTeamsCsv, type TeamRecord } from '@qbsheet/tournament-formats';
import { toImportedTeamInputs } from './teamImport';
import type { DirectorNavigationTarget } from '../app/navigationTarget';
import { errorNotice, type AnnounceInput } from '../notices';
import { dropTeamFlexibly } from '../state/flexibleEditing';
import { planTeamRestore } from '../domain';

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

export function TeamsView({
  state,
  controller,
  onAnnounce,
  navigationTarget,
  onClearNavigationTarget,
}: {
  state: DirectorState;
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
  navigationTarget?: DirectorNavigationTarget | null;
  onClearNavigationTarget?: () => void;
}) {
  const [search, setSearch] = useState('');
  const [teamDialog, setTeamDialog] = useState<{ mode: 'new' } | { mode: 'edit'; teamId: string } | null>(
    null,
  );
  const [pasteOpen, setPasteOpen] = useState(false);
  const [schoolsOpen, setSchoolsOpen] = useState(false);

  const visibleTeams = useMemo(() => {
    const needle = normalizeSearchText(search.trim());
    return state.teams.filter((team) => {
      if (!needle) return true;
      const players = state.players
        .filter((player) => player.teamId === team.id)
        .map((player) => player.name)
        .join(' ');
      return normalizeSearchText(
        [
          team.displayName,
          organizationNameFor(state, team.organizationId),
          team.teamLetter,
          team.status,
          players,
        ].join(' '),
      ).includes(needle);
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
    if (!result.ok) return;
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

  const columns: Column<DirectorState['teams'][number]>[] = [
    {
      key: 'team',
      header: 'Team',
      priority: 1,
      render: (team) => (
        <IdentityCell
          title={
            <button
              type="button"
              className="director-inline-action director-team-name-action"
              onClick={() => openTeamDialog({ mode: 'edit', teamId: team.id })}
            >
              {team.displayName}
            </button>
          }
          detail={team.teamLetter ? `Team ${team.teamLetter}` : team.notes || undefined}
        />
      ),
    },
    {
      key: 'organization',
      header: 'School / club',
      priority: 2,
      render: (team) => organizationNameFor(state, team.organizationId) || '—',
    },
    {
      key: 'players',
      header: 'Roster',
      priority: 2,
      render: (team) => {
        const activePlayers = state.players.filter(
          (player) => player.teamId === team.id && player.active,
        ).length;
        return `${activePlayers} player${activePlayers === 1 ? '' : 's'}`;
      },
    },
    {
      key: 'status',
      header: 'Status',
      priority: 2,
      render: (team) => (
        <StateLabel
          state={team.status}
          label={
            team.status === 'confirmed' ? 'Confirmed' : team.status === 'waitlist' ? 'Waitlist' : 'Dropped'
          }
        />
      ),
    },
    {
      key: 'actions',
      header: '',
      priority: 1,
      actions: true,
      render: (team) => (
        <TeamActions
          state={state}
          team={team}
          controller={controller}
          onEdit={() => openTeamDialog({ mode: 'edit', teamId: team.id })}
          onAnnounce={onAnnounce}
        />
      ),
    },
  ];

  return (
    <Page>
      <PageHeader
        title="Teams"
        description={`${state.teams.length} team${state.teams.length === 1 ? '' : 's'} · ${state.teams.filter((team) => team.status === 'confirmed').length} confirmed`}
        actions={
          <>
            <Button variant="primary" icon="plus" onClick={() => openTeamDialog({ mode: 'new' })}>
              Add team
            </Button>
            <ActionMenu
              label="Import teams"
              triggerLabel="Import"
              triggerVariant="secondary"
              triggerIcon="upload"
            >
              {(close) => (
                <>
                  <MenuItem
                    icon="edit"
                    onSelect={() => {
                      close();
                      setPasteOpen(true);
                    }}
                  >
                    Paste teams…
                  </MenuItem>
                  <MenuFileItem
                    accept=".csv,text/csv"
                    onFile={(files) => {
                      close();
                      void importCsv(files[0]);
                    }}
                  >
                    CSV file…
                  </MenuFileItem>
                  <MenuFileItem
                    accept=".sqbs,.txt,text/plain"
                    onFile={(files) => {
                      close();
                      void importSqbs(files[0]);
                    }}
                  >
                    SQBS file…
                  </MenuFileItem>
                  <MenuFileItem
                    accept=".qbj,application/json"
                    onFile={(files) => {
                      close();
                      void importQbjRoster(files[0]);
                    }}
                  >
                    QBJ file…
                  </MenuFileItem>
                </>
              )}
            </ActionMenu>
            <Button variant="quiet" onClick={() => setSchoolsOpen(true)}>
              Schools &amp; clubs
            </Button>
          </>
        }
      />

      {state.teams.length === 0 ? (
        <EmptyState title="No teams yet" description="Add a team or import an existing roster.">
          <Button variant="primary" icon="plus" onClick={() => openTeamDialog({ mode: 'new' })}>
            Add first team
          </Button>
        </EmptyState>
      ) : (
        <Panel flush className="director-teams-panel" data-testid="director-teams">
          <Toolbar
            filters={
              <SearchField
                value={search}
                onChange={setSearch}
                label="Filter teams"
                placeholder="Filter by team, school, or player"
              />
            }
            count={
              search.trim()
                ? `${visibleTeams.length} of ${state.teams.length} teams`
                : `${state.teams.length} team${state.teams.length === 1 ? '' : 's'}`
            }
          />
          <DataTable
            items={visibleTeams}
            columns={columns}
            rowKey={(team) => team.id}
            ariaLabel="Teams"
            empty={<p className="director-empty-copy">No teams match the current search.</p>}
          />
        </Panel>
      )}

      {activeTeamDialog && (
        <TeamDialog
          key={activeTeamDialog.mode === 'edit' ? activeTeamDialog.teamId : 'new-team'}
          state={state}
          controller={controller}
          teamId={activeTeamDialog.mode === 'edit' ? activeTeamDialog.teamId : undefined}
          onAnnounce={onAnnounce}
          onClose={closeTeamDialog}
          onCreateOrganization={() => setSchoolsOpen(true)}
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
    </Page>
  );
}

function TeamActions({
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
  const confirmAction = useConfirm();

  const changeStatus = async () => {
    const restorePlan = team.status === 'dropped' ? planTeamRestore(state, team.id) : undefined;
    const affectedGames = state.scheduledGames.filter((game) => {
      const round = state.rounds.find((entry) => entry.id === game.roundId);
      return (
        round?.status !== 'closed' &&
        !game.bye &&
        game.status !== 'cancelled' &&
        game.status !== 'accepted' &&
        (game.leftTeamId === team.id || game.rightTeamId === team.id)
      );
    });
    const operationalGame = unresolvedScheduledGameForTeam(state, team.id);
    if (team.status !== 'dropped' && operationalGame) {
      const round = state.rounds.find((entry) => entry.id === operationalGame.roundId);
      onAnnounce(
        errorNotice(
          `Cannot drop ${team.displayName} while ${round?.name ?? 'the current game'} is unresolved. ` +
            'Accept the result, record a forfeit, or cancel/replay it through recovery first.',
        ),
      );
      return;
    }
    const futureGames = affectedGames.filter((game) => game.status === 'scheduled');
    if (team.status !== 'dropped') {
      const roundNames = [
        ...new Set(
          futureGames
            .map((game) => state.rounds.find((round) => round.id === game.roundId)?.name)
            .filter((name): name is string => Boolean(name)),
        ),
      ];
      const approved = await confirmAction({
        title: `Drop ${team.displayName}?`,
        body: futureGames.length
          ? `${futureGames.length} unstarted game${futureGames.length === 1 ? '' : 's'} in ${roundNames.join(', ') || 'later rounds'} will be reconciled.`
          : 'No unstarted games are currently scheduled for this team.',
        consequence:
          'Completed games remain in tournament history. Future rounds may need regeneration or reconciliation.',
        confirmLabel: 'Drop team',
        tone: 'danger',
      });
      if (!approved) return;
    }
    let changed = false;
    try {
      changed =
        team.status === 'dropped'
          ? controller.restoreTeam(team.id)
          : await dropTeamFlexibly(controller, team.id);
    } catch (reason: unknown) {
      onAnnounce(
        errorNotice(
          reason instanceof Error
            ? `Team status was not changed: ${reason.message}`
            : 'Team status was not changed.',
        ),
      );
      return;
    }
    if (!changed) {
      onAnnounce(errorNotice('Team status was not changed; review the Director error.'));
      return;
    }
    onAnnounce(
      team.status === 'dropped'
        ? `${team.displayName} restored.${restorePlan?.safeGameIds.length ? ` ${restorePlan.safeGameIds.length} drop-cancelled game${restorePlan.safeGameIds.length === 1 ? '' : 's'} reopened.` : ''}${restorePlan?.review.length ? ` ${restorePlan.review.length} game${restorePlan.review.length === 1 ? '' : 's'} need explicit schedule review.` : ''}`
        : `${team.displayName} dropped.${futureGames.length ? ` ${futureGames.length} unstarted game${futureGames.length === 1 ? '' : 's'} reconciled; repair those rounds when ready.` : ''}`,
    );
  };

  return (
    <ActionMenu label={`Actions for ${team.displayName}`} triggerLabel={`Actions for ${team.displayName}`}>
      {(close) => (
        <>
          <MenuItem
            icon="edit"
            onSelect={() => {
              close();
              onEdit();
            }}
          >
            Edit team…
          </MenuItem>
          <MenuItem
            icon={team.status === 'dropped' ? 'undo' : 'x'}
            tone={team.status === 'dropped' ? 'default' : 'danger'}
            onSelect={() => {
              close();
              void changeStatus();
            }}
          >
            {team.status === 'dropped' ? 'Restore team' : 'Drop team'}
          </MenuItem>
        </>
      )}
    </ActionMenu>
  );
}

function TeamDialog({
  state,
  controller,
  teamId,
  onAnnounce,
  onClose,
  onCreateOrganization,
}: {
  state: DirectorState;
  controller: DirectorController;
  teamId?: string;
  onAnnounce: (announcement: AnnounceInput) => void;
  onClose: () => void;
  onCreateOrganization: () => void;
}) {
  const team = teamId ? state.teams.find((entry) => entry.id === teamId) : undefined;
  const [organizationId, setOrganizationId] = useState<string | null>(() => team?.organizationId ?? null);
  const [teamLetter, setTeamLetter] = useState(team?.teamLetter ?? '');
  const [displayName, setDisplayName] = useState(team?.displayName ?? '');
  const [displayNameCustomized, setDisplayNameCustomized] = useState(Boolean(team));
  const [seed, setSeed] = useState(team?.seed == null ? '' : String(team.seed));
  const [notes, setNotes] = useState(team?.notes ?? '');
  /** The roster row that "Add player" just created, so it can take focus once mounted. */
  const pendingFocusKey = useRef<string | null>(null);
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

  const suggestedName = (selectedOrganizationId: string | null, letter: string) => {
    const organization = state.organizations.find((entry) => entry.id === selectedOrganizationId);
    return [organization?.shortName || organization?.name || '', letter.trim()].filter(Boolean).join(' ');
  };

  const organizationOptions = state.organizations
    .filter((organization) => !organization.archived || organization.id === organizationId)
    .map((organization) => ({
      value: organization.id,
      label: organization.shortName ? `${organization.shortName} — ${organization.name}` : organization.name,
      detail: [organization.city, organization.archived ? 'Archived association' : undefined]
        .filter(Boolean)
        .join(' · '),
      disabled: Boolean(organization.archived),
    }));
  const createOrganizationOption = {
    value: '__create-organization__',
    label: 'Create a new school / club…',
    detail: 'Opens Schools & clubs manager',
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
          organizationId,
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
        organizationId,
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
    <Dialog
      title={team ? team.displayName : 'Team and roster'}
      description={team ? 'Edit team details and roster.' : 'Add a team and its initial roster.'}
      size="xl"
      onClose={onClose}
      onSubmit={save}
      submitLabel={team ? 'Save changes' : 'Add team'}
    >
      <DialogSection title="Team details">
        <FieldGrid>
          <Field
            label="School / club"
            hint="Choose an existing organization, or use the explicit create action."
          >
            <Combobox
              value={organizationId ?? ''}
              options={[...organizationOptions, createOrganizationOption]}
              ariaLabel="School / club"
              placeholder="Search schools and clubs…"
              allowClear
              onChange={(value) => {
                if (value === createOrganizationOption.value) {
                  onCreateOrganization();
                  return;
                }
                const nextId = value || null;
                setOrganizationId(nextId);
                if (!displayNameCustomized) setDisplayName(suggestedName(nextId, teamLetter));
              }}
            />
          </Field>
          <Field label="Team letter" optional>
            <TextInput
              value={teamLetter}
              maxLength={4}
              onChange={(event) => {
                setTeamLetter(event.target.value);
                if (!displayNameCustomized) setDisplayName(suggestedName(organizationId, event.target.value));
              }}
            />
          </Field>
          <Field label="Display name">
            <TextInput
              required
              value={displayName}
              onChange={(event) => {
                setDisplayName(event.target.value);
                setDisplayNameCustomized(true);
              }}
            />
          </Field>
          <Field label="Seed" optional hint="Used only by formats that seed teams.">
            <NumberInput min={1} step={1} value={seed} onChange={(event) => setSeed(event.target.value)} />
          </Field>
          <Field label="Notes" optional spanAll>
            <TextInput value={notes} onChange={(event) => setNotes(event.target.value)} />
          </Field>
        </FieldGrid>
      </DialogSection>

      <DialogSection title="Roster" description="Player changes are committed when you save the team.">
        <Field label="Paste player names" hint="One player per line.">
          <TextArea rows={3} value={rosterPaste} onChange={(event) => setRosterPaste(event.target.value)} />
        </Field>
        <Button variant="secondary" type="button" onClick={pasteRoster}>
          Add pasted names
        </Button>
        <div className="director-roster-entry">
          {players
            .filter((player) => !player.removed)
            .map((player, index) => (
              <div className="director-roster-entry-row" key={player.key}>
                <span className="director-roster-entry-number" aria-hidden="true">
                  {index + 1}
                </span>
                <TextInput
                  ref={(node) => {
                    // A row added by "Add player" takes focus, so a keyboard
                    // operator can type the name they pressed the button to
                    // enter instead of tabbing back into the list.
                    if (node && pendingFocusKey.current === player.key) {
                      pendingFocusKey.current = null;
                      node.focus();
                    }
                  }}
                  aria-label={`Player ${index + 1} name`}
                  value={player.name}
                  onChange={(event) => updatePlayer(player.key, { name: event.target.value })}
                  placeholder="Player name"
                />
                <TextInput
                  aria-label={`Player ${index + 1} roster number`}
                  value={player.rosterNumber}
                  onChange={(event) => updatePlayer(player.key, { rosterNumber: event.target.value })}
                  placeholder="No."
                />
                <Checkbox
                  checked={player.captain}
                  label="Captain"
                  ariaLabel={`Player ${index + 1} captain`}
                  onChange={(checked) => updatePlayer(player.key, { captain: checked })}
                />
                {player.id && (
                  <Checkbox
                    checked={player.active}
                    label="Active"
                    ariaLabel={`Player ${index + 1} active`}
                    onChange={(checked) => updatePlayer(player.key, { active: checked })}
                  />
                )}
                <TextInput
                  aria-label={`Player ${index + 1} notes`}
                  value={player.notes}
                  onChange={(event) => updatePlayer(player.key, { notes: event.target.value })}
                  placeholder="Notes"
                />
                <Button
                  variant="quiet"
                  type="button"
                  onClick={() => updatePlayer(player.key, { removed: true })}
                >
                  Remove
                </Button>
              </div>
            ))}
        </div>
        <Button
          variant="quiet"
          type="button"
          icon="plus"
          onClick={() =>
            setPlayers((current) => {
              const draft = newPlayerDraft();
              pendingFocusKey.current = draft.key;
              return [...current, draft];
            })
          }
        >
          Add player
        </Button>
      </DialogSection>
    </Dialog>
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
  const [paste, setPaste] = useState('');
  const importPaste = () => {
    const report = importTeamsCsv(paste);
    if (!report.ok) {
      onAnnounce(
        errorNotice(report.errors.map((entry) => entry.message).join(' ') || 'That CSV is not valid.'),
      );
      return;
    }
    const result = controller.addImportedTeams(toImportedTeamInputs(report.value));
    if (!result.ok) return;
    onAnnounce(
      `${result.inserted} team${result.inserted === 1 ? '' : 's'} imported${result.skipped ? `; ${result.skipped} duplicate${result.skipped === 1 ? '' : 's'} skipped` : ''}.`,
    );
    onClose();
  };
  return (
    <Dialog
      title="Paste teams"
      description="Paste RFC 4180 CSV with a header row. Use team_name, organization_id, and letter for the basic columns."
      size="lg"
      onClose={onClose}
      onSubmit={importPaste}
      submitLabel="Import teams"
    >
      <Field label="Team CSV">
        <TextArea rows={9} value={paste} onChange={(event) => setPaste(event.target.value)} />
      </Field>
    </Dialog>
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
  const [selectedId, setSelectedId] = useState<string | null>(state.organizations[0]?.id ?? null);
  const selected = state.organizations.find((organization) => organization.id === selectedId);
  const [newName, setNewName] = useState('');
  return (
    <Dialog title="Schools & clubs" size="lg" onClose={onClose} cancelLabel="Done">
      <div className="director-organization-workspace">
        <div className="director-organization-list" role="list" aria-label="Schools and clubs">
          {state.organizations.length ? (
            state.organizations.map((organization) => {
              const isSelected = organization.id === selectedId;
              return (
                <div key={organization.id} role="listitem">
                  <button
                    type="button"
                    className="director-organization-list-item"
                    data-selected={isSelected || undefined}
                    aria-current={isSelected ? 'true' : undefined}
                    onClick={() => setSelectedId(organization.id)}
                  >
                    <strong>{organization.name}</strong>
                    {organization.archived && <StateLabel state="archived" label="Archived" />}
                  </button>
                </div>
              );
            })
          ) : (
            <p className="director-empty-copy">No schools or clubs yet.</p>
          )}
        </div>
        <div className="director-organization-editor-pane">
          {selected ? (
            <OrganizationEditor
              key={selected.id}
              organization={selected}
              controller={controller}
              onAnnounce={onAnnounce}
            />
          ) : null}
          <DialogSection title="Add school or club">
            <Field label="Name">
              <TextInput value={newName} onChange={(event) => setNewName(event.target.value)} />
            </Field>
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
          </DialogSection>
        </div>
      </div>
    </Dialog>
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
      className="director-stack"
      onSubmit={(event) => {
        event.preventDefault();
        if (controller.updateOrganization(organization.id, { name, shortName, city, notes }))
          onAnnounce(`${name.trim()} updated.`);
      }}
    >
      <DialogSection title="School or club details">
        <FieldGrid>
          <Field label="Name">
            <TextInput value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label="Short name" optional>
            <TextInput value={shortName} onChange={(event) => setShortName(event.target.value)} />
          </Field>
          <Field label="City" optional>
            <TextInput value={city} onChange={(event) => setCity(event.target.value)} />
          </Field>
          <Field label="Notes" optional>
            <TextInput value={notes} onChange={(event) => setNotes(event.target.value)} />
          </Field>
        </FieldGrid>
        <div className="director-form-actions">
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
          <Button variant="primary" type="submit">
            Save
          </Button>
        </div>
      </DialogSection>
    </form>
  );
}

function organizationNameFor(state: DirectorState, organizationId: string | null): string {
  if (!organizationId) return '';
  return state.organizations.find((organization) => organization.id === organizationId)?.name ?? '';
}
