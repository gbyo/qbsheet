import { useMemo, useState } from 'react';
import { defaultReportOptions, type ReportOptions } from '@qbsheet/tournament-formats';
import type { DirectorState } from '../domain';
import { Button, EmptyState, Page, PageHeader, Panel, SummaryItem, SummaryList } from '../components';
import { exportArchiveBytes, exportQbjReport, exportSqbs, exportTeamCsv } from '../format/interchange';
import { playerStatsCsv, standingsFileStem, teamStandingsCsv } from '../format/standingsCsv';
import { csvMediaType, downloadBytes, downloadText } from '../format/downloadFile';
import { isNativeDirector, saveNativeFile } from '../platform/native';
import { errorNotice, infoNotice, warningNotice, type AnnounceInput } from '../notices';
import { saveOrDownloadBytes } from '../reports/downloads';
import { loadReportOptions, saveReportOptions } from '../reports/reportPreferences';
import { buildCanonicalStandingsHtml, buildCanonicalStatReport } from '../reports/statReportExport';
import { buildCanonicalResourceCenterReport } from '../reports/resourceCenterExport';
import { ReportOptionsDialog } from './ReportOptionsDialog';
import { SqbsTournamentDialog } from './SqbsTournamentDialog';

export function PublishView({
  state,
  onAnnounce,
}: {
  state: DirectorState;
  onAnnounce: (announcement: AnnounceInput) => void;
  onNavigate?: (section: import('../app/navigation').SectionId) => void;
}) {
  const hasTournament = state.tournament !== null;
  const tournamentId = state.tournament?.id ?? '';
  const loadedReportOptions = useMemo(
    () =>
      tournamentId
        ? loadReportOptions(tournamentId)
        : { ...defaultReportOptions, pages: [...defaultReportOptions.pages] },
    [tournamentId],
  );
  const [reportOptionsOverride, setReportOptionsOverride] = useState<{
    tournamentId: string;
    options: ReportOptions;
  } | null>(null);
  const reportOptions =
    reportOptionsOverride?.tournamentId === tournamentId
      ? reportOptionsOverride.options
      : loadedReportOptions;
  const [reportOptionsOpen, setReportOptionsOpen] = useState(false);
  const [sqbsTournamentOpen, setSqbsTournamentOpen] = useState(false);

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
              title="Printable stat report"
              description="Rules-aware linked standings, individuals, games, rounds, team, and player pages for printing or static hosting."
              action="Download report"
              secondaryAction={{ label: 'Report options', onClick: () => setReportOptionsOpen(true) }}
              onClick={() => void downloadStatReport(state, onAnnounce, reportOptions)}
            />
            <ExportAction
              title="Resource Center report"
              description="Six upload-ready HTML files with conventional SQBS/YellowFruit names (standings, individuals, scoreboard, team detail, player detail, round report) plus an optional stat-key companion, all from the canonical snapshot."
              action="Download ZIP"
              onClick={() => void downloadResourceCenterReport(state, onAnnounce, reportOptions)}
            />
            <ExportAction
              title="Team standings HTML"
              description="Single-page standings from the same canonical snapshot and renderer as the printable stat report."
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
              title="SQBS tournament"
              description="Full tournament data file for SQBS: teams, players, games, scores, and detail stats."
              action="Download tournament"
              onClick={() => setSqbsTournamentOpen(true)}
            />
            <ExportAction
              title="SQBS roster"
              description="Roster-only compatibility file for SQBS-compatible tools. No games or scores."
              action="Download roster"
              onClick={() => downloadSqbs(state, onAnnounce)}
            />
          </SummaryList>
        </Panel>
      )}

      {sqbsTournamentOpen && state.tournament && (
        <SqbsTournamentDialog
          state={state}
          onAnnounce={onAnnounce}
          onClose={() => setSqbsTournamentOpen(false)}
        />
      )}

      {reportOptionsOpen && state.tournament && (
        <ReportOptionsDialog
          options={reportOptions}
          onClose={() => setReportOptionsOpen(false)}
          onSave={(options) => {
            const saved = saveReportOptions(state.tournament!.id, options);
            setReportOptionsOverride({ tournamentId: state.tournament!.id, options: saved });
            setReportOptionsOpen(false);
            onAnnounce(infoNotice('Printable report options saved on this Director.'));
          }}
        />
      )}
    </Page>
  );
}

function ExportAction({
  title,
  description,
  action,
  secondaryAction,
  onClick,
}: {
  title: string;
  description: string;
  action: string;
  secondaryAction?: { label: string; onClick: () => void };
  onClick: () => void;
}) {
  return (
    <SummaryItem
      title={<strong>{title}</strong>}
      summary={description}
      actions={
        <div className="director-actions">
          {secondaryAction && (
            <Button variant="quiet" onClick={secondaryAction.onClick}>
              {secondaryAction.label}
            </Button>
          )}
          <Button variant="secondary" icon="download" onClick={onClick}>
            {action}
          </Button>
        </div>
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

export async function downloadStatReport(
  state: DirectorState,
  onAnnounce: (announcement: AnnounceInput) => void,
  options: ReportOptions = defaultReportOptions,
): Promise<void> {
  try {
    const artifact = buildCanonicalStatReport(state, new Date().toISOString(), options);
    await saveOrDownloadBytes(
      artifact.bytes,
      artifact.fileName,
      'application/zip',
      onAnnounce,
      'Printable stat report exported',
      'Printable stat report save cancelled.',
    );
  } catch (reason: unknown) {
    onAnnounce(
      errorNotice(reason instanceof Error ? reason.message : 'Printable stat report could not be exported.'),
    );
  }
}

export async function downloadResourceCenterReport(
  state: DirectorState,
  onAnnounce: (announcement: AnnounceInput) => void,
  options: ReportOptions = defaultReportOptions,
): Promise<void> {
  try {
    const artifact = buildCanonicalResourceCenterReport(state, new Date().toISOString(), options);
    await saveOrDownloadBytes(
      artifact.bytes,
      artifact.fileName,
      'application/zip',
      onAnnounce,
      'Resource Center report exported',
      'Resource Center report save cancelled.',
    );
  } catch (reason: unknown) {
    onAnnounce(
      errorNotice(reason instanceof Error ? reason.message : 'Resource Center report could not be exported.'),
    );
  }
}

function downloadHtml(state: DirectorState, onAnnounce: (announcement: AnnounceInput) => void): void {
  try {
    const html = buildCanonicalStandingsHtml(state);
    downloadText(html, `${standingsFileStem(state)}-standings.html`, 'text/html;charset=utf-8');
    onAnnounce('Static standings HTML exported.');
  } catch (reason: unknown) {
    onAnnounce(
      errorNotice(reason instanceof Error ? reason.message : 'Static standings HTML could not be exported.'),
    );
  }
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
  try {
    const exported = exportQbjReport(state);
    downloadText(
      exported.text,
      `${standingsFileStem(state)}.qbj`,
      'application/vnd.quizbowl.qbj+json;charset=utf-8',
    );
    onAnnounce('QBJ tournament exported.');
    // A multi-definition tournament's single global ScoringRules object does not describe every
    // game (#671). The file stays honest through per-Match extensions; say so where the director
    // will see it rather than letting the download look self-describing.
    for (const message of exported.warnings) onAnnounce(warningNotice(message));
  } catch (reason: unknown) {
    onAnnounce(
      errorNotice(reason instanceof Error ? reason.message : 'QBJ tournament could not be exported.'),
    );
  }
}

function downloadSqbs(state: DirectorState, onAnnounce: (announcement: AnnounceInput) => void): void {
  downloadText(exportSqbs(state), `${standingsFileStem(state)}.sqbs`, 'text/plain;charset=utf-8');
  onAnnounce('SQBS roster exported.');
}
