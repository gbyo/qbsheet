import type { GamePlayerStatsRow } from './reportDetail.js';
import {
  answerCount,
  reportNumber,
  reportPresentationOf,
  type ReportPresentation,
} from './reportPresentation.js';
import type { GameStatsRow, PlayerStatsRow, StatsSnapshot, TeamStatsRow } from './stats.js';
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

function teamRowFor(snapshot: StatsSnapshot, teamId: string): Pick<TeamStatsRow, 'rank' | 'teamId'> {
  return snapshot.teams.find((team) => team.teamId === teamId) ?? { rank: 0, teamId };
}

function playerLine(game: GameStatsRow, playerId: string): GamePlayerStatsRow | undefined {
  return game.playerStats?.find((line) => line.playerId === playerId);
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

function summary(row: PlayerStatsRow, presentation: ReportPresentation): string {
  const pieces = [
    `${row.gamesPlayed} games`,
    row.tossupsHeard === null ? 'TUH —' : `${row.tossupsHeard} TUH`,
    ...presentation.answerColumns.map(
      (column) =>
        `${reportNumber(answerCount(row, column.key))} ${column.label.toLowerCase()}${answerCount(row, column.key) === 1 ? '' : 's'}`,
    ),
    `${row.points} pts`,
    `${reportPointsMetricValue(row, presentation)} ${reportPointsMetricLabel(presentation)}`,
    row.pptuh === null ? 'PPTUH —' : `${row.pptuh.toFixed(presentation.precision.rate)} PPTUH`,
    ...(presentation.applicability.bonuses ? [`${row.bonusPoints} bonus pts`] : []),
  ];
  return pieces.join(' · ');
}

function playerGameRows(
  snapshot: StatsSnapshot,
  row: PlayerStatsRow,
  games: readonly GameStatsRow[],
  presentation: ReportPresentation,
): string {
  const teamDetailIncluded = presentation.options.pages.includes('teamDetail');
  const gamesIncluded = presentation.options.pages.includes('games');
  return games
    .map((game) => {
      const line = playerLine(game, row.playerId);
      if (!line) return '';
      const opponent = opponentFor(game, row.teamId);
      const opponentTeam = teamRowFor(snapshot, opponent.id);
      const opponentName = reportEscape(opponent.name);
      const opponentCell = teamDetailIncluded
        ? `<a href="teamdetail.html#${reportTeamAnchor(opponentTeam)}">${opponentName}</a>`
        : opponentName;
      const score = reportEscape(scoreText(game));
      const scoreCell = gamesIncluded ? `<a href="games.html#${reportGameAnchor(game)}">${score}</a>` : score;
      return (
        `<tr><td>${reportEscape(game.roundName ?? game.roundId ?? 'Game')}</td>` +
        `${presentation.applicability.stage ? `<td>${reportEscape(game.phaseId ?? '—')}</td>` : ''}` +
        `<td>${opponentCell}</td>` +
        `<td>${reportEscape(resultFor(game, row.teamId))}</td>` +
        `<td class="num">${scoreCell}</td>` +
        `${reportNumberCell(line.tossupsHeard)}${reportAnswerCells(line, presentation)}${reportNumberCell(line.points)}` +
        `${presentation.applicability.bonuses ? reportNumberCell(line.bonusPoints) : ''}</tr>`
      );
    })
    .join('');
}

function playerSection(
  snapshot: StatsSnapshot,
  row: PlayerStatsRow,
  presentation: ReportPresentation,
): string {
  const team = teamRowFor(snapshot, row.teamId);
  const actualGames = snapshot.games.filter((game) => playerLine(game, row.playerId) !== undefined);
  const teamGames = snapshot.games.filter(
    (game) => game.teamOneId === row.teamId || game.teamTwoId === row.teamId,
  );
  const rows = playerGameRows(snapshot, row, actualGames, presentation);
  const omittedNote =
    teamGames.length > actualGames.length
      ? `<p class="meta">${teamGames.length - actualGames.length} other team game${teamGames.length - actualGames.length === 1 ? '' : 's'} ${teamGames.length - actualGames.length === 1 ? 'is' : 'are'} not listed because the canonical result does not contain a player line for this player.</p>`
      : '';
  const teamName = reportEscape(row.teamName);
  const teamCell = presentation.options.pages.includes('teamDetail')
    ? `<a href="teamdetail.html#${reportTeamAnchor(team)}">${teamName}</a>`
    : teamName;

  return (
    `<section id="${reportPlayerAnchor(row)}" aria-label="${reportEscape(row.playerName)}"><h2>${reportEscape(row.playerName)}</h2>` +
    `<p>${teamCell}` +
    `${typeof row.schoolYear === 'number' ? ` · Grade ${row.schoolYear}` : ''} · ${reportEscape(summary(row, presentation))}</p>` +
    `<h3>Game-by-game</h3>` +
    `${actualGames.length > 0 ? `<div class="table-wrap"><table><thead><tr><th scope="col">Round</th>${presentation.applicability.stage ? '<th scope="col">Stage</th>' : ''}<th scope="col">Opponent</th><th scope="col">Result</th><th scope="col" class="num">Score</th><th scope="col" class="num">TUH</th>${reportAnswerHeaders(presentation)}<th scope="col" class="num">Pts</th>${presentation.applicability.bonuses ? '<th scope="col" class="num">Bonus pts</th>' : ''}</tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="meta">No canonical player-game lines.</p>'}` +
    `${omittedNote}</section>`
  );
}

/** Player Detail is driven by actual player-game rows and the shared report presentation. */
export function renderPlayerDetailReport(snapshot: StatsSnapshot): string {
  const presentation = reportPresentationOf(snapshot);
  const sections = snapshot.players.map((row) => playerSection(snapshot, row, presentation)).join('');
  return renderReportPage(
    snapshot,
    'Players',
    `${reportScopeNote(snapshot)}${sections || '<p class="meta">No player statistics.</p>'}`,
  );
}
