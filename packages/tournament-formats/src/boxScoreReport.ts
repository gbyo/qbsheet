import type { GamePlayerStatsRow, GameTeamStatsRow } from './reportDetail.js';
import {
  buildStatReportBundle,
  type GameStatsRow,
  type StatReportPage,
  type StatsSnapshot,
} from './stats.js';
import {
  renderReportPage,
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
      ].some((value) => value !== null),
  );
}

function playerRows(
  players: readonly GamePlayerStatsRow[],
  showSuperpowers: boolean,
): string {
  return players
    .map(
      (player) =>
        `<tr><td>${reportEscape(player.playerName)}</td>` +
        `${reportNumberCell(player.tossupsHeard)}` +
        `${showSuperpowers ? reportNumberCell(player.superpowers) : ''}` +
        `${reportNumberCell(player.powers)}${reportNumberCell(player.gets)}${reportNumberCell(player.negs)}` +
        `${reportNumberCell(player.points)}</tr>`,
    )
    .join('');
}

function teamBox(
  game: GameStatsRow,
  team: GameTeamStatsRow,
  showSuperpowers: boolean,
): string {
  const players = (game.playerStats ?? []).filter((player) => player.teamId === team.teamId);
  const playerBody =
    players.length > 0
      ? playerRows(players, showSuperpowers)
      : '<tr><td colspan="7" class="meta">Player-level statistics unavailable.</td></tr>';
  const columns = 6 + (showSuperpowers ? 1 : 0);
  const playerBodyWithCorrectSpan = playerBody.replace('colspan="7"', `colspan="${columns}"`);
  const bonusKnown = team.bonusesHeard !== null || team.bonusPoints !== null;
  const bonusSummary = bonusKnown
    ? `<div class="bonus-summary"><span>Bonuses heard: <strong>${reportEscape(team.bonusesHeard ?? '—')}</strong></span>` +
      `<span>Bonus points: <strong>${reportEscape(team.bonusPoints ?? '—')}</strong></span>` +
      `<span>PPB: <strong>${typeof team.ppb === 'number' ? team.ppb.toFixed(2) : '—'}</strong></span>` +
      `${team.bouncebacks !== null ? `<span>Bouncebacks: <strong>${team.bouncebacks}</strong></span>` : ''}</div>`
    : '';

  return (
    `<section class="team-box" aria-label="${reportEscape(team.teamName)} box score"><h3>${reportEscape(team.teamName)}</h3>` +
    `<div class="table-wrap"><table><thead><tr><th scope="col">Player</th><th scope="col" class="num">TUH</th>` +
    `${showSuperpowers ? '<th scope="col" class="num">Superpowers</th>' : ''}` +
    `<th scope="col" class="num">Powers</th><th scope="col" class="num">Gets</th><th scope="col" class="num">Negs</th><th scope="col" class="num">Pts</th>` +
    `</tr></thead><tbody>${playerBodyWithCorrectSpan}</tbody><tfoot><tr><td>Team total</td>` +
    `${reportNumberCell(team.tossupsHeard)}${showSuperpowers ? reportNumberCell(team.superpowers) : ''}` +
    `${reportNumberCell(team.powers)}${reportNumberCell(team.gets)}${reportNumberCell(team.negs)}${reportNumberCell(team.points)}` +
    `</tr></tfoot></table></div>${bonusSummary}</section>`
  );
}

function gameMeta(game: GameStatsRow): string {
  const items: string[] = [];
  if (game.packetName) items.push(`Packet: ${reportEscape(game.packetName)}`);
  if (typeof game.tossupsRead === 'number') items.push(`Tossups read: ${game.tossupsRead}`);
  if (typeof game.overtimeTossupsRead === 'number' && game.overtimeTossupsRead > 0) {
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
  }
  if (game.detail === 'partial') items.push('Partial detailed statistics');
  return items.length > 0 ? `<p class="meta">${items.join(' · ')}</p>` : '';
}

function gameSection(game: GameStatsRow, showSuperpowers: boolean): string {
  const teamStats = game.teamStats ?? [];
  const anyDetail = teamStats.some(detailKnown);
  const detail = anyDetail
    ? teamStats.map((team) => teamBox(game, team, showSuperpowers)).join('')
    : '<p class="detail-note">Detailed statistics unavailable for this result.</p>';
  return (
    `<section class="game" id="${reportGameAnchor(game)}" aria-label="${reportEscape(game.teamOneName)} versus ${reportEscape(game.teamTwoName)}">` +
    `<div class="game-header"><h2>${reportEscape(game.roundName ?? 'Game')} · ${reportEscape(game.teamOneName)} vs ${reportEscape(game.teamTwoName)}</h2>` +
    `<p class="score">${reportEscape(game.teamOneName)} ${reportEscape(scoreText(game))} ${reportEscape(game.teamTwoName)}</p>${gameMeta(game)}</div>` +
    `${detail}</section>`
  );
}

function groupedGames(snapshot: StatsSnapshot): Array<{ id: string; name: string; games: GameStatsRow[] }> {
  const groups = new Map<string, { id: string; name: string; games: GameStatsRow[] }>();
  for (const game of snapshot.games) {
    const id = game.roundId ?? game.gameId;
    const group = groups.get(id) ?? { id, name: game.roundName ?? game.roundId ?? 'Games', games: [] };
    group.games.push(game);
    groups.set(id, group);
  }
  return [...groups.values()];
}

/** Render the Games report as real box scores instead of a score-only results table. */
export function renderBoxScoreReport(snapshot: StatsSnapshot): string {
  const groups = groupedGames(snapshot);
  const showSuperpowers = snapshot.games.some(
    (game) =>
      (game.teamStats ?? []).some((team) => (team.superpowers ?? 0) > 0) ||
      (game.playerStats ?? []).some((player) => (player.superpowers ?? 0) > 0),
  );
  const contents =
    groups.length > 1
      ? `<nav aria-label="Rounds"><strong>Rounds</strong><ul>${groups
          .map(
            (group) =>
              `<li><a href="#${reportRoundAnchor(group.id)}">${reportEscape(group.name)}</a></li>`,
          )
          .join('')}</ul></nav>`
      : '';
  const sections = groups
    .map(
      (group) =>
        `<section id="${reportRoundAnchor(group.id)}" aria-label="${reportEscape(group.name)}"><h2>${reportEscape(group.name)}</h2>` +
        `${group.games.map((game) => gameSection(game, showSuperpowers)).join('')}</section>`,
    )
    .join('');
  return renderReportPage(
    snapshot,
    'Games',
    `${reportScopeNote(snapshot)}${contents}${sections || '<p class="meta">No accepted games.</p>'}`,
  );
}

/**
 * Progressive richer renderer for Director's printable bundle. Page-specific
 * report PRs replace one page at a time while all untouched pages continue to
 * use the existing deterministic serializer.
 */
export function buildPrintableStatReportBundle(snapshot: StatsSnapshot): StatReportPage[] {
  const pages = buildStatReportBundle(snapshot);
  return pages.map((page) =>
    page.name === 'games.html' ? { name: page.name, content: renderBoxScoreReport(snapshot) } : page,
  );
}
