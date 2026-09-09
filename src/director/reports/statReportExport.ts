import {
  buildExtendedStatReportBundle,
  defaultReportOptions,
  zipStatReportBundle,
  type ReportOptions,
  type StatReportPage,
} from '@qbsheet/tournament-formats';
import type { DirectorState } from '../domain';
import { buildCanonicalSnapshot } from './canonicalReports';
import { safeReportName } from './downloads';
import { withReportPresentation } from './reportPresentation';

export interface CanonicalStatReportArtifact {
  fileName: string;
  pages: StatReportPage[];
  bytes: Uint8Array;
}

/** Build the one canonical static report artifact used by Director Exports. */
export function buildCanonicalStatReport(
  state: DirectorState,
  generatedAt = new Date().toISOString(),
  options: ReportOptions = defaultReportOptions,
): CanonicalStatReportArtifact {
  const snapshot = withReportPresentation(
    state,
    buildCanonicalSnapshot(state, undefined, generatedAt),
    options,
  );
  const pages = buildExtendedStatReportBundle(snapshot);
  return {
    fileName: `${safeReportName(state.tournament?.name ?? 'tournament')}-stat-report.zip`,
    pages,
    bytes: zipStatReportBundle(pages),
  };
}

/**
 * Keep the single-page standings convenience download on the same canonical
 * snapshot/renderer as the full report bundle. It is a view of the bundle,
 * not a second standings implementation.
 */
export function buildCanonicalStandingsHtml(
  state: DirectorState,
  generatedAt = new Date().toISOString(),
): string {
  const snapshot = withReportPresentation(
    state,
    buildCanonicalSnapshot(state, undefined, generatedAt),
    defaultReportOptions,
  );
  const standings = buildExtendedStatReportBundle(snapshot).find((page) => page.name === 'standings.html');
  if (!standings) throw new Error('The canonical stat report did not include standings.html.');
  return standings.content;
}
