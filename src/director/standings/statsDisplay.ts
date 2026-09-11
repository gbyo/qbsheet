/**
 * Shared presentation helpers for the Stats workspace.
 *
 * Pure functions only: scope options, column definitions with persisted
 * preferences, honest unknown-value rendering, and classification labels. The
 * canonical engine stays the single place that computes anything.
 */

import {
  buildReportPresentation,
  defaultReportOptions,
  pointsPerX,
  reportNumber,
  reportPercent,
  type ReportAnswerKey,
} from '@qbsheet/tournament-formats';
import {
  isTeamClassification,
  playerPptuh,
  type DirectorState,
  type Player,
  type PlayerStanding,
  type TeamClassification,
  type TeamStanding,
} from '../domain';
import { stateDefinitions } from '../reports/reportPresentation';

export const UNKNOWN_STAT = '—';

export interface StatsScope {
  id: string;
  label: string;
  phaseId?: string;
  poolId?: string;
  /** Explicit final-placement ordering instead of the calculated cascade. */
  final?: boolean;
  /**
   * Including-carryover variant of a phase/pool scope: the printable standings
   * composition counts prior-stage games between field teams, selected through the
   * same carryover game set (resolved to game ids by the caller, which owns state).
   */
  carryover?: boolean;
}

export function buildStatsScopes(state: DirectorState): { scopes: StatsScope[]; showSelector: boolean } {
  const phases = state.phases.filter((phase) => !phase.archived);
  const activePhaseIds = new Set(phases.map((phase) => phase.id));
  const pools = state.pools.filter((pool) => !pool.archived && activePhaseIds.has(pool.phaseId));
  const scopes: StatsScope[] = [{ id: 'overall', label: 'Overall' }];
  if (state.tournament?.finalPlacement) scopes.push({ id: 'final', label: 'Final', final: true });
  const carryoverScopes = (phaseId: string | undefined, poolId: string | undefined, label: string) => ({
    id: `carryover:${phaseId ?? ''}:${poolId ?? ''}`,
    label: `${label} · including carryover`,
    ...(phaseId !== undefined ? { phaseId } : {}),
    ...(poolId !== undefined ? { poolId } : {}),
    carryover: true,
  });
  if (phases.length > 1) {
    for (const phase of phases) {
      scopes.push({ id: `phase:${phase.id}`, label: phase.name, phaseId: phase.id });
      if (phase.carryover) scopes.push(carryoverScopes(phase.id, undefined, phase.name));
    }
    for (const pool of pools) {
      const phase = phases.find((entry) => entry.id === pool.phaseId);
      const label = `${phase?.name ?? 'Stage'} · ${pool.name}`;
      scopes.push({ id: `pool:${pool.id}`, label, phaseId: pool.phaseId, poolId: pool.id });
      if (phase?.carryover) scopes.push(carryoverScopes(pool.phaseId, pool.id, label));
    }
  } else if (pools.length > 1) {
    for (const pool of pools) scopes.push({ id: `pool:${pool.id}`, label: pool.name, poolId: pool.id });
  }
  return { scopes, showSelector: scopes.length > 1 };
}

/**
 * Explicit final-placement ordering: listed teams first in placement order, unlisted
 * teams keep their calculated order after them (mirrors the FinalPlacement contract).
 */
export function orderByFinalPlacement(standings: TeamStanding[], order: readonly string[]): TeamStanding[] {
  const rank = new Map(order.map((teamId, index) => [teamId, index]));
  return [...standings].sort((left, right) => {
    const leftRank = rank.get(left.teamId);
    const rightRank = rank.get(right.teamId);
    if (leftRank === undefined && rightRank === undefined) return 0;
    if (leftRank === undefined) return 1;
    if (rightRank === undefined) return -1;
    return leftRank - rightRank;
  });
}

export function scopeOptionsFor(scope: StatsScope): { phaseId?: string; poolId?: string } {
  // Carryover and final scopes resolve their game sets through the shared selectors at the
  // call site (carryover game set / full accepted games); only plain phase/pool scopes
  // filter here, exactly like the printable composition.
  if (scope.carryover || scope.final) return {};
  return {
    ...(scope.phaseId !== undefined ? { phaseId: scope.phaseId } : {}),
    ...(scope.poolId !== undefined ? { poolId: scope.poolId } : {}),
  };
}

export const classificationLabels: Record<TeamClassification, string> = {
  'small-school': 'Small School',
  'junior-varsity': 'JV',
  undergraduate: 'UG',
  'division-2': 'D2',
};

export function usedClassifications(state: DirectorState): TeamClassification[] {
  const seen = new Set<TeamClassification>();
  for (const team of state.teams) {
    for (const classification of team.classifications ?? []) {
      if (isTeamClassification(classification)) seen.add(classification);
    }
  }
  return [...seen];
}

export function teamClassificationsOf(state: DirectorState, teamId: string): TeamClassification[] {
  return (state.teams.find((team) => team.id === teamId)?.classifications ?? []).filter(isTeamClassification);
}

export function formatRecord(standing: Pick<TeamStanding, 'wins' | 'losses' | 'ties'>): string {
  return standing.ties > 0
    ? `${standing.wins}–${standing.losses}–${standing.ties}`
    : `${standing.wins}–${standing.losses}`;
}

/**
 * A win rate needs a game to be a rate. `deriveTeamStandings` seeds every confirmed team with
 * `winPercentage: 0`, so a team that has not played renders `0.0%` — indistinguishable on the page
 * from a team that played and lost every game. Unknown stays unknown.
 */
export function formatWinPct(standing: Pick<TeamStanding, 'winPercentage' | 'gamesPlayed'>): string {
  return standing.gamesPlayed > 0 ? `${(standing.winPercentage * 100).toFixed(1)}%` : UNKNOWN_STAT;
}

export function formatAverage(total: number, games: number): string {
  return games > 0 ? (total / games).toFixed(1) : '0.0';
}

/**
 * Points per bonus is undefined — not zero — when no bonuses were heard. A
 * manual result without detail and a team that never converted both render
 * honestly instead of fabricating 0.00.
 */
export function formatPpb(standing: Pick<TeamStanding, 'bonuses' | 'bonusPoints'>): string {
  return standing.bonuses > 0 ? (standing.bonusPoints / standing.bonuses).toFixed(2) : UNKNOWN_STAT;
}

export interface TossupsHeardKnown {
  tossupsHeard: number;
  tossupsHeardKnown?: boolean;
}

export function formatTuh(standing: TossupsHeardKnown): string {
  return standing.tossupsHeardKnown === false ? UNKNOWN_STAT : String(standing.tossupsHeard);
}

/**
 * Fractional games played renders trimmed (1, 0.5, never 1.00); unknown participation
 * renders "—" rather than a partial sum (#746).
 */
export function formatGamesPlayed(
  standing: Pick<PlayerStanding, 'gamesPlayed' | 'gamesPlayedKnown'>,
): string | number {
  if (standing.gamesPlayedKnown === false) return UNKNOWN_STAT;
  return Number.isInteger(standing.gamesPlayed)
    ? standing.gamesPlayed
    : Number(standing.gamesPlayed.toFixed(2));
}

/**
 * Points per game needs a known games denominator. A scorer with result lines
 * but no game TUH renders "—" rather than 0.0 (#746).
 */
export function formatPlayerPpg(standing: Pick<PlayerStanding, 'gamesPlayedKnown' | 'ppg'>): string {
  if (standing.gamesPlayedKnown === false) return UNKNOWN_STAT;
  return standing.ppg.toFixed(1);
}

/** Points per tossup heard needs a known, nonzero denominator; otherwise "—". */
export function formatPptuh(points: number, standing: TossupsHeardKnown): string {
  const value = pptuhValue(points, standing);
  return value === null ? UNKNOWN_STAT : value.toFixed(2);
}

/** Numeric PPTUH behind formatPptuh, for shared canonical derivations like points-per-X. */
export function pptuhValue(points: number, standing: TossupsHeardKnown): number | null {
  return playerPptuh({ points, ...standing });
}

/**
 * Tri-state eligibility cells (#749): an explicit Yes/No never masquerades unknown
 * metadata as a claim, and unknown never renders as a negative.
 */
export function formatEligibility(value: boolean | null | undefined): string {
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  return UNKNOWN_STAT;
}

const TIER_KEY_BY_COLUMN_ID: Record<string, ReportAnswerKey> = {
  superpowers: 'superpower',
  powers: 'power',
  gets: 'get',
  negs: 'neg',
};

export interface StatsSchemaPresentation {
  /** Display label for an answer-tier column, with configured point values. */
  tierLabel: (columnId: string, fallback: string) => string;
  /** Mixed historical point values note, if the issued definitions disagree. */
  mixedDefinitionNote?: string;
  /** Points-per-regulation-set label, or null when definitions disagree on the count. */
  pointsLabel: string | null;
  /** Regulation tossup count behind the label, or null when unusable. */
  pointsTossups: number | null;
}

/**
 * The shared report presentation for the Stats workspace, built from the same
 * scoring-definition history the printable pages consume — never a second
 * hard-coded tier vocabulary (#750). Labels stay semantic; configured point
 * values ride along so a custom-valued power still reads as Power.
 */
export function presentationForStats(state: DirectorState): StatsSchemaPresentation {
  const tournament = state.tournament;
  const presentation = tournament
    ? buildReportPresentation({
        metadata: {
          tournamentName: tournament.name,
          scopeLabel: 'Overall',
          generatedAt: new Date().toISOString(),
        },
        definitions: stateDefinitions(state),
        options: defaultReportOptions,
        capabilities: {
          bouncebacksRecorded: state.games.some((game) =>
            game.scores.some((score) => typeof score.bouncebacks === 'number'),
          ),
          packetRecorded: state.games.some((game) => game.packetId !== null),
          stageRecorded: state.phases.length > 1,
          lightningRecorded: state.games.some((game) =>
            game.scores.some((score) => typeof score.lightningPoints === 'number'),
          ),
        },
      })
    : null;
  const columns = presentation?.answerColumns ?? [];
  return {
    tierLabel: (columnId, fallback) => {
      const key = TIER_KEY_BY_COLUMN_ID[columnId];
      const column = key ? columns.find((entry) => entry.key === key) : undefined;
      if (!column || column.pointValues.length === 0) return fallback;
      return `${fallback} (${column.pointValues.join('/')})`;
    },
    ...(presentation?.mixedDefinitionNote ? { mixedDefinitionNote: presentation.mixedDefinitionNote } : {}),
    pointsLabel: presentation?.pointsNormalization?.label ?? null,
    pointsTossups: presentation?.pointsNormalization?.tossups ?? null,
  };
}

/** Signed point differential: a bare number cannot tell a lead from a deficit. */
export function formatMargin(standing: Pick<TeamStanding, 'margin'>): string {
  return `${standing.margin > 0 ? '+' : ''}${standing.margin}`;
}

/**
 * Teams sharing one canonical competition rank take the YellowFruit `=` marker.
 * The grouping itself comes from `canonicalCompetitionRanks`, never local math.
 */
export function tiedTeamIds(ranks: Map<string, number>): Set<string> {
  const counts = new Map<number, number>();
  for (const rank of ranks.values()) counts.set(rank, (counts.get(rank) ?? 0) + 1);
  return new Set([...ranks].filter(([, rank]) => (counts.get(rank) ?? 0) > 1).map(([teamId]) => teamId));
}

/**
 * Player rank ties: adjacent rows with equal PPTUH share the rank number, matching
 * the canonical PPTUH ordering (#751). Unknown PPTUH ties only with unknown.
 */
export function playerRankTies(standings: readonly PlayerStanding[]): Set<string> {
  const tied = new Set<string>();
  const keyOf = (standing: PlayerStanding): string => {
    const pptuh = playerPptuh(standing);
    return pptuh === null ? 'unknown' : String(pptuh);
  };
  for (let index = 1; index < standings.length; index++) {
    const previous = standings[index - 1]!;
    const current = standings[index]!;
    if (keyOf(previous) === keyOf(current)) {
      tied.add(previous.playerId);
      tied.add(current.playerId);
    }
  }
  return tied;
}

export interface StatsColumn {
  id: string;
  label: string;
  /** Short accessible description, read for abbreviated headers and the column chooser. */
  description: string;
  /** DataTable priority: 1 identity, 2 the point of the page, 3 context. */
  priority: 1 | 2 | 3;
  defaultVisible: boolean;
}

export const TEAM_COLUMNS: StatsColumn[] = [
  { id: 'record', label: 'Record', description: 'Wins, losses, and ties', priority: 1, defaultVisible: true },
  { id: 'winpct', label: 'Win %', description: 'Win percentage', priority: 2, defaultVisible: true },
  { id: 'games', label: 'GP', description: 'Games played', priority: 2, defaultVisible: true },
  { id: 'wins', label: 'W', description: 'Wins', priority: 3, defaultVisible: false },
  { id: 'losses', label: 'L', description: 'Losses', priority: 3, defaultVisible: false },
  { id: 'ties', label: 'T', description: 'Ties', priority: 3, defaultVisible: false },
  { id: 'margin', label: 'Margin', description: 'Point differential', priority: 2, defaultVisible: true },
  { id: 'class', label: 'Group', description: 'Team classifications', priority: 3, defaultVisible: false },
  { id: 'pf', label: 'PF', description: 'Points for', priority: 3, defaultVisible: false },
  { id: 'pa', label: 'PA', description: 'Points against', priority: 3, defaultVisible: false },
  { id: 'ppg', label: 'PPG', description: 'Points per game', priority: 2, defaultVisible: true },
  { id: 'papg', label: 'PAPG', description: 'Points against per game', priority: 3, defaultVisible: false },
  { id: 'ppx', label: 'Pts/X', description: 'Points per regulation set', priority: 3, defaultVisible: false },
  {
    id: 'superpowers',
    label: 'Superpowers',
    description: 'Superpower tossups answered',
    priority: 3,
    defaultVisible: false,
  },
  {
    id: 'powers',
    label: 'Powers',
    description: 'Power tossups answered',
    priority: 3,
    defaultVisible: false,
  },
  { id: 'gets', label: 'Gets', description: 'Regular tossups answered', priority: 3, defaultVisible: false },
  { id: 'negs', label: 'Negs', description: 'Incorrect interrupts', priority: 3, defaultVisible: false },
  { id: 'tuh', label: 'TUH', description: 'Tossups heard', priority: 2, defaultVisible: true },
  { id: 'pptuh', label: 'PPTUH', description: 'Points per tossup heard', priority: 3, defaultVisible: false },
  { id: 'bonuses', label: 'Bonuses', description: 'Bonuses heard', priority: 3, defaultVisible: false },
  { id: 'bonuspoints', label: 'Bonus pts', description: 'Bonus points', priority: 3, defaultVisible: false },
  { id: 'ppb', label: 'PPB', description: 'Points per bonus', priority: 2, defaultVisible: true },
  {
    id: 'bbpoints',
    label: 'BB pts',
    description: 'Bounceback points converted',
    priority: 3,
    defaultVisible: false,
  },
  {
    id: 'bbheard',
    label: 'BB heard',
    description: 'Bounceback parts heard',
    priority: 3,
    defaultVisible: false,
  },
  {
    id: 'bbconv',
    label: 'BB %',
    description: 'Bounceback conversion percentage',
    priority: 3,
    defaultVisible: false,
  },
  {
    id: 'totalbonus',
    label: 'Total bonus',
    description: 'Total bonus conversion: own plus bounceback',
    priority: 3,
    defaultVisible: false,
  },
  {
    id: 'lightning',
    label: 'Lightning',
    description: 'Lightning points',
    priority: 3,
    defaultVisible: false,
  },
  {
    id: 'lightningpg',
    label: 'Lightning/G',
    description: 'Lightning points per lightning-applicable non-forfeit game',
    priority: 3,
    defaultVisible: false,
  },
];

export const INDIVIDUAL_COLUMNS: StatsColumn[] = [
  { id: 'games', label: 'GP', description: 'Games played', priority: 2, defaultVisible: true },
  { id: 'points', label: 'Pts', description: 'Total points', priority: 2, defaultVisible: true },
  { id: 'ppg', label: 'PPG', description: 'Points per game', priority: 2, defaultVisible: true },
  { id: 'tuh', label: 'TUH', description: 'Tossups heard', priority: 2, defaultVisible: true },
  { id: 'pptuh', label: 'PPTUH', description: 'Points per tossup heard', priority: 3, defaultVisible: true },
  { id: 'year', label: 'Grade', description: 'School year or grade', priority: 3, defaultVisible: false },
  { id: 'ug', label: 'UG', description: 'Undergraduate eligible', priority: 3, defaultVisible: false },
  { id: 'd2', label: 'D2', description: 'Division II eligible', priority: 3, defaultVisible: false },
  {
    id: 'superpowers',
    label: 'Superpowers',
    description: 'Superpower tossups answered',
    priority: 3,
    defaultVisible: false,
  },
  {
    id: 'powers',
    label: 'Powers',
    description: 'Power tossups answered',
    priority: 3,
    defaultVisible: false,
  },
  { id: 'gets', label: 'Gets', description: 'Regular tossups answered', priority: 3, defaultVisible: false },
  { id: 'negs', label: 'Negs', description: 'Incorrect interrupts', priority: 3, defaultVisible: false },
  { id: 'bonus', label: 'Bonus pts', description: 'Bonus points', priority: 3, defaultVisible: false },
];

/**
 * Bonus columns are applicability-gated, not zero-filled: a tossup-only format has no bonus
 * facts, so offering Bonuses/PPB there would print a column of meaningless zeroes (#750).
 * History outlives defaults (#671): issued bonus definitions keep the columns even after the
 * default moves on, and observed bonus data keeps them even without a definition.
 */
export function bonusesInUse(state: DirectorState): boolean {
  if (state.tournament?.rules.useBonuses) return true;
  if (state.gameDefinitions.some((entry) => entry.rules.useBonuses)) return true;
  return state.games.some((game) => game.scores.some((score) => score.bonuses > 0 || score.bonusPoints > 0));
}

const TEAM_BONUS_COLUMN_IDS = new Set(['bonuses', 'bonuspoints', 'ppb']);
const TEAM_BOUNCEBACK_COLUMN_IDS = new Set(['bbpoints', 'bbheard', 'bbconv', 'totalbonus']);
const TEAM_LIGHTNING_COLUMN_IDS = new Set(['lightning', 'lightningpg']);
const INDIVIDUAL_BONUS_COLUMN_IDS = new Set(['bonus']);
const TIER_COLUMN_IDS = new Set(['superpowers', 'powers', 'gets', 'negs']);

/**
 * Bounceback columns are applicability-gated like bonus columns: they need the
 * bounceback game (configured, issued, or observed), never a zero-filled guess (#750).
 */
export function bouncebacksInUse(state: DirectorState): boolean {
  if (state.tournament?.rules.bouncebacks) return true;
  if (state.gameDefinitions.some((entry) => entry.rules.bouncebacks)) return true;
  return state.games.some((game) =>
    game.scores.some((score) => typeof score.bouncebacks === 'number' && score.bouncebacks !== 0),
  );
}

/** Lightning columns need the lightning game the same way (#747, #750). */
export function lightningInUse(state: DirectorState): boolean {
  if (state.tournament?.rules.lightning) return true;
  if (state.gameDefinitions.some((entry) => entry.rules.lightning)) return true;
  return state.games.some((game) =>
    game.scores.some((score) => typeof score.lightningPoints === 'number' && score.lightningPoints !== 0),
  );
}

/** Player metadata columns appear only when some roster actually carries the field (#749). */
export function playerYearInUse(state: DirectorState): boolean {
  return state.players.some((player) => typeof player.schoolYear === 'number');
}

export function playerUndergraduateInUse(state: DirectorState): boolean {
  return state.players.some((player) => typeof player.undergraduateEligible === 'boolean');
}

export function playerDivisionTwoInUse(state: DirectorState): boolean {
  return state.players.some((player) => typeof player.divisionTwoEligible === 'boolean');
}

function withTierLabels(columns: StatsColumn[], presentation: StatsSchemaPresentation): StatsColumn[] {
  return columns.map((column) => {
    if (TIER_COLUMN_IDS.has(column.id)) {
      return { ...column, label: presentation.tierLabel(column.id, column.label) };
    }
    if (column.id === 'ppx' && presentation.pointsLabel) {
      return { ...column, label: presentation.pointsLabel };
    }
    return column;
  });
}

/** Columns that exist for this tournament: inapplicable families drop out, never zero-fill. */
export function teamColumnsForState(state: DirectorState): StatsColumn[] {
  const bonus = bonusesInUse(state);
  const bouncebacks = bouncebacksInUse(state);
  const lightning = lightningInUse(state);
  const tiers = superpowersInUse(state);
  const classifications = usedClassifications(state).length > 0;
  const presentation = presentationForStats(state);
  return withTierLabels(
    TEAM_COLUMNS.filter(
      (column) =>
        (bonus || !TEAM_BONUS_COLUMN_IDS.has(column.id)) &&
        (bouncebacks || !TEAM_BOUNCEBACK_COLUMN_IDS.has(column.id)) &&
        (lightning || !TEAM_LIGHTNING_COLUMN_IDS.has(column.id)) &&
        (tiers || column.id !== 'superpowers') &&
        (classifications || column.id !== 'class') &&
        (presentation.pointsTossups !== null || column.id !== 'ppx'),
    ),
    presentation,
  );
}

/** Columns that exist for this tournament's individuals. */
export function individualColumnsForState(state: DirectorState): StatsColumn[] {
  const bonus = bonusesInUse(state);
  const tiers = superpowersInUse(state);
  return withTierLabels(
    INDIVIDUAL_COLUMNS.filter(
      (column) =>
        (bonus || !INDIVIDUAL_BONUS_COLUMN_IDS.has(column.id)) &&
        (tiers || column.id !== 'superpowers') &&
        (playerYearInUse(state) || column.id !== 'year') &&
        (playerUndergraduateInUse(state) || column.id !== 'ug') &&
        (playerDivisionTwoInUse(state) || column.id !== 'd2'),
    ),
    presentationForStats(state),
  );
}

/**
 * Fresh defaults: the schema's visible set, with the superpower tier promoted when the format
 * enables it — even when nobody has recorded one yet, an enabled-but-zero tier is a fact (#750).
 */
export function defaultTeamColumnIds(state: DirectorState): string[] {
  const applicable = teamColumnsForState(state);
  const ids = applicable.filter((column) => column.defaultVisible).map((column) => column.id);
  if (superpowersInUse(state) && !ids.includes('superpowers')) ids.push('superpowers');
  return ids;
}

/** Fresh defaults for the individual table. */
export function defaultIndividualColumnIds(state: DirectorState): string[] {
  const applicable = individualColumnsForState(state);
  const ids = applicable.filter((column) => column.defaultVisible).map((column) => column.id);
  if (superpowersInUse(state) && !ids.includes('superpowers')) ids.push('superpowers');
  return ids;
}

/**
 * One shared mapping from schema column to cell text for the team table, so Director, printable
 * reports, and QBLive cannot drift into three vocabularies (#750). Printable parity notes: PPG
 * and PAPG are 0.0 for a team with no games, matching the canonical snapshot rows; unknowns
 * stay "—".
 */
export interface TeamStatContext {
  classifications?: TeamClassification[];
  /** Regulation tossup count behind the Pts/X column; null hides behind "—" via pointsPerX. */
  pointsTossups?: number | null;
}

export function teamStatCell(
  columnId: string,
  standing: TeamStanding,
  context: TeamStatContext = {},
): string {
  switch (columnId) {
    case 'record':
      return formatRecord(standing);
    case 'winpct':
      return formatWinPct(standing);
    case 'games':
      return String(standing.gamesPlayed);
    case 'wins':
      return String(standing.wins);
    case 'losses':
      return String(standing.losses);
    case 'ties':
      return String(standing.ties);
    case 'margin':
      return formatMargin(standing);
    case 'class': {
      const labels = (context.classifications ?? []).map((entry) => classificationLabels[entry]);
      return labels.length > 0 ? labels.join('; ') : UNKNOWN_STAT;
    }
    case 'pf':
      return String(standing.pointsFor);
    case 'pa':
      return String(standing.pointsAgainst);
    case 'ppg':
      return formatAverage(standing.pointsFor, standing.gamesPlayed);
    case 'papg':
      return formatAverage(standing.pointsAgainst, standing.gamesPlayed);
    case 'ppx':
      return reportNumber(
        pointsPerX(pptuhValue(standing.pointsFor, standing), context.pointsTossups ?? null),
        2,
      );
    case 'superpowers':
      return String(standing.superpowers);
    case 'powers':
      return String(standing.powers);
    case 'gets':
      return String(standing.gets);
    case 'negs':
      return String(standing.negs);
    case 'tuh':
      return formatTuh(standing);
    case 'pptuh':
      return formatPptuh(standing.pointsFor, standing);
    case 'bonuses':
      return String(standing.bonuses);
    case 'bonuspoints':
      return String(standing.bonusPoints);
    case 'ppb':
      return formatPpb(standing);
    case 'bbpoints':
      return standing.bouncebacksKnown ? String(standing.bouncebackPoints) : UNKNOWN_STAT;
    case 'bbheard':
      return reportNumber(standing.bouncebackPartsHeard, 0);
    case 'bbconv':
      return reportPercent(standing.bouncebackConversion, 1);
    case 'totalbonus':
      return reportPercent(standing.totalBonusConversion, 1);
    case 'lightning':
      return standing.lightningKnown ? String(standing.lightningPoints) : UNKNOWN_STAT;
    case 'lightningpg':
      return standing.lightningKnown && standing.lightningGames > 0
        ? reportNumber(standing.lightningPoints / standing.lightningGames, 1)
        : UNKNOWN_STAT;
    default:
      return UNKNOWN_STAT;
  }
}

/** One shared mapping from schema column to cell text for the individual table (#750). */
export function playerStatCell(columnId: string, standing: PlayerStanding, player?: Player): string {
  switch (columnId) {
    case 'games':
      return String(formatGamesPlayed(standing));
    case 'points':
      return String(standing.points);
    case 'ppg':
      return formatPlayerPpg(standing);
    case 'tuh':
      return formatTuh(standing);
    case 'pptuh':
      return formatPptuh(standing.points, standing);
    case 'year':
      return typeof player?.schoolYear === 'number' ? `Grade ${player.schoolYear}` : UNKNOWN_STAT;
    case 'ug':
      return formatEligibility(player?.undergraduateEligible);
    case 'd2':
      return formatEligibility(player?.divisionTwoEligible);
    case 'superpowers':
      return String(standing.superpowers);
    case 'powers':
      return String(standing.powers);
    case 'gets':
      return String(standing.gets);
    case 'negs':
      return String(standing.negs);
    case 'bonus':
      return String(standing.bonusPoints);
    default:
      return UNKNOWN_STAT;
  }
}

export interface StatsColumnPrefs {
  teams: string[];
  individuals: string[];
}

const prefsKey = 'qbsheet.director.statsColumns.v1';

function sanitize(ids: unknown, columns: StatsColumn[]): string[] {
  if (!Array.isArray(ids))
    return columns.filter((column) => column.defaultVisible).map((column) => column.id);
  const known = new Set(columns.map((column) => column.id));
  const seen = new Set<string>();
  const selected = ids.filter((id): id is string => {
    if (typeof id !== 'string' || !known.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return selected.length > 0
    ? selected
    : columns.filter((column) => column.defaultVisible).map((column) => column.id);
}

export function hasStoredStatsColumnPrefs(tournamentId: string | undefined): boolean {
  if (!tournamentId || typeof localStorage === 'undefined') return false;
  try {
    const raw = localStorage.getItem(prefsKey);
    if (!raw) return false;
    return (JSON.parse(raw) as Record<string, unknown>)[tournamentId] !== undefined;
  } catch {
    return false;
  }
}

export function loadStatsColumnPrefs(tournamentId: string | undefined): StatsColumnPrefs {
  const fallback: StatsColumnPrefs = {
    teams: TEAM_COLUMNS.filter((column) => column.defaultVisible).map((column) => column.id),
    individuals: INDIVIDUAL_COLUMNS.filter((column) => column.defaultVisible).map((column) => column.id),
  };
  if (!tournamentId || typeof localStorage === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(prefsKey);
    if (!raw) return fallback;
    const stored = (JSON.parse(raw) as Record<string, Partial<StatsColumnPrefs>>)[tournamentId];
    if (!stored) return fallback;
    return {
      teams: sanitize(stored.teams, TEAM_COLUMNS),
      individuals: sanitize(stored.individuals, INDIVIDUAL_COLUMNS),
    };
  } catch {
    return fallback;
  }
}

export function saveStatsColumnPrefs(tournamentId: string | undefined, prefs: StatsColumnPrefs): void {
  if (!tournamentId || typeof localStorage === 'undefined') return;
  try {
    const raw = localStorage.getItem(prefsKey);
    let all: Record<string, StatsColumnPrefs> = {};
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          all = parsed as Record<string, StatsColumnPrefs>;
        }
      } catch {
        // A corrupt convenience preference should be replaced by the next valid choice.
      }
    }
    all[tournamentId] = prefs;
    localStorage.setItem(prefsKey, JSON.stringify(all));
  } catch {
    // Column preferences are a convenience; a full disk never blocks stats.
  }
}

/** Superpower columns appear by default only when the tournament uses them. */
export function superpowersInUse(state: DirectorState): boolean {
  if (typeof state.tournament?.rules.superpowerValue === 'number') return true;
  // History outlives defaults (#671): a tournament that issued superpower definitions keeps the
  // column even after the default moves on, and even when nobody has recorded one yet.
  if (state.gameDefinitions.some((entry) => typeof entry.rules.superpowerValue === 'number')) return true;
  return state.games.some((game) => game.scores.some((score) => score.superpowers > 0));
}
