/**
 * Shared presentation helpers for the Stats workspace.
 *
 * Pure functions only: scope options, column definitions with persisted
 * preferences, honest unknown-value rendering, and classification labels. The
 * canonical engine stays the single place that computes anything.
 */

import {
  isTeamClassification,
  type DirectorState,
  type PlayerStanding,
  type TeamClassification,
  type TeamStanding,
} from '../domain';

export const UNKNOWN_STAT = '—';

export interface StatsScope {
  id: string;
  label: string;
  phaseId?: string;
  poolId?: string;
}

export function buildStatsScopes(state: DirectorState): { scopes: StatsScope[]; showSelector: boolean } {
  const phases = state.phases.filter((phase) => !phase.archived);
  const activePhaseIds = new Set(phases.map((phase) => phase.id));
  const pools = state.pools.filter((pool) => !pool.archived && activePhaseIds.has(pool.phaseId));
  const scopes: StatsScope[] = [{ id: 'overall', label: 'Overall' }];
  if (phases.length > 1) {
    for (const phase of phases)
      scopes.push({ id: `phase:${phase.id}`, label: phase.name, phaseId: phase.id });
    for (const pool of pools) {
      const phase = phases.find((entry) => entry.id === pool.phaseId);
      scopes.push({
        id: `pool:${pool.id}`,
        label: `${phase?.name ?? 'Stage'} · ${pool.name}`,
        phaseId: pool.phaseId,
        poolId: pool.id,
      });
    }
  } else if (pools.length > 1) {
    for (const pool of pools) scopes.push({ id: `pool:${pool.id}`, label: pool.name, poolId: pool.id });
  }
  return { scopes, showSelector: scopes.length > 1 };
}

export function scopeOptionsFor(scope: StatsScope): { phaseId?: string; poolId?: string } {
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

/** Points per tossup heard needs a known, nonzero denominator; otherwise "—". */
export function formatPptuh(points: number, standing: TossupsHeardKnown): string {
  if (standing.tossupsHeardKnown === false || standing.tossupsHeard === 0) return UNKNOWN_STAT;
  return (points / standing.tossupsHeard).toFixed(2);
}

/** Signed point differential: a bare number cannot tell a lead from a deficit. */
export function formatMargin(standing: Pick<TeamStanding, 'margin'>): string {
  return `${standing.margin > 0 ? '+' : ''}${standing.margin}`;
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
  { id: 'margin', label: 'Margin', description: 'Point differential', priority: 2, defaultVisible: true },
  { id: 'pf', label: 'PF', description: 'Points for', priority: 3, defaultVisible: false },
  { id: 'pa', label: 'PA', description: 'Points against', priority: 3, defaultVisible: false },
  { id: 'ppg', label: 'PPG', description: 'Points per game', priority: 2, defaultVisible: true },
  { id: 'papg', label: 'PAPG', description: 'Points against per game', priority: 3, defaultVisible: false },
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
];

export const INDIVIDUAL_COLUMNS: StatsColumn[] = [
  { id: 'games', label: 'GP', description: 'Games played', priority: 2, defaultVisible: true },
  { id: 'points', label: 'Pts', description: 'Total points', priority: 2, defaultVisible: true },
  { id: 'ppg', label: 'PPG', description: 'Points per game', priority: 2, defaultVisible: true },
  { id: 'tuh', label: 'TUH', description: 'Tossups heard', priority: 2, defaultVisible: true },
  { id: 'pptuh', label: 'PPTUH', description: 'Points per tossup heard', priority: 3, defaultVisible: true },
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
const INDIVIDUAL_BONUS_COLUMN_IDS = new Set(['bonus']);

/** Columns that exist for this tournament: bonus tiers drop out when bonuses are not in use. */
export function teamColumnsForState(state: DirectorState): StatsColumn[] {
  const bonus = bonusesInUse(state);
  const tiers = superpowersInUse(state);
  return TEAM_COLUMNS.filter(
    (column) => (bonus || !TEAM_BONUS_COLUMN_IDS.has(column.id)) && (tiers || column.id !== 'superpowers'),
  );
}

/** Columns that exist for this tournament's individuals. */
export function individualColumnsForState(state: DirectorState): StatsColumn[] {
  const bonus = bonusesInUse(state);
  const tiers = superpowersInUse(state);
  return INDIVIDUAL_COLUMNS.filter(
    (column) =>
      (bonus || !INDIVIDUAL_BONUS_COLUMN_IDS.has(column.id)) && (tiers || column.id !== 'superpowers'),
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
export function teamStatCell(columnId: string, standing: TeamStanding): string {
  switch (columnId) {
    case 'record':
      return formatRecord(standing);
    case 'winpct':
      return formatWinPct(standing);
    case 'games':
      return String(standing.gamesPlayed);
    case 'margin':
      return formatMargin(standing);
    case 'pf':
      return String(standing.pointsFor);
    case 'pa':
      return String(standing.pointsAgainst);
    case 'ppg':
      return formatAverage(standing.pointsFor, standing.gamesPlayed);
    case 'papg':
      return formatAverage(standing.pointsAgainst, standing.gamesPlayed);
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
    default:
      return UNKNOWN_STAT;
  }
}

/** One shared mapping from schema column to cell text for the individual table (#750). */
export function playerStatCell(columnId: string, standing: PlayerStanding): string {
  switch (columnId) {
    case 'games':
      return String(standing.gamesPlayed);
    case 'points':
      return String(standing.points);
    case 'ppg':
      return standing.ppg.toFixed(1);
    case 'tuh':
      return formatTuh(standing);
    case 'pptuh':
      return formatPptuh(standing.points, standing);
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
