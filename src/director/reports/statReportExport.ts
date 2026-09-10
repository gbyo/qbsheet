import {
  buildExtendedStatReportBundle,
  buildRoundAwareStatReportBundle,
  defaultReportOptions,
  renderStageAwareStandingsReport,
  zipStatReportBundle,
  type ReportOptions,
  type StatReportPage,
} from '@qbsheet/tournament-formats';
import type { DirectorState } from '../domain';
import { buildCanonicalRoundStatsSnapshot } from './canonicalRoundReports';
import { safeReportName } from './downloads';
import { buildCanonicalStandingsReport } from './standingsReport';
import { withReportPresentation } from './reportPresentation';

export interface CanonicalStatReportArtifact {
  fileName: string;
  pages: StatReportPage[];
  bytes: Uint8Array;
}

function buildCanonicalReportPages(
  state: DirectorState,
  generatedAt: string,
  options: ReportOptions = defaultReportOptions,
): StatReportPage[] {
  const snapshot = withReportPresentation(
    state,
    buildCanonicalRoundStatsSnapshot(state, undefined, generatedAt),
    options,
  );
  const standings = renderStageAwareStandingsReport(
    buildCanonicalStandingsReport(state, generatedAt, options),
  );
  const rounds = buildRoundAwareStatReportBundle(snapshot).find((page) => page.name === 'rounds.html');
  return buildExtendedStatReportBundle(snapshot).map((page) => {
    if (page.name === 'standings.html') return { ...page, content: standings };
    if (page.name === 'rounds.html' && rounds) return { ...page, content: rounds.content };
    return page;
  });
}

/** Build the one canonical static report artifact used by Director Exports. */
export function buildCanonicalStatReport(
  state: DirectorState,
  generatedAt = new Date().toISOString(),
  options: ReportOptions = defaultReportOptions,
): CanonicalStatReportArtifact {
  const pages = buildCanonicalReportPages(state, generatedAt, options);
  return {
    fileName: `${safeReportName(state.tournament?.name ?? 'tournament')}-stat-report.zip`,
    pages,
    bytes: zipStatReportBundle(pages),
  };
}

/**
 * Keep the single-page standings convenience download on the exact same page
 * as the full report bundle. It is a view of the canonical artifact, not a
 * second standings implementation.
 */
export function buildCanonicalStandingsHtml(
  state: DirectorState,
  generatedAt = new Date().toISOString(),
): string {
  const standings = buildCanonicalReportPages(state, generatedAt).find(
    (page) => page.name === 'standings.html',
  );
  if (!standings) throw new Error('The canonical stat report did not include standings.html.');
  return standings.content;
}
