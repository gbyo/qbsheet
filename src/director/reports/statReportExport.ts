import { buildStatReportBundle, zipStatReportBundle, type StatReportPage } from '@qbsheet/tournament-formats';
import type { DirectorState } from '../domain';
import { buildCanonicalRoundStatsSnapshot } from './canonicalRoundReports';
import { safeReportName } from './downloads';

export interface CanonicalStatReportArtifact {
  fileName: string;
  pages: StatReportPage[];
  bytes: Uint8Array;
}

/** Build the one canonical static report artifact used by Director Exports. */
export function buildCanonicalStatReport(
  state: DirectorState,
  generatedAt = new Date().toISOString(),
): CanonicalStatReportArtifact {
  const snapshot = buildCanonicalRoundStatsSnapshot(state, undefined, generatedAt);
  const pages = buildStatReportBundle(snapshot);
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
  const snapshot = buildCanonicalRoundStatsSnapshot(state, undefined, generatedAt);
  const standings = buildStatReportBundle(snapshot).find((page) => page.name === 'standings.html');
  if (!standings) throw new Error('The canonical stat report did not include standings.html.');
  return standings.content;
}
