import type { GameTeamStatsRow } from './reportDetail.js';
import { reportPercent, reportPresentationOf, type ReportPresentation } from './reportPresentation.js';
import type { GameStatsRow, StatsSnapshot, TeamStatsRow } from './stats.js';
import {
  renderReportPage,
  reportAnswerCells,
  reportAnswerHeaders,
  reportEscape,
  reportGameAnchor,
  reportNumberCell,
  reportPlayerAnchor,
  reportPointsMetricLabel,
  reportPointsMetricValue,
  reportScopeNote,
  reportTeamAnchor,
} from './reportHtml.js';

function recordText(row: TeamStatsRow): string {
  return row.ties > 0 ? `${row.wins}–${row.losses}–${row.ties}` : `${row.wins}–${row.losses}`;
}

/** Per-game bounceback conversion cell: parts-converted over parts-heard (#748). */
function bouncebackConversionCell(stats: GameTeamStatsRow | undefined): string {
  const heard = stats?.bouncebackPartsHeard ?? null;
  const converted = stats?.bouncebackPartsConverted ?? null;
  const conversion = heard !== null && heard > 0 && converted !== null ? converted / heard : null;
  return `<td class="num">${reportPercent(conversion, 1)}</td>`;
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
  presentation: ReportPresentation,
): string {
  const gamesIncluded = presentation.options.pages.includes('games');
  return games
    .map((game) => {
      const stats = teamGameStats(game, row.teamId);
      const opponent = opponentFor(game, row.teamId);
      const score = reportEscape(scoreText(game));
      const scoreCell = gamesIncluded ? `<a href="games.html#${reportGameAnchor(game)}">${score}</a>` : score;
      return (
        `<tr><td>${reportEscape(game.roundName ?? game.roundId ?? 'Game')}</td>` +
        `${presentation.applicability.stage ? `<td>${reportEscape(game.phaseId ?? '—')}</td>` : ''}` +
        `<td><a href="teamdetail.html#${teamAnchorFor(snapshot, opponent.id)}">${reportEscape(opponent.name)}</a></td>` +
        `<td>${reportEscape(resultFor(game, row.teamId))}</td>` +
        `<td class="num">${scoreCell}</td>` +
        `${stats ? reportAnswerCells(stats, presentation) : presentation.answerColumns.map(() => reportNumberCell(null)).join('')}` +
        `${reportNumberCell(stats?.tossupsHeard ?? null)}` +
        `${presentation.applicability.bonuses ? `${reportNumberCell(stats?.bonusesHeard ?? null)}${reportNumberCell(stats?.bonusPoints ?? null)}${reportNumberCell(stats?.ppb ?? null, presentation.precision.ppb)}` : ''}` +
        `${presentation.applicability.bouncebacks ? `${reportNumberCell(stats?.bouncebacks ?? null)}${reportNumberCell(stats?.bouncebackPartsHeard ?? null, 0)}${bouncebackConversionCell(stats)}` : ''}` +
        `${presentation.applicability.lightning ? reportNumberCell(stats?.lightningPoints ?? null, 0) : ''}` +
        `${presentation.applicability.packet ? `<td>${reportEscape(game.packetName ?? '—')}</td>` : ''}</tr>`
      );
    })
    .join('');
}

function totalsRow(row: TeamStatsRow, presentation: ReportPresentation): string {
  return (
    `<tr><td>Tournament total</td>${presentation.applicability.stage ? '<td></td>' : ''}<td></td><td>${reportEscape(recordText(row))}</td>` +
    `<td class="num">PF ${row.pointsFor}</td>${reportAnswerCells(row, presentation)}` +
    `${reportNumberCell(row.tossupsHeardKnown ? row.tossupsHeard : null)}` +
    `${presentation.applicability.bonuses ? `${reportNumberCell(row.bonusesHeard)}${reportNumberCell(row.bonusPoints)}${reportNumberCell(row.ppb, presentation.precision.ppb)}` : ''}` +
    // Totals come from the team's canonical aggregates, never re-summed from the
    // per-game cells above: the points total stays exactly known when the team
    // total is known, even if some row cell is individually blank.
    `${presentation.applicability.bouncebacks ? `${reportNumberCell(row.bouncebacksKnown ? row.bouncebackPoints : null)}${reportNumberCell(row.bouncebackPartsHeard, 0)}<td class="num">${reportPercent(row.bouncebackConversion, 1)}</td>` : ''}` +
    `${presentation.applicability.lightning ? reportNumberCell(row.lightningKnown ? row.lightningPoints : null, 0) : ''}` +
    `${presentation.applicability.packet ? '<td></td>' : ''}</tr>`
  );
}

function rosterTable(snapshot: StatsSnapshot, row: TeamStatsRow, presentation: ReportPresentation): string {
  const roster = snapshot.players.filter((player) => player.teamId === row.teamId);
  if (roster.length === 0) return '<p class="meta">No player statistics.</p>';
  const showGrade = roster.some((player) => typeof player.schoolYear === 'number');
  const playerDetailIncluded = presentation.options.pages.includes('playerDetail');
  const body = roster
    .map((player) => {
      const name = reportEscape(player.playerName);
      const playerCell = playerDetailIncluded
        ? `<a href="playerdetail.html#${reportPlayerAnchor(player)}">${name}</a>`
        : name;
      return (
        `<tr><td>${playerCell}</td>` +
        `${showGrade ? `<td class="num">${reportEscape(player.schoolYear ?? '—')}</td>` : ''}` +
        `<td class="num">${player.gamesPlayed}</td>${reportNumberCell(player.tossupsHeard)}` +
        `${reportAnswerCells(player, presentation)}` +
        `${reportNumberCell(player.points)}<td class="num">${reportEscape(reportPointsMetricValue(player, presentation))}</td>` +
        `${reportNumberCell(player.pptuh, presentation.precision.rate)}` +
        `${presentation.applicability.bonuses ? reportNumberCell(player.bonusPoints) : ''}</tr>`
      );
    })
    .join('');
  return (
    `<div class="table-wrap"><table><thead><tr><th scope="col">Player</th>` +
    `${showGrade ? '<th scope="col" class="num">Grade</th>' : ''}` +
    `<th scope="col" class="num">GP</th><th scope="col" class="num">TUH</th>${reportAnswerHeaders(presentation)}` +
    `<th scope="col" class="num">Pts</th><th scope="col" class="num">${reportEscape(reportPointsMetricLabel(presentation))}</th><th scope="col" class="num">PPTUH</th>` +
    `${presentation.applicability.bonuses ? '<th scope="col" class="num">Bonus pts</th>' : ''}</tr></thead><tbody>${body}</tbody></table></div>`
  );
}

function teamSection(snapshot: StatsSnapshot, row: TeamStatsRow, presentation: ReportPresentation): string {
  const games = snapshot.games.filter(
    (game) => game.teamOneId === row.teamId || game.teamTwoId === row.teamId,
  );
  const classifications = (row.classifications ?? []).join('; ');
  const summary = [
    `${recordText(row)} record`,
    `${row.gamesPlayed} games`,
    `${reportPointsMetricValue(row, presentation)} ${reportPointsMetricLabel(presentation)}`,
    ...(presentation.options.showPapg ? [`${row.papg.toFixed(presentation.precision.ppg)} PAPG`] : []),
    ...(presentation.options.showPointsForAgainstMargin
      ? [`${row.pointsFor} PF`, `${row.pointsAgainst} PA`, `${row.margin} margin`]
      : []),
    row.tossupsHeardKnown ? `${row.tossupsHeard} TUH` : 'TUH —',
    row.pptuh === null ? 'PPTUH —' : `${row.pptuh.toFixed(presentation.precision.rate)} PPTUH`,
    ...(presentation.applicability.bonuses
      ? [row.ppb === null ? 'PPB —' : `${row.ppb.toFixed(presentation.precision.ppb)} PPB`]
      : []),
    ...(presentation.applicability.bouncebacks
      ? [
          row.bouncebacksKnown ? `${row.bouncebackPoints} BB pts` : 'BB pts —',
          row.bouncebackConversion === null
            ? 'BB conv —'
            : `${reportPercent(row.bouncebackConversion, 1)} BB conv`,
        ]
      : []),
    ...(presentation.applicability.lightning
      ? [row.lightningKnown ? `${row.lightningPoints} lightning pts` : 'Lightning —']
      : []),
  ].join(' · ');
  const body = gameRows(snapshot, row, games, presentation);

  return (
    `<section id="${reportTeamAnchor(row)}" aria-label="${reportEscape(row.teamName)}"><h2>${row.rank}. ${reportEscape(row.teamName)}</h2>` +
    `<p>${reportEscape(summary)}</p>` +
    `${presentation.options.showClassifications && classifications ? `<p class="meta">Classifications: ${reportEscape(classifications)}</p>` : ''}` +
    `<h3>Game-by-game</h3>` +
    `${games.length > 0 ? `<div class="table-wrap"><table><thead><tr><th scope="col">Round</th>${presentation.applicability.stage ? '<th scope="col">Stage</th>' : ''}<th scope="col">Opponent</th><th scope="col">Result</th><th scope="col" class="num">Score</th>${reportAnswerHeaders(presentation)}<th scope="col" class="num">TUH</th>${presentation.applicability.bonuses ? '<th scope="col" class="num">BH</th><th scope="col" class="num">BP</th><th scope="col" class="num">PPB</th>' : ''}${presentation.applicability.bouncebacks ? '<th scope="col" class="num">Bounceback pts</th><th scope="col" class="num">BB parts heard</th><th scope="col" class="num">BB conv %</th>' : ''}${presentation.applicability.lightning ? '<th scope="col" class="num">Lightning pts</th>' : ''}${presentation.applicability.packet ? '<th scope="col">Packet</th>' : ''}</tr></thead><tbody>${body}</tbody><tfoot>${totalsRow(row, presentation)}</tfoot></table></div>` : '<p class="meta">No games.</p>'}` +
    `<h3>Roster</h3>${rosterTable(snapshot, row, presentation)}</section>`
  );
}

/** Render one canonical per-game statistical line for every accepted team game. */
export function renderTeamDetailReport(snapshot: StatsSnapshot): string {
  const presentation = reportPresentationOf(snapshot);
  const sections = snapshot.teams.map((row) => teamSection(snapshot, row, presentation)).join('');
  return renderReportPage(
    snapshot,
    'Teams',
    `${reportScopeNote(snapshot)}${sections || '<p class="meta">No team statistics.</p>'}`,
  );
}
