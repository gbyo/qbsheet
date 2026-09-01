import type {
  DirectorTournament,
  DirectorTournamentInput,
  FormatReport,
  FormatWarning,
  GameRecord,
  GamePlayerResult,
  GameTeamResult,
  JsonObject,
} from './types';
import { serializeCsv } from './csv';
import { normalizeTournamentData } from './tournament';
import { ok, warning } from './util';

export const statsFormat = 'qbsheet-stats' as const;
export const statsVersion = 1;

export interface TeamStatsRow {
  rank: number;
  teamId: string;
  teamName: string;
  organizationId?: string;
  gamesPlayed: number;
  wins: number;
  losses: number;
  ties: number;
  winPercentage: number;
  pointsFor: number;
  pointsAgainst: number;
  ppg: number;
  papg: number;
  margin: number;
  powers: number;
  gets: number;
  negs: number;
  tossupsHeard: number;
  pptuh: number;
  bonusPoints: number;
  bonusesHeard: number;
  ppb: number;
}

export interface PlayerStatsRow {
  rank: number;
  playerId: string;
  playerName: string;
  teamId: string;
  teamName: string;
  gamesPlayed: number;
  tossupsHeard: number;
  powers: number;
  gets: number;
  negs: number;
  points: number;
  ppg: number;
  pptuh: number;
  bonusesHeard: number;
  bonusPoints: number;
  ppb: number;
}

export interface GameStatsRow {
  gameId: string;
  phaseId?: string;
  roundId?: string;
  teamOneId: string;
  teamOneName: string;
  teamOnePoints?: number;
  teamTwoId: string;
  teamTwoName: string;
  teamTwoPoints?: number;
  winnerId?: string;
  status: string;
}

export interface StatsSnapshot {
  format: typeof statsFormat;
  version: number;
  generatedAt: string;
  tournament: { id: string; name: string };
  teams: TeamStatsRow[];
  players: PlayerStatsRow[];
  games: GameStatsRow[];
  extensions?: JsonObject;
}

export type TeamTiebreaker =
  | 'wins'
  | 'winPercentage'
  | 'pointsFor'
  | 'pointsAgainst'
  | 'margin'
  | 'powers'
  | 'gets'
  | 'negs'
  | 'teamName';

export interface StatsOptions {
  phaseId?: string;
  poolId?: string;
  roundId?: string;
  generatedAt?: string;
  acceptedStatuses?: readonly string[];
  tiebreakers?: readonly TeamTiebreaker[];
}

interface MutableTeamStats extends Omit<
  TeamStatsRow,
  'rank' | 'winPercentage' | 'ppg' | 'papg' | 'pptuh' | 'ppb'
> {
  organizationId?: string;
}

type MutablePlayerStats = Omit<PlayerStatsRow, 'rank' | 'ppg' | 'pptuh' | 'ppb'>;

const defaultTiebreakers: readonly TeamTiebreaker[] = [
  'wins',
  'winPercentage',
  'pointsFor',
  'margin',
  'powers',
  'gets',
  'teamName',
];

function acceptedGame(game: GameRecord, statuses: readonly string[]): boolean {
  return statuses.includes(game.status ?? (game.result ? 'complete' : 'scheduled'));
}

function resultTeam(result: GameTeamResult | undefined): GameTeamResult | undefined {
  return result;
}

function valueOrZero(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : 0;
}

function configTiebreakers(
  data: DirectorTournament,
  options: StatsOptions,
  warnings: FormatWarning[],
): readonly TeamTiebreaker[] {
  if (options.tiebreakers) return options.tiebreakers;
  const configured = data.rules?.tiebreakers;
  if (!Array.isArray(configured)) return defaultTiebreakers;
  const accepted = configured.filter(
    (value): value is TeamTiebreaker =>
      typeof value === 'string' && (defaultTiebreakers as readonly string[]).includes(value),
  );
  const unsupported = configured.filter(
    (value) => typeof value !== 'string' || !(defaultTiebreakers as readonly string[]).includes(value),
  );
  unsupported.forEach((value, index) =>
    warnings.push(
      warning(
        'unsupported-tiebreaker',
        `rules.tiebreakers[${index}]`,
        `The tiebreaker ${String(value)} is not implemented by this exporter; the configured value was ignored for ranking.`,
      ),
    ),
  );
  return accepted.length > 0 ? accepted : defaultTiebreakers;
}

function compareTeams(a: MutableTeamStats, b: MutableTeamStats, order: readonly TeamTiebreaker[]): number {
  for (const key of order) {
    if (key === 'teamName') {
      const comparison = a.teamName.localeCompare(b.teamName);
      if (comparison !== 0) return comparison;
      continue;
    }
    const aValue = key === 'winPercentage' ? (a.gamesPlayed > 0 ? a.wins / a.gamesPlayed : 0) : a[key];
    const bValue = key === 'winPercentage' ? (b.gamesPlayed > 0 ? b.wins / b.gamesPlayed : 0) : b[key];
    if (aValue !== bValue) return bValue - aValue;
  }
  return a.teamId.localeCompare(b.teamId);
}

function rankRows<T>(rows: T[], compare: (left: T, right: T) => number): T[] {
  return rows
    .slice()
    .sort(compare)
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

function teamRow(mutable: MutableTeamStats): TeamStatsRow {
  const games = mutable.gamesPlayed;
  const tossups = mutable.tossupsHeard;
  const bonuses = mutable.bonusesHeard;
  return {
    rank: 0,
    ...mutable,
    winPercentage: games > 0 ? mutable.wins / games : 0,
    ppg: games > 0 ? mutable.pointsFor / games : 0,
    papg: games > 0 ? mutable.pointsAgainst / games : 0,
    pptuh: tossups > 0 ? mutable.pointsFor / tossups : 0,
    ppb: bonuses > 0 ? mutable.bonusPoints / bonuses : 0,
  };
}

function playerRow(mutable: MutablePlayerStats): PlayerStatsRow {
  return {
    rank: 0,
    ...mutable,
    ppg: mutable.gamesPlayed > 0 ? mutable.points / mutable.gamesPlayed : 0,
    pptuh: mutable.tossupsHeard > 0 ? mutable.points / mutable.tossupsHeard : 0,
    ppb: mutable.bonusesHeard > 0 ? mutable.bonusPoints / mutable.bonusesHeard : 0,
  };
}

/** Derive reportable team/player/game statistics from accepted game results. */
export function buildStatsSnapshot(
  input: DirectorTournamentInput | DirectorTournament,
  options: StatsOptions = {},
): FormatReport<StatsSnapshot> {
  const normalized = normalizeTournamentData(input);
  if (!normalized.ok) return normalized;
  const data = normalized.value;
  const warnings = [...normalized.warnings];
  const statuses = options.acceptedStatuses ?? ['accepted', 'complete', 'forfeit'];
  const teamById = new Map(data.teams.map((team) => [team.id, team]));
  const teamStats = new Map<string, MutableTeamStats>();
  const playerStats = new Map<string, MutablePlayerStats>();
  const games: GameStatsRow[] = [];
  const ensureTeam = (teamId: string): MutableTeamStats => {
    const existing = teamStats.get(teamId);
    if (existing) return existing;
    const team = teamById.get(teamId);
    const created: MutableTeamStats = {
      teamId,
      teamName: team?.name ?? teamId,
      ...(team?.organizationId ? { organizationId: team.organizationId } : {}),
      gamesPlayed: 0,
      wins: 0,
      losses: 0,
      ties: 0,
      pointsFor: 0,
      pointsAgainst: 0,
      margin: 0,
      powers: 0,
      gets: 0,
      negs: 0,
      tossupsHeard: 0,
      bonusPoints: 0,
      bonusesHeard: 0,
    };
    teamStats.set(teamId, created);
    return created;
  };
  const ensurePlayer = (result: GamePlayerResult): MutablePlayerStats => {
    const existing = playerStats.get(result.playerId);
    if (existing) return existing;
    const team = teamById.get(result.teamId);
    const created: MutablePlayerStats = {
      playerId: result.playerId,
      playerName: data.players.find((player) => player.id === result.playerId)?.name ?? result.playerId,
      teamId: result.teamId,
      teamName: team?.name ?? result.teamId,
      gamesPlayed: 0,
      tossupsHeard: 0,
      powers: 0,
      gets: 0,
      negs: 0,
      points: 0,
      bonusesHeard: 0,
      bonusPoints: 0,
    };
    playerStats.set(result.playerId, created);
    return created;
  };

  data.games.forEach((game) => {
    if (!acceptedGame(game, statuses) || !game.result) return;
    if (options.phaseId && game.phaseId !== options.phaseId) return;
    if (options.poolId && game.poolId !== options.poolId) return;
    if (options.roundId && game.roundId !== options.roundId) return;
    const ids = game.teamIds.filter((id): id is string => Boolean(id));
    if (ids.length !== 2) {
      warnings.push(
        warning(
          'invalid-stats-game',
          `games.${game.id}.teamIds`,
          'A stats result needs two teams; this game was omitted from standings but retained in the source tournament.',
        ),
      );
      return;
    }
    const first = resultTeam(game.result.teams.find((result) => result.teamId === ids[0]));
    const second = resultTeam(game.result.teams.find((result) => result.teamId === ids[1]));
    const firstPoints = first?.points;
    const secondPoints = second?.points;
    if (firstPoints === undefined || secondPoints === undefined) {
      warnings.push(
        warning(
          'missing-score',
          `games.${game.id}.result`,
          'A game without two numeric team scores was omitted from derived standings.',
        ),
      );
      return;
    }
    const firstTeam = ensureTeam(ids[0]);
    const secondTeam = ensureTeam(ids[1]);
    firstTeam.gamesPlayed += 1;
    secondTeam.gamesPlayed += 1;
    firstTeam.pointsFor += firstPoints;
    firstTeam.pointsAgainst += secondPoints;
    firstTeam.margin += firstPoints - secondPoints;
    secondTeam.pointsFor += secondPoints;
    secondTeam.pointsAgainst += firstPoints;
    secondTeam.margin += secondPoints - firstPoints;
    if (first?.forfeitLoss) {
      firstTeam.losses += 1;
      secondTeam.wins += 1;
    } else if (second?.forfeitLoss) {
      secondTeam.losses += 1;
      firstTeam.wins += 1;
    } else if (firstPoints > secondPoints) {
      firstTeam.wins += 1;
      secondTeam.losses += 1;
    } else if (secondPoints > firstPoints) {
      secondTeam.wins += 1;
      firstTeam.losses += 1;
    } else {
      firstTeam.ties += 1;
      secondTeam.ties += 1;
    }
    const updateTeamStats = (team: MutableTeamStats, result: GameTeamResult | undefined) => {
      if (!result) return;
      team.powers = valueOrZero(team.powers) + valueOrZero(result.powers);
      team.gets = valueOrZero(team.gets) + valueOrZero(result.gets);
      team.negs = valueOrZero(team.negs) + valueOrZero(result.negs);
      team.tossupsHeard = valueOrZero(team.tossupsHeard) + valueOrZero(result.tossupsHeard);
      team.bonusPoints = valueOrZero(team.bonusPoints) + valueOrZero(result.bonusPoints);
      team.bonusesHeard = valueOrZero(team.bonusesHeard) + valueOrZero(result.bonusesHeard);
    };
    updateTeamStats(firstTeam, first);
    updateTeamStats(secondTeam, second);
    const resultPlayers = game.result.players ?? [];
    resultPlayers.forEach((result) => {
      const player = ensurePlayer(result);
      player.gamesPlayed += 1;
      player.tossupsHeard += valueOrZero(result.tossupsHeard);
      player.powers += valueOrZero(result.powers);
      player.gets += valueOrZero(result.gets);
      player.negs += valueOrZero(result.negs);
      player.points += valueOrZero(result.points);
      player.bonusesHeard += valueOrZero(result.bonusesHeard);
      player.bonusPoints += valueOrZero(result.bonusPoints);
    });
    const firstName = teamById.get(ids[0])?.name ?? ids[0];
    const secondName = teamById.get(ids[1])?.name ?? ids[1];
    games.push({
      gameId: game.id,
      ...(game.phaseId ? { phaseId: game.phaseId } : {}),
      ...(game.roundId ? { roundId: game.roundId } : {}),
      teamOneId: ids[0],
      teamOneName: firstName,
      teamOnePoints: firstPoints,
      teamTwoId: ids[1],
      teamTwoName: secondName,
      teamTwoPoints: secondPoints,
      ...(firstPoints === secondPoints ? {} : { winnerId: firstPoints > secondPoints ? ids[0] : ids[1] }),
      status: game.status ?? 'complete',
    });
  });

  const tiebreakers = configTiebreakers(data, options, warnings);
  const teams = rankRows([...teamStats.values()].map(teamRow), (left, right) =>
    compareTeams(left, right, tiebreakers),
  );
  const players = rankRows(
    [...playerStats.values()].map(playerRow),
    (left, right) =>
      right.ppg - left.ppg ||
      right.powers - left.powers ||
      right.gets - left.gets ||
      left.playerName.localeCompare(right.playerName),
  );
  return ok(
    {
      format: statsFormat,
      version: statsVersion,
      generatedAt: options.generatedAt ?? new Date().toISOString(),
      tournament: { id: data.tournament.id, name: data.tournament.name },
      teams,
      players,
      games,
    },
    warnings,
  );
}

function htmlEscape(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const teamStatHeaders = [
  'rank',
  'team_id',
  'team_name',
  'organization_id',
  'games_played',
  'wins',
  'losses',
  'ties',
  'win_percentage',
  'points_for',
  'points_against',
  'ppg',
  'papg',
  'margin',
  'powers',
  'gets',
  'negs',
  'tossups_heard',
  'pptuh',
  'bonus_points',
  'bonuses_heard',
  'ppb',
] as const;

const playerStatHeaders = [
  'rank',
  'player_id',
  'player_name',
  'team_id',
  'team_name',
  'games_played',
  'tossups_heard',
  'powers',
  'gets',
  'negs',
  'points',
  'ppg',
  'pptuh',
  'bonuses_heard',
  'bonus_points',
  'ppb',
] as const;

const gameStatHeaders = [
  'game_id',
  'phase_id',
  'round_id',
  'team_one_id',
  'team_one_name',
  'team_one_points',
  'team_two_id',
  'team_two_name',
  'team_two_points',
  'winner_id',
  'status',
] as const;

export function exportTeamStandingsCsv(snapshot: StatsSnapshot): string {
  return serializeCsv(
    teamStatHeaders,
    snapshot.teams.map((row) => [
      row.rank,
      row.teamId,
      row.teamName,
      row.organizationId,
      row.gamesPlayed,
      row.wins,
      row.losses,
      row.ties,
      row.winPercentage,
      row.pointsFor,
      row.pointsAgainst,
      row.ppg,
      row.papg,
      row.margin,
      row.powers,
      row.gets,
      row.negs,
      row.tossupsHeard,
      row.pptuh,
      row.bonusPoints,
      row.bonusesHeard,
      row.ppb,
    ]),
  );
}

export function exportPlayerStatsCsv(snapshot: StatsSnapshot): string {
  return serializeCsv(
    playerStatHeaders,
    snapshot.players.map((row) => [
      row.rank,
      row.playerId,
      row.playerName,
      row.teamId,
      row.teamName,
      row.gamesPlayed,
      row.tossupsHeard,
      row.powers,
      row.gets,
      row.negs,
      row.points,
      row.ppg,
      row.pptuh,
      row.bonusesHeard,
      row.bonusPoints,
      row.ppb,
    ]),
  );
}

export function exportGameResultsCsv(snapshot: StatsSnapshot): string {
  return serializeCsv(
    gameStatHeaders,
    snapshot.games.map((row) => [
      row.gameId,
      row.phaseId,
      row.roundId,
      row.teamOneId,
      row.teamOneName,
      row.teamOnePoints,
      row.teamTwoId,
      row.teamTwoName,
      row.teamTwoPoints,
      row.winnerId,
      row.status,
    ]),
  );
}

export type StatsCsvSection = 'teams' | 'players' | 'games';

export function exportStatsCsv(snapshot: StatsSnapshot, section: StatsCsvSection = 'teams'): string {
  if (section === 'players') return exportPlayerStatsCsv(snapshot);
  if (section === 'games') return exportGameResultsCsv(snapshot);
  return exportTeamStandingsCsv(snapshot);
}

export function exportStatsJson(snapshot: StatsSnapshot, pretty = true): string {
  return `${JSON.stringify(snapshot, null, pretty ? 2 : 0)}\n`;
}

function tableHtml<T extends object>(
  title: string,
  headers: readonly string[],
  rows: readonly T[],
  values: (row: T) => readonly unknown[],
): string {
  return `<section><h2>${htmlEscape(title)}</h2><table><thead><tr>${headers.map((header) => `<th>${htmlEscape(header)}</th>`).join('')}</tr></thead><tbody>${rows
    .map(
      (row) =>
        `<tr>${values(row)
          .map((value) => `<td>${htmlEscape(value)}</td>`)
          .join('')}</tr>`,
    )
    .join('')}</tbody></table></section>`;
}

export function exportStatsHtml(snapshot: StatsSnapshot): string {
  const teamTable = tableHtml('Team standings', teamStatHeaders, snapshot.teams, (row) => [
    row.rank,
    row.teamId,
    row.teamName,
    row.organizationId,
    row.gamesPlayed,
    row.wins,
    row.losses,
    row.ties,
    row.winPercentage.toFixed(3),
    row.pointsFor,
    row.pointsAgainst,
    row.ppg.toFixed(1),
    row.papg.toFixed(1),
    row.margin,
    row.powers,
    row.gets,
    row.negs,
    row.tossupsHeard,
    row.pptuh.toFixed(2),
    row.bonusPoints,
    row.bonusesHeard,
    row.ppb.toFixed(2),
  ]);
  const playerTable = tableHtml('Player statistics', playerStatHeaders, snapshot.players, (row) => [
    row.rank,
    row.playerId,
    row.playerName,
    row.teamId,
    row.teamName,
    row.gamesPlayed,
    row.tossupsHeard,
    row.powers,
    row.gets,
    row.negs,
    row.points,
    row.ppg.toFixed(1),
    row.pptuh.toFixed(2),
    row.bonusesHeard,
    row.bonusPoints,
    row.ppb.toFixed(2),
  ]);
  const gameTable = tableHtml('Game results', gameStatHeaders, snapshot.games, (row) => [
    row.gameId,
    row.phaseId,
    row.roundId,
    row.teamOneId,
    row.teamOneName,
    row.teamOnePoints,
    row.teamTwoId,
    row.teamTwoName,
    row.teamTwoPoints,
    row.winnerId,
    row.status,
  ]);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${htmlEscape(snapshot.tournament.name)} statistics</title><style>body{font:14px system-ui,sans-serif;color:#1f2933;margin:32px}h1{font-size:24px;font-weight:600}h2{font-size:18px;margin:28px 0 8px}table{border-collapse:collapse;width:100%;margin-bottom:24px}th,td{border:1px solid #d7dde3;padding:5px 7px;text-align:left;white-space:nowrap}th{background:#f1f4f6;font-weight:600}tr:nth-child(even){background:#fafbfc}@media print{body{margin:12px}section{break-inside:avoid}}</style></head><body><h1>${htmlEscape(snapshot.tournament.name)}</h1><p>Generated ${htmlEscape(snapshot.generatedAt)}</p>${teamTable}${playerTable}${gameTable}</body></html>`;
}

export const exportStats = exportStatsJson;
