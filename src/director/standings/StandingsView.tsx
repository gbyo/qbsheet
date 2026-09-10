import { useState } from 'react';
import {
  derivePlayerStandings,
  deriveTeamStandings,
  playerHasAppearance,
  totalAcceptedResults,
  type DirectorState,
} from '../domain';
import type { DirectorController } from '../state/useDirectorController';
import {
  ActionMenu,
  DataTable,
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
import { formatGamesPlayed, formatPlayerPpg, formatWinPct } from './statsDisplay';
import { csvMediaType, downloadText } from '../format/downloadFile';
import type { AnnounceInput } from '../notices';

type StatsView = 'teams' | 'players';

type TeamStanding = ReturnType<typeof deriveTeamStandings>[number];
type PlayerStanding = ReturnType<typeof derivePlayerStandings>[number];

const detailedTeamColumnKeys = ['pf', 'pa', 'powers', 'gets', 'negs'];
const detailedPlayerColumnKeys = ['powers', 'gets', 'negs', 'bonus'];

export function StandingsView({
  state,
  onAnnounce,
}: {
  state: DirectorState;
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
}) {
  const [view, setView] = useState<StatsView>('teams');
  const [showDetailed, setShowDetailed] = useState(false);
  const teamStandings = deriveTeamStandings(state);
  // Anyone with any appearance qualifies; bare GP > 0 would drop lined players on unknown TUH (#746).
  const playerStandings = derivePlayerStandings(state).filter(playerHasAppearance);

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

  const teamColumns: Column<TeamStanding>[] = [
    {
      key: 'rank',
      header: '#',
      priority: 1,
      align: 'right',
      render: (standing) => teamStandings.findIndex((entry) => entry.teamId === standing.teamId) + 1,
    },
    {
      key: 'team',
      header: 'Team',
      priority: 1,
      render: (standing) => (
        <IdentityCell
          title={state.teams.find((team) => team.id === standing.teamId)?.displayName ?? 'Unknown'}
        />
      ),
    },
    {
      key: 'record',
      header: 'W–L',
      priority: 1,
      align: 'right',
      render: (standing) => `${standing.wins}–${standing.losses}${standing.ties ? `–${standing.ties}` : ''}`,
    },
    {
      key: 'winPct',
      header: 'Win %',
      priority: 2,
      align: 'right',
      render: formatWinPct,
    },
    {
      key: 'margin',
      header: 'Margin',
      priority: 2,
      align: 'right',
      render: (standing) => `${standing.margin > 0 ? '+' : ''}${standing.margin}`,
    },
    {
      key: 'pf',
      header: 'PF',
      priority: 3,
      align: 'right',
      optional: true,
      render: (standing) => standing.pointsFor,
    },
    {
      key: 'pa',
      header: 'PA',
      priority: 3,
      align: 'right',
      optional: true,
      render: (standing) => standing.pointsAgainst,
    },
    {
      key: 'powers',
      header: 'Powers',
      priority: 3,
      align: 'right',
      optional: true,
      render: (standing) => standing.powers,
    },
    {
      key: 'gets',
      header: 'Gets',
      priority: 3,
      align: 'right',
      optional: true,
      render: (standing) => standing.gets,
    },
    {
      key: 'negs',
      header: 'Negs',
      priority: 3,
      align: 'right',
      optional: true,
      render: (standing) => standing.negs,
    },
  ];

  const playerColumns: Column<PlayerStanding>[] = [
    {
      key: 'player',
      header: 'Player',
      priority: 1,
      render: (standing) => (
        <IdentityCell
          title={state.players.find((player) => player.id === standing.playerId)?.name ?? 'Unknown'}
          detail={state.teams.find((team) => team.id === standing.teamId)?.displayName ?? 'Unknown team'}
        />
      ),
    },
    {
      key: 'games',
      header: 'Games',
      priority: 1,
      align: 'right',
      render: (standing) => formatGamesPlayed(standing),
    },
    {
      key: 'ppg',
      header: 'PPG',
      priority: 1,
      align: 'right',
      render: (standing) => formatPlayerPpg(standing),
    },
    {
      key: 'powers',
      header: 'Powers',
      priority: 2,
      align: 'right',
      optional: true,
      render: (standing) => standing.powers,
    },
    {
      key: 'gets',
      header: 'Gets',
      priority: 2,
      align: 'right',
      optional: true,
      render: (standing) => standing.gets,
    },
    {
      key: 'negs',
      header: 'Negs',
      priority: 2,
      align: 'right',
      optional: true,
      render: (standing) => standing.negs,
    },
    {
      key: 'bonus',
      header: 'Bonus pts',
      priority: 3,
      align: 'right',
      optional: true,
      render: (standing) => standing.bonusPoints,
    },
  ];

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
        <Switch checked={showDetailed} label="Detailed scoring columns" onChange={setShowDetailed} />
      </div>

      {view === 'teams' ? (
        <Panel
          title="Team standings"
          description="Rank, team, and record stay visible first; detailed scoring columns are optional and stay available when enabled."
          flush
        >
          <DataTable
            items={teamStandings}
            columns={teamColumns}
            rowKey={(standing) => standing.teamId}
            ariaLabel="Team standings"
            enabledOptionalColumns={showDetailed ? detailedTeamColumnKeys : []}
          />
        </Panel>
      ) : (
        <Panel
          title="Player statistics"
          description="Accepted games only. Team context stays attached to each player."
          flush
        >
          {playerStandings.length === 0 ? (
            <div className="director-empty-in-panel">
              <p className="director-empty-copy">
                Player statistics will appear when accepted results include rosters.
              </p>
            </div>
          ) : (
            <DataTable
              items={playerStandings}
              columns={playerColumns}
              rowKey={(standing) => standing.playerId}
              ariaLabel="Player statistics"
              enabledOptionalColumns={showDetailed ? detailedPlayerColumnKeys : []}
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
