import type { GamePlayerStatsRow } from './reportDetail.js';
import type { GameStatsRow, PlayerStatsRow, StatsSnapshot, TeamStatsRow } from './stats.js';
import {
  renderReportPage,
  reportEscape,
  reportGameAnchor,
  reportNumberCell,
  reportPlayerAnchor,
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

function summary(row: PlayerStatsRow, showSuperpowers: boolean): string {
  const pieces = [
    `${row.gamesPlayed} games`,
    row.tossupsHeard === null ? 'TUH —' : `${row.tossupsHeard} TUH`,
    ...(showSuperpowers ? [`${row.superpowers} superpowers`] : []),
    `${row.powers} powers`,
    `${row.gets} gets`,
    `${row.negs} negs`,
    `${row.points} pts`,
    `${row.ppg.toFixed(1)} PPG`,
    row.pptuh === null ? 'PPTUH —' : `${row.pptuh.toFixed(2)} PPTUH`,
  ];
  return pieces.join(' · ');
}

function playerGameRows(
  snapshot: StatsSnapshot,
  row: PlayerStatsRow,
  games: readonly GameStatsRow[],
  showSuperpowers: boolean,
  showStage: boolean,
): string {
  return games
    .map((game) => {
      const line = playerLine(game, row.playerId);
      if (!line) return '';
      const opponent = opponentFor(game, row.teamId);
      const opponentTeam = teamRowFor(snapshot, opponent.id);
      return (
        `<tr><td>${reportEscape(game.roundName ?? game.roundId ?? 'Game')}</td>` +
        `${showStage ? `<td>${reportEscape(game.phaseId ?? '—')}</td>` : ''}` +
        `<td><a href="teamdetail.html#${reportTeamAnchor(opponentTeam)}">${reportEscape(opponent.name)}</a></td>` +
        `<td>${reportEscape(resultFor(game, row.teamId))}</td>` +
        `<td class="num"><a href="games.html#${reportGameAnchor(game)}">${reportEscape(scoreText(game))}</a></td>` +
        `${reportNumberCell(line.tossupsHeard)}` +
        `${showSuperpowers ? reportNumberCell(line.superpowers) : ''}` +
        `${reportNumberCell(line.powers)}${reportNumberCell(line.gets)}${reportNumberCell(line.negs)}${reportNumberCell(line.points)}</tr>`
      );
    })
    .join('');
}

function playerSection(
  snapshot: StatsSnapshot,
  row: PlayerStatsRow,
  showSuperpowers: boolean,
  showStage: boolean,
): string {
  const team = teamRowFor(snapshot, row.teamId);
  const actualGames = snapshot.games.filter((game) => playerLine(game, row.playerId) !== undefined);
  const teamGames = snapshot.games.filter(
    (game) => game.teamOneId === row.teamId || game.teamTwoId === row.teamId,
  );
  const rows = playerGameRows(snapshot, row, actualGames, showSuperpowers, showStage);
  const omittedNote =
    teamGames.length > actualGames.length
      ? `<p class="meta">${teamGames.length - actualGames.length} other team game${teamGames.length - actualGames.length === 1 ? '' : 's'} ${teamGames.length - actualGames.length === 1 ? 'is' : 'are'} not listed because the canonical result does not contain a player line for this player.</p>`
      : '';

  return (
    `<section id="${reportPlayerAnchor(row)}" aria-label="${reportEscape(row.playerName)}"><h2>${reportEscape(row.playerName)}</h2>` +
    `<p><a href="teamdetail.html#${reportTeamAnchor(team)}">${reportEscape(row.teamName)}</a>` +
    `${typeof row.schoolYear === 'number' ? ` · Grade ${row.schoolYear}` : ''} · ${reportEscape(summary(row, showSuperpowers))}</p>` +
    `<h3>Game-by-game</h3>` +
    `${actualGames.length > 0 ? `<div class="table-wrap"><table><thead><tr><th scope="col">Round</th>${showStage ? '<th scope="col">Stage</th>' : ''}<th scope="col">Opponent</th><th scope="col">Result</th><th scope="col" class="num">Score</th><th scope="col" class="num">TUH</th>${showSuperpowers ? '<th scope="col" class="num">Superpowers</th>' : ''}<th scope="col" class="num">Powers</th><th scope="col" class="num">Gets</th><th scope="col" class="num">Negs</th><th scope="col" class="num">Pts</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="meta">No canonical player-game lines.</p>'}` +
    `${omittedNote}</section>`
  );
}

/** Player Detail is driven by actual player-game rows, never the team's schedule. */
export function renderPlayerDetailReport(snapshot: StatsSnapshot): string {
  const showSuperpowers = snapshot.players.some((player) => player.superpowers > 0);
  const phases = new Set(
    snapshot.games.map((game) => game.phaseId).filter((value): value is string => Boolean(value)),
  );
  const showStage = phases.size > 1;
  const sections = snapshot.players
    .map((row) => playerSection(snapshot, row, showSuperpowers, showStage))
    .join('');
  return renderReportPage(
    snapshot,
    'Players',
    `${reportScopeNote(snapshot)}${sections || '<p class="meta">No player statistics.</p>'}`,
  );
}
