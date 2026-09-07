import {
  derivePlayerStandings,
  deriveTeamStandings,
  totalAcceptedResults,
  type DirectorState,
} from '../domain';
import type { DirectorController } from '../state/useDirectorController';
import { Button, EmptyState } from '../components/Controls';
import { PageHeader } from '../components/PageHeader';
import { playerStatsCsv, standingsFileStem, teamStandingsCsv } from '../format/standingsCsv';
import { formatWinPct } from './statsDisplay';
import { csvMediaType, downloadText } from '../format/downloadFile';
import type { AnnounceInput } from '../notices';

export function StandingsView({
  state,
  onAnnounce,
}: {
  state: DirectorState;
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
}) {
  const teamStandings = deriveTeamStandings(state);
  /*
   * Everybody who has played, in the order the derivation ranks them.
   *
   * This used to be `.slice(0, 10)` with nothing on screen saying so, which is a table that looks
   * complete and is not: the eleventh player was unreachable from the only page that reports player
   * statistics, and a director checking a stat leader against a protest would have found the page
   * silently disagreeing with the export.
   */
  const playerStandings = derivePlayerStandings(state).filter((standing) => standing.gamesPlayed > 0);
  return (
    <>
      <PageHeader
        eyebrow="Review"
        title="Standings & stats"
        description="Derived from accepted game records and the tournament tiebreak configuration."
        actions={
          <>
            <Button
              variant="secondary"
              icon="download"
              onClick={() => downloadTeamStandings(state, onAnnounce)}
            >
              Export team standings CSV
            </Button>
            <Button
              variant="secondary"
              icon="download"
              onClick={() => downloadPlayerStats(state, onAnnounce)}
            >
              Export player stats CSV
            </Button>
          </>
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
                        <td className="director-number-cell">{formatWinPct(standing)}</td>
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
                  <h2>
                    {playerStandings.length} player{playerStandings.length === 1 ? '' : 's'}
                  </h2>
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

/*
 * Both exports write the shared serialization, so the file a director opens has the columns the
 * table above them has. See `standingsCsv` for why that is one module rather than one per page.
 */
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
