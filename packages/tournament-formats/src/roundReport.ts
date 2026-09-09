import type { StatsSnapshot } from './stats.js';
import {
  renderReportPage,
  reportEscape,
  reportGameAnchor,
  reportNumberCell,
  reportRoundAnchor,
  reportScopeNote,
} from './reportHtml.js';

export interface RoundReportMetricApplicability {
  power: boolean;
  superpower: boolean;
  bonuses: boolean;
  bouncebacks: boolean;
  lightning: boolean;
}

/**
 * One already-derived row in the printable Round Report.
 *
 * The serializer deliberately receives the final rates instead of their component counts. Competitive
 * formulas live in Director's canonical report adapter, where accepted-game evidence and scope are
 * available; this package only formats the result.
 */
export interface RoundReportRow {
  roundId: string;
  roundName: string;
  phaseId?: string;
  phaseName?: string;
  packetLabel: string | null;
  gameIds: string[];
  /** Accepted results in this scope, including administrative forfeits. */
  games: number;
  /** Results that contain actual played scoring data and therefore enter scoring denominators. */
  playedGames: number;
  detailGames: number;
  definitionGames: number;
  /** Common regulation length, or null when historical games use different values / lack evidence. */
  regulationTossups: number | null;
  mixedDefinitions: boolean;
  pointsPerTeamPerXTuh: number | null;
  powerRate: number | null;
  superpowerRate: number | null;
  tossupConversionRate: number | null;
  negRatePerXTuh: number | null;
  ppb: number | null;
  bonusConversionRate: number | null;
  bouncebackConversionRate: number | null;
  lightningPointsPerTeamPerGame: number | null;
  applicability: RoundReportMetricApplicability;
}

export interface RoundReportData {
  scopeLabel: string;
  rows: RoundReportRow[];
  /** Recomputed from the report scope's game numerators/denominators; never a mean of row rates. */
  total: RoundReportRow;
}

declare module './stats.js' {
  interface StatsSnapshot {
    roundReport?: RoundReportData;
  }
}

function percent(value: number | null): string {
  return value === null || !Number.isFinite(value)
    ? '<td class="num">—</td>'
    : `<td class="num">${(value * 100).toFixed(1)}%</td>`;
}

function packetCell(value: string | null): string {
  return `<td>${value ? reportEscape(value) : '—'}</td>`;
}

function coverage(row: RoundReportRow): string {
  const pieces: string[] = [];
  if (row.detailGames < row.playedGames) pieces.push(`${row.detailGames}/${row.playedGames} detail`);
  if (row.definitionGames < row.playedGames)
    pieces.push(`${row.definitionGames}/${row.playedGames} definitions`);
  if (row.mixedDefinitions) pieces.push('mixed rules');
  return pieces.length > 0 ? pieces.join(' · ') : 'Complete';
}

function roundLink(row: RoundReportRow): string {
  if (row.roundId === 'report-total') return '<strong>Tournament total</strong>';
  return `<a href="games.html#${reportRoundAnchor(row.roundId)}">${reportEscape(row.roundName)}</a>`;
}

function rowHtml(
  row: RoundReportRow,
  options: {
    stage: boolean;
    power: boolean;
    superpower: boolean;
    bonuses: boolean;
    bouncebacks: boolean;
    lightning: boolean;
  },
): string {
  const gameLink =
    row.roundId === 'report-total' || row.gameIds.length === 0
      ? String(row.games)
      : `<a href="games.html#${reportGameAnchor({ gameId: row.gameIds[0]! })}">${row.games}</a>`;
  return `<tr><th scope="row">${roundLink(row)}</th>${
    options.stage ? `<td>${reportEscape(row.phaseName ?? row.phaseId ?? '—')}</td>` : ''
  }<td class="num">${gameLink}</td><td class="num">${
    row.regulationTossups === null ? (row.mixedDefinitions ? 'Mixed' : '—') : row.regulationTossups
  }</td>${reportNumberCell(row.pointsPerTeamPerXTuh, 1)}${
    options.power ? percent(row.powerRate) : ''
  }${options.superpower ? percent(row.superpowerRate) : ''}${percent(row.tossupConversionRate)}${
    row.negRatePerXTuh === null
      ? '<td class="num">—</td>'
      : `<td class="num">${row.negRatePerXTuh.toFixed(2)}</td>`
  }${options.bonuses ? reportNumberCell(row.ppb, 2) : ''}${
    options.bonuses ? percent(row.bonusConversionRate) : ''
  }${options.bouncebacks ? percent(row.bouncebackConversionRate) : ''}${
    options.lightning ? reportNumberCell(row.lightningPointsPerTeamPerGame, 1) : ''
  }${packetCell(row.packetLabel)}<td>${reportEscape(coverage(row))}</td></tr>`;
}

/** Render the true round-statistics page. No statistical formulas live here. */
export function renderRoundReport(snapshot: StatsSnapshot): string {
  const report = snapshot.roundReport;
  if (!report) {
    return renderReportPage(
      snapshot,
      'Round Report',
      '<h2>Round Report</h2><p class="detail-note">Round statistics are unavailable for this snapshot.</p>',
    );
  }
  const allRows = [...report.rows, report.total];
  const stage = new Set(report.rows.map((row) => row.phaseId).filter(Boolean)).size > 1;
  const power = allRows.some((row) => row.applicability.power);
  const superpower = allRows.some((row) => row.applicability.superpower);
  const bonuses = allRows.some((row) => row.applicability.bonuses);
  const bouncebacks = allRows.some((row) => row.applicability.bouncebacks);
  const lightning = allRows.some((row) => row.applicability.lightning);

  const header = `<thead><tr><th scope="col">Round</th>${stage ? '<th scope="col">Stage</th>' : ''}<th scope="col" class="num">Games</th><th scope="col" class="num">Reg TU</th><th scope="col" class="num">Pts/team/X TU</th>${
    power ? '<th scope="col" class="num">Power %</th>' : ''
  }${superpower ? '<th scope="col" class="num">Superpower %</th>' : ''}<th scope="col" class="num">TU Conv %</th><th scope="col" class="num">Negs/X</th>${
    bonuses ? '<th scope="col" class="num">PPB</th><th scope="col" class="num">Bonus Conv %</th>' : ''
  }${bouncebacks ? '<th scope="col" class="num">Bounceback Conv %</th>' : ''}${
    lightning ? '<th scope="col" class="num">Lightning/team/game</th>' : ''
  }<th scope="col">Packet</th><th scope="col">Coverage</th></tr></thead>`;

  const body = report.rows.map((row) => rowHtml(row, { stage, power, superpower, bonuses, bouncebacks, lightning })).join('');
  const total = rowHtml(report.total, { stage, power, superpower, bonuses, bouncebacks, lightning });
  const notes = [
    '<strong>Pts/team/X TU</strong> normalizes each played game to that game’s own regulation tossup count before combining team scores.',
    '<strong>TU Conv %</strong> is positive tossup conversions divided by tossups read; powers, superpowers, and ordinary gets are conversions. Overtime is included when it is included in the accepted game’s tossups-read total.',
    '<strong>Power %</strong> is power conversions divided by positive conversions when a historical definition identifies a power tier.',
    '<strong>Negs/X</strong> is total negs divided by tossups read and scaled to that game’s own regulation X.',
    '<strong>PPB</strong> is total controlled bonus points divided by bonuses heard. Missing detail makes the whole affected aggregate unknown rather than a known-subset statistic.',
    'Administrative forfeits count in Games but do not enter scoring denominators unless actual played statistics exist.',
    'Historical rule-dependent metrics use each accepted game’s persisted QBJ scoring definition. They never fall back to the tournament’s current defaults; missing or incompatible evidence is shown as —.',
  ];

  return renderReportPage(
    snapshot,
    'Round Report',
    `<h2>Round Report</h2>${reportScopeNote(snapshot)}<div class="table-wrap"><table>${header}<tbody>${body}</tbody><tfoot>${total}</tfoot></table></div><div class="detail-note"><strong>Definitions</strong><ul>${notes
      .map((note) => `<li>${note}</li>`)
      .join('')}</ul></div>`,
  );
}
