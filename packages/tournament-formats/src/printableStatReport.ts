import { buildPrintableStatReportBundle as buildBoxScoreStatReportBundle } from './boxScoreReport.js';
import { renderPlayerDetailReport } from './playerDetailReport.js';
import type { StatReportPage, StatsSnapshot } from './stats.js';

/**
 * Compose the progressively upgraded printable report pages while keeping a
 * single artifact/export pipeline. Each page renderer consumes only the
 * canonical snapshot DTO.
 */
export function buildExtendedStatReportBundle(snapshot: StatsSnapshot): StatReportPage[] {
  return buildBoxScoreStatReportBundle(snapshot).map((page) =>
    page.name === 'playerdetail.html'
      ? { name: page.name, content: renderPlayerDetailReport(snapshot) }
      : page,
  );
}
