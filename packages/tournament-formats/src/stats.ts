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
import { strToU8, zipSync } from 'fflate';
import { serializeCsv } from './csv';
import { normalizeTournamentData } from './tournament';
import { ok, warning } from './util';

export const statsFormat = 'qbsheet-stats' as const;
export const statsVersion = 1;

export interface TeamStatsRow {
  /** Final rank: the director's explicit final placement when one exists. */
  rank: number;
  /** Rank from calculated results alone; present only when it differs from rank. */
  calculatedRank?: number;
  teamId: string;
  teamName: string;
  organizationId?: string;
  classifications?: string[];
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
  superpowers: number;
  powers: number;
  gets: number;
  negs: number;
  /** Null when any contributing scoresheet omitted tossups-heard; never a partial-sum zero. */
  tossupsHeard: number | null;
  /**
   * False when any contributing non-forfeit game lacked an exact tossups-read count (#746):
   * unknown TUH renders null, never a fabricated zero (#754).
   */
  tossupsHeardKnown: boolean;
  /**
   * Regulation tossups heard (total minus known overtime); null when not exactly derivable.
   * Normalized PPX-style display divides by this denominator, never by summed player exposure.
   */
  tossupsHeardRegulation: number | null;
  /**
   * Regulation points (total minus known overtime); null when the overtime split is
   * unknown. Normalized Pts/X divides this numerator by the regulation denominator.
   */
  regulationPoints: number | null;
  /** Null when tossups-heard is unknown or zero: PPTUH is undefined, not zero. */
  pptuh: number | null;
  bonusPoints: number;
  bonusesHeard: number;
  /** Null when no bonuses were heard: PPB is undefined, not zero. */
  ppb: number | null;
  /**
   * Bounceback points earned. Unknown (not zero) when any contributing result supplied no
   * bounceback breakdown; see bouncebacksKnown (#748).
   */
  bouncebackPoints: number;
  /** False when any contributing result lacked a bounceback breakdown. */
  bouncebacksKnown: boolean;
  /**
   * Bounceback parts heard (opponents' unconverted bonus value in parts, #748).
   * Null when any contributing game lacks the opponent bonus detail or the
   * regular rules the denominator requires; never a fabricated zero.
   */
  bouncebackPartsHeard: number | null;
  /** Bounceback parts converted; null when any contributing breakdown is unknown. */
  bouncebackPartsConverted: number | null;
  /** Bounceback conversion as a fraction of parts heard; null unless parts are known and heard. */
  bouncebackConversion: number | null;
  /**
   * Total bonus conversion as a fraction (own plus bounceback converted parts over
   * own plus bounceback parts heard); null unless every part is known.
   */
  totalBonusConversion: number | null;
  /** Sum of known per-game lightning points; null when any game lacked the breakdown. */
  lightningPoints: number | null;
  /** False when any contributing game lacked a lightning breakdown (unknown, not zero). */
  lightningKnown: boolean;
}

export interface PlayerStatsRow {
  rank: number;
  playerId: string;
  playerName: string;
  teamId: string;
  teamName: string;
  schoolYear?: number | null;
  /** Player-level UG eligibility; null when unknown or not supplied (#749). */
  undergraduateEligible: boolean | null;
  /** Player-level D2 eligibility; null when unknown or not supplied (#749). */
  divisionTwoEligible: boolean | null;
  /** Fractional GP (player TUH / game TUH); see the canonical domain engine (#746). */
  gamesPlayed: number;
  /** False when some appearance cannot be expressed fractionally (#746). */
  gamesPlayedKnown: boolean;
  /** Null when any contributing scoresheet omitted tossups-heard. */
  tossupsHeard: number | null;
  superpowers: number;
  powers: number;
  gets: number;
  negs: number;
  points: number;
  /** Null when games played is unknown: a partial denominator must not masquerade as a rate. */
  ppg: number | null;
  /** Null when tossups-heard is unknown or zero. */
  pptuh: number | null;
  bonusesHeard: number;
  bonusPoints: number;
  /** Null when no bonuses were heard. */
  ppb: number | null;
}

export interface GameStatsRow {
  gameId: string;
  phaseId?: string;
  roundId?: string;
  roundName?: string;
  teamOneId: string;
  teamOneName: string;
  teamOnePoints?: number;
  teamTwoId: string;
  teamTwoName: string;
  teamTwoPoints?: number;
  winnerId?: string;
  status: string;
  /** 'complete' detail, or 'partial' when the scoresheet omitted detail stats. */
  detail?: string;
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
  'rank' | 'winPercentage' | 'ppg' | 'papg' | 'pptuh' | 'ppb' | 'tossupsHeard' | 'tossupsHeardRegulation'
> {
  organizationId?: string;
  /** Running exact total; the row exposes null unless every contributing game was exact. */
  tossupsHeard: number;
  tossupsHeardRegulation: number;
  /** Tracks regulation known-ness while aggregating; the row exposes a nullable value instead. */
  tossupsHeardRegulationKnown: boolean;
}

type MutablePlayerStats = Omit<PlayerStatsRow, 'rank' | 'ppg' | 'pptuh' | 'ppb' | 'tossupsHeard'> & {
  tossupsHeard: number;
  /** Tracks known-ness while aggregating; the row exposes nullable tossupsHeard instead. */
  tossupsHeardKnown: boolean;
};

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

function isForfeitGame(game: GameRecord): boolean {
  return (
    game.status === 'forfeit' ||
    game.result?.forfeit === true ||
    (game.result?.teams ?? []).some((team) => team.forfeitLoss === true)
  );
}

function validGameTuh(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value) && value >= 0;
}

/**
 * Game-level TUH for both teams from the exact result count (#746).
 *
 * Forfeits contribute W/L but no denominator; a non-forfeit game without an exact count marks
 * both teams unknown rather than summing player exposure. Regulation TUH subtracts known
 * overtime; an absent overtime count is a known zero only when the tournament rules have no
 * overtime period.
 */
function addGameResultTuh(
  data: DirectorTournament,
  firstTeam: MutableTeamStats,
  secondTeam: MutableTeamStats,
  game: GameRecord,
): void {
  const tossupsRead = game.result?.tossupsRead;
  if (isForfeitGame(game) || !validGameTuh(tossupsRead)) {
    if (!isForfeitGame(game)) {
      firstTeam.tossupsHeardKnown = false;
      secondTeam.tossupsHeardKnown = false;
      firstTeam.tossupsHeardRegulationKnown = false;
      secondTeam.tossupsHeardRegulationKnown = false;
    }
    return;
  }
  firstTeam.tossupsHeard += tossupsRead;
  secondTeam.tossupsHeard += tossupsRead;
  const overtime = game.result?.overtimeTossupsRead;
  const overtimeKnown = validGameTuh(overtime)
    ? overtime
    : (data.rules as { overtime?: unknown } | undefined)?.overtime === false
      ? 0
      : null;
  if (overtimeKnown === null || overtimeKnown > tossupsRead) {
    firstTeam.tossupsHeardRegulationKnown = false;
    secondTeam.tossupsHeardRegulationKnown = false;
    return;
  }
  firstTeam.tossupsHeardRegulation += tossupsRead - overtimeKnown;
  secondTeam.tossupsHeardRegulation += tossupsRead - overtimeKnown;
}

function resultTeam(result: GameTeamResult | undefined): GameTeamResult | undefined {
  return result;
}

function valueOrZero(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Tri-state eligibility: only a real boolean is known, everything else is unknown (#749). */
function eligibilityOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/**
 * Roster eligibility from extensions, with a YellowFruit YfData sidecar fallback (#749).
 *
 * Mirrors the Director interchange rule so a snapshot built directly from YFT-derived input
 * agrees with the imported canonical state: QBSheet's own vocabulary wins, YfData fills gaps.
 */
function rosterEligibility(
  extensions:
    { undergraduateEligible?: unknown; divisionTwoEligible?: unknown; YfData?: unknown } | undefined,
  key: 'undergraduateEligible' | 'divisionTwoEligible',
  sidecarKey: 'isUG' | 'isD2',
): boolean | null {
  const own = eligibilityOrNull(extensions?.[key]);
  if (own !== null) return own;
  const sidecar =
    extensions?.YfData !== null &&
    typeof extensions?.YfData === 'object' &&
    !Array.isArray(extensions?.YfData)
      ? (extensions.YfData as Record<string, unknown>)
      : undefined;
  return eligibilityOrNull(sidecar?.[sidecarKey]);
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

function compareTeams(a: TeamStatsRow, b: TeamStatsRow, order: readonly TeamTiebreaker[]): number {
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

/** Null rate (unknown or zero denominator) sorts after every known rate. */
function comparePlayerRate(left: number | null, right: number | null): number {
  if (left !== null && right !== null) return right - left;
  if (left !== null) return -1;
  if (right !== null) return 1;
  return 0;
}

function teamRow(mutable: MutableTeamStats): TeamStatsRow {
  const games = mutable.gamesPlayed;
  const tossups =
    mutable.tossupsHeardKnown && typeof mutable.tossupsHeard === 'number' ? mutable.tossupsHeard : 0;
  const bonuses = mutable.bonusesHeard;
  const { tossupsHeardRegulationKnown, ...rest } = mutable;
  return {
    rank: 0,
    ...rest,
    winPercentage: games > 0 ? mutable.wins / games : 0,
    ppg: games > 0 ? mutable.pointsFor / games : 0,
    papg: games > 0 ? mutable.pointsAgainst / games : 0,
    // Unknown TUH is null like the player rows, never the partial sum (#754).
    tossupsHeard: mutable.tossupsHeardKnown ? mutable.tossupsHeard : null,
    pptuh: tossups > 0 ? mutable.pointsFor / tossups : null,
    ppb: bonuses > 0 ? mutable.bonusPoints / bonuses : null,
    tossupsHeardRegulation: tossupsHeardRegulationKnown ? mutable.tossupsHeardRegulation : null,
    lightningPoints: mutable.lightningKnown ? mutable.lightningPoints : null,
  };
}

function playerRow(mutable: MutablePlayerStats): PlayerStatsRow {
  const { tossupsHeardKnown, ...rest } = mutable;
  const known = tossupsHeardKnown;
  return {
    rank: 0,
    ...rest,
    tossupsHeard: known ? mutable.tossupsHeard : null,
    ppg: mutable.gamesPlayedKnown && mutable.gamesPlayed > 0 ? mutable.points / mutable.gamesPlayed : null,
    pptuh: known && mutable.tossupsHeard > 0 ? mutable.points / mutable.tossupsHeard : null,
    ppb: mutable.bonusesHeard > 0 ? mutable.bonusPoints / mutable.bonusesHeard : null,
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
      superpowers: 0,
      powers: 0,
      gets: 0,
      negs: 0,
      tossupsHeard: 0,
      tossupsHeardKnown: true,
      tossupsHeardRegulation: 0,
      tossupsHeardRegulationKnown: true,
      // The interchange result carries no per-team overtime-points split, so the
      // regulation numerator stays unknown here; the canonical adapter fills it
      // from the domain regulation derivation (#755).
      regulationPoints: null,
      bonusPoints: 0,
      bonusesHeard: 0,
      bouncebackPoints: 0,
      bouncebacksKnown: true,
      // The interchange snapshot declines parts derivation: it cannot prove
      // per-game bonus regularity, and the canonical adapter is the parity path
      // that fills these from the domain engine (#748, #751).
      bouncebackPartsHeard: null,
      bouncebackPartsConverted: null,
      bouncebackConversion: null,
      totalBonusConversion: null,
      lightningPoints: 0,
      lightningKnown: true,
    };
    teamStats.set(teamId, created);
    return created;
  };
  const ensurePlayer = (result: GamePlayerResult): MutablePlayerStats => {
    const existing = playerStats.get(result.playerId);
    if (existing) return existing;
    const team = teamById.get(result.teamId);
    const roster = data.players.find((player) => player.id === result.playerId);
    const created: MutablePlayerStats = {
      playerId: result.playerId,
      playerName: roster?.name ?? result.playerId,
      teamId: result.teamId,
      teamName: team?.name ?? result.teamId,
      // YellowFruit parity (#749): roster-level eligibility rides the snapshot row; a
      // player with no roster entry keeps both flags unknown rather than false.
      undergraduateEligible: rosterEligibility(roster?.extensions, 'undergraduateEligible', 'isUG'),
      divisionTwoEligible: rosterEligibility(roster?.extensions, 'divisionTwoEligible', 'isD2'),
      gamesPlayed: 0,
      gamesPlayedKnown: true,
      tossupsHeard: 0,
      tossupsHeardKnown: true,
      superpowers: 0,
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
      team.superpowers = valueOrZero(team.superpowers) + valueOrZero(result.superpowers);
      team.powers = valueOrZero(team.powers) + valueOrZero(result.powers);
      team.gets = valueOrZero(team.gets) + valueOrZero(result.gets);
      team.negs = valueOrZero(team.negs) + valueOrZero(result.negs);
      team.bonusPoints = valueOrZero(team.bonusPoints) + valueOrZero(result.bonusPoints);
      team.bonusesHeard = valueOrZero(team.bonusesHeard) + valueOrZero(result.bonusesHeard);
      // An omitted breakdown is a legacy zero shorthand; an explicit null is an unknown
      // manual/imported result, never a verified zero (#748).
      if (result.bonusBouncebackPoints === null) team.bouncebacksKnown = false;
      else
        team.bouncebackPoints =
          valueOrZero(team.bouncebackPoints) + valueOrZero(result.bonusBouncebackPoints);
      if (result.lightningPoints === undefined) team.lightningKnown = false;
      else team.lightningPoints = valueOrZero(team.lightningPoints ?? undefined) + result.lightningPoints;
    };
    updateTeamStats(firstTeam, first);
    updateTeamStats(secondTeam, second);
    // Team TUH comes from the game's exact tossups-read count, never summed player exposure;
    // forfeits contribute W/L but no denominator (#746).
    addGameResultTuh(data, firstTeam, secondTeam, game);
    const gameTuh =
      typeof game.result.tossupsRead === 'number' &&
      Number.isInteger(game.result.tossupsRead) &&
      game.result.tossupsRead > 0 &&
      !isForfeitGame(game)
        ? game.result.tossupsRead
        : null;
    const resultPlayers = game.result.players ?? [];
    resultPlayers.forEach((result) => {
      const player = ensurePlayer(result);
      // Exposure beyond the game's own count is corrupt data, not extra participation:
      // crediting it would publish more than one GP for a single game.
      if (result.tossupsHeard !== undefined && gameTuh !== null && result.tossupsHeard <= gameTuh) {
        player.gamesPlayed += result.tossupsHeard / gameTuh;
      } else {
        player.gamesPlayedKnown = false;
      }
      if (result.tossupsHeard === undefined) player.tossupsHeardKnown = false;
      else player.tossupsHeard += result.tossupsHeard;
      player.superpowers += valueOrZero(result.superpowers);
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
  // YellowFruit parity (#751): individuals order by PPTUH descending with unknown
  // rates last, matching the canonical domain engine; powers then player id break ties.
  const players = rankRows(
    [...playerStats.values()].map(playerRow),
    (left, right) =>
      comparePlayerRate(left.pptuh, right.pptuh) ||
      right.powers - left.powers ||
      left.playerId.localeCompare(right.playerId),
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
  'calculated_rank',
  'team_id',
  'team_name',
  'classifications',
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
  'superpowers',
  'powers',
  'gets',
  'negs',
  'tossups_heard',
  'tossups_heard_regulation',
  'pptuh',
  'bonus_points',
  'bonuses_heard',
  'ppb',
  'bounceback_points',
  'bounceback_parts_heard',
  'bounceback_parts_converted',
  'bounceback_conversion_pct',
  'total_bonus_conversion_pct',
  'lightning_points',
] as const;

const playerStatHeaders = [
  'rank',
  'player_id',
  'player_name',
  'team_id',
  'team_name',
  'school_year',
  'undergraduate_eligible',
  'division_2_eligible',
  'games_played',
  'tossups_heard',
  'superpowers',
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
  'round_name',
  'team_one_id',
  'team_one_name',
  'team_one_points',
  'team_two_id',
  'team_two_name',
  'team_two_points',
  'winner_id',
  'status',
  'detail',
] as const;

export function exportTeamStandingsCsv(snapshot: StatsSnapshot): string {
  return serializeCsv(
    teamStatHeaders,
    snapshot.teams.map((row) => [
      row.rank,
      row.calculatedRank ?? null,
      row.teamId,
      row.teamName,
      (row.classifications ?? []).join('; '),
      row.organizationId,
      row.gamesPlayed,
      row.wins,
      row.losses,
      row.ties,
      `${(row.winPercentage * 100).toFixed(1)}%`,
      row.pointsFor,
      row.pointsAgainst,
      row.ppg,
      row.papg,
      row.margin,
      row.superpowers,
      row.powers,
      row.gets,
      row.negs,
      row.tossupsHeardKnown ? row.tossupsHeard : null,
      row.tossupsHeardRegulation,
      row.pptuh,
      row.bonusPoints,
      row.bonusesHeard,
      row.ppb,
      row.bouncebacksKnown ? row.bouncebackPoints : null,
      row.bouncebackPartsHeard,
      row.bouncebackPartsConverted,
      row.bouncebackConversion !== null ? `${(row.bouncebackConversion * 100).toFixed(1)}%` : null,
      row.totalBonusConversion !== null ? `${(row.totalBonusConversion * 100).toFixed(1)}%` : null,
      row.lightningKnown ? row.lightningPoints : null,
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
      row.schoolYear ?? null,
      row.undergraduateEligible ?? null,
      row.divisionTwoEligible ?? null,
      row.gamesPlayedKnown ? row.gamesPlayed : null,
      row.tossupsHeard,
      row.superpowers,
      row.powers,
      row.gets,
      row.negs,
      row.points,
      row.gamesPlayedKnown ? row.ppg : null,
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
      row.roundName ?? null,
      row.teamOneId,
      row.teamOneName,
      row.teamOnePoints,
      row.teamTwoId,
      row.teamTwoName,
      row.teamTwoPoints,
      row.winnerId,
      row.status,
      row.detail ?? null,
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

/**
 * Unknown statistics render as an em dash in HTML reports, never as a
 * fabricated zero.
 */
export function unknownStatText(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '—';
}

function fixedStatText(value: number | null | undefined, digits: number): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';
}

export function exportStatsHtml(snapshot: StatsSnapshot): string {
  const teamTable = tableHtml('Team standings', teamStatHeaders, snapshot.teams, (row) => [
    row.rank,
    row.calculatedRank ?? '',
    row.teamId,
    row.teamName,
    (row.classifications ?? []).join('; '),
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
    row.superpowers,
    row.powers,
    row.gets,
    row.negs,
    row.tossupsHeardKnown ? row.tossupsHeard : '—',
    fixedStatText(row.pptuh, 2),
    row.bonusPoints,
    row.bonusesHeard,
    fixedStatText(row.ppb, 2),
    row.bouncebacksKnown ? row.bouncebackPoints : '—',
  ]);
  const playerTable = tableHtml('Player statistics', playerStatHeaders, snapshot.players, (row) => [
    row.rank,
    row.playerId,
    row.playerName,
    row.teamId,
    row.teamName,
    row.schoolYear ?? '',
    row.gamesPlayedKnown ? unknownStatText(row.gamesPlayed) : '—',
    unknownStatText(row.tossupsHeard),
    row.superpowers,
    row.powers,
    row.gets,
    row.negs,
    row.points,
    row.gamesPlayedKnown && row.ppg !== null ? row.ppg.toFixed(1) : '—',
    fixedStatText(row.pptuh, 2),
    row.bonusesHeard,
    row.bonusPoints,
    fixedStatText(row.ppb, 2),
  ]);
  const gameTable = tableHtml('Game results', gameStatHeaders, snapshot.games, (row) => [
    row.gameId,
    row.phaseId,
    row.roundId,
    row.roundName ?? '',
    row.teamOneId,
    row.teamOneName,
    row.teamOnePoints,
    row.teamTwoId,
    row.teamTwoName,
    row.teamTwoPoints,
    row.winnerId,
    row.status,
    row.detail ?? '',
  ]);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${htmlEscape(snapshot.tournament.name)} statistics</title><style>body{font:14px system-ui,sans-serif;color:#1f2933;margin:32px}h1{font-size:24px;font-weight:600}h2{font-size:18px;margin:28px 0 8px}table{border-collapse:collapse;width:100%;margin-bottom:24px}th,td{border:1px solid #d7dde3;padding:5px 7px;text-align:left;white-space:nowrap}th{background:#f1f4f6;font-weight:600}tr:nth-child(even){background:#fafbfc}@media print{body{margin:12px}section{break-inside:avoid}}</style></head><body><h1>${htmlEscape(snapshot.tournament.name)}</h1><p>Generated ${htmlEscape(snapshot.generatedAt)}</p>${teamTable}${playerTable}${gameTable}</body></html>`;
}

export const exportStats = exportStatsJson;

/**
 * Package a report bundle as a single ZIP download: the cleanest
 * browser/Tauri behavior for a multi-file static report. Page content stays
 * deterministic; only the ZIP container carries file metadata.
 */
export function zipStatReportBundle(pages: readonly StatReportPage[]): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (const page of pages) files[page.name] = strToU8(page.content);
  return zipSync(files);
}

export interface StatReportPage {
  name: string;
  content: string;
}

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

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/g, '')
      .replace(/-+$/g, '') || 'item'
  );
}

function teamAnchor(row: TeamStatsRow): string {
  return `team-${row.rank}-${slugify(row.teamId)}`;
}

function playerAnchor(row: PlayerStatsRow): string {
  return `player-${row.rank}-${slugify(row.playerId)}`;
}

const reportStyle = [
  'body{font:15px/1.5 system-ui,-apple-system,sans-serif;color:#1f2933;margin:0 auto;max-width:960px;padding:16px}',
  'nav ul{list-style:none;display:flex;flex-wrap:wrap;gap:4px 16px;margin:0 0 24px;padding:0 0 12px;border-bottom:2px solid #1f2933}',
  'h1{font-size:24px}h2{font-size:19px;margin-top:28px}h3{font-size:16px;margin-top:24px}',
  '.meta{color:#52606d}.table-wrap{overflow-x:auto}',
  'table{border-collapse:collapse;width:100%;margin:12px 0 24px}',
  'caption{text-align:left;font-weight:600;padding:4px 0}',
  'th,td{border:1px solid #d7dde3;padding:5px 8px;text-align:left;white-space:nowrap}',
  'td.num,th.num{text-align:right}',
  'th{background:#f1f4f6}tr:nth-child(even){background:#fafbfc}',
  'footer{margin-top:32px;padding-top:12px;border-top:1px solid #d7dde3;color:#52606d;font-size:13px}',
  '@media print{body{max-width:none}section{break-inside:avoid}}',
].join('');

function reportPage(snapshot: StatsSnapshot, title: string, body: string): string {
  const nav = `<nav aria-label="Stat reports"><ul>${reportNav
    .map((link) => `<li><a href="${link.href}">${htmlEscape(link.label)}</a></li>`)
    .join('')}</ul></nav>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${htmlEscape(title)} · ${htmlEscape(snapshot.tournament.name)}</title><style>${reportStyle}</style></head><body>${nav}<h1>${htmlEscape(snapshot.tournament.name)}</h1>${body}<footer>Generated ${htmlEscape(snapshot.generatedAt)} · QBSheet stat report</footer></body></html>`;
}

function cell(value: unknown, numeric = false): string {
  return `<td${numeric ? ' class="num"' : ''}>${htmlEscape(value ?? '')}</td>`;
}

function numCell(value: number | null | undefined, digits?: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '<td class="num">—</td>';
  return `<td class="num">${digits === undefined ? String(value) : value.toFixed(digits)}</td>`;
}

function recordText(row: TeamStatsRow): string {
  return row.ties > 0 ? `${row.wins}–${row.losses}–${row.ties}` : `${row.wins}–${row.losses}`;
}

function scopeNote(snapshot: StatsSnapshot): string {
  const extensions = snapshot.extensions ?? {};
  const scope = typeof extensions.scopeLabel === 'string' ? extensions.scopeLabel : 'Overall';
  const finalNote =
    extensions.finalPlacementApplied === true
      ? ' Ranks follow the director’s explicit final order; calculated ranks are shown where they differ.'
      : '';
  return `<p class="meta">Scope: ${htmlEscape(scope)} · ${snapshot.teams.length} teams · ${snapshot.games.length} games.${htmlEscape(finalNote)}</p>`;
}

function gamesByRound(
  snapshot: StatsSnapshot,
): { roundId: string; roundName: string; games: GameStatsRow[] }[] {
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

/**
 * A self-contained static report bundle: linked HTML pages with no JavaScript
 * and no external dependencies, usable directly from disk or static hosting.
 * Every page renders the same snapshot rows the CSV exporters use.
 */
export function buildStatReportBundle(snapshot: StatsSnapshot): StatReportPage[] {
  const showCalc = snapshot.teams.some(
    (row) => row.calculatedRank !== undefined && row.calculatedRank !== row.rank,
  );
  const showSuperpowers = snapshot.teams.some((row) => row.superpowers > 0);
  const showClassifications = snapshot.teams.some((row) => (row.classifications ?? []).length > 0);
  const showGrades = snapshot.players.some((row) => typeof row.schoolYear === 'number');

  const standingsRows = snapshot.teams
    .map(
      (row) =>
        `<tr><td class="num">${row.rank}</td>${showCalc ? cell(row.calculatedRank ?? '') : ''}<td><a href="teamdetail.html#${teamAnchor(row)}">${htmlEscape(row.teamName)}</a></td>` +
        `<td class="num">${htmlEscape(recordText(row))}</td><td class="num">${(row.winPercentage * 100).toFixed(1)}%</td>` +
        `<td class="num">${row.pointsFor}</td><td class="num">${row.pointsAgainst}</td><td class="num">${row.margin}</td>` +
        `<td class="num">${row.ppg.toFixed(1)}</td><td class="num">${row.papg.toFixed(1)}</td>${numCell(row.ppb, 2)}` +
        `${showSuperpowers ? cell(row.superpowers, true) : ''}<td class="num">${row.powers}</td><td class="num">${row.gets}</td><td class="num">${row.negs}</td>` +
        `${showClassifications ? cell((row.classifications ?? []).join('; ')) : ''}</tr>`,
    )
    .join('');
  const standingsTable =
    `<div class="table-wrap"><table><caption>Team standings</caption><thead><tr><th scope="col" class="num">#</th>` +
    `${showCalc ? '<th scope="col" class="num">Calc</th>' : ''}<th scope="col">Team</th><th scope="col" class="num">Record</th>` +
    `<th scope="col" class="num">Win %</th><th scope="col" class="num">PF</th><th scope="col" class="num">PA</th><th scope="col" class="num">Margin</th>` +
    `<th scope="col" class="num">PPG</th><th scope="col" class="num">PAPG</th><th scope="col" class="num">PPB</th>` +
    `${showSuperpowers ? '<th scope="col" class="num">15s</th>' : ''}<th scope="col" class="num">Powers</th><th scope="col" class="num">Gets</th><th scope="col" class="num">Negs</th>` +
    `${showClassifications ? '<th scope="col">Group</th>' : ''}</tr></thead><tbody>${standingsRows}</tbody></table></div>`;

  const teamById = new Map(snapshot.teams.map((row) => [row.teamId, row]));
  const individualsRows = snapshot.players
    .map(
      (row) =>
        `<tr><td class="num">${row.rank}</td><td><a href="playerdetail.html#${playerAnchor(row)}">${htmlEscape(row.playerName)}</a></td>` +
        `<td><a href="teamdetail.html#${teamAnchor(teamById.get(row.teamId) ?? ({ rank: 0, teamId: row.teamId } as TeamStatsRow))}">${htmlEscape(row.teamName)}</a></td>` +
        `${showGrades ? cell(typeof row.schoolYear === 'number' ? row.schoolYear : '—', true) : ''}` +
        `<td class="num">${row.gamesPlayed}</td>${numCell(row.tossupsHeard)}` +
        `${showSuperpowers ? cell(row.superpowers, true) : ''}<td class="num">${row.powers}</td><td class="num">${row.gets}</td><td class="num">${row.negs}</td>` +
        `<td class="num">${row.points}</td>${numCell(row.ppg, 1)}${numCell(row.pptuh, 2)}` +
        `<td class="num">${row.bonusPoints}</td>${numCell(row.ppb, 2)}</tr>`,
    )
    .join('');
  const individualsTable =
    `<div class="table-wrap"><table><caption>Individual statistics</caption><thead><tr><th scope="col" class="num">#</th><th scope="col">Player</th><th scope="col">Team</th>` +
    `${showGrades ? '<th scope="col" class="num">Grade</th>' : ''}<th scope="col" class="num">GP</th><th scope="col" class="num">TUH</th>` +
    `${showSuperpowers ? '<th scope="col" class="num">15s</th>' : ''}<th scope="col" class="num">Powers</th><th scope="col" class="num">Gets</th><th scope="col" class="num">Negs</th>` +
    `<th scope="col" class="num">Pts</th><th scope="col" class="num">PPG</th><th scope="col" class="num">PPTUH</th><th scope="col" class="num">Bonus</th><th scope="col" class="num">PPB</th></tr></thead><tbody>${individualsRows}</tbody></table></div>`;

  const gameLine = (game: GameStatsRow): string =>
    `<li>${htmlEscape(game.roundName ?? '')} · ${htmlEscape(game.teamOneName)} ${game.teamOnePoints ?? ''}–${game.teamTwoPoints ?? ''} ${htmlEscape(game.teamTwoName)}${game.detail === 'partial' ? ' (partial stats)' : ''}</li>`;
  const gamesRows = snapshot.games
    .map(
      (game) =>
        `<tr><td>${htmlEscape(game.roundName ?? '')}</td>` +
        `<td>${htmlEscape(game.teamOneName)} vs ${htmlEscape(game.teamTwoName)}</td>` +
        `<td class="num">${game.teamOnePoints ?? ''}–${game.teamTwoPoints ?? ''}</td>` +
        `<td>${game.detail === 'partial' ? 'Partial stats' : 'Complete'}</td></tr>`,
    )
    .join('');
  const gamesTable = `<div class="table-wrap"><table><caption>Games</caption><thead><tr><th scope="col">Round</th><th scope="col">Matchup</th><th scope="col" class="num">Score</th><th scope="col">Detail</th></tr></thead><tbody>${gamesRows}</tbody></table></div>`;

  const roundsSections = gamesByRound(snapshot)
    .map(
      (group) =>
        `<section aria-label="${htmlEscape(group.roundName)}"><h2>${htmlEscape(group.roundName)}</h2><ul>${group.games.map(gameLine).join('')}</ul></section>`,
    )
    .join('');

  const teamSections = snapshot.teams
    .map((row) => {
      const roster = snapshot.players.filter((player) => player.teamId === row.teamId);
      const log = snapshot.games.filter(
        (game) => game.teamOneId === row.teamId || game.teamTwoId === row.teamId,
      );
      return (
        `<section id="${teamAnchor(row)}" aria-label="${htmlEscape(row.teamName)}"><h2>${row.rank}. ${htmlEscape(row.teamName)}</h2>` +
        `<p>${htmlEscape(recordText(row))} · ${row.ppg.toFixed(1)} PPG · ${row.papg.toFixed(1)} PAPG · ` +
        `${typeof row.ppb === 'number' ? `${row.ppb.toFixed(2)} PPB` : 'PPB —'} · ${row.powers} powers, ${row.gets} gets, ${row.negs} negs` +
        `${showClassifications ? ` · Group: ${htmlEscape((row.classifications ?? []).join('; ') || '—')}` : ''}</p>` +
        `<h3>Roster</h3>${roster.length > 0 ? `<ul>${roster.map((player) => `<li><a href="playerdetail.html#${playerAnchor(player)}">${htmlEscape(player.playerName)}</a> · ${player.gamesPlayed} games · ${player.points} pts</li>`).join('')}</ul>` : '<p class="meta">No player statistics.</p>'}` +
        `<h3>Games</h3>${log.length > 0 ? `<ul>${log.map(gameLine).join('')}</ul>` : '<p class="meta">No games.</p>'}</section>`
      );
    })
    .join('');

  const playerSections = snapshot.players
    .map((row) => {
      const log = snapshot.games.filter(
        (game) => game.teamOneId === row.teamId || game.teamTwoId === row.teamId,
      );
      return (
        `<section id="${playerAnchor(row)}" aria-label="${htmlEscape(row.playerName)}"><h2>${htmlEscape(row.playerName)}</h2>` +
        `<p><a href="teamdetail.html#${teamAnchor(teamById.get(row.teamId) ?? ({ rank: 0, teamId: row.teamId } as TeamStatsRow))}">${htmlEscape(row.teamName)}</a>` +
        `${typeof row.schoolYear === 'number' ? ` · Grade ${row.schoolYear}` : ''} · ${row.gamesPlayed} games · ` +
        `${row.tossupsHeard === null ? 'TUH —' : `${row.tossupsHeard} TUH`} · ${row.powers}/${row.gets}/${row.negs} · ${row.points} pts · ${row.ppg === null ? 'PPG —' : `${row.ppg.toFixed(1)} PPG`} · ` +
        `${row.pptuh === null ? 'PPTUH —' : `${row.pptuh.toFixed(2)} PPTUH`}</p>` +
        `<h3>Games</h3>${log.length > 0 ? `<ul>${log.map(gameLine).join('')}</ul>` : '<p class="meta">No games.</p>'}</section>`
      );
    })
    .join('');

  const indexBody =
    `<p class="meta">${snapshot.teams.length} teams · ${snapshot.players.length} players · ${snapshot.games.length} games.</p>` +
    `<ul>${reportNav
      .filter((link) => link.href !== 'index.html')
      .map((link) => `<li><a href="${link.href}">${htmlEscape(link.label)}</a></li>`)
      .join('')}</ul>`;

  return [
    { name: 'index.html', content: reportPage(snapshot, 'Stat report', indexBody) },
    {
      name: 'standings.html',
      content: reportPage(snapshot, 'Standings', `${scopeNote(snapshot)}${standingsTable}`),
    },
    {
      name: 'individuals.html',
      content: reportPage(snapshot, 'Individuals', `${scopeNote(snapshot)}${individualsTable}`),
    },
    {
      name: 'games.html',
      content: reportPage(snapshot, 'Games', `${scopeNote(snapshot)}${gamesTable}`),
    },
    {
      name: 'rounds.html',
      content: reportPage(snapshot, 'Rounds', `${scopeNote(snapshot)}${roundsSections}`),
    },
    {
      name: 'teamdetail.html',
      content: reportPage(snapshot, 'Teams', `${scopeNote(snapshot)}${teamSections}`),
    },
    {
      name: 'playerdetail.html',
      content: reportPage(snapshot, 'Players', `${scopeNote(snapshot)}${playerSections}`),
    },
  ];
}
