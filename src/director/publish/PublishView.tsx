import type { DirectorState } from '../domain';
import type { SectionId } from '../app/navigation';
import { Button, EmptyState, PanelBody } from '../components/Controls';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { exportArchiveBytes, exportQbj, exportSqbs } from '../format/interchange';
import { safeReportName, saveOrDownloadBytes, saveOrDownloadText } from '../reports/downloads';
import type { AnnounceInput } from '../notices';

export function PublishView({
  state,
  onAnnounce,
  onNavigate,
}: {
  state: DirectorState;
  onAnnounce: (announcement: AnnounceInput) => void;
  onNavigate: (section: SectionId) => void;
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
              <span className="director-muted">Local files · overall scope</span>
            </div>
            <div className="director-publish-rows">
              <PublishAction
                title="Stat exports"
                description="The stat report and team, individual, and games CSVs live in Stats, alongside the standings they are derived from."
                action="Open Stats"
                icon="publish"
                onClick={() => onNavigate('standings')}
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
                description="Positional roster export for SQBS-compatible tools. Full tournament SQBS export lands next."
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
                <span>
                  Reports share the canonical standings engine, so Stats, Live, CSV, and HTML cannot disagree
                  about who is first.
                </span>
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

function downloadArchive(
  state: DirectorState,
  onAnnounce: (announcement: AnnounceInput) => void,
): Promise<void> {
  let bytes: Uint8Array;
  try {
    bytes = exportArchiveBytes(state);
  } catch (reason: unknown) {
    onAnnounce(
      reason instanceof Error ? reason.message : 'Portable tournament archive could not be exported.',
    );
    return Promise.resolve();
  }
  return saveOrDownloadBytes(
    bytes,
    `${safeReportName(state.tournament?.name ?? 'tournament')}.qbst`,
    'application/vnd.qbsheet.director+zip',
    onAnnounce,
    'Portable tournament archive exported',
    'Portable archive save cancelled',
  );
}

function downloadQbj(state: DirectorState, onAnnounce: (announcement: AnnounceInput) => void): void {
  saveOrDownloadText(
    exportQbj(state),
    `${safeReportName(state.tournament?.name ?? 'tournament')}.qbj`,
    'application/vnd.quizbowl.qbj+json;charset=utf-8',
    onAnnounce,
    'QBJ tournament exported',
  );
}
function downloadSqbs(state: DirectorState, onAnnounce: (announcement: AnnounceInput) => void): void {
  saveOrDownloadText(
    exportSqbs(state),
    `${safeReportName(state.tournament?.name ?? 'tournament')}.sqbs`,
    'text/plain;charset=utf-8',
    onAnnounce,
    'SQBS roster exported',
  );
}
