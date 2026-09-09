import type { GameStatsRow, PlayerStatsRow, StatsSnapshot, TeamStatsRow } from './stats.js';

interface ReportLink {
  href: string;
  label: string;
}

const reportNav: readonly ReportLink[] = [
  { href: 'index.html', label: 'Index' },
  { href: 'standings.html', label: 'Standings' },
  { href: 'individuals.html', label: 'Individuals' },
  { href: 'games.html', label: 'Games' },
  { href: 'rounds.html', label: 'Rounds' },
  { href: 'teamdetail.html', label: 'Teams' },
  { href: 'playerdetail.html', label: 'Players' },
];

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

/** Keep these formulas identical to the original bundle's existing anchors. */
export function reportTeamAnchor(row: Pick<TeamStatsRow, 'rank' | 'teamId'>): string {
  return `team-${row.rank}-${reportSlug(row.teamId)}`;
}

export function reportPlayerAnchor(row: Pick<PlayerStatsRow, 'rank' | 'playerId'>): string {
  return `player-${row.rank}-${reportSlug(row.playerId)}`;
}

/** Game anchors are ID-based so rematches and duplicate display names cannot collide. */
export function reportGameAnchor(game: Pick<GameStatsRow, 'gameId'>): string {
  return `game-${reportSlug(game.gameId)}`;
}

export function reportRoundAnchor(roundId: string): string {
  return `round-${reportSlug(roundId)}`;
}

const reportStyle = [
  'body{font:15px/1.5 system-ui,-apple-system,sans-serif;color:#1f2933;margin:0 auto;max-width:1040px;padding:16px}',
  'nav ul{list-style:none;display:flex;flex-wrap:wrap;gap:4px 16px;margin:0 0 24px;padding:0 0 12px;border-bottom:2px solid #1f2933}',
  'h1{font-size:24px}h2{font-size:19px;margin-top:28px}h3{font-size:16px;margin-top:22px}',
  '.meta{color:#52606d}.table-wrap{overflow-x:auto}.game{margin:28px 0 40px}.game-header{border-bottom:2px solid #1f2933;padding-bottom:8px}',
  '.score{font-size:18px;font-weight:650}.detail-note{padding:10px 12px;background:#f1f4f6;border-left:3px solid #9aa5b1}',
  '.team-box{margin:20px 0}.bonus-summary{display:flex;flex-wrap:wrap;gap:8px 18px;margin:-10px 0 20px;color:#52606d}',
  'table{border-collapse:collapse;width:100%;margin:12px 0 24px}',
  'caption{text-align:left;font-weight:600;padding:4px 0}',
  'th,td{border:1px solid #d7dde3;padding:5px 8px;text-align:left;white-space:nowrap}',
  'td.num,th.num{text-align:right}',
  'th{background:#f1f4f6}tbody tr:nth-child(even){background:#fafbfc}tfoot{font-weight:650}',
  'footer{margin-top:32px;padding-top:12px;border-top:1px solid #d7dde3;color:#52606d;font-size:13px}',
  '@media print{body{max-width:none;padding:8px}.game{break-inside:avoid-page}.table-wrap{overflow:visible}nav{display:none}}',
].join('');

export function renderReportPage(snapshot: StatsSnapshot, title: string, body: string): string {
  const nav = `<nav aria-label="Stat reports"><ul>${reportNav
    .map((link) => `<li><a href="${link.href}">${reportEscape(link.label)}</a></li>`)
    .join('')}</ul></nav>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${reportEscape(title)} · ${reportEscape(snapshot.tournament.name)}</title><style>${reportStyle}</style></head><body>${nav}<h1>${reportEscape(snapshot.tournament.name)}</h1>${body}<footer>Generated ${reportEscape(snapshot.generatedAt)} · QBSheet stat report</footer></body></html>`;
}

export function reportNumberCell(value: number | null | undefined, digits?: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '<td class="num">—</td>';
  return `<td class="num">${digits === undefined ? String(value) : value.toFixed(digits)}</td>`;
}

export function reportScopeNote(snapshot: StatsSnapshot): string {
  const extensions = snapshot.extensions ?? {};
  const scope = typeof extensions.scopeLabel === 'string' ? extensions.scopeLabel : 'Overall';
  return `<p class="meta">Scope: ${reportEscape(scope)} · ${snapshot.teams.length} teams · ${snapshot.games.length} games.</p>`;
}
