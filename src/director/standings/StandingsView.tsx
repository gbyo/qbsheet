import {
  derivePlayerStandings,
  deriveTeamStandings,
  totalAcceptedResults,
  type DirectorState,
} from '../domain';
import type { DirectorController } from '../state/useDirectorController';
import { Button, EmptyState } from '../components/Controls';
import { PageHeader } from '../components/PageHeader';
import { csvCell } from '@qbsheet/tournament-formats';

export function StandingsView({
  state,
  onAnnounce,
}: {
  state: DirectorState;
  controller: DirectorController;
  onAnnounce: (message: string) => void;
}) {
  const teamStandings = deriveTeamStandings(state);
  const playerStandings = derivePlayerStandings(state)
    .filter((standing) => standing.gamesPlayed > 0)
    .slice(0, 10);
  return (
    <>
      <PageHeader
        eyebrow="Review"
        title="Standings & stats"
        description="Derived from accepted game records and the tournament tiebreak configuration."
        actions={
          <Button variant="secondary" icon="download" onClick={() => downloadCsv(state, onAnnounce)}>
            Export CSV
          </Button>
        }
      />
      <div className="director-page-stack">
        {state.teams.length === 0 ? (
          <EmptyState
            title="No standings yet"
            description="Add teams and accept results to derive records, scoring, and player statistics."
          />
        ) : (
          <>
            <section className="director-panel">
              <div className="director-panel-heading">
                <div>
                  <p className="director-eyebrow">Team standings</p>
                  <h2>{teamStandings.length} teams</h2>
                </div>
                <span className="director-muted">{totalAcceptedResults(state)} accepted games</span>
              </div>
              <div className="director-table-wrap">
                <table className="director-table director-standings-table">
                  <thead>
                    <tr>
                      <th scope="col">#</th>
                      <th scope="col">Team</th>
                      <th scope="col">W–L</th>
                      <th scope="col">Win %</th>
                      <th scope="col">PF</th>
                      <th scope="col">PA</th>
                      <th scope="col">Margin</th>
                      <th scope="col">Powers</th>
                      <th scope="col">Gets</th>
                      <th scope="col">Negs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {teamStandings.map((standing, index) => (
                      <tr key={standing.teamId}>
                        <td className="director-number-cell">{index + 1}</td>
                        <td>
                          <strong>
                            {state.teams.find((team) => team.id === standing.teamId)?.displayName ??
                              'Unknown'}
                          </strong>
                        </td>
                        <td className="director-record-cell director-number-cell">
                          {standing.wins}–{standing.losses}
                          {standing.ties ? `–${standing.ties}` : ''}
                        </td>
                        <td className="director-number-cell">{(standing.winPercentage * 100).toFixed(1)}%</td>
                        <td className="director-number-cell">{standing.pointsFor}</td>
                        <td className="director-number-cell">{standing.pointsAgainst}</td>
                        <td className="director-number-cell">
                          {standing.margin > 0 ? '+' : ''}
                          {standing.margin}
                        </td>
                        <td className="director-number-cell">{standing.powers}</td>
                        <td className="director-number-cell">{standing.gets}</td>
                        <td className="director-number-cell">{standing.negs}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <section className="director-panel">
              <div className="director-panel-heading">
                <div>
                  <p className="director-eyebrow">Player statistics</p>
                  <h2>Scoring leaders</h2>
                </div>
                <span className="director-muted">Accepted games only</span>
              </div>
              {playerStandings.length === 0 ? (
                <div className="director-panel-body director-panel-empty-body" role="status">
                  <p className="director-empty-copy">
                    Player statistics will appear when accepted results include rosters.
                  </p>
                </div>
              ) : (
                <div className="director-table-wrap">
                  <table className="director-table director-player-table">
                    <thead>
                      <tr>
                        <th scope="col">Player</th>
                        <th scope="col">Team</th>
                        <th scope="col">Games</th>
                        <th scope="col">PPG</th>
                        <th scope="col">Powers</th>
                        <th scope="col">Gets</th>
                        <th scope="col">Negs</th>
                        <th scope="col">Bonus pts</th>
                      </tr>
                    </thead>
                    <tbody>
                      {playerStandings.map((standing) => (
                        <tr key={standing.playerId}>
                          <td>
                            <strong>
                              {state.players.find((player) => player.id === standing.playerId)?.name ??
                                'Unknown'}
                            </strong>
                          </td>
                          <td>
                            {state.teams.find((team) => team.id === standing.teamId)?.displayName ??
                              'Unknown'}
                          </td>
                          <td className="director-number-cell">{standing.gamesPlayed}</td>
                          <td className="director-number-cell">{standing.ppg.toFixed(1)}</td>
                          <td className="director-number-cell">{standing.powers}</td>
                          <td className="director-number-cell">{standing.gets}</td>
                          <td className="director-number-cell">{standing.negs}</td>
                          <td className="director-number-cell">{standing.bonusPoints}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </>
  );
}

function downloadCsv(state: DirectorState, onAnnounce: (message: string) => void): void {
  const rows = [
    ['Rank', 'Team', 'Wins', 'Losses', 'Ties', 'Win %', 'Points for', 'Points against', 'Margin'],
    ...deriveTeamStandings(state).map((standing, index) => [
      String(index + 1),
      state.teams.find((team) => team.id === standing.teamId)?.displayName ?? '',
      String(standing.wins),
      String(standing.losses),
      String(standing.ties),
      `${(standing.winPercentage * 100).toFixed(1)}%`,
      String(standing.pointsFor),
      String(standing.pointsAgainst),
      String(standing.margin),
    ]),
  ];
  const blob = new Blob([rows.map((row) => row.map(csvCell).join(',')).join('\n')], {
    type: 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${safeName(state.tournament?.name ?? 'tournament')}-standings.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
  onAnnounce('Standings CSV exported.');
}
function safeName(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-|-$/g, '') || 'tournament'
  );
}
