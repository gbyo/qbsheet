import {
  answerCount,
  reportNumber,
  reportPageFiles,
  reportPageLabels,
  reportPresentationOf,
  reportUnknown,
  type ReportPresentation,
} from './reportPresentation.js';
import type { GameStatsRow, PlayerStatsRow, StatsSnapshot, TeamStatsRow } from './stats.js';

export function reportEscape(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function reportSlug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/g, '')
      .replace(/-+$/g, '') || 'item'
  );
}

/** Entity anchors are stable ID-only URLs: rank/display changes never break links. */
export function reportTeamAnchor(row: Pick<TeamStatsRow, 'teamId'>): string {
  return `team-${reportSlug(row.teamId)}`;
}

export function reportPlayerAnchor(row: Pick<PlayerStatsRow, 'playerId'>): string {
  return `player-${reportSlug(row.playerId)}`;
}

/** Game anchors are ID-based so rematches and duplicate display names cannot collide. */
export function reportGameAnchor(game: Pick<GameStatsRow, 'gameId'>): string {
  return `game-${reportSlug(game.gameId)}`;
}

export function reportRoundAnchor(roundId: string): string {
  return `round-${reportSlug(roundId)}`;
}

const reportStyle = [
  'body{font:15px/1.5 system-ui,-apple-system,sans-serif;color:#1f2933;margin:0 auto;max-width:1120px;padding:16px}',
  'nav ul{list-style:none;display:flex;flex-wrap:wrap;gap:4px 16px;margin:0 0 20px;padding:0 0 12px;border-bottom:2px solid #1f2933}',
  'h1{font-size:24px;margin-bottom:4px}h2{font-size:19px;margin-top:28px}h3{font-size:16px;margin-top:22px}',
  '.event-meta{display:flex;flex-wrap:wrap;gap:4px 18px;margin:0 0 18px;color:#52606d}.meta{color:#52606d}',
  '.report-note{padding:9px 12px;border-left:3px solid #9aa5b1;background:#f1f4f6;color:#52606d}',
  '.table-wrap{overflow-x:auto}.game{margin:28px 0 40px}.game-header{border-bottom:2px solid #1f2933;padding-bottom:8px}',
  '.score{font-size:18px;font-weight:650}.detail-note{padding:10px 12px;background:#f1f4f6;border-left:3px solid #9aa5b1}',
  '.team-box{margin:20px 0}.bonus-summary{display:flex;flex-wrap:wrap;gap:8px 18px;margin:-10px 0 20px;color:#52606d}',
  'table{border-collapse:collapse;width:100%;margin:12px 0 24px}',
  'caption{text-align:left;font-weight:600;padding:4px 0}',
  'th,td{border:1px solid #d7dde3;padding:5px 8px;text-align:left;white-space:nowrap}',
  'td.num,th.num{text-align:right}',
  'th{background:#f1f4f6}tbody tr:nth-child(even){background:#fafbfc}tfoot{font-weight:650}',
  'footer{margin-top:32px;padding-top:12px;border-top:1px solid #d7dde3;color:#52606d;font-size:13px}',
  '@media print{body{max-width:none;padding:8px}.game-compact{break-inside:avoid-page}.game-header{break-after:avoid}.table-wrap{overflow:visible}nav{display:none}}',
].join('');

function dateOnly(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return value;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function reportEventMeta(presentation: ReportPresentation): string {
  const metadata = presentation.metadata;
  const start = dateOnly(metadata.startDate);
  const end = dateOnly(metadata.endDate);
  const date = start && end && end !== start ? `${start} – ${end}` : start;
  const items = [
    date ? `Date: ${date}` : undefined,
    metadata.venue ? `Site: ${metadata.venue}` : undefined,
    metadata.questionSet ? `Question set: ${metadata.questionSet}` : undefined,
    metadata.organizer ? `Organizer: ${metadata.organizer}` : undefined,
    `Scope: ${metadata.scopeLabel}`,
  ].filter((value): value is string => Boolean(value));
  return `<div class="event-meta">${items.map((item) => `<span>${reportEscape(item)}</span>`).join('')}</div>`;
}

export function renderReportPage(snapshot: StatsSnapshot, title: string, body: string): string {
  const presentation = reportPresentationOf(snapshot);
  const nav = `<nav aria-label="Stat reports"><ul><li><a href="index.html">Index</a></li>${presentation.options.pages
    .map((page) => `<li><a href="${reportPageFiles[page]}">${reportEscape(reportPageLabels[page])}</a></li>`)
    .join('')}</ul></nav>`;
  const mixed = presentation.mixedDefinitionNote
    ? `<p class="report-note">${reportEscape(presentation.mixedDefinitionNote)}</p>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${reportEscape(title)} · ${reportEscape(presentation.metadata.tournamentName)}</title><style>${reportStyle}</style></head><body>${nav}<h1>${reportEscape(presentation.metadata.tournamentName)}</h1>${reportEventMeta(presentation)}${mixed}${body}<footer>Generated ${reportEscape(presentation.metadata.generatedAt)} · QBSheet stat report</footer></body></html>`;
}

export function reportNumberCell(value: number | null | undefined, digits?: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return `<td class="num">${reportUnknown}</td>`;
  return `<td class="num">${digits === undefined ? String(value) : value.toFixed(digits)}</td>`;
}

/**
 * Fractional games played as Director renders it: whole games stay whole, partial
 * games round to two decimals. Callers gate unknown GP to null first; this shapes
 * known values only, so every printable page shares one GP vocabulary (#746).
 */
export function reportGamesPlayedCell(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return `<td class="num">${reportUnknown}</td>`;
  return `<td class="num">${Number.isInteger(value) ? String(value) : value.toFixed(2)}</td>`;
}

/**
 * Tri-state eligibility cells (#749): an explicit Yes/No never masquerades unknown
 * metadata as a claim, and unknown never renders as a negative.
 */
export function reportEligibilityCell(value: boolean | null | undefined): string {
  if (value === true) return '<td class="num">Yes</td>';
  if (value === false) return '<td class="num">No</td>';
  return `<td class="num">${reportUnknown}</td>`;
}

export function reportAnswerHeaders(presentation: ReportPresentation): string {
  return presentation.answerColumns
    .map((column) => {
      const valueLabel =
        column.pointValue !== null
          ? String(column.pointValue)
          : column.pointValues.length > 1
            ? column.pointValues.join('/')
            : '';
      const visibleLabel = valueLabel ? `${column.shortLabel} (${valueLabel})` : column.shortLabel;
      const detail =
        column.pointValue !== null
          ? `${column.pointValue} pts`
          : column.pointValues.length > 1
            ? `mixed values: ${column.pointValues.join(', ')}`
            : 'point value unavailable';
      return `<th scope="col" class="num" title="${reportEscape(`${column.label} · ${detail}`)}">${reportEscape(visibleLabel)}</th>`;
    })
    .join('');
}

export function reportAnswerCells(
  row: { answerCounts?: import('./reportPresentation.js').ReportAnswerCounts },
  presentation: ReportPresentation,
): string {
  return presentation.answerColumns.map((column) => reportNumberCell(answerCount(row, column.key))).join('');
}

export function reportPointsMetricLabel(presentation: ReportPresentation): string {
  if (presentation.options.pointsMetric === 'pointsPerX') {
    return presentation.pointsNormalization?.label ?? 'Pts/X';
  }
  return 'PPG';
}

export function reportPointsMetricValue(
  row: { ppg: number | null; pointsPerX?: number | null },
  presentation: ReportPresentation,
): string {
  return presentation.options.pointsMetric === 'pointsPerX'
    ? reportNumber(row.pointsPerX, presentation.precision.rate)
    : reportNumber(row.ppg, presentation.precision.ppg);
}

export function reportScopeNote(snapshot: StatsSnapshot): string {
  const presentation = reportPresentationOf(snapshot);
  return `<p class="meta">${snapshot.teams.length} teams · ${snapshot.games.length} games · Scope: ${reportEscape(presentation.metadata.scopeLabel)}.</p>`;
}
