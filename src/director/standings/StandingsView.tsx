import { useState } from 'react';
import {
  derivePlayerStandings,
  deriveTeamStandings,
  totalAcceptedResults,
  type DirectorState,
} from '../domain';
import type { DirectorController } from '../state/useDirectorController';
import {
  ActionMenu,
  DataTable,
  Disclosure,
  EmptyState,
  IdentityCell,
  MenuItem,
  Page,
  PageHeader,
  Panel,
  Segmented,
  Switch,
  type Column,
} from '../components';
import { playerStatsCsv, standingsFileStem, teamStandingsCsv } from '../format/standingsCsv';
import { csvMediaType, downloadText } from '../format/downloadFile';
import {
  UNKNOWN_STAT,
  buildStatsScopes,
  defaultIndividualColumnIds,
  defaultTeamColumnIds,
  hasStoredStatsColumnPrefs,
  individualColumnsForState,
  loadStatsColumnPrefs,
  playerStatCell,
  saveStatsColumnPrefs,
  scopeOptionsFor,
  teamColumnsForState,
  teamStatCell,
  type StatsColumn,
} from './statsDisplay';
import type { AnnounceInput } from '../notices';

type StatsView = 'teams' | 'players';

type TeamStanding = ReturnType<typeof deriveTeamStandings>[number];
type PlayerStanding = ReturnType<typeof derivePlayerStandings>[number];

/**
 * An unknown stays unavailable to assistive tech too: a bare "—" is announced
 * as a dash, which a director could mishear as a zero claim (#750).
 */
function statCell(text: string, column: StatsColumn) {
  if (text !== UNKNOWN_STAT) return text;
  return (
    <>
      {UNKNOWN_STAT}
      <span className="director-visually-hidden">{`${column.label} not available`}</span>
    </>
  );
}

function initialTeamColumns(state: DirectorState): string[] {
  const tournamentId = state.tournament?.id;
  if (hasStoredStatsColumnPrefs(tournamentId)) {
    const applicable = new Set(teamColumnsForState(state).map((column) => column.id));
    return loadStatsColumnPrefs(tournamentId).teams.filter((id) => applicable.has(id));
  }
  return defaultTeamColumnIds(state);
}

function initialIndividualColumns(state: DirectorState): string[] {
  const tournamentId = state.tournament?.id;
  if (hasStoredStatsColumnPrefs(tournamentId)) {
    const applicable = new Set(individualColumnsForState(state).map((column) => column.id));
    return loadStatsColumnPrefs(tournamentId).individuals.filter((id) => applicable.has(id));
  }
  return defaultIndividualColumnIds(state);
}

function teamName(state: DirectorState, teamId: string): string {
  return state.teams.find((team) => team.id === teamId)?.displayName ?? 'Unknown';
}

function teamTableColumns(
  state: DirectorState,
  schema: StatsColumn[],
  rankOf: Map<string, number>,
): Column<TeamStanding>[] {
  return [
    {
      key: 'rank',
      header: '#',
      priority: 1,
      align: 'right',
      render: (standing) => rankOf.get(standing.teamId) ?? '—',
    },
    {
      key: 'team',
      header: 'Team',
      priority: 1,
      render: (standing) => <IdentityCell title={teamName(state, standing.teamId)} />,
    },
    ...schema.map(
      (column): Column<TeamStanding> => ({
        key: column.id,
        header: <span title={column.description}>{column.label}</span>,
        priority: column.priority,
        align: 'right',
        optional: column.priority === 3,
        render: (standing) => statCell(teamStatCell(column.id, standing), column),
      }),
    ),
  ];
}

function playerTableColumns(
  state: DirectorState,
  schema: StatsColumn[],
): Column<PlayerStanding>[] {
  return [
    {
      key: 'player',
      header: 'Player',
      priority: 1,
      render: (standing) => (
        <IdentityCell
          title={state.players.find((player) => player.id === standing.playerId)?.name ?? 'Unknown'}
          detail={teamName(state, standing.teamId)}
        />
      ),
    },
    ...schema.map(
      (column): Column<PlayerStanding> => ({
        key: column.id,
        header: <span title={column.description}>{column.label}</span>,
        priority: column.priority,
        align: 'right',
        optional: column.priority === 3,
        render: (standing) => statCell(playerStatCell(column.id, standing), column),
      }),
    ),
  ];
}

function ColumnChooser({
  schema,
  enabled,
  onChange,
  label,
}: {
  schema: StatsColumn[];
  enabled: string[];
  onChange: (enabled: string[]) => void;
  label: string;
}) {
  const toggleable = schema.filter((column) => column.priority === 3);
  if (toggleable.length === 0) return null;
  const on = new Set(enabled);
  const visible = schema.filter((column) => column.priority < 3 || on.has(column.id)).length;
  return (
    <Disclosure label={label} hint={`${visible} of ${schema.length} shown`}>
      {toggleable.map((column) => (
        <Switch
          key={column.id}
          checked={on.has(column.id)}
          label={column.label}
          hint={column.description}
          onChange={(checked) => {
            onChange(
              checked ? [...enabled, column.id] : enabled.filter((id) => id !== column.id),
            );
          }}
        />
      ))}
    </Disclosure>
  );
}

export function StandingsView({
  state,
  onAnnounce,
}: {
  state: DirectorState;
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
}) {
  const [view, setView] = useState<StatsView>('teams');
  const [scopeId, setScopeId] = useState('overall');
  const [teamCols, setTeamCols] = useState<string[]>(() => initialTeamColumns(state));
  const [playerCols, setPlayerCols] = useState<string[]>(() => initialIndividualColumns(state));

  const teamSchema = teamColumnsForState(state);
  const playerSchema = individualColumnsForState(state);
  const { scopes, showSelector } = buildStatsScopes(state);
  const scope = scopes.find((entry) => entry.id === scopeId) ?? scopes[0] ?? { id: 'overall', label: 'Overall' };
  const scopeOptions = scopeOptionsFor(scope);
  // Both tables derive from the same canonical scope selector: Director never
  // re-scopes or re-derives statistics locally (#750).
  const teamStandings = deriveTeamStandings(state, undefined, scopeOptions);
  const playerStandings = derivePlayerStandings(state, scopeOptions).filter(
    (standing) => standing.gamesPlayed > 0,
  );
  const rankOf = new Map(teamStandings.map((standing, index) => [standing.teamId, index + 1]));

  if (state.teams.length === 0) {
    return (
      <Page>
        <PageHeader title="Standings" description="Derived from accepted game records." />
        <EmptyState
          title="No standings yet"
          description="Add teams and accept results to derive records, scoring, and player statistics."
        />
      </Page>
    );
  }

  const persistTeamCols = (enabled: string[]) => {
    setTeamCols(enabled);
    saveStatsColumnPrefs(state.tournament?.id, { teams: enabled, individuals: playerCols });
  };
  const persistPlayerCols = (enabled: string[]) => {
    setPlayerCols(enabled);
    saveStatsColumnPrefs(state.tournament?.id, { teams: teamCols, individuals: enabled });
  };

  return (
    <Page>
      <PageHeader
        title="Standings"
        description={`${totalAcceptedResults(state)} accepted game${totalAcceptedResults(state) === 1 ? '' : 's'} · ranked using the tournament tiebreak configuration`}
        actions={
          <ActionMenu
            label="Export standings and stats"
            triggerLabel="Export"
            triggerVariant="secondary"
            triggerIcon="download"
          >
            {(close) => (
              <>
                <MenuItem
                  icon="download"
                  onSelect={() => {
                    close();
                    downloadTeamStandings(state, onAnnounce);
                  }}
                >
                  Team standings CSV
                </MenuItem>
                <MenuItem
                  icon="download"
                  onSelect={() => {
                    close();
                    downloadPlayerStats(state, onAnnounce);
                  }}
                >
                  Player stats CSV
                </MenuItem>
              </>
            )}
          </ActionMenu>
        }
      />

      <div className="director-results-toolbar">
        <Segmented<StatsView>
          value={view}
          onChange={setView}
          ariaLabel="Statistics view"
          options={[
            { value: 'teams', label: `Teams ${teamStandings.length}` },
            { value: 'players', label: `Players ${playerStandings.length}` },
          ]}
        />
        {showSelector && (
          <Segmented<string>
            value={scope.id}
            onChange={setScopeId}
            ariaLabel="Statistics scope"
            options={scopes.map((entry) => ({ value: entry.id, label: entry.label }))}
          />
        )}
      </div>

      {view === 'teams' ? (
        <Panel
          title="Team standings"
          description="Rank, team, and record stay visible first; further statistics are optional and stay available in the column chooser."
          flush
        >
          <ColumnChooser
            schema={teamSchema}
            enabled={teamCols}
            onChange={persistTeamCols}
            label="Team columns"
          />
          <DataTable
            items={teamStandings}
            columns={teamTableColumns(state, teamSchema, rankOf)}
            rowKey={(standing) => standing.teamId}
            ariaLabel="Team standings"
            enabledOptionalColumns={teamCols}
            empty={`No accepted results in ${scope.label} yet.`}
          />
        </Panel>
      ) : (
        <Panel
          title="Player statistics"
          description="Accepted games only. Team context stays attached to each player."
          flush
        >
          <ColumnChooser
            schema={playerSchema}
            enabled={playerCols}
            onChange={persistPlayerCols}
            label="Player columns"
          />
          {playerStandings.length === 0 ? (
            <div className="director-empty-in-panel">
              <p className="director-empty-copy">
                Player statistics will appear when accepted results include rosters.
              </p>
            </div>
          ) : (
            <DataTable
              items={playerStandings}
              columns={playerTableColumns(state, playerSchema)}
              rowKey={(standing) => standing.playerId}
              ariaLabel="Player statistics"
              enabledOptionalColumns={playerCols}
            />
          )}
        </Panel>
      )}
    </Page>
  );
}

function downloadTeamStandings(
  state: DirectorState,
  onAnnounce: (announcement: AnnounceInput) => void,
): void {
  downloadText(teamStandingsCsv(state), `${standingsFileStem(state)}-standings.csv`, csvMediaType);
  onAnnounce('Team standings CSV exported.');
}

function downloadPlayerStats(state: DirectorState, onAnnounce: (announcement: AnnounceInput) => void): void {
  downloadText(playerStatsCsv(state), `${standingsFileStem(state)}-player-stats.csv`, csvMediaType);
  onAnnounce('Player statistics CSV exported.');
}
