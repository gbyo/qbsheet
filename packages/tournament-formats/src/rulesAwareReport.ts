import {
  reportNumber,
  reportPageFiles,
  reportPageLabels,
  reportPercent,
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
  reportRoundAnchor,
  reportScopeNote,
  reportTeamAnchor,
} from './reportHtml.js';

function recordText(row: TeamStatsRow): string {
  return row.ties > 0 ? `${row.wins}–${row.losses}–${row.ties}` : `${row.wins}–${row.losses}`;
}

export function renderReportIndex(snapshot: StatsSnapshot): string {
  const presentation = reportPresentationOf(snapshot);
  const body =
    `<p class="meta">${snapshot.teams.length} teams · ${snapshot.players.length} players · ${snapshot.games.length} games.</p>` +
    `<ul>${presentation.options.pages
      .map(
        (page) => `<li><a href="${reportPageFiles[page]}">${reportEscape(reportPageLabels[page])}</a></li>`,
      )
      .join('')}</ul>`;
  return renderReportPage(snapshot, 'Stat report', body);
}

function teamRowHtml(
  row: TeamStatsRow,
  presentation: ReportPresentation,
  showCalculatedRank: boolean,
  showClassifications: boolean,
): string {
  const teamName = reportEscape(row.teamName);
  const teamCell = presentation.options.pages.includes('teamDetail')
    ? `<a href="teamdetail.html#${reportTeamAnchor(row)}">${teamName}</a>`
    : teamName;
  return (
    `<tr><td class="num">${row.rank}</td>` +
    `${showCalculatedRank ? reportNumberCell(row.calculatedRank ?? row.rank) : ''}` +
    `<td>${teamCell}</td>` +
    `<td class="num">${reportEscape(recordText(row))}</td><td class="num">${row.gamesPlayed}</td>` +
    `<td class="num">${reportPercent(row.winPercentage, presentation.precision.percentage)}</td>` +
    `${presentation.options.showPointsForAgainstMargin ? `${reportNumberCell(row.pointsFor)}${reportNumberCell(row.pointsAgainst)}${reportNumberCell(row.margin)}` : ''}` +
    `<td class="num">${reportEscape(reportPointsMetricValue(row, presentation))}</td>` +
    `${presentation.options.showPapg ? `<td class="num">${reportNumber(row.papg, presentation.precision.ppg)}</td>` : ''}` +
    `${reportNumberCell(row.tossupsHeardKnown ? row.tossupsHeard : null)}${reportNumberCell(row.pptuh, presentation.precision.rate)}` +
    `${reportAnswerCells(row, presentation)}` +
    `${presentation.applicability.bonuses ? `${reportNumberCell(row.bonusesHeard)}${reportNumberCell(row.bonusPoints)}${reportNumberCell(row.ppb, presentation.precision.ppb)}` : ''}` +
    `${showClassifications ? `<td>${reportEscape((row.classifications ?? []).join('; ') || '—')}</td>` : ''}</tr>`
  );
}

/** Standings always keeps competitive essentials; advanced options only remove secondary columns. */
export function renderRulesAwareStandings(snapshot: StatsSnapshot): string {
  const presentation = reportPresentationOf(snapshot);
  const showCalculatedRank = snapshot.teams.some(
    (row) => row.calculatedRank !== undefined && row.calculatedRank !== row.rank,
  );
  const showClassifications =
    presentation.options.showClassifications &&
    snapshot.teams.some((row) => (row.classifications ?? []).length > 0);
  const rows = snapshot.teams
    .map((row) => teamRowHtml(row, presentation, showCalculatedRank, showClassifications))
    .join('');
  const table =
    `<div class="table-wrap"><table><caption>Team standings</caption><thead><tr><th scope="col" class="num">#</th>` +
    `${showCalculatedRank ? '<th scope="col" class="num">Calc</th>' : ''}<th scope="col">Team</th><th scope="col" class="num">Record</th><th scope="col" class="num">GP</th><th scope="col" class="num">Win %</th>` +
    `${presentation.options.showPointsForAgainstMargin ? '<th scope="col" class="num">PF</th><th scope="col" class="num">PA</th><th scope="col" class="num">Margin</th>' : ''}` +
    `<th scope="col" class="num">${reportEscape(reportPointsMetricLabel(presentation))}</th>` +
    `${presentation.options.showPapg ? '<th scope="col" class="num">PAPG</th>' : ''}` +
    `<th scope="col" class="num">TUH</th><th scope="col" class="num">PPTUH</th>${reportAnswerHeaders(presentation)}` +
    `${presentation.applicability.bonuses ? '<th scope="col" class="num">BH</th><th scope="col" class="num">BP</th><th scope="col" class="num">PPB</th>' : ''}` +
    `${showClassifications ? '<th scope="col">Group</th>' : ''}</tr></thead><tbody>${rows}</tbody></table></div>`;
  return renderReportPage(snapshot, 'Standings', `${reportScopeNote(snapshot)}${table}`);
}

function playerRowHtml(
  row: PlayerStatsRow,
  presentation: ReportPresentation,
  showGrade: boolean,
  showPlayerPpb: boolean,
): string {
  const team = snapshotTeamLinkFallback(row.teamId);
  const playerName = reportEscape(row.playerName);
  const teamName = reportEscape(row.teamName);
  const playerCell = presentation.options.pages.includes('playerDetail')
    ? `<a href="playerdetail.html#${reportPlayerAnchor(row)}">${playerName}</a>`
    : playerName;
  const teamCell = presentation.options.pages.includes('teamDetail')
    ? `<a href="teamdetail.html#${reportTeamAnchor(team)}">${teamName}</a>`
    : teamName;
  return (
    `<tr><td class="num">${row.rank}</td><td>${playerCell}</td>` +
    `<td>${teamCell}</td>` +
    `${showGrade ? `<td class="num">${reportEscape(row.schoolYear ?? '—')}</td>` : ''}` +
    `<td class="num">${row.gamesPlayed}</td>${reportNumberCell(row.tossupsHeard)}${reportAnswerCells(row, presentation)}` +
    `${reportNumberCell(row.points)}<td class="num">${reportEscape(reportPointsMetricValue(row, presentation))}</td>${reportNumberCell(row.pptuh, presentation.precision.rate)}` +
    `${presentation.applicability.bonuses ? `${reportNumberCell(row.bonusPoints)}${showPlayerPpb ? reportNumberCell(row.ppb, presentation.precision.ppb) : ''}` : ''}</tr>`
  );
}

function snapshotTeamLinkFallback(teamId: string): Pick<TeamStatsRow, 'teamId'> {
  return { teamId };
}

export function renderRulesAwareIndividuals(snapshot: StatsSnapshot): string {
  const presentation = reportPresentationOf(snapshot);
  const showGrade = snapshot.players.some((row) => typeof row.schoolYear === 'number');
  const showPlayerPpb =
    presentation.applicability.bonuses &&
    snapshot.players.some((row) => row.bonusesHeard > 0 && typeof row.ppb === 'number');
  const rows = snapshot.players
    .map((row) => playerRowHtml(row, presentation, showGrade, showPlayerPpb))
    .join('');
  const table =
    `<div class="table-wrap"><table><caption>Individual statistics</caption><thead><tr><th scope="col" class="num">#</th><th scope="col">Player</th><th scope="col">Team</th>` +
    `${showGrade ? '<th scope="col" class="num">Grade</th>' : ''}<th scope="col" class="num">GP</th><th scope="col" class="num">TUH</th>${reportAnswerHeaders(presentation)}` +
    `<th scope="col" class="num">Pts</th><th scope="col" class="num">${reportEscape(reportPointsMetricLabel(presentation))}</th><th scope="col" class="num">PPTUH</th>` +
    `${presentation.applicability.bonuses ? `<th scope="col" class="num">Bonus pts</th>${showPlayerPpb ? '<th scope="col" class="num">PPB</th>' : ''}` : ''}</tr></thead><tbody>${rows}</tbody></table></div>`;
  return renderReportPage(snapshot, 'Individuals', `${reportScopeNote(snapshot)}${table}`);
}

function opponent(game: GameStatsRow, teamId: string): string {
  return game.teamOneId === teamId ? game.teamTwoName : game.teamOneName;
}

function scoreFor(game: GameStatsRow, teamId: string): string {
  const own = game.teamOneId === teamId ? game.teamOnePoints : game.teamTwoPoints;
  const other = game.teamOneId === teamId ? game.teamTwoPoints : game.teamOnePoints;
  return `${typeof own === 'number' ? own : '—'}–${typeof other === 'number' ? other : '—'}`;
}

function gameScoreCell(game: GameStatsRow, score: string, presentation: ReportPresentation): string {
  const escaped = reportEscape(score);
  return presentation.options.pages.includes('games')
    ? `<a href="games.html#${reportGameAnchor(game)}">${escaped}</a>`
    : escaped;
}

/**
 * Round Report remains fact-only until #686's canonical aggregate DTO lands: each row is a canonical
 * team-game line, grouped by round, so this page still uses the same rules-aware vocabulary without
 * inventing rates or denominators in the serializer.
 */
export function renderRulesAwareRounds(snapshot: StatsSnapshot): string {
  const presentation = reportPresentationOf(snapshot);
  const groups = new Map<string, { name: string; games: GameStatsRow[] }>();
  for (const game of snapshot.games) {
    const key = game.roundId ?? game.gameId;
    const group = groups.get(key) ?? { name: game.roundName ?? game.roundId ?? 'Round', games: [] };
    group.games.push(game);
    groups.set(key, group);
  }
  const sections = [...groups.entries()]
    .map(([roundId, group]) => {
      const rows = group.games
        .flatMap((game) => {
          const stageCell = presentation.applicability.stage
            ? `<td>${reportEscape(game.phaseId ?? '—')}</td>`
            : '';
          const stats = game.teamStats ?? [];
          if (stats.length === 0) {
            const score = `${game.teamOnePoints ?? '—'}–${game.teamTwoPoints ?? '—'}`;
            return [
              `<tr>${stageCell}<td>${reportEscape(game.teamOneName)} vs ${reportEscape(game.teamTwoName)}</td><td>—</td><td class="num">${gameScoreCell(game, score, presentation)}</td>` +
                `${presentation.answerColumns.map(() => reportNumberCell(null)).join('')}${reportNumberCell(null)}` +
                `${presentation.applicability.bonuses ? `${reportNumberCell(null)}${reportNumberCell(null)}${reportNumberCell(null)}` : ''}` +
                `${presentation.applicability.bouncebacks ? reportNumberCell(null) : ''}` +
                `${presentation.applicability.packet ? `<td>${reportEscape(game.packetName ?? '—')}</td>` : ''}</tr>`,
            ];
          }
          return stats.map(
            (line) =>
              `<tr>${stageCell}<td>${reportEscape(line.teamName)}</td><td>${reportEscape(opponent(game, line.teamId))}</td><td class="num">${gameScoreCell(game, scoreFor(game, line.teamId), presentation)}</td>` +
              `${reportAnswerCells(line, presentation)}${reportNumberCell(line.tossupsHeard)}` +
              `${presentation.applicability.bonuses ? `${reportNumberCell(line.bonusesHeard)}${reportNumberCell(line.bonusPoints)}${reportNumberCell(line.ppb, presentation.precision.ppb)}` : ''}` +
              `${presentation.applicability.bouncebacks ? reportNumberCell(line.bouncebacks) : ''}` +
              `${presentation.applicability.packet ? `<td>${reportEscape(game.packetName ?? '—')}</td>` : ''}</tr>`,
          );
        })
        .join('');
      return (
        `<section id="${reportRoundAnchor(roundId)}"><h2>${reportEscape(group.name)}</h2>` +
        `<div class="table-wrap"><table><thead><tr>${presentation.applicability.stage ? '<th scope="col">Stage</th>' : ''}<th scope="col">Team</th><th scope="col">Opponent</th><th scope="col" class="num">Score</th>` +
        `${reportAnswerHeaders(presentation)}<th scope="col" class="num">TUH</th>` +
        `${presentation.applicability.bonuses ? '<th scope="col" class="num">BH</th><th scope="col" class="num">BP</th><th scope="col" class="num">PPB</th>' : ''}` +
        `${presentation.applicability.bouncebacks ? '<th scope="col" class="num">Bounceback pts</th>' : ''}` +
        `${presentation.applicability.packet ? '<th scope="col">Packet</th>' : ''}</tr></thead><tbody>${rows}</tbody></table></div></section>`
      );
    })
    .join('');
  return renderReportPage(
    snapshot,
    'Rounds',
    `${reportScopeNote(snapshot)}${sections || '<p class="meta">No accepted games.</p>'}`,
  );
}
