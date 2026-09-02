/**
 * Director-defined dynamic tables.
 *
 * # Why the columns come from Director
 *
 * Official placement is Director's answer. If QBSheet Live decided which columns a standings table
 * has, it would be quietly asserting a ranking system, and every tournament whose rules differ
 * would see a table that disagrees with the printout at the front desk. So Director ships the
 * columns, the values, *and* the rendered strings, and the clients render what they are given —
 * including columns they have never heard of.
 *
 * The practical payoff is that a new statistic reaches an installed iPhone without an App Store
 * release.
 */

import {
  deriveTeamStandings,
  derivePlayerStandings,
  type DirectorState,
  type PlayerStanding,
  type TeamStanding,
} from '@qbsheet/tournament-domain';
import type { QbliveCell, QbliveColumn, QbliveDataTable, QbliveRow } from '@qbsheet/qblive-protocol';

export interface TableScope {
  id: string;
  label: string;
  phaseId?: string;
  poolId?: string | null;
  teamIds?: string[];
}

function decimal(value: number, precision: number): QbliveCell {
  return { value, display: value.toFixed(precision) };
}

function integer(value: number): QbliveCell {
  return { value, display: String(value) };
}

/**
 * A win-loss(-tie) record as one cell.
 *
 * Rendered here rather than on the client because the tie half is conditional: a format without
 * ties should read `7-1`, not `7-1-0`, and a client cannot know which without knowing the format.
 */
function record(standing: TeamStanding): QbliveCell {
  const display =
    standing.ties > 0
      ? `${standing.wins}-${standing.losses}-${standing.ties}`
      : `${standing.wins}-${standing.losses}`;
  return { value: display, display };
}

const teamStandingsColumns: QbliveColumn[] = [
  { id: 'rank', label: '#', kind: 'rank', alignment: 'trailing' },
  { id: 'team', label: 'Team', kind: 'team', alignment: 'leading' },
  { id: 'record', label: 'W–L', kind: 'record', alignment: 'trailing' },
  { id: 'pct', label: 'Pct', kind: 'decimal', precision: 3, alignment: 'trailing' },
  { id: 'pf', label: 'PF', kind: 'integer', alignment: 'trailing', description: 'Points for' },
  { id: 'pa', label: 'PA', kind: 'integer', alignment: 'trailing', description: 'Points against' },
  {
    id: 'ppg',
    label: 'PPG',
    kind: 'decimal',
    precision: 1,
    alignment: 'trailing',
    description: 'Points per game',
  },
  { id: 'margin', label: 'Marg', kind: 'integer', alignment: 'trailing', description: 'Point differential' },
];

const teamStatisticsColumns: QbliveColumn[] = [
  { id: 'team', label: 'Team', kind: 'team', alignment: 'leading' },
  { id: 'games', label: 'G', kind: 'integer', alignment: 'trailing', description: 'Games played' },
  { id: 'powers', label: '15', kind: 'integer', alignment: 'trailing', description: 'Powers' },
  { id: 'gets', label: '10', kind: 'integer', alignment: 'trailing', description: 'Regular tossups' },
  { id: 'negs', label: '−5', kind: 'integer', alignment: 'trailing', description: 'Negs' },
  {
    id: 'ppb',
    label: 'PPB',
    kind: 'decimal',
    precision: 2,
    alignment: 'trailing',
    description: 'Points per bonus',
  },
  { id: 'ppg', label: 'PPG', kind: 'decimal', precision: 1, alignment: 'trailing' },
];

const playerStatisticsColumns: QbliveColumn[] = [
  { id: 'player', label: 'Player', kind: 'player', alignment: 'leading' },
  { id: 'team', label: 'Team', kind: 'team', alignment: 'leading' },
  { id: 'games', label: 'G', kind: 'integer', alignment: 'trailing' },
  { id: 'powers', label: '15', kind: 'integer', alignment: 'trailing' },
  { id: 'gets', label: '10', kind: 'integer', alignment: 'trailing' },
  { id: 'negs', label: '−5', kind: 'integer', alignment: 'trailing' },
  { id: 'points', label: 'Pts', kind: 'integer', alignment: 'trailing' },
  { id: 'ppg', label: 'PPG', kind: 'decimal', precision: 1, alignment: 'trailing' },
];

export interface TableNaming {
  teamName(teamId: string): string;
  playerName(playerId: string): string | null;
}

export function buildStandingsTable(
  state: DirectorState,
  scope: TableScope,
  naming: TableNaming,
): QbliveDataTable {
  const standings = deriveTeamStandings(state, undefined, {
    phaseId: scope.phaseId,
    poolId: scope.poolId,
    teamIds: scope.teamIds,
  });
  const rows: QbliveRow[] = standings.map((standing, index) => ({
    id: standing.teamId,
    teamId: standing.teamId,
    cells: [
      integer(index + 1),
      { value: naming.teamName(standing.teamId), entityId: standing.teamId },
      record(standing),
      decimal(standing.winPercentage, 3),
      integer(standing.pointsFor),
      integer(standing.pointsAgainst),
      decimal(standing.gamesPlayed > 0 ? standing.pointsFor / standing.gamesPlayed : 0, 1),
      integer(standing.margin),
    ],
  }));
  return {
    id: `standings:${scope.id}`,
    title: 'Standings',
    scope: scope.id,
    scopeLabel: scope.label,
    columns: teamStandingsColumns,
    rows,
  };
}

export function buildTeamStatisticsTable(
  state: DirectorState,
  scope: TableScope,
  naming: TableNaming,
): QbliveDataTable {
  const standings = deriveTeamStandings(state, undefined, {
    phaseId: scope.phaseId,
    poolId: scope.poolId,
    teamIds: scope.teamIds,
  });
  const rows: QbliveRow[] = standings.map((standing) => ({
    id: standing.teamId,
    teamId: standing.teamId,
    cells: [
      { value: naming.teamName(standing.teamId), entityId: standing.teamId },
      integer(standing.gamesPlayed),
      integer(standing.powers),
      integer(standing.gets),
      integer(standing.negs),
      decimal(standing.bonuses > 0 ? standing.bonusPoints / standing.bonuses : 0, 2),
      decimal(standing.gamesPlayed > 0 ? standing.pointsFor / standing.gamesPlayed : 0, 1),
    ],
  }));
  return {
    id: `team-statistics:${scope.id}`,
    title: 'Team statistics',
    scope: scope.id,
    scopeLabel: scope.label,
    columns: teamStatisticsColumns,
    rows,
  };
}

/**
 * Individual statistics, built only when the Director has published player data.
 *
 * A player whose name is not published is omitted entirely rather than shown as "Player 3": a row
 * that identifies somebody by position on a roster is still identifying them to anyone who has the
 * roster, and the point of the switch is that nobody outside the tournament has one.
 */
export function buildPlayerStatisticsTable(
  state: DirectorState,
  scope: TableScope,
  naming: TableNaming,
): QbliveDataTable {
  const standings: PlayerStanding[] = derivePlayerStandings(state, {
    phaseId: scope.phaseId,
    poolId: scope.poolId,
    teamIds: scope.teamIds,
  });
  const rows: QbliveRow[] = [];
  for (const standing of standings) {
    const name = naming.playerName(standing.playerId);
    if (name === null) continue;
    // Scored with the tournament's own values rather than the common ones, so a house format that
    // does not use powers, or values a neg differently, publishes its own arithmetic.
    const rules = state.tournament?.rules;
    const points =
      standing.powers * (rules?.powerValue ?? 15) +
      standing.gets * (rules?.tossupValue ?? 10) +
      standing.negs * (rules?.negValue ?? -5) +
      standing.bonusPoints;
    rows.push({
      id: standing.playerId,
      playerId: standing.playerId,
      teamId: standing.teamId,
      cells: [
        { value: name, entityId: standing.playerId },
        { value: naming.teamName(standing.teamId), entityId: standing.teamId },
        integer(standing.gamesPlayed),
        integer(standing.powers),
        integer(standing.gets),
        integer(standing.negs),
        integer(points),
        decimal(standing.ppg, 1),
      ],
    });
  }
  return {
    id: `player-statistics:${scope.id}`,
    title: 'Individual statistics',
    scope: scope.id,
    scopeLabel: scope.label,
    columns: playerStatisticsColumns,
    rows,
  };
}
