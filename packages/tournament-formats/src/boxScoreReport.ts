import type { GamePlayerStatsRow, GameTeamStatsRow } from './reportDetail.js';
import { reportPercent, reportPresentationOf, type ReportPresentation } from './reportPresentation.js';
import {
  buildStatReportBundle,
  type GameStatsRow,
  type StatReportPage,
  type StatsSnapshot,
} from './stats.js';
import {
  renderReportPage,
  reportAnswerCells,
  reportAnswerHeaders,
  reportEscape,
  reportGameAnchor,
  reportNumberCell,
  reportRoundAnchor,
  reportScopeNote,
} from './reportHtml.js';

function scoreText(game: GameStatsRow): string {
  const left = typeof game.teamOnePoints === 'number' ? String(game.teamOnePoints) : '—';
  const right = typeof game.teamTwoPoints === 'number' ? String(game.teamTwoPoints) : '—';
  return `${left}–${right}`;
}

function detailKnown(team: GameTeamStatsRow | undefined): boolean {
  return Boolean(
    team &&
    [
      team.superpowers,
      team.powers,
      team.gets,
      team.negs,
      team.tossupsHeard,
      team.bonusesHeard,
      team.bonusPoints,
      team.bouncebacks,
      team.lightningPoints,
      // A known number is detail; an omitted field (legacy/imported rows) is not.
    ].some((value) => typeof value === 'number'),
  );
}

function playerRows(players: readonly GamePlayerStatsRow[], presentation: ReportPresentation): string {
  return players
    .map(
      (player) =>
        `<tr><td>${reportEscape(player.playerName)}</td>` +
        `${reportNumberCell(player.tossupsHeard)}${reportAnswerCells(player, presentation)}` +
        `${reportNumberCell(player.points)}</tr>`,
    )
    .join('');
}

function teamBox(game: GameStatsRow, team: GameTeamStatsRow, presentation: ReportPresentation): string {
  const players = (game.playerStats ?? []).filter((player) => player.teamId === team.teamId);
  const columns = 3 + presentation.answerColumns.length;
  const playerBody =
    players.length > 0
      ? playerRows(players, presentation)
      : `<tr><td colspan="${columns}" class="meta">Player-level statistics unavailable.</td></tr>`;
  const partsHeard = typeof team.bouncebackPartsHeard === 'number' ? team.bouncebackPartsHeard : null;
  const partsConverted =
    typeof team.bouncebackPartsConverted === 'number' ? team.bouncebackPartsConverted : null;
  const bouncebackSummary =
    presentation.applicability.bonuses && presentation.applicability.bouncebacks
      ? `${typeof team.bouncebacks === 'number' ? `<span>Bounceback points: <strong>${team.bouncebacks}</strong></span>` : ''}` +
        `${partsHeard !== null ? `<span>Bounceback parts heard: <strong>${partsHeard}</strong></span>` : ''}` +
        `${
          partsHeard !== null && partsConverted !== null && partsHeard > 0
            ? `<span>BB %: <strong>${reportPercent(partsConverted / partsHeard, 1)}</strong></span>`
            : ''
        }`
      : '';
  const lightningSummary =
    typeof team.lightningPoints === 'number'
      ? `<span>Lightning points: <strong>${team.lightningPoints}</strong></span>`
      : '';
  const bonusSummary = presentation.applicability.bonuses
    ? `<div class="bonus-summary"><span>Bonuses heard: <strong>${reportEscape(team.bonusesHeard ?? '—')}</strong></span>` +
      `<span>Bonus points: <strong>${reportEscape(team.bonusPoints ?? '—')}</strong></span>` +
      `<span>PPB: <strong>${typeof team.ppb === 'number' ? team.ppb.toFixed(presentation.precision.ppb) : '—'}</strong></span>` +
      `${bouncebackSummary}${lightningSummary}</div>`
    : `${lightningSummary ? `<div class="bonus-summary">${lightningSummary}</div>` : ''}`;

  return (
    `<section class="team-box" aria-label="${reportEscape(team.teamName)} box score"><h3>${reportEscape(team.teamName)}</h3>` +
    `<div class="table-wrap"><table><thead><tr><th scope="col">Player</th><th scope="col" class="num">TUH</th>` +
    `${reportAnswerHeaders(presentation)}<th scope="col" class="num">Pts</th></tr></thead>` +
    `<tbody>${playerBody}</tbody><tfoot><tr><td>Team total</td>${reportNumberCell(team.tossupsHeard)}` +
    `${reportAnswerCells(team, presentation)}${reportNumberCell(team.points)}</tr></tfoot></table></div>${bonusSummary}</section>`
  );
}

function gameMeta(game: GameStatsRow, presentation: ReportPresentation): string {
  const items: string[] = [];
  if (presentation.applicability.stage && (game.phaseName ?? game.phaseId))
    items.push(`Stage: ${reportEscape(game.phaseName ?? game.phaseId ?? '')}`);
  if (presentation.applicability.packet && game.packetName)
    items.push(`Packet: ${reportEscape(game.packetName)}`);
  items.push(`Tossups read: ${typeof game.tossupsRead === 'number' ? game.tossupsRead : '—'}`);
  if (
    presentation.applicability.overtime &&
    typeof game.overtimeTossupsRead === 'number' &&
    game.overtimeTossupsRead > 0
  ) {
    items.push(`Overtime tossups: ${game.overtimeTossupsRead}`);
  }
  if (game.forfeitedTeamId) {
    const forfeitingName =
      game.forfeitedTeamId === game.teamOneId
        ? game.teamOneName
        : game.forfeitedTeamId === game.teamTwoId
          ? game.teamTwoName
          : game.forfeitedTeamId;
    items.push(`Forfeit: ${reportEscape(forfeitingName)} forfeited`);
  } else if (game.status === 'forfeit') {
    items.push('Forfeit');
  } else if (game.winnerId === game.teamOneId || game.winnerId === game.teamTwoId) {
    const winnerName = game.winnerId === game.teamOneId ? game.teamOneName : game.teamTwoName;
    items.push(`Winner: ${reportEscape(winnerName)}`);
  } else if (typeof game.teamOnePoints === 'number' && game.teamOnePoints === game.teamTwoPoints) {
    items.push('Result: Tie');
  }
  if (game.detail === 'partial') items.push('Partial detailed statistics');
  return items.length > 0 ? `<p class="meta">${items.join(' · ')}</p>` : '';
}

/**
 * A box score with this many player lines or fewer fits comfortably on one
 * printed page, so print CSS keeps it together. Larger box scores may break
 * across pages rather than leaving huge blank areas.
 */
const COMPACT_BOX_SCORE_PLAYER_LINES = 10;

function gameSection(game: GameStatsRow, presentation: ReportPresentation): string {
  const teamStats = game.teamStats ?? [];
  const anyDetail = teamStats.some(detailKnown);
  const detail = anyDetail
    ? teamStats.map((team) => teamBox(game, team, presentation)).join('')
    : '<p class="detail-note">Detailed statistics unavailable for this result.</p>';
  const compact = (game.playerStats ?? []).length <= COMPACT_BOX_SCORE_PLAYER_LINES;
  return (
    `<section class="game${compact ? ' game-compact' : ''}" id="${reportGameAnchor(game)}" aria-label="${reportEscape(game.teamOneName)} versus ${reportEscape(game.teamTwoName)}">` +
    `<div class="game-header"><h2>${reportEscape(game.roundName ?? 'Game')} · ${reportEscape(game.teamOneName)} vs ${reportEscape(game.teamTwoName)}</h2>` +
    `<p class="score">${reportEscape(game.teamOneName)} ${reportEscape(scoreText(game))} ${reportEscape(game.teamTwoName)}</p>${gameMeta(game, presentation)}</div>` +
    `${detail}</section>`
  );
}

function groupedGames(snapshot: StatsSnapshot): Array<{ id: string; name: string; games: GameStatsRow[] }> {
  const groups = new Map<string, { id: string; name: string; games: GameStatsRow[] }>();
  for (const game of snapshot.games) {
    const id = game.roundId ?? game.gameId;
    const group = groups.get(id) ?? {
      id,
      name: game.roundName ?? game.roundId ?? 'Games',
      games: [],
    };
    group.games.push(game);
    groups.set(id, group);
  }
  return [...groups.values()];
}

/** Render the Games report as real box scores using the shared rules-aware columns. */
export function renderBoxScoreReport(snapshot: StatsSnapshot): string {
  const groups = groupedGames(snapshot);
  const presentation = reportPresentationOf(snapshot);
  const contents =
    groups.length > 1
      ? `<nav aria-label="Rounds"><strong>Rounds</strong><ul>${groups
          .map(
            (group) => `<li><a href="#${reportRoundAnchor(group.id)}">${reportEscape(group.name)}</a></li>`,
          )
          .join('')}</ul></nav>`
      : '';
  const sections = groups
    .map(
      (group) =>
        `<section id="${reportRoundAnchor(group.id)}" aria-label="${reportEscape(group.name)}"><h2>${reportEscape(group.name)}</h2>` +
        `${group.games.map((game) => gameSection(game, presentation)).join('')}</section>`,
    )
    .join('');
  return renderReportPage(
    snapshot,
    'Games',
    `${reportScopeNote(snapshot)}${contents}${sections || '<p class="meta">No accepted games.</p>'}`,
  );
}

/** Keep the richer Games replacement usable by the progressive report compositor. */
export function buildPrintableStatReportBundle(snapshot: StatsSnapshot): StatReportPage[] {
  const pages = buildStatReportBundle(snapshot);
  return pages.map((page) =>
    page.name === 'games.html' ? { name: page.name, content: renderBoxScoreReport(snapshot) } : page,
  );
}
