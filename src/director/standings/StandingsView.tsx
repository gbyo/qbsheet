import { useState } from 'react';
import {
  acceptedGameRecords,
  canonicalCompetitionRanks,
  derivePlayerStandings,
  deriveTeamStandings,
  playerHasAppearance,
  totalAcceptedResults,
  type DirectorState,
} from '../domain';
import { carryoverGames, fieldTeamIds } from '../reports/standingsReport';
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
  orderByFinalPlacement,
  playerRankTies,
  playerStatCell,
  presentationForStats,
  saveStatsColumnPrefs,
  scopeOptionsFor,
  teamClassificationsOf,
  teamColumnsForState,
  teamStatCell,
  tiedTeamIds,
  type StatsColumn,
  type StatsScope,
  type TeamStatContext,
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

function rankCell(rank: number | undefined, tied: boolean) {
  if (rank === undefined) return UNKNOWN_STAT;
  if (!tied) return rank;
  return (
    <>
      <span title="Tied rank">{`${rank}=`}</span>
      <span className="director-visually-hidden">tied</span>
    </>
  );
}

function teamTableColumns(
  state: DirectorState,
  schema: StatsColumn[],
  rankOf: Map<string, number>,
  tied: Set<string>,
  contextFor: (teamId: string) => TeamStatContext,
): Column<TeamStanding>[] {
  return [
    {
      key: 'rank',
      header: '#',
      priority: 1,
      align: 'right',
      render: (standing) => rankCell(rankOf.get(standing.teamId), tied.has(standing.teamId)),
    },
    {
      key: 'team',
      header: 'Team',
      priority: 1,
      render: (standing) => <IdentityCell title={teamName(state, standing.teamId)} />,
    },
    ...schema.map((column): Column<TeamStanding> => ({
      key: column.id,
      header: <span title={column.description}>{column.label}</span>,
      priority: column.priority,
      align: 'right',
      optional: column.priority === 3,
      render: (standing) => statCell(teamStatCell(column.id, standing, contextFor(standing.teamId)), column),
    })),
  ];
}

function playerTableColumns(
  state: DirectorState,
  schema: StatsColumn[],
  rankOf: Map<string, number>,
  tied: Set<string>,
): Column<PlayerStanding>[] {
  const playerById = new Map(state.players.map((player) => [player.id, player]));
  return [
    {
      key: 'rank',
      header: '#',
      priority: 1,
      align: 'right',
      render: (standing) => rankCell(rankOf.get(standing.playerId), tied.has(standing.playerId)),
    },
    {
      key: 'player',
      header: 'Player',
      priority: 1,
      render: (standing) => (
        <IdentityCell
          title={playerById.get(standing.playerId)?.name ?? 'Unknown'}
          detail={teamName(state, standing.teamId)}
        />
      ),
    },
    ...schema.map((column): Column<PlayerStanding> => ({
      key: column.id,
      header: <span title={column.description}>{column.label}</span>,
      priority: column.priority,
      align: 'right',
      optional: column.priority === 3,
      render: (standing) =>
        statCell(playerStatCell(column.id, standing, playerById.get(standing.playerId)), column),
    })),
  ];
}

/**
 * Resolve a stats scope to canonical standings options. Plain scopes filter by
 * phase/pool; a carryover scope reuses the printable composition's carryover game
 * set (plus its field teams); the final scope ranks the full accepted game set
 * and orders rows by explicit placement at render time.
 */
function scopeStandingsOptions(
  state: DirectorState,
  scope: StatsScope,
): { phaseId?: string; poolId?: string; gameIds?: string[]; teamIds?: string[] } {
  if (!scope.carryover || !scope.phaseId) return scopeOptionsFor(scope);
  const phase = state.phases.find((entry) => entry.id === scope.phaseId);
  if (!phase) return scopeOptionsFor(scope);
  const pool = scope.poolId ? state.pools.find((entry) => entry.id === scope.poolId) : undefined;
  return {
    // Canonical game scoping is by scheduled-game identity; resolve the shared
    // carryover game set to the same key the printable composition narrows by.
    gameIds: [...new Set(carryoverGames(state, phase, pool).map((game) => game.scheduledGameId))],
    teamIds: fieldTeamIds(state, phase, pool),
  };
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
            onChange(checked ? [...enabled, column.id] : enabled.filter((id) => id !== column.id));
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
  const statsPresentation = presentationForStats(state);
  const { scopes, showSelector } = buildStatsScopes(state);
  const scope = scopes.find((entry) => entry.id === scopeId) ??
    scopes[0] ?? { id: 'overall', label: 'Overall' };
  const standingsOptions = scopeStandingsOptions(state, scope);
  // Both tables derive from the same canonical scope selectors the printable
  // composition uses: Director never re-scopes or re-derives statistics locally (#750).
  const scopedGames = acceptedGameRecords(state, standingsOptions);
  const calculatedStandings = deriveTeamStandings(state, undefined, standingsOptions);
  const teamStandings = scope.final
    ? orderByFinalPlacement(calculatedStandings, state.tournament?.finalPlacement?.order ?? [])
    : calculatedStandings;
  // Anyone with any appearance qualifies; bare GP > 0 would drop lined players on unknown TUH (#746).
  const playerStandings = derivePlayerStandings(state, standingsOptions).filter(playerHasAppearance);
  // Ranks come from the canonical competition grouping (1, 1, 3 with `=` markers),
  // except under explicit final placement, which is already a total order.
  const rankOf = scope.final
    ? new Map(teamStandings.map((standing, index) => [standing.teamId, index + 1]))
    : canonicalCompetitionRanks(teamStandings, scopedGames, state.tournament?.rules.tiebreakers);
  const tiedRanks = scope.final ? new Set<string>() : tiedTeamIds(rankOf);
  const playerRankOf = new Map(playerStandings.map((standing, index) => [standing.playerId, index + 1]));
  const tiedPlayerRanks = playerRankTies(playerStandings);
  const teamContextFor = (teamId: string): TeamStatContext => ({
    classifications: teamClassificationsOf(state, teamId),
    pointsTossups: statsPresentation.pointsTossups,
  });

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
          description={
            <>
              Rank, team, and record stay visible first; further statistics are optional and stay available in
              the column chooser.
              {statsPresentation.mixedDefinitionNote && (
                <>
                  <br />
                  <span>{statsPresentation.mixedDefinitionNote}</span>
                </>
              )}
            </>
          }
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
            columns={teamTableColumns(state, teamSchema, rankOf, tiedRanks, teamContextFor)}
            rowKey={(standing) => standing.teamId}
            ariaLabel="Team standings"
            enabledOptionalColumns={teamCols}
            empty={`No accepted results in ${scope.label} yet.`}
          />
        </Panel>
      ) : (
        <Panel
          title="Player statistics"
          description={
            <>
              Accepted games only. Team context stays attached to each player.
              {statsPresentation.mixedDefinitionNote && (
                <>
                  <br />
                  <span>{statsPresentation.mixedDefinitionNote}</span>
                </>
              )}
            </>
          }
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
              columns={playerTableColumns(state, playerSchema, playerRankOf, tiedPlayerRanks)}
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
