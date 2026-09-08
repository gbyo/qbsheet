import { deriveTeamStandings, type DirectorState } from '../domain';
import { Button, EmptyState, Page, PageHeader, Panel, SummaryItem, SummaryList } from '../components';
import { exportArchiveBytes, exportQbj, exportSqbs, exportTeamCsv } from '../format/interchange';
import { playerStatsCsv, standingsFileStem, teamStandingsCsv } from '../format/standingsCsv';
import { csvMediaType, downloadBytes, downloadText } from '../format/downloadFile';
import { isNativeDirector, saveNativeFile } from '../platform/native';
import { errorNotice, infoNotice, type AnnounceInput } from '../notices';

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
    <Page>
      <PageHeader
        title="Exports"
        description="Create local files for teams, staff, interoperability, and tournament backup. Public publishing lives in QBSheet Live."
        actions={
          <Button
            variant="primary"
            icon="download"
            disabled={!hasTournament}
            onClick={() => void downloadArchive(state, onAnnounce)}
          >
            Export tournament archive
          </Button>
        }
      />

      {!hasTournament ? (
        <EmptyState
          title="Nothing to export"
          description="Create or open a tournament before generating local files."
        />
      ) : (
        <Panel
          title="Local files"
          description="Standings and player-stat CSVs use the same canonical serializers as the shortcuts on Standings. Archives retain raw submissions and audit history."
          flush
        >
          <SummaryList ariaLabel="Export formats">
            <ExportAction
              title="Team standings HTML"
              description="Printable static standings table using accepted results and the configured tiebreak order."
              action="Download HTML"
              onClick={() => downloadHtml(state, onAnnounce)}
            />
            <ExportAction
              title="Team standings CSV"
              description="Canonical team records and scoring columns for spreadsheets."
              action="Download CSV"
              onClick={() => downloadTeamStandingsCsv(state, onAnnounce)}
            />
            <ExportAction
              title="Player stats CSV"
              description="Canonical per-player powers, gets, negs, bonus points, games, and PPG."
              action="Download CSV"
              onClick={() => downloadPlayerStatsCsv(state, onAnnounce)}
            />
            <ExportAction
              title="Team & roster CSV"
              description="Teams and players in the same CSV shape the Director team importer reads."
              action="Download CSV"
              onClick={() => downloadTeamCsv(state, onAnnounce)}
            />
            <ExportAction
              title="QBJ tournament"
              description="Interoperable tournament, roster, schedule, packet, and accepted-result data."
              action="Download QBJ"
              onClick={() => downloadQbj(state, onAnnounce)}
            />
            <ExportAction
              title="SQBS roster"
              description="Positional roster export for SQBS-compatible tools."
              action="Download SQBS"
              onClick={() => downloadSqbs(state, onAnnounce)}
            />
          </SummaryList>
        </Panel>
      )}
    </Page>
  );
}

function ExportAction({
  title,
  description,
  action,
  onClick,
}: {
  title: string;
  description: string;
  action: string;
  onClick: () => void;
}) {
  return (
    <SummaryItem
      title={<strong>{title}</strong>}
      summary={description}
      actions={
        <Button variant="secondary" icon="download" onClick={onClick}>
          {action}
        </Button>
      }
    />
  );
}

export async function downloadArchive(
  state: DirectorState,
  onAnnounce: (announcement: AnnounceInput) => void,
): Promise<void> {
  try {
    const bytes = exportArchiveBytes(state);
    const name = `${standingsFileStem(state)}.qbst`;
    if (isNativeDirector()) {
      const result = await saveNativeFile(name, bytes);
      if (result.status === 'cancelled') {
        onAnnounce(infoNotice('Portable archive save cancelled.'));
        return;
      }
      if (result.status === 'unavailable') {
        onAnnounce(infoNotice('The native file-save dialog is unavailable.'));
        return;
      }
      onAnnounce(`Portable archive saved to ${result.path}.`);
      return;
    }
    downloadBytes(bytes, name, 'application/vnd.qbsheet.director+zip');
    onAnnounce('Portable tournament archive exported.');
  } catch (reason: unknown) {
    onAnnounce(
      errorNotice(
        reason instanceof Error ? reason.message : 'Portable tournament archive could not be exported.',
      ),
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
