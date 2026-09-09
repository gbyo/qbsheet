import type { CanonicalStandingsReport, StandingsContextGame } from './standingsReport.js';
import { renderCanonicalStandingsReport } from './standingsReport.js';

/**
 * Keep result-context classification in the serializer instead of making the Director shape HTML.
 * Final/placement games render under the final-ranking or explicit final-stage section; tiebreaker
 * games remain adjacent to the section that owns them.
 */
export function renderStageAwareStandingsReport(report: CanonicalStandingsReport): string {
  const sections = report.sections.map((section) => ({
    ...section,
    ...(section.contextGames ? { contextGames: [...section.contextGames] } : {}),
  }));
  const finalResults: StandingsContextGame[] = [];
  let explicitFinalSection = sections.findIndex((section) => section.kind === 'final');
  let contextualFinalSection = -1;

  sections.forEach((section, index) => {
    const context = section.contextGames ?? [];
    const finals = context.filter((game) => game.kind === 'final' || game.kind === 'placement');
    if (finals.length > 0 && contextualFinalSection < 0) contextualFinalSection = index;
    finalResults.push(...finals);
    const tiebreakers = context.filter((game) => game.kind === 'tiebreaker');
    if (tiebreakers.length > 0) section.contextGames = tiebreakers;
    else delete section.contextGames;
  });

  if (explicitFinalSection < 0) explicitFinalSection = contextualFinalSection;
  if (explicitFinalSection >= 0 && finalResults.length > 0) {
    sections[explicitFinalSection] = { ...sections[explicitFinalSection]!, kind: 'final' };
  }

  return renderCanonicalStandingsReport({
    ...report,
    sections,
    ...(finalResults.length > 0 ? { finalResults } : {}),
  });
}
