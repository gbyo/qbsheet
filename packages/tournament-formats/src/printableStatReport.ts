import { buildPrintableStatReportBundle as buildBoxScoreStatReportBundle } from './boxScoreReport.js';
import { renderPlayerDetailReport } from './playerDetailReport.js';
import { reportPageFiles, reportPresentationOf } from './reportPresentation.js';
import {
  renderReportIndex,
  renderRulesAwareIndividuals,
  renderRulesAwareRounds,
  renderRulesAwareStandings,
} from './rulesAwareReport.js';
import type { StatReportPage, StatsSnapshot } from './stats.js';
import { renderTeamDetailReport } from './teamDetailReport.js';

/**
 * Compose one rules-aware printable report bundle. The canonical snapshot plus its presentation
 * contract is the only input; page renderers never inspect Director state or raw QBJ.
 */
export function buildExtendedStatReportBundle(snapshot: StatsSnapshot): StatReportPage[] {
  const presentation = reportPresentationOf(snapshot);
  const included = new Set(presentation.options.pages.map((page) => reportPageFiles[page]));
  const pages = buildBoxScoreStatReportBundle(snapshot).map((page) => {
    if (page.name === 'index.html') return { name: page.name, content: renderReportIndex(snapshot) };
    if (page.name === 'standings.html') {
      return { name: page.name, content: renderRulesAwareStandings(snapshot) };
    }
    if (page.name === 'individuals.html') {
      return { name: page.name, content: renderRulesAwareIndividuals(snapshot) };
    }
    if (page.name === 'rounds.html') return { name: page.name, content: renderRulesAwareRounds(snapshot) };
    if (page.name === 'playerdetail.html') {
      return { name: page.name, content: renderPlayerDetailReport(snapshot) };
    }
    if (page.name === 'teamdetail.html') {
      return { name: page.name, content: renderTeamDetailReport(snapshot) };
    }
    return page;
  });
  return pages.filter((page) => page.name === 'index.html' || included.has(page.name));
}
