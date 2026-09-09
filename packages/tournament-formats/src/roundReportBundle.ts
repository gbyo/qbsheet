import { buildStatReportBundle as buildBaseStatReportBundle, type StatReportPage } from './stats.js';
import { deriveRoundStats, type RoundStatsReport, type RoundReportRow } from './roundStats.js';
import type { GameStatsRow, StatsSnapshot } from './stats.js';

function htmlEscape(value: unknown): string {
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

function roundAnchor(game: Pick<GameStatsRow, 'gameId' | 'roundId'>): string {
  return `round-${slugify(game.roundId ?? game.gameId)}`;
}

function rowAnchor(row: RoundReportRow): string | null {
  return row.roundId ? `round-${slugify(row.roundId)}` : null;
}

function numberCell(value: number | null | undefined, digits = 1): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `<td class="num">${value.toFixed(digits)}</td>`
    : '<td class="num">—</td>';
}

function percentCell(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `<td class="num">${(value * 100).toFixed(1)}%</td>`
    : '<td class="num">—</td>';
}

function gamesCell(row: RoundReportRow): string {
  if (row.results === row.games) return `<td class="num">${row.games}</td>`;
  const excluded = row.results - row.games;
  const title = `${row.results} accepted result${row.results === 1 ? '' : 's'}; ${excluded} pure forfeit${excluded === 1 ? '' : 's'} excluded from scoring denominators`;
  return `<td class="num" title="${htmlEscape(title)}">${row.games}</td>`;
}

function roundNameCell(row: RoundReportRow): string {
  const anchor = rowAnchor(row);
  const name = htmlEscape(row.roundName);
  return anchor ? `<td><a href="games.html#${anchor}">${name}</a></td>` : `<td>${name}</td>`;
}

function stageCell(row: RoundReportRow): string {
  return `<td>${htmlEscape(row.phaseName ?? row.phaseId ?? '—')}</td>`;
}

function packetCell(row: RoundReportRow): string {
  return `<td>${htmlEscape(row.packetName ?? '—')}</td>`;
}

function metricHeaders(report: RoundStatsReport): string {
  return (
    '<th scope="col">Round</th>' +
    (report.showPhase ? '<th scope="col">Stage</th>' : '') +
    '<th scope="col" class="num">Games</th>' +
    '<th scope="col" class="num"><abbr title="Average team score normalized per game to the round’s regulation tossup count X.">Pts/team/X TUH</abbr></th>' +
    (report.showSuperpowers
      ? '<th scope="col" class="num"><abbr title="Superpowers divided by all positive tossup conversions.">SP %</abbr></th>'
      : '') +
    (report.showPowers
      ? '<th scope="col" class="num"><abbr title="Powers divided by all positive tossup conversions.">Power %</abbr></th>'
      : '') +
    '<th scope="col" class="num"><abbr title="Positive tossup conversions divided by tossups read.">TU Conv %</abbr></th>' +
    '<th scope="col" class="num"><abbr title="Negs per regulation tossup count X.">Negs/X</abbr></th>' +
    (report.showBonuses
      ? '<th scope="col" class="num"><abbr title="Total bonus points divided by total bonuses heard.">PPB</abbr></th>'
      : '') +
    (report.showBonusConversion
      ? '<th scope="col" class="num"><abbr title="Bonus points divided by the maximum possible points on the bonuses heard, using each game’s own bonus definition.">Bonus Conv %</abbr></th>'
      : '') +
    (report.rows.some((row) => row.packetName !== null) ? '<th scope="col">Packet</th>' : '')
  );
}

function statsCells(row: RoundReportRow, report: RoundStatsReport): string {
  return (
    roundNameCell(row) +
    (report.showPhase ? stageCell(row) : '') +
    gamesCell(row) +
    numberCell(row.pointsPerTeamPerXTuh, 1) +
    (report.showSuperpowers ? percentCell(row.superpowerRate) : '') +
    (report.showPowers ? percentCell(row.powerRate) : '') +
    percentCell(row.tossupConversionRate) +
    numberCell(row.negRatePerXTuh, 2) +
    (report.showBonuses ? numberCell(row.ppb, 2) : '') +
    (report.showBonusConversion ? percentCell(row.bonusConversionRate) : '') +
    (report.rows.some((entry) => entry.packetName !== null) ? packetCell(row) : '')
  );
}

function totalCells(report: RoundStatsReport): string {
  const row = report.total;
  return (
    '<th scope="row">Overall</th>' +
    (report.showPhase ? '<td>All stages</td>' : '') +
    gamesCell(row) +
    numberCell(row.pointsPerTeamPerXTuh, 1) +
    (report.showSuperpowers ? percentCell(row.superpowerRate) : '') +
    (report.showPowers ? percentCell(row.powerRate) : '') +
    percentCell(row.tossupConversionRate) +
    numberCell(row.negRatePerXTuh, 2) +
    (report.showBonuses ? numberCell(row.ppb, 2) : '') +
    (report.showBonusConversion ? percentCell(row.bonusConversionRate) : '') +
    (report.rows.some((entry) => entry.packetName !== null) ? '<td>—</td>' : '')
  );
}

function roundReportHtml(report: RoundStatsReport): string {
  if (report.rows.length === 0) return '<p class="meta">No accepted games are in this report scope.</p>';
  const rows = report.rows.map((row) => `<tr>${statsCells(row, report)}</tr>`).join('');
  const partial = report.rows.some((row) => row.partial) || report.total.partial;
  const forfeits = report.rows.reduce((sum, row) => sum + row.excludedForfeits, 0);
  const notes = [
    'Rates use aggregate numerators and denominators; the Overall row is recomputed from all games rather than averaging round percentages.',
    '“—” means a required denominator or detailed field is not known for every included game; QBSheet does not report a known-subset value as the whole round.',
    ...(forfeits > 0
      ? [
          `${forfeits} pure forfeit${forfeits === 1 ? '' : 's'} count as results but are excluded from scoring and conversion denominators.`,
        ]
      : []),
    ...(report.hasMixedRegulation
      ? [
          'The report scope contains different regulation tossup counts, so definition-dependent Overall per-X metrics are unavailable.',
        ]
      : []),
    ...(partial
      ? ['At least one row has partial source detail; unavailable cells are intentionally shown as —.']
      : []),
  ];
  return (
    '<div class="table-wrap"><table><caption>Round statistics</caption>' +
    `<thead><tr>${metricHeaders(report)}</tr></thead><tbody>${rows}</tbody>` +
    `<tfoot><tr>${totalCells(report)}</tr></tfoot></table></div>` +
    `<p class="meta">${notes.map(htmlEscape).join(' ')}</p>`
  );
}

function replaceRoundsBody(page: StatReportPage, report: RoundStatsReport): StatReportPage {
  const scopeStart = page.content.indexOf('<p class="meta">');
  const scopeEnd = scopeStart >= 0 ? page.content.indexOf('</p>', scopeStart) : -1;
  const footer = page.content.lastIndexOf('<footer>');
  if (scopeEnd < 0 || footer < 0 || footer <= scopeEnd) return page;
  return {
    ...page,
    content: `${page.content.slice(0, scopeEnd + 4)}${roundReportHtml(report)}${page.content.slice(footer)}`,
  };
}

/**
 * Add one stable target per round to the Games/Scoreboard table. The printable
 * Round Report links here instead of duplicating the old grouped score list.
 */
function addGameRoundAnchors(page: StatReportPage, games: readonly GameStatsRow[]): StatReportPage {
  let content = page.content;
  const anchored = new Set<string>();
  for (const game of games) {
    const key = game.roundId ?? game.gameId;
    if (anchored.has(key)) continue;
    anchored.add(key);
    const name = htmlEscape(game.roundName ?? '');
    const needle = `<tr><td>${name}</td>`;
    const replacement = `<tr id="${roundAnchor(game)}"><td>${name}</td>`;
    content = content.replace(needle, replacement);
  }
  return { ...page, content };
}

/**
 * Build the static bundle while keeping the legacy score list in Games and
 * replacing rounds.html with the already-derived canonical statistical table.
 * No competitive aggregate is calculated by the string-building code here.
 */
export function buildRoundAwareStatReportBundle(snapshot: StatsSnapshot): StatReportPage[] {
  const report = snapshot.roundStats ?? deriveRoundStats(snapshot.games);
  return buildBaseStatReportBundle(snapshot).map((page) => {
    if (page.name === 'rounds.html') return replaceRoundsBody(page, report);
    if (page.name === 'games.html') return addGameRoundAnchors(page, snapshot.games);
    return page;
  });
}
