import {
  reportAnswerCells,
  reportAnswerHeaders,
  reportPointsMetricLabel,
  reportPointsMetricValue,
  reportTeamAnchor,
} from './reportHtml.js';
import {
  reportNumber,
  reportPercent,
  type ReportPresentation,
} from './reportPresentation.js';
import type { GameStatsRow, StatsSnapshot, TeamStatsRow } from './stats.js';

export type StandingsReportSectionKind = 'final' | 'phase' | 'pool' | 'cumulative';
export type StandingsAdvancementStatus = 'committed' | 'provisional' | 'unresolved' | 'eliminated';
export type StandingsContextGameKind = 'final' | 'placement' | 'tiebreaker';

export interface StandingsAdvancementCell {
  status: StandingsAdvancementStatus;
  target?: string;
  note?: string;
}

export interface StandingsContextGame {
  gameId: string;
  kind: StandingsContextGameKind;
  label: string;
  roundName?: string;
  teamOneName: string;
  teamOnePoints?: number;
  teamTwoName: string;
  teamTwoPoints?: number;
  forfeitedTeamName?: string;
}

export interface StandingsReportSection {
  id: string;
  title: string;
  kind: StandingsReportSectionKind;
  scopeLabel: string;
  teams: TeamStatsRow[];
  phaseId?: string;
  poolId?: string;
  carryover?: boolean;
  advancement?: Record<string, StandingsAdvancementCell>;
  contextGames?: StandingsContextGame[];
}

export interface CanonicalStandingsReport {
  tournament: StatsSnapshot['tournament'];
  generatedAt: string;
  sections: StandingsReportSection[];
  finalResults?: StandingsContextGame[];
  /** Canonical competition ranks for unresolved ties; absent means ordinary sequential rank. */
  displayRanks?: Record<string, number>;
  /**
   * Shared rules-aware presentation contract. When present, the section tables consume its
   * answer-tier columns, points metric, and options instead of the legacy fixed vocabulary;
   * when absent, tables render the legacy fixed set (#751).
   */
  presentation?: ReportPresentation;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/g, '')
      .replace(/-+$/g, '') || 'item'
  );
}

export function standingsGameAnchor(gameId: string): string {
  return `game-${slugify(gameId)}`;
}

function recordText(row: TeamStatsRow): string {
  return row.ties > 0 ? `${row.wins}–${row.losses}–${row.ties}` : `${row.wins}–${row.losses}`;
}

function advancementText(cell: StandingsAdvancementCell | undefined): string {
  if (!cell) return '';
  if (cell.status === 'committed') return cell.target ? `Advanced to ${cell.target}` : 'Advanced';
  if (cell.status === 'provisional') {
    return cell.target ? `Would advance to ${cell.target}` : 'Would advance';
  }
  if (cell.status === 'unresolved') return cell.note ? `Unresolved — ${cell.note}` : 'Unresolved';
  return 'Did not advance';
}

function resultLine(game: StandingsContextGame): string {
  const left = game.teamOnePoints === undefined ? '—' : String(game.teamOnePoints);
  const right = game.teamTwoPoints === undefined ? '—' : String(game.teamTwoPoints);
  const forfeit = game.forfeitedTeamName ? ` · ${escapeHtml(game.forfeitedTeamName)} forfeited` : '';
  return (
    `<li><strong>${escapeHtml(game.label)}</strong>${game.roundName ? ` · ${escapeHtml(game.roundName)}` : ''}: ` +
    `<a href="games.html#${standingsGameAnchor(game.gameId)}">${escapeHtml(game.teamOneName)} ${left}–${right} ${escapeHtml(game.teamTwoName)}</a>${forfeit}</li>`
  );
}

function contextBlock(title: string, games: readonly StandingsContextGame[]): string {
  if (games.length === 0) return '';
  return `<div class="context"><h3>${escapeHtml(title)}</h3><ul>${games.map(resultLine).join('')}</ul></div>`;
}

/**
 * Legacy fixed tier vocabulary, kept for reports composed without a presentation contract.
 * Counts come from the row's legacy fields, so output is unchanged for existing callers.
 */
function legacyAnswerCells(row: TeamStatsRow, showSuperpowers: boolean): string {
  const cells: string[] = [];
  if (showSuperpowers) cells.push(`<td class="num">${row.superpowers}</td>`);
  cells.push(
    `<td class="num">${row.powers}</td>`,
    `<td class="num">${row.gets}</td>`,
    `<td class="num">${row.negs}</td>`,
  );
  return cells.join('');
}

function legacyAnswerHeaders(showSuperpowers: boolean): string {
  return (
    `${showSuperpowers ? '<th scope="col" class="num">Superpowers</th>' : ''}` +
    `<th scope="col" class="num">Powers</th><th scope="col" class="num">Gets</th><th scope="col" class="num">Negs</th>`
  );
}

function sectionTable(report: CanonicalStandingsReport, section: StandingsReportSection): string {
  const presentation = report.presentation;
  const showCalculated = section.teams.some(
    (row) => row.calculatedRank !== undefined && row.calculatedRank !== row.rank,
  );
  const showClassifications = section.teams.some((row) => (row.classifications ?? []).length > 0);
  const showAdvancement = section.advancement !== undefined;
  // Without a presentation contract the table keeps its legacy fixed vocabulary; with one,
  // PF/PA/Margin follow the shared report option and tiers/metric follow the schema (#751).
  const showExtras = presentation ? presentation.options.showPointsForAgainstMargin : true;
  const showSuperpowers = presentation
    ? presentation.answerColumns.some((column) => column.key === 'superpower')
    : section.teams.some((row) => row.superpowers > 0);
  const scoringLabel = presentation ? reportPointsMetricLabel(presentation) : 'PPG';
  const scoringCell = (row: TeamStatsRow): string =>
    presentation
      ? `<td class="num">${reportPointsMetricValue(row, presentation)}</td>`
      : `<td class="num">${row.ppg.toFixed(1)}</td>`;
  const rows = section.teams
    .map((row) => {
      const displayRank = report.displayRanks?.[`${section.id}:${row.teamId}`] ?? row.rank;
      return (
        `<tr><td class="num">${displayRank}</td>` +
        `${showCalculated ? `<td class="num">${row.calculatedRank ?? ''}</td>` : ''}` +
        `<td><a href="teamdetail.html#${reportTeamAnchor(row)}">${escapeHtml(row.teamName)}</a></td>` +
        `${showClassifications ? `<td>${escapeHtml((row.classifications ?? []).join('; ') || '—')}</td>` : ''}` +
        `<td class="num">${escapeHtml(recordText(row))}</td><td class="num">${reportPercent(row.winPercentage, 1)}</td>` +
        `${showExtras ? `<td class="num">${row.pointsFor}</td><td class="num">${row.pointsAgainst}</td><td class="num">${row.margin}</td>` : ''}` +
        `${scoringCell(row)}` +
        `${presentation ? reportAnswerCells(row, presentation) : legacyAnswerCells(row, showSuperpowers)}` +
        `<td class="num">${reportNumber(row.tossupsHeardKnown ? row.tossupsHeard : null)}</td>` +
        `<td class="num">${reportNumber(row.pptuh, 2)}</td>` +
        `<td class="num">${reportNumber(row.ppb, 2)}</td>` +
        `${showAdvancement ? `<td>${escapeHtml(advancementText(section.advancement?.[row.teamId]))}</td>` : ''}</tr>`
      );
    })
    .join('');
  return (
    `<div class="table-wrap"><table><thead><tr><th scope="col" class="num">#</th>` +
    `${showCalculated ? '<th scope="col" class="num">Calc</th>' : ''}<th scope="col">Team</th>` +
    `${showClassifications ? '<th scope="col">Group</th>' : ''}<th scope="col" class="num">Record</th>` +
    `<th scope="col" class="num">Win %</th>` +
    `${showExtras ? '<th scope="col" class="num">PF</th><th scope="col" class="num">PA</th><th scope="col" class="num">Margin</th>' : ''}` +
    `<th scope="col" class="num">${escapeHtml(scoringLabel)}</th>` +
    `${presentation ? reportAnswerHeaders(presentation) : legacyAnswerHeaders(showSuperpowers)}` +
    `<th scope="col" class="num">TUH</th><th scope="col" class="num">PPTUH</th><th scope="col" class="num">PPB</th>` +
    `${showAdvancement ? '<th scope="col">Advancement</th>' : ''}</tr></thead><tbody>${rows}</tbody></table></div>`
  );
}

function renderSection(report: CanonicalStandingsReport, section: StandingsReportSection): string {
  const carryover = section.carryover
    ? '<p class="meta">Includes canonical prior-stage carryover games for this field; each physical game is counted once.</p>'
    : '';
  const finalContext =
    section.kind === 'final' ? contextBlock('Finals & placement results', report.finalResults ?? []) : '';
  const tiebreakers = contextBlock('Tiebreaker results', section.contextGames ?? []);
  return (
    `<section id="${escapeHtml(section.id)}"><h2>${escapeHtml(section.title)}</h2>` +
    `<p class="meta">Scope: ${escapeHtml(section.scopeLabel)} · ${section.teams.length} teams</p>${carryover}` +
    `${sectionTable(report, section)}${finalContext}${tiebreakers}</section>`
  );
}

const reportStyle = [
  'body{font:15px/1.5 system-ui,-apple-system,sans-serif;color:#1f2933;margin:0 auto;max-width:1200px;padding:16px}',
  'nav ul{list-style:none;display:flex;flex-wrap:wrap;gap:4px 16px;margin:0 0 24px;padding:0 0 12px;border-bottom:2px solid #1f2933}',
  'h1{font-size:24px}h2{font-size:19px;margin-top:30px}h3{font-size:16px;margin-top:18px}',
  '.meta{color:#52606d}.table-wrap{overflow-x:auto}.context ul{padding-left:20px}',
  'table{border-collapse:collapse;width:100%;margin:12px 0 18px}',
  'th,td{border:1px solid #d7dde3;padding:5px 8px;text-align:left;white-space:nowrap}',
  'td.num,th.num{text-align:right}th{background:#f1f4f6}tr:nth-child(even){background:#fafbfc}',
  'footer{margin-top:32px;padding-top:12px;border-top:1px solid #d7dde3;color:#52606d;font-size:13px}',
  '.report-note{padding:9px 12px;border-left:3px solid #9aa5b1;background:#f1f4f6;color:#52606d}',
  '@media print{body{max-width:none}section{break-inside:avoid-page}.table-wrap{overflow:visible}}',
].join('');

/** Serialize an already-composed canonical standings report. No ranking or progression logic lives here. */
export function renderCanonicalStandingsReport(report: CanonicalStandingsReport): string {
  const statNav =
    '<nav aria-label="Stat reports"><ul><li><a href="index.html">Index</a></li><li><a href="standings.html">Standings</a></li>' +
    '<li><a href="individuals.html">Individuals</a></li><li><a href="games.html">Games</a></li><li><a href="rounds.html">Rounds</a></li>' +
    '<li><a href="teamdetail.html">Teams</a></li><li><a href="playerdetail.html">Players</a></li></ul></nav>';
  const sectionNav =
    report.sections.length > 1
      ? `<nav aria-label="Standings sections"><strong>Sections</strong><ul>${report.sections
          .map((section) => `<li><a href="#${escapeHtml(section.id)}">${escapeHtml(section.title)}</a></li>`)
          .join('')}</ul></nav>`
      : '';
  const body = report.sections.map((section) => renderSection(report, section)).join('');
  const mixed = report.presentation?.mixedDefinitionNote
    ? `<p class="report-note">${escapeHtml(report.presentation.mixedDefinitionNote)}</p>`
    : '';
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>Standings · ${escapeHtml(report.tournament.name)}</title><style>${reportStyle}</style></head><body>${statNav}` +
    `<h1>${escapeHtml(report.tournament.name)}</h1>${sectionNav}${mixed}${body || '<p class="meta">No standings.</p>'}` +
    `<footer>Generated ${escapeHtml(report.generatedAt)} · QBSheet stat report</footer></body></html>`
  );
}

/**
 * Add stable per-game row anchors to the legacy score-table page. This keeps exact standings
 * links valid until the richer box-score renderer replaces this page.
 */
export function addGameRowAnchors(page: string, games: readonly GameStatsRow[]): string {
  const bodyStart = page.indexOf('<tbody>');
  const bodyEnd = bodyStart >= 0 ? page.indexOf('</tbody>', bodyStart) : -1;
  if (bodyStart < 0 || bodyEnd < 0 || games.length === 0) return page;
  let index = 0;
  const body = page.slice(bodyStart, bodyEnd).replace(/<tr>/g, () => {
    const game = games[index++];
    return game ? `<tr id="${standingsGameAnchor(game.gameId)}">` : '<tr>';
  });
  return `${page.slice(0, bodyStart)}${body}${page.slice(bodyEnd)}`;
}
