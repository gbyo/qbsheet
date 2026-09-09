import { buildPrintableStatReportBundle as buildBoxScoreStatReportBundle } from './boxScoreReport.js';
import { renderPlayerDetailReport } from './playerDetailReport.js';
import { renderRoundReport } from './roundReport.js';
import type { StatReportPage, StatsSnapshot } from './stats.js';
import { renderTeamDetailReport } from './teamDetailReport.js';

/**
 * Compose the progressively upgraded printable report pages while keeping a
 * single artifact/export pipeline. Each page renderer consumes only the
 * canonical snapshot DTO.
 */
export function buildExtendedStatReportBundle(snapshot: StatsSnapshot): StatReportPage[] {
  return buildBoxScoreStatReportBundle(snapshot).map((page) => {
    if (page.name === 'playerdetail.html') {
      return { name: page.name, content: renderPlayerDetailReport(snapshot) };
    }
    if (page.name === 'teamdetail.html') {
      return { name: page.name, content: renderTeamDetailReport(snapshot) };
    }
    if (page.name === 'rounds.html') {
      return { name: page.name, content: renderRoundReport(snapshot) };
    }
    return page;
  });
}