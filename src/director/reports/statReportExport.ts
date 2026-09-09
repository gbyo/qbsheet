import {
  addGameRowAnchors,
  buildStatReportBundle,
  renderCanonicalStandingsReport,
  zipStatReportBundle,
  type StatReportPage,
} from '@qbsheet/tournament-formats';
import type { DirectorState } from '../domain';
import { buildCanonicalSnapshot } from './canonicalReports';
import { safeReportName } from './downloads';
import { buildCanonicalStandingsReport } from './standingsReport';

export interface CanonicalStatReportArtifact {
  fileName: string;
  pages: StatReportPage[];
  bytes: Uint8Array;
}

function buildCanonicalReportPages(state: DirectorState, generatedAt: string): StatReportPage[] {
  const snapshot = buildCanonicalSnapshot(state, undefined, generatedAt);
  const standings = renderCanonicalStandingsReport(buildCanonicalStandingsReport(state, generatedAt));
  return buildStatReportBundle(snapshot).map((page) => {
    if (page.name === 'standings.html') return { ...page, content: standings };
    if (page.name === 'games.html') {
      return { ...page, content: addGameRowAnchors(page.content, snapshot.games) };
    }
    return page;
  });
}

/** Build the one canonical static report artifact used by Director Exports. */
export function buildCanonicalStatReport(
  state: DirectorState,
  generatedAt = new Date().toISOString(),
): CanonicalStatReportArtifact {
  const pages = buildCanonicalReportPages(state, generatedAt);
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
