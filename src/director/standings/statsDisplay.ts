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

export function formatTuh(standing: Pick<PlayerStanding, 'tossupsHeard' | 'tossupsHeardKnown'>): string {
  return standing.tossupsHeardKnown === false ? UNKNOWN_STAT : String(standing.tossupsHeard);
}

/** Points per tossup heard needs a known, nonzero denominator; otherwise "—". */
export function formatPptuh(
  points: number,
  standing: Pick<PlayerStanding, 'tossupsHeard' | 'tossupsHeardKnown'>,
): string {
  if (standing.tossupsHeardKnown === false || standing.tossupsHeard === 0) return UNKNOWN_STAT;
  return (points / standing.tossupsHeard).toFixed(2);
}

export interface StatsColumn {
  id: string;
  label: string;
  defaultVisible: boolean;
}

export const TEAM_COLUMNS: StatsColumn[] = [
  { id: 'record', label: 'Record', defaultVisible: true },
  { id: 'winpct', label: 'Win %', defaultVisible: true },
  { id: 'pf', label: 'PF', defaultVisible: true },
  { id: 'pa', label: 'PA', defaultVisible: true },
  { id: 'margin', label: 'Margin', defaultVisible: true },
  { id: 'ppg', label: 'PPG', defaultVisible: true },
  { id: 'papg', label: 'PAPG', defaultVisible: false },
  { id: 'ppb', label: 'PPB', defaultVisible: true },
  { id: 'superpowers', label: 'Superpowers', defaultVisible: false },
  { id: 'powers', label: 'Powers', defaultVisible: true },
  { id: 'gets', label: 'Gets', defaultVisible: true },
  { id: 'negs', label: 'Negs', defaultVisible: true },
];

export const INDIVIDUAL_COLUMNS: StatsColumn[] = [
  { id: 'tuh', label: 'TUH', defaultVisible: true },
  { id: 'superpowers', label: 'Superpowers', defaultVisible: false },
  { id: 'powers', label: 'Powers', defaultVisible: true },
  { id: 'gets', label: 'Gets', defaultVisible: true },
  { id: 'negs', label: 'Negs', defaultVisible: true },
  { id: 'points', label: 'Points', defaultVisible: true },
  { id: 'ppg', label: 'PPG', defaultVisible: true },
  { id: 'pptuh', label: 'PPTUH', defaultVisible: true },
  { id: 'bonus', label: 'Bonus pts', defaultVisible: false },
];

export interface StatsColumnPrefs {
  teams: string[];
  individuals: string[];
}

const prefsKey = 'qbsheet.director.statsColumns.v1';

function sanitize(ids: unknown, columns: StatsColumn[]): string[] {
  if (!Array.isArray(ids))
    return columns.filter((column) => column.defaultVisible).map((column) => column.id);
  const known = new Set(columns.map((column) => column.id));
  const selected = ids.filter((id): id is string => typeof id === 'string' && known.has(id));
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
    const all = raw ? (JSON.parse(raw) as Record<string, StatsColumnPrefs>) : {};
    all[tournamentId] = prefs;
    localStorage.setItem(prefsKey, JSON.stringify(all));
  } catch {
    // Column preferences are a convenience; a full disk never blocks stats.
  }
}

/** Superpower columns appear by default only when the tournament uses them. */
export function superpowersInUse(state: DirectorState): boolean {
  if (typeof state.tournament?.rules.superpowerValue === 'number') return true;
  return state.games.some((game) => game.scores.some((score) => score.superpowers > 0));
}
