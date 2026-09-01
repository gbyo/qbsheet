import { derivePlayerStandings, deriveTeamStandings, type DirectorState } from '../domain';
import type { DirectorController } from '../state/useDirectorController';
import { Button, EmptyState } from '../components/Controls';
import { PageHeader } from '../components/PageHeader';

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
              <span className="director-muted">
                {state.games.filter((game) => game.status === 'accepted').length} accepted games
              </span>
            </div>
            <div className="director-table-wrap">
              <table className="director-table director-standings-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Team</th>
                    <th>W–L</th>
                    <th>Win %</th>
                    <th>PF</th>
                    <th>PA</th>
                    <th>Margin</th>
                    <th>Powers</th>
                    <th>Gets</th>
                    <th>Negs</th>
                  </tr>
                </thead>
                <tbody>
                  {teamStandings.map((standing, index) => (
                    <tr key={standing.teamId}>
                      <td>{index + 1}</td>
                      <td>
                        <strong>
                          {state.teams.find((team) => team.id === standing.teamId)?.displayName ?? 'Unknown'}
                        </strong>
                      </td>
                      <td className="director-record-cell">
                        {standing.wins}–{standing.losses}
                        {standing.ties ? `–${standing.ties}` : ''}
                      </td>
                      <td>{(standing.winPercentage * 100).toFixed(1)}%</td>
                      <td>{standing.pointsFor}</td>
                      <td>{standing.pointsAgainst}</td>
                      <td>
                        {standing.margin > 0 ? '+' : ''}
                        {standing.margin}
                      </td>
                      <td>{standing.powers}</td>
                      <td>{standing.gets}</td>
                      <td>{standing.negs}</td>
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
              <p className="director-empty-copy">
                Player statistics will appear when accepted results include rosters.
              </p>
            ) : (
              <div className="director-table-wrap">
                <table className="director-table">
                  <thead>
                    <tr>
                      <th>Player</th>
                      <th>Team</th>
                      <th>Games</th>
                      <th>PPG</th>
                      <th>Powers</th>
                      <th>Gets</th>
                      <th>Negs</th>
                      <th>Bonus pts</th>
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
                          {state.teams.find((team) => team.id === standing.teamId)?.displayName ?? 'Unknown'}
                        </td>
                        <td>{standing.gamesPlayed}</td>
                        <td>{standing.ppg.toFixed(1)}</td>
                        <td>{standing.powers}</td>
                        <td>{standing.gets}</td>
                        <td>{standing.negs}</td>
                        <td>{standing.bonusPoints}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
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
      String(standing.winPercentage),
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
function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
function safeName(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-|-$/g, '') || 'tournament'
  );
}
