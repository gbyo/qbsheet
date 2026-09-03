import { deriveTeamStandings, type DirectorState } from '../domain';
import { Button, EmptyState, PanelBody } from '../components/Controls';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { exportArchiveBytes, exportQbj, exportSqbs, exportTeamCsv } from '../format/interchange';
import { playerStatsCsv, standingsFileStem, teamStandingsCsv } from '../format/standingsCsv';
import { csvMediaType, downloadBytes, downloadText } from '../format/downloadFile';
import { isNativeDirector, saveNativeFile } from '../platform/native';
import type { AnnounceInput } from '../notices';

export function PublishView({
  state,
  onAnnounce,
}: {
  state: DirectorState;
  onAnnounce: (announcement: AnnounceInput) => void;
  onNavigate?: (section: import('../app/navigation').SectionId) => void;
}) {
  const hasTournament = state.tournament !== null;
  return (
    <>
      <PageHeader
        eyebrow="Review"
        title="Publish"
        description="Generate files locally for teams, staff, and tournament records."
        actions={
          <Button
            variant="primary"
            icon="download"
            disabled={!hasTournament}
            onClick={() => void downloadArchive(state, onAnnounce)}
          >
            Export archive
          </Button>
        }
      />
      <div className="director-page-stack">
        {!hasTournament ? (
          /*
           * Nothing else on this page is about anything. The checklist below used to render here
           * too, describing what a tournament export contains to somebody who has no tournament.
           */
          <EmptyState
            title="Nothing to publish"
            description="Create or open a tournament before exporting reports."
          />
        ) : (
          <>
            <section className="director-panel director-publish-panel">
              <div className="director-panel-heading">
                <div>
                  <p className="director-eyebrow">Offline publishing</p>
                  <h2>Exports</h2>
                </div>
                <span className="director-muted">Local files</span>
              </div>
              <div className="director-publish-rows">
                <PublishAction
                  title="Team standings"
                  description="Printable HTML table with the configured tiebreak order."
                  action="Download HTML"
                  icon="publish"
                  onClick={() => downloadHtml(state, onAnnounce)}
                />
                {/*
                  The same serialization Standings & stats offers, so "team standings CSV" means one
                  thing wherever a director exports it. See `standingsCsv`.
                */}
                <PublishAction
                  title="Team standings CSV"
                  description="Records, scoring, and bonus columns for spreadsheets."
                  action="Download CSV"
                  icon="download"
                  onClick={() => downloadTeamStandingsCsv(state, onAnnounce)}
                />
                <PublishAction
                  title="Player stats CSV"
                  description="Per-player powers, gets, negs, and points from accepted games."
                  action="Download CSV"
                  icon="download"
                  onClick={() => downloadPlayerStatsCsv(state, onAnnounce)}
                />
                <PublishAction
                  title="Team & roster CSV"
                  description="Team and player rows in the format the team importer reads back."
                  action="Download CSV"
                  icon="download"
                  onClick={() => downloadTeamCsv(state, onAnnounce)}
                />
                <PublishAction
                  title="QBJ tournament"
                  description="Interoperable tournament, roster, schedule, and accepted-result data."
                  action="Download QBJ"
                  icon="file"
                  onClick={() => downloadQbj(state, onAnnounce)}
                />
                <PublishAction
                  title="SQBS roster"
                  description="Positional roster export for SQBS-compatible tools."
                  action="Download SQBS"
                  icon="download"
                  onClick={() => downloadSqbs(state, onAnnounce)}
                />
              </div>
            </section>
            <section className="director-panel">
              <div className="director-panel-heading">
                <div>
                  <p className="director-eyebrow">Offline publishing</p>
                  <h2>What is included</h2>
                </div>
              </div>
              <PanelBody>
                <ul className="director-publish-checklist">
                  <li>
                    <Icon name="check" size={16} />
                    <span>Team standings use accepted results only.</span>
                  </li>
                  <li>
                    <Icon name="check" size={16} />
                    <span>Original QBTCP submissions stay in the archive.</span>
                  </li>
                  <li>
                    <Icon name="check" size={16} />
                    <span>Audit history and schema version travel with the tournament.</span>
                  </li>
                </ul>
              </PanelBody>
            </section>
          </>
        )}
      </div>
    </>
  );
}

function PublishAction({
  title,
  description,
  action,
  icon,
  onClick,
}: {
  title: string;
  description: string;
  action: string;
  icon: 'publish' | 'download' | 'file';
  onClick: () => void;
}) {
  return (
    <div className="director-publish-row">
      <div className="director-publish-action-icon">
        <Icon name={icon} size={19} />
      </div>
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      <Button variant="secondary" onClick={onClick}>
        {action}
      </Button>
    </div>
  );
}

async function downloadArchive(
  state: DirectorState,
  onAnnounce: (announcement: AnnounceInput) => void,
): Promise<void> {
  try {
    const bytes = exportArchiveBytes(state);
    const name = `${standingsFileStem(state)}.qbst`;
    if (isNativeDirector()) {
      const result = await saveNativeFile(name, bytes);
      if (result.status === 'cancelled') {
        onAnnounce('Portable archive save cancelled.');
        return;
      }
      if (result.status === 'unavailable') {
        onAnnounce('The native file-save dialog is unavailable.');
        return;
      }
      onAnnounce(`Portable archive saved to ${result.path}.`);
      return;
    }
    downloadBytes(bytes, name, 'application/vnd.qbsheet.director+zip');
    onAnnounce('Portable tournament archive exported.');
  } catch (reason: unknown) {
    onAnnounce(
      reason instanceof Error ? reason.message : 'Portable tournament archive could not be exported.',
    );
  }
}
function downloadHtml(state: DirectorState, onAnnounce: (announcement: AnnounceInput) => void): void {
  const standings = deriveTeamStandings(state);
  const title = escapeHtml(state.tournament?.name ?? 'Tournament standings');
  const rows = standings
    .map(
      (standing, index) =>
        `<tr><td>${index + 1}</td><td>${escapeHtml(state.teams.find((team) => team.id === standing.teamId)?.displayName ?? '')}</td><td>${standing.wins}–${standing.losses}${standing.ties ? `–${standing.ties}` : ''}</td><td>${standing.pointsFor}</td><td>${standing.pointsAgainst}</td><td>${standing.margin}</td></tr>`,
    )
    .join('');
  const html = `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{font:16px system-ui,sans-serif;max-width:960px;margin:40px auto;color:#202a2e}table{border-collapse:collapse;width:100%}th,td{padding:9px;border-bottom:1px solid #d8dfe1;text-align:left}th{font-size:12px;text-transform:uppercase}</style><h1>${title}</h1><table><thead><tr><th>Rank</th><th>Team</th><th>Record</th><th>PF</th><th>PA</th><th>Margin</th></tr></thead><tbody>${rows}</tbody></table>`;
  downloadText(html, `${standingsFileStem(state)}-standings.html`, 'text/html;charset=utf-8');
  onAnnounce('Static standings HTML exported.');
}
function downloadTeamStandingsCsv(
  state: DirectorState,
  onAnnounce: (announcement: AnnounceInput) => void,
): void {
  downloadText(teamStandingsCsv(state), `${standingsFileStem(state)}-standings.csv`, csvMediaType);
  onAnnounce('Team standings CSV exported.');
}
function downloadPlayerStatsCsv(
  state: DirectorState,
  onAnnounce: (announcement: AnnounceInput) => void,
): void {
  downloadText(playerStatsCsv(state), `${standingsFileStem(state)}-player-stats.csv`, csvMediaType);
  onAnnounce('Player statistics CSV exported.');
}
function downloadTeamCsv(state: DirectorState, onAnnounce: (announcement: AnnounceInput) => void): void {
  // Named for what it holds. This is the roster importer's format, not a standings table.
  downloadText(exportTeamCsv(state), `${standingsFileStem(state)}-teams.csv`, csvMediaType);
  onAnnounce('Team and roster CSV exported.');
}
function downloadQbj(state: DirectorState, onAnnounce: (announcement: AnnounceInput) => void): void {
  downloadText(
    exportQbj(state),
    `${standingsFileStem(state)}.qbj`,
    'application/vnd.quizbowl.qbj+json;charset=utf-8',
  );
  onAnnounce('QBJ tournament exported.');
}
function downloadSqbs(state: DirectorState, onAnnounce: (announcement: AnnounceInput) => void): void {
  downloadText(exportSqbs(state), `${standingsFileStem(state)}.sqbs`, 'text/plain;charset=utf-8');
  onAnnounce('SQBS roster exported.');
}
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
