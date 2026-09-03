import { deriveTeamStandings, type DirectorState } from '../domain';
import { Button, EmptyState, PanelBody } from '../components/Controls';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { exportArchiveBytes, exportQbj, exportSqbs, exportTeamCsv } from '../format/interchange';
import { isNativeDirector, saveNativeFile } from '../platform/native';
import type { AnnounceInput } from '../notices';

export function PublishView({
  state,
  onAnnounce,
}: {
  state: DirectorState;
  onAnnounce: (announcement: AnnounceInput) => void;
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
          <EmptyState
            title="Nothing to publish"
            description="Create or open a tournament before exporting reports."
          />
        ) : (
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
              <PublishAction
                title="Standings CSV"
                description="Team records and scoring columns for spreadsheets."
                action="Download CSV"
                icon="download"
                onClick={() => downloadCsv(state, onAnnounce)}
              />
              <PublishAction
                title="Portable archive"
                description="Versioned Director document that can be reopened on another computer."
                action="Export archive"
                icon="file"
                onClick={() => void downloadArchive(state, onAnnounce)}
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
              <PublishAction
                title="Print current view"
                description="Use the browser print dialog for room sheets or review tables."
                action="Print"
                icon="publish"
                onClick={() => {
                  window.print();
                  onAnnounce('Print dialog opened.');
                }}
              />
            </div>
          </section>
        )}
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
    const name = `${safeName(state.tournament?.name ?? 'tournament')}.qbst`;
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
  download(
    html,
    `${safeName(state.tournament?.name ?? 'tournament')}-standings.html`,
    'text/html;charset=utf-8',
  );
  onAnnounce('Static standings HTML exported.');
}
function downloadCsv(state: DirectorState, onAnnounce: (announcement: AnnounceInput) => void): void {
  const rows = exportTeamCsv(state);
  download(
    rows,
    `${safeName(state.tournament?.name ?? 'tournament')}-standings.csv`,
    'text/csv;charset=utf-8',
  );
  onAnnounce('Team and roster CSV exported.');
}
function downloadQbj(state: DirectorState, onAnnounce: (announcement: AnnounceInput) => void): void {
  download(
    exportQbj(state),
    `${safeName(state.tournament?.name ?? 'tournament')}.qbj`,
    'application/vnd.quizbowl.qbj+json;charset=utf-8',
  );
  onAnnounce('QBJ tournament exported.');
}
function downloadSqbs(state: DirectorState, onAnnounce: (announcement: AnnounceInput) => void): void {
  download(
    exportSqbs(state),
    `${safeName(state.tournament?.name ?? 'tournament')}.sqbs`,
    'text/plain;charset=utf-8',
  );
  onAnnounce('SQBS roster exported.');
}
function download(content: string, name: string, type: string): void {
  downloadBytes(new TextEncoder().encode(content), name, type);
}
function downloadBytes(content: Uint8Array, name: string, type: string): void {
  const copy = new Uint8Array(content);
  const url = URL.createObjectURL(new Blob([copy.buffer as ArrayBuffer], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoking synchronously can cancel the download in some browsers before navigation starts.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
function safeName(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-|-$/g, '') || 'tournament'
  );
}
