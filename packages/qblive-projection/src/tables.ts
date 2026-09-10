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
  applyFinalPlacement,
  deriveTeamStandings,
  derivePlayerStandings,
  type DirectorState,
  type PlayerStanding,
  type TeamStanding,
  type TournamentRules,
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
 * An unknown is a null value with an em-dash display, never a zero: clients render what they
 * are given, so a fabricated zero here would publish a false statistic to every installed app.
 */
function unknown(): QbliveCell {
  return { value: null, display: '—' };
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
  { id: 'games', label: 'G', kind: 'integer', alignment: 'trailing', description: 'Games played' },
  { id: 'tuh', label: 'TUH', kind: 'integer', alignment: 'trailing', description: 'Tossups heard' },
  { id: 'bonuses', label: 'Bonuses', kind: 'integer', alignment: 'trailing', description: 'Bonuses heard' },
  {
    id: 'bonuspoints',
    label: 'Bonus pts',
    kind: 'integer',
    alignment: 'trailing',
    description: 'Bonus points',
  },
  {
    id: 'pptuh',
    label: 'PPTUH',
    kind: 'decimal',
    precision: 2,
    alignment: 'trailing',
    description: 'Points per tossup heard',
  },
];

/**
 * Tossup answer tiers published as table columns, YellowFruit parity (#753).
 *
 * Column identity is semantic (`superpowers`, not `20`): the label carries the configured point
 * value while the id stays stable across formats. Tiers the format does not define (a null power
 * or neg value) publish no column rather than a meaningless zero column; gets are always
 * present because every format values an ordinary tossup get.
 */
export interface AnswerTierColumn {
  id: 'superpowers' | 'powers' | 'gets' | 'negs';
  label: string;
  description: string;
}

function answerTierLabel(value: number): string {
  return value < 0 ? `−${Math.abs(value)}` : String(value);
}

export function answerTierColumns(
  rules:
    Pick<TournamentRules, 'superpowerValue' | 'powerValue' | 'tossupValue' | 'negValue'> | null | undefined,
): AnswerTierColumn[] {
  const tiers: AnswerTierColumn[] = [];
  if (rules?.superpowerValue != null) {
    tiers.push({
      id: 'superpowers',
      label: answerTierLabel(rules.superpowerValue),
      description: 'Superpowers',
    });
  }
  if (rules?.powerValue != null) {
    tiers.push({ id: 'powers', label: answerTierLabel(rules.powerValue), description: 'Powers' });
  }
  tiers.push({
    id: 'gets',
    label: answerTierLabel(rules?.tossupValue ?? 10),
    description: 'Regular tossups',
  });
  if (rules?.negValue != null) {
    tiers.push({ id: 'negs', label: answerTierLabel(rules.negValue), description: 'Negs' });
  }
  return tiers;
}

function answerTierColumnDefs(tiers: readonly AnswerTierColumn[]): QbliveColumn[] {
  return tiers.map((tier): QbliveColumn => ({
    id: tier.id,
    label: tier.label,
    kind: 'integer',
    alignment: 'trailing',
    description: tier.description,
  }));
}

function teamStatisticsColumns(rules: Parameters<typeof answerTierColumns>[0]): QbliveColumn[] {
  return [
    { id: 'team', label: 'Team', kind: 'team', alignment: 'leading' },
    { id: 'games', label: 'G', kind: 'integer', alignment: 'trailing', description: 'Games played' },
    ...answerTierColumnDefs(answerTierColumns(rules)),
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
}

function playerStatisticsColumns(rules: Parameters<typeof answerTierColumns>[0]): QbliveColumn[] {
  return [
    { id: 'player', label: 'Player', kind: 'player', alignment: 'leading' },
    { id: 'team', label: 'Team', kind: 'team', alignment: 'leading' },
    { id: 'games', label: 'G', kind: 'integer', alignment: 'trailing' },
    ...answerTierColumnDefs(answerTierColumns(rules)),
    { id: 'points', label: 'Pts', kind: 'integer', alignment: 'trailing' },
    { id: 'ppg', label: 'PPG', kind: 'decimal', precision: 1, alignment: 'trailing' },
  ];
}

export interface TableNaming {
  teamName(teamId: string): string;
  playerName(playerId: string): string | null;
}

/**
 * An explicit final placement reorders the overall table only. Scoped
 * (stage/pool) tables keep their calculated order: the override answers "who
 * finished where", not "who led the prelims".
 */
function finalTeamStandings(
  state: DirectorState,
  scope: TableScope,
  standings: TeamStanding[],
): TeamStanding[] {
  if (scope.phaseId !== undefined || scope.poolId !== undefined || scope.teamIds !== undefined) {
    return standings;
  }
  return applyFinalPlacement(standings, state.tournament?.finalPlacement);
}

export function buildStandingsTable(
  state: DirectorState,
  scope: TableScope,
  naming: TableNaming,
): QbliveDataTable {
  const standings = finalTeamStandings(
    state,
    scope,
    deriveTeamStandings(state, undefined, {
      phaseId: scope.phaseId,
      poolId: scope.poolId,
      teamIds: scope.teamIds,
    }),
  );
  const rows: QbliveRow[] = standings.map((standing, index) => ({
    id: standing.teamId,
    teamId: standing.teamId,
    cells: [
      integer(index + 1),
      { value: naming.teamName(standing.teamId), entityId: standing.teamId },
      record(standing),
      // A team that has not played has no win rate: 0.000 would read as three decimals of losing.
      standing.gamesPlayed > 0 ? decimal(standing.winPercentage, 3) : unknown(),
      integer(standing.pointsFor),
      integer(standing.pointsAgainst),
      decimal(standing.gamesPlayed > 0 ? standing.pointsFor / standing.gamesPlayed : 0, 1),
      integer(standing.margin),
      integer(standing.gamesPlayed),
      standing.tossupsHeardKnown ? integer(standing.tossupsHeard) : unknown(),
      integer(standing.bonuses),
      integer(standing.bonusPoints),
      standing.tossupsHeardKnown && standing.tossupsHeard > 0
        ? decimal(standing.pointsFor / standing.tossupsHeard, 2)
        : unknown(),
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
  const standings = finalTeamStandings(
    state,
    scope,
    deriveTeamStandings(state, undefined, {
      phaseId: scope.phaseId,
      poolId: scope.poolId,
      teamIds: scope.teamIds,
    }),
  );
  const tiers = answerTierColumns(state.tournament?.rules);
  const rows: QbliveRow[] = standings.map((standing) => ({
    id: standing.teamId,
    teamId: standing.teamId,
    cells: [
      { value: naming.teamName(standing.teamId), entityId: standing.teamId },
      integer(standing.gamesPlayed),
      ...tiers.map((tier) => integer(standing[tier.id])),
      // PPB with no bonuses heard is undefined, not zero: a manual result
      // without detail and a team that never heard a bonus both render "—".
      standing.bonuses > 0
        ? decimal(standing.bonusPoints / standing.bonuses, 2)
        : { value: null, display: '—' },
      decimal(standing.gamesPlayed > 0 ? standing.pointsFor / standing.gamesPlayed : 0, 1),
    ],
  }));
  return {
    id: `team-statistics:${scope.id}`,
    title: 'Team statistics',
    scope: scope.id,
    scopeLabel: scope.label,
    columns: teamStatisticsColumns(state.tournament?.rules),
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
  const tiers = answerTierColumns(state.tournament?.rules);
  for (const standing of standings) {
    const name = naming.playerName(standing.playerId);
    if (name === null) continue;
    // Valued per game under each game's own definition inside derivePlayerStandings (#671).
    // Revaluing the aggregate buckets with live defaults here would rewrite history — and a
    // house format's arithmetic is already the arithmetic those games were valued with.
    const points = standing.points;
    rows.push({
      id: standing.playerId,
      playerId: standing.playerId,
      teamId: standing.teamId,
      cells: [
        { value: name, entityId: standing.playerId },
        { value: naming.teamName(standing.teamId), entityId: standing.teamId },
        // Fractional GP needs both player and game TUH: without a game denominator the
        // participation is unknown, not zero, and PPG with it (#746).
        standing.gamesPlayedKnown ? integer(standing.gamesPlayed) : { value: null, display: '—' },
        ...tiers.map((tier) => integer(standing[tier.id])),
        integer(points),
        standing.gamesPlayedKnown ? decimal(standing.ppg, 1) : { value: null, display: '—' },
      ],
    });
  }
  return {
    id: `player-statistics:${scope.id}`,
    title: 'Individual statistics',
    scope: scope.id,
    scopeLabel: scope.label,
    columns: playerStatisticsColumns(state.tournament?.rules),
    rows,
  };
}
