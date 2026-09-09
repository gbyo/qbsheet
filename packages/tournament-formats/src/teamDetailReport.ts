import type { GameTeamStatsRow } from './reportDetail.js';
import type { GameStatsRow, StatsSnapshot, TeamStatsRow } from './stats.js';
import {
  renderReportPage,
  reportEscape,
  reportGameAnchor,
  reportNumberCell,
  reportPlayerAnchor,
  reportScopeNote,
  reportTeamAnchor,
} from './reportHtml.js';

function recordText(row: TeamStatsRow): string {
  return row.ties > 0 ? `${row.wins}–${row.losses}–${row.ties}` : `${row.wins}–${row.losses}`;
}

function opponentFor(game: GameStatsRow, teamId: string): { id: string; name: string } {
  if (game.teamOneId === teamId) return { id: game.teamTwoId, name: game.teamTwoName };
  return { id: game.teamOneId, name: game.teamOneName };
}

function resultFor(game: GameStatsRow, teamId: string): string {
  if (game.forfeitedTeamId) return game.forfeitedTeamId === teamId ? 'L (forfeit)' : 'W (forfeit)';
  if (game.winnerId === teamId) return 'W';
  if (game.winnerId) return 'L';
  return 'T';
}

function scoreText(game: GameStatsRow): string {
  const left = typeof game.teamOnePoints === 'number' ? String(game.teamOnePoints) : '—';
  const right = typeof game.teamTwoPoints === 'number' ? String(game.teamTwoPoints) : '—';
  return `${left}–${right}`;
}

function teamGameStats(game: GameStatsRow, teamId: string): GameTeamStatsRow | undefined {
  return game.teamStats?.find((stats) => stats.teamId === teamId);
}

function teamAnchorFor(snapshot: StatsSnapshot, teamId: string): string {
  const team = snapshot.teams.find((row) => row.teamId === teamId) ?? { rank: 0, teamId };
  return reportTeamAnchor(team);
}

function gameRows(
  snapshot: StatsSnapshot,
  row: TeamStatsRow,
  games: readonly GameStatsRow[],
  showStage: boolean,
  showSuperpowers: boolean,
  showPacket: boolean,
): string {
  return games
    .map((game) => {
      const stats = teamGameStats(game, row.teamId);
      const opponent = opponentFor(game, row.teamId);
      return (
        `<tr><td>${reportEscape(game.roundName ?? game.roundId ?? 'Game')}</td>` +
        `${showStage ? `<td>${reportEscape(game.phaseId ?? '—')}</td>` : ''}` +
        `<td><a href="teamdetail.html#${teamAnchorFor(snapshot, opponent.id)}">${reportEscape(opponent.name)}</a></td>` +
        `<td>${reportEscape(resultFor(game, row.teamId))}</td>` +
        `<td class="num"><a href="games.html#${reportGameAnchor(game)}">${reportEscape(scoreText(game))}</a></td>` +
        `${showSuperpowers ? reportNumberCell(stats?.superpowers ?? null) : ''}` +
        `${reportNumberCell(stats?.powers ?? null)}${reportNumberCell(stats?.gets ?? null)}${reportNumberCell(stats?.negs ?? null)}` +
        `${reportNumberCell(stats?.tossupsHeard ?? null)}${reportNumberCell(stats?.bonusesHeard ?? null)}${reportNumberCell(stats?.bonusPoints ?? null)}${reportNumberCell(stats?.ppb ?? null, 2)}` +
        `${showPacket ? `<td>${reportEscape(game.packetName ?? '—')}</td>` : ''}</tr>`
      );
    })
    .join('');
}

function totalsRow(
  row: TeamStatsRow,
  showStage: boolean,
  showSuperpowers: boolean,
  showPacket: boolean,
): string {
  return (
    `<tr><td>Tournament total</td>${showStage ? '<td></td>' : ''}<td></td><td>${reportEscape(recordText(row))}</td>` +
    `<td class="num">PF ${row.pointsFor}</td>${showSuperpowers ? reportNumberCell(row.superpowers) : ''}` +
    `${reportNumberCell(row.powers)}${reportNumberCell(row.gets)}${reportNumberCell(row.negs)}` +
    `${reportNumberCell(row.tossupsHeardKnown ? row.tossupsHeard : null)}${reportNumberCell(row.bonusesHeard)}${reportNumberCell(row.bonusPoints)}${reportNumberCell(row.ppb, 2)}` +
    `${showPacket ? '<td></td>' : ''}</tr>`
  );
}

function rosterTable(snapshot: StatsSnapshot, row: TeamStatsRow, showSuperpowers: boolean): string {
  const roster = snapshot.players.filter((player) => player.teamId === row.teamId);
  if (roster.length === 0) return '<p class="meta">No player statistics.</p>';
  const showGrade = roster.some((player) => typeof player.schoolYear === 'number');
  const body = roster
    .map(
      (player) =>
        `<tr><td><a href="playerdetail.html#${reportPlayerAnchor(player)}">${reportEscape(player.playerName)}</a></td>` +
        `${showGrade ? `<td class="num">${reportEscape(player.schoolYear ?? '—')}</td>` : ''}` +
        `<td class="num">${player.gamesPlayed}</td>${reportNumberCell(player.tossupsHeard)}` +
        `${showSuperpowers ? reportNumberCell(player.superpowers) : ''}` +
        `${reportNumberCell(player.powers)}${reportNumberCell(player.gets)}${reportNumberCell(player.negs)}` +
        `${reportNumberCell(player.points)}<td class="num">${player.ppg.toFixed(1)}</td>${reportNumberCell(player.pptuh, 2)}</tr>`,
    )
    .join('');
  return (
    `<div class="table-wrap"><table><thead><tr><th scope="col">Player</th>` +
    `${showGrade ? '<th scope="col" class="num">Grade</th>' : ''}` +
    `<th scope="col" class="num">GP</th><th scope="col" class="num">TUH</th>` +
    `${showSuperpowers ? '<th scope="col" class="num">Superpowers</th>' : ''}` +
    `<th scope="col" class="num">Powers</th><th scope="col" class="num">Gets</th><th scope="col" class="num">Negs</th>` +
    `<th scope="col" class="num">Pts</th><th scope="col" class="num">PPG</th><th scope="col" class="num">PPTUH</th></tr></thead><tbody>${body}</tbody></table></div>`
  );
}

function teamSection(
  snapshot: StatsSnapshot,
  row: TeamStatsRow,
  showStage: boolean,
  showSuperpowers: boolean,
  showPacket: boolean,
): string {
  const games = snapshot.games.filter(
    (game) => game.teamOneId === row.teamId || game.teamTwoId === row.teamId,
  );
  const classifications = (row.classifications ?? []).join('; ');
  const summary = [
    `${recordText(row)} record`,
    `${row.gamesPlayed} games`,
    `${row.ppg.toFixed(1)} PPG`,
    `${row.papg.toFixed(1)} PAPG`,
    `${row.margin} margin`,
    row.tossupsHeardKnown ? `${row.tossupsHeard} TUH` : 'TUH —',
    row.pptuh === null ? 'PPTUH —' : `${row.pptuh.toFixed(2)} PPTUH`,
    row.ppb === null ? 'PPB —' : `${row.ppb.toFixed(2)} PPB`,
  ].join(' · ');
  const body = gameRows(snapshot, row, games, showStage, showSuperpowers, showPacket);

  return (
    `<section id="${reportTeamAnchor(row)}" aria-label="${reportEscape(row.teamName)}"><h2>${row.rank}. ${reportEscape(row.teamName)}</h2>` +
    `<p>${reportEscape(summary)}</p>` +
    `${classifications ? `<p class="meta">Classifications: ${reportEscape(classifications)}</p>` : ''}` +
    `<h3>Game-by-game</h3>` +
    `${games.length > 0 ? `<div class="table-wrap"><table><thead><tr><th scope="col">Round</th>${showStage ? '<th scope="col">Stage</th>' : ''}<th scope="col">Opponent</th><th scope="col">Result</th><th scope="col" class="num">Score</th>${showSuperpowers ? '<th scope="col" class="num">Superpowers</th>' : ''}<th scope="col" class="num">Powers</th><th scope="col" class="num">Gets</th><th scope="col" class="num">Negs</th><th scope="col" class="num">TUH</th><th scope="col" class="num">BH</th><th scope="col" class="num">BP</th><th scope="col" class="num">PPB</th>${showPacket ? '<th scope="col">Packet</th>' : ''}</tr></thead><tbody>${body}</tbody><tfoot>${totalsRow(row, showStage, showSuperpowers, showPacket)}</tfoot></table></div>` : '<p class="meta">No games.</p>'}` +
    `<h3>Roster</h3>${rosterTable(snapshot, row, showSuperpowers)}</section>`
  );
}

/** Render one canonical per-game statistical line for every accepted team game. */
export function renderTeamDetailReport(snapshot: StatsSnapshot): string {
  const phases = new Set(
    snapshot.games.map((game) => game.phaseId).filter((value): value is string => Boolean(value)),
  );
  const showStage = phases.size > 1;
  const showSuperpowers =
    snapshot.teams.some((team) => team.superpowers > 0) ||
    snapshot.games.some((game) => (game.teamStats ?? []).some((stats) => (stats.superpowers ?? 0) > 0));
  const showPacket = snapshot.games.some((game) => Boolean(game.packetName));
  const sections = snapshot.teams
    .map((row) => teamSection(snapshot, row, showStage, showSuperpowers, showPacket))
    .join('');
  return renderReportPage(
    snapshot,
    'Teams',
    `${reportScopeNote(snapshot)}${sections || '<p class="meta">No team statistics.</p>'}`,
  );
}
