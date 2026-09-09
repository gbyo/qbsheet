import {
  buildStatReportBundle as buildBaseStatReportBundle,
  type GameStatsRow,
  type StatReportPage,
  type StatsSnapshot,
} from './stats.js';
import type { RoundStatsRow } from './reportDetail.js';

function htmlEscape(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
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

const reportNav = [
  ['index.html', 'Index'],
  ['standings.html', 'Standings'],
  ['individuals.html', 'Individuals'],
  ['games.html', 'Games'],
  ['rounds.html', 'Rounds'],
  ['teamdetail.html', 'Teams'],
  ['playerdetail.html', 'Players'],
] as const;

const reportStyle = [
  'body{font:15px/1.5 system-ui,-apple-system,sans-serif;color:#1f2933;margin:0 auto;max-width:1100px;padding:16px}',
  'nav ul{list-style:none;display:flex;flex-wrap:wrap;gap:4px 16px;margin:0 0 24px;padding:0 0 12px;border-bottom:2px solid #1f2933}',
  'h1{font-size:24px}h2{font-size:19px;margin-top:28px}',
  '.meta{color:#52606d}.table-wrap{overflow-x:auto}.note{white-space:normal;min-width:16rem}',
  'table{border-collapse:collapse;width:100%;margin:12px 0 24px}',
  'caption{text-align:left;font-weight:600;padding:4px 0}',
  'th,td{border:1px solid #d7dde3;padding:5px 8px;text-align:left;white-space:nowrap}',
  'td.num,th.num{text-align:right}',
  'th{background:#f1f4f6}tbody tr:nth-child(even){background:#fafbfc}tfoot{font-weight:700;border-top:2px solid #52606d}',
  'footer{margin-top:32px;padding-top:12px;border-top:1px solid #d7dde3;color:#52606d;font-size:13px}',
  '@media print{body{max-width:none}section{break-inside:avoid}.table-wrap{overflow:visible}a{color:inherit;text-decoration:none}}',
].join('');

function reportPage(snapshot: StatsSnapshot, title: string, body: string): string {
  const nav = `<nav aria-label="Stat reports"><ul>${reportNav
    .map(([href, label]) => `<li><a href="${href}">${label}</a></li>`)
    .join('')}</ul></nav>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${htmlEscape(title)} · ${htmlEscape(snapshot.tournament.name)}</title><style>${reportStyle}</style></head><body>${nav}<h1>${htmlEscape(snapshot.tournament.name)}</h1>${body}<footer>Generated ${htmlEscape(snapshot.generatedAt)} · QBSheet stat report</footer></body></html>`;
}

function scopeNote(snapshot: StatsSnapshot): string {
  const extensions = snapshot.extensions ?? {};
  const scope = typeof extensions.scopeLabel === 'string' ? extensions.scopeLabel : 'Overall';
  return `<p class="meta">Scope: ${htmlEscape(scope)} · ${snapshot.teams.length} teams · ${snapshot.games.length} games.</p>`;
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

function gamesByRound(snapshot: StatsSnapshot): Array<{ roundId: string; roundName: string; games: GameStatsRow[] }> {
  const groups = new Map<string, { roundId: string; roundName: string; games: GameStatsRow[] }>();
  for (const game of snapshot.games) {
    const key = game.roundId ?? game.gameId;
    const group = groups.get(key) ?? {
      roundId: key,
      roundName: game.roundName ?? game.roundId ?? 'Games',
      games: [],
    };
    group.games.push(game);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function gamesPage(snapshot: StatsSnapshot): string {
  const showPacket = snapshot.games.some((game) => Boolean(game.packetName));
  const sections = gamesByRound(snapshot)
    .map((group) => {
      const rows = group.games
        .map((game) => {
          const score =
            game.teamOnePoints === undefined || game.teamTwoPoints === undefined
              ? '—'
              : `${game.teamOnePoints}–${game.teamTwoPoints}`;
          return (
            `<tr><td>${htmlEscape(game.teamOneName)} vs ${htmlEscape(game.teamTwoName)}</td>` +
            `<td class="num">${htmlEscape(score)}</td>` +
            `<td>${game.detail === 'partial' ? 'Partial stats' : 'Complete'}</td>` +
            `${showPacket ? `<td>${htmlEscape(game.packetName ?? '—')}</td>` : ''}</tr>`
          );
        })
        .join('');
      return (
        `<section id="round-${slugify(group.roundId)}" aria-label="${htmlEscape(group.roundName)}"><h2>${htmlEscape(group.roundName)}</h2>` +
        `<div class="table-wrap"><table><thead><tr><th scope="col">Matchup</th><th scope="col" class="num">Score</th><th scope="col">Detail</th>${showPacket ? '<th scope="col">Packet</th>' : ''}</tr></thead><tbody>${rows}</tbody></table></div></section>`
      );
    })
    .join('');
  const body = sections || '<p class="meta">No accepted games in this scope.</p>';
  return reportPage(snapshot, 'Games', `${scopeNote(snapshot)}${body}`);
}

interface RoundColumns {
  stage: boolean;
  superpower: boolean;
  power: boolean;
  neg: boolean;
  ppb: boolean;
  bonusConversion: boolean;
  packet: boolean;
  notes: boolean;
}

function roundColumns(rows: readonly RoundStatsRow[], total: RoundStatsRow | null | undefined): RoundColumns {
  const all = total ? [...rows, total] : [...rows];
  const phases = new Set(rows.map((row) => row.phaseId).filter((value): value is string => Boolean(value)));
  return {
    stage: phases.size > 1,
    superpower: all.some((row) => row.superpowerApplicable === true),
    power: all.some((row) => row.powerApplicable === true),
    neg: all.some((row) => row.negApplicable === true),
    ppb: all.some((row) => row.bonusApplicable === true),
    bonusConversion: all.some((row) => row.bonusConversionRate !== null),
    packet: rows.some((row) => Boolean(row.packetName)),
    notes: all.some((row) => row.notes.length > 0),
  };
}

function roundRow(row: RoundStatsRow, columns: RoundColumns, total = false): string {
  const label = total
    ? htmlEscape(row.roundName)
    : `<a href="games.html#round-${slugify(row.roundId)}">${htmlEscape(row.roundName)}</a>`;
  return (
    `<tr><${total ? 'th scope="row"' : 'td'}>${label}</${total ? 'th' : 'td'}>` +
    `${columns.stage ? `<td>${htmlEscape(row.phaseName ?? row.phaseId ?? '—')}</td>` : ''}` +
    `<td class="num">${row.games}</td>` +
    numberCell(row.pointsPerTeamPerXTuh, 1) +
    `${columns.superpower ? percentCell(row.superpowerRate) : ''}` +
    `${columns.power ? percentCell(row.powerRate) : ''}` +
    percentCell(row.tossupConversionRate) +
    `${columns.neg ? numberCell(row.negRatePerXTuh, 2) : ''}` +
    `${columns.ppb ? numberCell(row.ppb, 2) : ''}` +
    `${columns.bonusConversion ? percentCell(row.bonusConversionRate) : ''}` +
    `${columns.packet ? `<td>${total ? '—' : htmlEscape(row.packetName ?? '—')}</td>` : ''}` +
    `${columns.notes ? `<td class="note">${row.notes.length > 0 ? htmlEscape(row.notes.join(' ')) : 'Complete'}</td>` : ''}</tr>`
  );
}

function roundsPage(snapshot: StatsSnapshot): string {
  const rows = snapshot.rounds;
  if (!rows) {
    return reportPage(
      snapshot,
      'Rounds',
      `${scopeNote(snapshot)}<p class="meta">Round statistics are unavailable in this older snapshot. Regenerate the report from current Director data.</p>`,
    );
  }
  const total = snapshot.roundTotal;
  const columns = roundColumns(rows, total);
  const headers =
    '<th scope="col">Round</th>' +
    `${columns.stage ? '<th scope="col">Stage</th>' : ''}` +
    '<th scope="col" class="num">Games</th>' +
    '<th scope="col" class="num"><abbr title="Points per team normalized to the historical regulation tossup count">Pts/team/reg</abbr></th>' +
    `${columns.superpower ? '<th scope="col" class="num"><abbr title="Superpowers divided by positive tossup conversions">SP %</abbr></th>' : ''}` +
    `${columns.power ? '<th scope="col" class="num"><abbr title="Superpowers plus powers divided by positive tossup conversions">Power %</abbr></th>' : ''}` +
    '<th scope="col" class="num"><abbr title="Positive tossup conversions divided by exact tossups read">TU Conv %</abbr></th>' +
    `${columns.neg ? '<th scope="col" class="num"><abbr title="Negs normalized to the historical regulation tossup count">Negs/reg</abbr></th>' : ''}` +
    `${columns.ppb ? '<th scope="col" class="num"><abbr title="Bonus points divided by bonuses heard">PPB</abbr></th>' : ''}` +
    `${columns.bonusConversion ? '<th scope="col" class="num"><abbr title="Bonus points divided by the historical maximum points available on heard bonuses">Bonus Conv %</abbr></th>' : ''}` +
    `${columns.packet ? '<th scope="col">Packet</th>' : ''}` +
    `${columns.notes ? '<th scope="col">Data</th>' : ''}`;
  const bodyRows = rows.map((row) => roundRow(row, columns)).join('');
  const footer = total ? `<tfoot>${roundRow(total, columns, true)}</tfoot>` : '';
  const definitions =
    '<p class="meta">Pts/team/reg uses each game’s exact tossups read and the row’s common historical regulation length. TU Conv % is positive tossup conversions / tossups read. Power % is (superpowers + powers) / positive conversions. Negs/reg is negs normalized to regulation length. PPB is bonus points / bonuses heard. Overall percentages are recomputed from their numerators and denominators; — means required source detail is incomplete, unknown, or not comparable.</p>';
  const table = `<div class="table-wrap"><table><caption>Round statistics</caption><thead><tr>${headers}</tr></thead><tbody>${bodyRows}</tbody>${footer}</table></div>`;
  return reportPage(snapshot, 'Rounds', `${scopeNote(snapshot)}${definitions}${table}`);
}

/**
 * Render the ordinary static report bundle, replacing only the Games and
 * Rounds pages with the round-aware canonical views. No competitive formula
 * lives here: all rates and knownness decisions arrive on `snapshot.rounds`.
 */
export function buildStatReportBundle(snapshot: StatsSnapshot): StatReportPage[] {
  return buildBaseStatReportBundle(snapshot).map((page) => {
    if (page.name === 'games.html') return { ...page, content: gamesPage(snapshot) };
    if (page.name === 'rounds.html') return { ...page, content: roundsPage(snapshot) };
    return page;
  });
}
