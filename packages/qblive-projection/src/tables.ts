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
  acceptedGameRecords,
  applyFinalPlacement,
  bonusPointsPerBonus,
  canonicalCompetitionRanks,
  deriveTeamStandings,
  derivePlayerStandings,
  normalizedPointsPerX,
  playerPptuh,
  regulationDerivationForTeam,
  scopeScoringApplicability,
  type DirectorState,
  type PlayerStanding,
  type ScopeAnswerTier,
  type ScopeScoringApplicability,
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

/** A percentage cell from a fractional rate; null stays unknown, never 0%. */
function percent(value: number | null, precision: number): QbliveCell {
  return typeof value === 'number' && Number.isFinite(value)
    ? { value, display: `${(value * 100).toFixed(precision)}%` }
    : unknown();
}

/** Director's signed margin text: a positive differential carries its `+`. */
function signed(value: number): QbliveCell {
  return { value, display: `${value > 0 ? '+' : ''}${value}` };
}

/**
 * Points per tossup heard through the shared domain helper, so QBLive rates
 * cannot drift from Director and the printable reports; null is unknown,
 * never zero.
 */
function pptuhFor(
  points: number,
  tossupsHeard: number,
  tossupsHeardKnown: boolean | undefined,
): number | null {
  return playerPptuh({ points, tossupsHeard, tossupsHeardKnown });
}

/**
 * Points per bonus through the canonical domain helper, so QBLive cannot drift
 * from Director and the printable reports; null is unknown, never zero.
 */
function ppbFor(bonusPoints: number, bonuses: number): number | null {
  return bonusPointsPerBonus(bonusPoints, bonuses);
}

/**
 * Normalized points per regulation set through the canonical domain helpers —
 * the same regulation-points numerator and regulation-TUH denominator Director
 * and the printable reports use, never final-score PPTUH scaled by X (#755).
 * Null (unknown overtime split, unknown regulation TUH, or mixed-X scope)
 * renders "—", matching Director.
 */
function ppxFor(standing: TeamStanding, regulationTossups: number | null): number | null {
  const regulation = regulationDerivationForTeam(standing);
  return normalizedPointsPerX(
    regulation.regulationPoints,
    standing.tossupsHeardRegulationKnown ? standing.tossupsHeardRegulation : null,
    regulationTossups,
  );
}

/**
 * Applicability for one table scope from the historical scoring definitions of its
 * accepted games, never from the tournament's current rules alone (#868).
 */
function scopeApplicability(state: DirectorState, scope: TableScope): ScopeScoringApplicability {
  return scopeScoringApplicability(
    state,
    acceptedGameRecords(state, {
      phaseId: scope.phaseId,
      poolId: scope.poolId,
      teamIds: scope.teamIds,
    }),
  );
}

/**
 * Scope-derived answer tiers with the printable mixed-value label contract: one column
 * per semantic tier, a single value when definitions agree, `15/20` when they differ.
 */
function scopeTierColumns(tiers: readonly ScopeAnswerTier[]): AnswerTierColumn[] {
  const descriptions = {
    superpowers: 'Superpowers',
    powers: 'Powers',
    gets: 'Regular tossups',
    negs: 'Negs',
  } as const;
  return tiers.map((tier): AnswerTierColumn => ({
    id: tier.id,
    label: tier.values.map(answerTierLabel).join('/'),
    description: tier.values.length > 1 ? `${descriptions[tier.id]} (mixed values)` : descriptions[tier.id],
  }));
}

function decimalOrUnknown(value: number | null, precision: number): QbliveCell {
  return typeof value === 'number' && Number.isFinite(value) ? decimal(value, precision) : unknown();
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
  // En dashes, matching Director's shared record text exactly.
  const display =
    standing.ties > 0
      ? `${standing.wins}–${standing.losses}–${standing.ties}`
      : `${standing.wins}–${standing.losses}`;
  return { value: display, display };
}

/**
 * The public standings vocabulary, YellowFruit parity (#753).
 *
 * Rank through PPTUH is the long-standing public set, with the scope's own
 * historical answer tiers inline. Bonus facts, bouncebacks, and lightning append
 * only when the accepted games' historical definitions configure them: a
 * not-applicable statistic omits its column rather than publishing a table of
 * em dashes, while an applicable-but-unknown value renders `—` with a null
 * value in the row. Pts/X follows Director: one column when the scope agrees
 * on a single regulation X, omitted for mixed-X scopes.
 */
function standingsColumns(
  applicability: Pick<
    ScopeScoringApplicability,
    'bonuses' | 'bouncebacks' | 'lightning' | 'regulationTossups'
  >,
  tiers: readonly AnswerTierColumn[],
): QbliveColumn[] {
  const trailing = 'trailing' as const;
  const columns: QbliveColumn[] = [
    { id: 'rank', label: '#', kind: 'rank', alignment: trailing },
    { id: 'team', label: 'Team', kind: 'team', alignment: 'leading' },
    { id: 'record', label: 'W–L', kind: 'record', alignment: trailing },
    {
      id: 'pct',
      label: 'Pct',
      kind: 'percentage',
      precision: 1,
      alignment: trailing,
      description: 'Win percentage',
    },
    { id: 'pf', label: 'PF', kind: 'integer', alignment: trailing, description: 'Points for' },
    { id: 'pa', label: 'PA', kind: 'integer', alignment: trailing, description: 'Points against' },
    {
      id: 'ppg',
      label: 'PPG',
      kind: 'decimal',
      precision: 1,
      alignment: trailing,
      description: 'Points per game',
    },
    { id: 'margin', label: 'Marg', kind: 'integer', alignment: trailing, description: 'Point differential' },
    { id: 'games', label: 'G', kind: 'integer', alignment: trailing, description: 'Games played' },
    ...answerTierColumnDefs(tiers),
    { id: 'tuh', label: 'TUH', kind: 'integer', alignment: trailing, description: 'Tossups heard' },
    {
      id: 'pptuh',
      label: 'PPTUH',
      kind: 'decimal',
      precision: 2,
      alignment: trailing,
      description: 'Points per tossup heard',
    },
  ];
  if (applicability.regulationTossups !== null) {
    columns.push({
      id: 'ppx',
      label: 'Pts/X',
      kind: 'decimal',
      precision: 2,
      alignment: trailing,
      description: `Points per regulation set of ${applicability.regulationTossups}`,
    });
  }
  if (applicability.bonuses) {
    columns.push(
      { id: 'bonuses', label: 'Bonuses', kind: 'integer', alignment: trailing, description: 'Bonuses heard' },
      {
        id: 'bonuspoints',
        label: 'Bonus pts',
        kind: 'integer',
        alignment: trailing,
        description: 'Bonus points',
      },
      {
        id: 'ppb',
        label: 'PPB',
        kind: 'decimal',
        precision: 2,
        alignment: trailing,
        description: 'Points per bonus',
      },
    );
  }
  if (applicability.bouncebacks) {
    columns.push(
      { id: 'bb', label: 'BB', kind: 'integer', alignment: trailing, description: 'Bounceback points' },
      {
        id: 'bbheard',
        label: 'BB heard',
        kind: 'integer',
        alignment: trailing,
        description: 'Bounceback parts heard',
      },
      {
        id: 'bbconv',
        label: 'BB %',
        kind: 'percentage',
        precision: 1,
        alignment: trailing,
        description: 'Bounceback conversion',
      },
      {
        id: 'totalbonus',
        label: 'Total bonus',
        kind: 'percentage',
        precision: 1,
        alignment: trailing,
        description: 'Total bonus conversion',
      },
    );
  }
  if (applicability.lightning) {
    columns.push(
      {
        id: 'lightning',
        label: 'Lightning',
        kind: 'integer',
        alignment: trailing,
        description: 'Lightning points',
      },
      {
        id: 'lightningpg',
        label: 'Lightning/G',
        kind: 'decimal',
        precision: 1,
        alignment: trailing,
        description: 'Lightning points per lightning-applicable non-forfeit game',
      },
    );
  }
  return columns;
}

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

/**
 * The public team-statistics vocabulary (#753): the complete aggregate set —
 * games, tiers, TUH, PPTUH, bonus facts, bouncebacks, lightning — gated the
 * same way as the standings table.
 */
function teamStatisticsColumns(
  meta: { bonuses: boolean; bouncebacks: boolean; lightning: boolean; regulationTossups: number | null },
  tiers: readonly AnswerTierColumn[],
): QbliveColumn[] {
  const trailing = 'trailing' as const;
  const columns: QbliveColumn[] = [
    { id: 'team', label: 'Team', kind: 'team', alignment: 'leading' },
    { id: 'games', label: 'G', kind: 'integer', alignment: trailing, description: 'Games played' },
    ...answerTierColumnDefs(tiers),
    { id: 'tuh', label: 'TUH', kind: 'integer', alignment: trailing, description: 'Tossups heard' },
    {
      id: 'pptuh',
      label: 'PPTUH',
      kind: 'decimal',
      precision: 2,
      alignment: trailing,
      description: 'Points per tossup heard',
    },
  ];
  if (meta.regulationTossups !== null) {
    columns.push({
      id: 'ppx',
      label: 'Pts/X',
      kind: 'decimal',
      precision: 2,
      alignment: trailing,
      description: `Points per regulation set of ${meta.regulationTossups}`,
    });
  }
  if (meta.bonuses) {
    columns.push(
      { id: 'bonuses', label: 'Bonuses', kind: 'integer', alignment: trailing, description: 'Bonuses heard' },
      {
        id: 'bonuspoints',
        label: 'Bonus pts',
        kind: 'integer',
        alignment: trailing,
        description: 'Bonus points',
      },
      {
        id: 'ppb',
        label: 'PPB',
        kind: 'decimal',
        precision: 2,
        alignment: trailing,
        description: 'Points per bonus',
      },
    );
  }
  if (meta.bouncebacks) {
    columns.push(
      { id: 'bb', label: 'BB', kind: 'integer', alignment: trailing, description: 'Bounceback points' },
      {
        id: 'bbheard',
        label: 'BB heard',
        kind: 'integer',
        alignment: trailing,
        description: 'Bounceback parts heard',
      },
      {
        id: 'bbconv',
        label: 'BB %',
        kind: 'percentage',
        precision: 1,
        alignment: trailing,
        description: 'Bounceback conversion',
      },
      {
        id: 'totalbonus',
        label: 'Total bonus',
        kind: 'percentage',
        precision: 1,
        alignment: trailing,
        description: 'Total bonus conversion',
      },
    );
  }
  if (meta.lightning) {
    columns.push(
      {
        id: 'lightning',
        label: 'Lightning',
        kind: 'integer',
        alignment: trailing,
        description: 'Lightning points',
      },
      {
        id: 'lightningpg',
        label: 'Lightning/G',
        kind: 'decimal',
        precision: 1,
        alignment: trailing,
        description: 'Lightning points per lightning-applicable non-forfeit game',
      },
    );
  }
  columns.push({
    id: 'ppg',
    label: 'PPG',
    kind: 'decimal',
    precision: 1,
    alignment: trailing,
    description: 'Points per game',
  });
  return columns;
}

export interface PlayerMeta {
  schoolYear: number | null;
  undergraduateEligible: boolean | null;
  divisionTwoEligible: boolean | null;
}

/**
 * The public individual-statistics vocabulary (#753): rank, identity, year and
 * eligibility flags, fractional participation, TUH, tiers, points, rates.
 * Metadata columns appear only when some published player carries that
 * metadata; without a `playerMeta` source they stay out entirely.
 */
function playerStatisticsColumns(
  tiers: readonly AnswerTierColumn[],
  meta: { year: boolean; undergraduate: boolean; divisionTwo: boolean; bonuses: boolean },
): QbliveColumn[] {
  const trailing = 'trailing' as const;
  const columns: QbliveColumn[] = [
    { id: 'rank', label: '#', kind: 'rank', alignment: trailing },
    { id: 'player', label: 'Player', kind: 'player', alignment: 'leading' },
    { id: 'team', label: 'Team', kind: 'team', alignment: 'leading' },
  ];
  if (meta.year) {
    columns.push({
      id: 'year',
      label: 'Grade',
      kind: 'integer',
      alignment: trailing,
      description: 'School year or grade',
    });
  }
  if (meta.undergraduate) {
    columns.push({
      id: 'ug',
      label: 'UG',
      kind: 'text',
      alignment: trailing,
      description: 'Undergraduate eligible',
    });
  }
  if (meta.divisionTwo) {
    columns.push({
      id: 'd2',
      label: 'D2',
      kind: 'text',
      alignment: trailing,
      description: 'Division II eligible',
    });
  }
  columns.push(
    {
      id: 'games',
      label: 'G',
      kind: 'decimal',
      precision: 2,
      alignment: trailing,
      description: 'Games played',
    },
    { id: 'tuh', label: 'TUH', kind: 'integer', alignment: trailing, description: 'Tossups heard' },
    ...answerTierColumnDefs(tiers),
    { id: 'points', label: 'Pts', kind: 'integer', alignment: trailing, description: 'Total points' },
    {
      id: 'ppg',
      label: 'PPG',
      kind: 'decimal',
      precision: 1,
      alignment: trailing,
      description: 'Points per game',
    },
    {
      id: 'pptuh',
      label: 'PPTUH',
      kind: 'decimal',
      precision: 2,
      alignment: trailing,
      description: 'Points per tossup heard',
    },
  );
  if (meta.bonuses) {
    columns.push({
      id: 'bonus',
      label: 'Bonus pts',
      kind: 'integer',
      alignment: trailing,
      description: 'Bonus points',
    });
  }
  return columns;
}

export interface TableNaming {
  teamName(teamId: string): string;
  playerName(playerId: string): string | null;
  /**
   * Published player metadata, or null when the player is unpublished.
   *
   * The projection only calls this while building the individual-statistics
   * table, which itself only exists when player publication is on — metadata
   * can never leak through this callback when names are off.
   */
  playerMeta?(playerId: string): PlayerMeta | null;
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

/**
 * Rank numbers for the displayed order.
 *
 * Calculated tables use the canonical competition ranks, so ties share one
 * number exactly as Director and the printout show them. An explicit final
 * placement answers "who finished where" positionally instead.
 */
function standingsRankOf(
  state: DirectorState,
  scope: TableScope,
  calculated: TeamStanding[],
): { rank: (teamId: string) => number; tied: (teamId: string) => boolean } {
  const finalActive =
    scope.phaseId === undefined &&
    scope.poolId === undefined &&
    scope.teamIds === undefined &&
    (state.tournament?.finalPlacement?.order.length ?? 0) > 0;
  if (finalActive) {
    return { rank: () => 0, tied: () => false };
  }
  const ranks = canonicalCompetitionRanks(
    calculated,
    acceptedGameRecords(state, {
      phaseId: scope.phaseId,
      poolId: scope.poolId,
      teamIds: scope.teamIds,
    }),
    state.tournament?.rules.tiebreakers,
  );
  const counts = new Map<number, number>();
  for (const rank of ranks.values()) counts.set(rank, (counts.get(rank) ?? 0) + 1);
  return {
    rank: (teamId) => ranks.get(teamId) ?? 0,
    tied: (teamId) => (counts.get(ranks.get(teamId) ?? 0) ?? 0) > 1,
  };
}

function rankCell(rank: number, tied: boolean): QbliveCell {
  return { value: rank, display: tied ? `${rank}=` : `${rank}` };
}

export function buildStandingsTable(
  state: DirectorState,
  scope: TableScope,
  naming: TableNaming,
): QbliveDataTable {
  const applicability = scopeApplicability(state, scope);
  const tiers = scopeTierColumns(applicability.tiers);
  const columns = standingsColumns(applicability, tiers);
  const calculated = deriveTeamStandings(state, undefined, {
    phaseId: scope.phaseId,
    poolId: scope.poolId,
    teamIds: scope.teamIds,
  });
  const rankOf = standingsRankOf(state, scope, calculated);
  const standings = finalTeamStandings(state, scope, calculated);
  const rows: QbliveRow[] = standings.map((standing, index) => {
    const rank = rankOf.rank(standing.teamId) || index + 1;
    const cells: QbliveCell[] = [
      rankCell(rank, rankOf.tied(standing.teamId)),
      { value: naming.teamName(standing.teamId), entityId: standing.teamId },
      record(standing),
      // A team that has not played has no win rate: 0.0% would read as precision losing.
      standing.gamesPlayed > 0 ? percent(standing.winPercentage, 1) : unknown(),
      integer(standing.pointsFor),
      integer(standing.pointsAgainst),
      decimal(standing.gamesPlayed > 0 ? standing.pointsFor / standing.gamesPlayed : 0, 1),
      signed(standing.margin),
      integer(standing.gamesPlayed),
      ...tiers.map((tier) => integer(standing[tier.id])),
      standing.tossupsHeardKnown ? integer(standing.tossupsHeard) : unknown(),
      decimalOrUnknown(pptuhFor(standing.pointsFor, standing.tossupsHeard, standing.tossupsHeardKnown), 2),
    ];
    if (applicability.regulationTossups !== null) {
      cells.push(decimalOrUnknown(ppxFor(standing, applicability.regulationTossups), 2));
    }
    if (applicability.bonuses) {
      cells.push(
        integer(standing.bonuses),
        integer(standing.bonusPoints),
        decimalOrUnknown(ppbFor(standing.bonusPoints, standing.bonuses), 2),
      );
    }
    if (applicability.bouncebacks) {
      cells.push(
        // Unknown bounceback breakdowns render "—", never a fabricated zero (#748).
        standing.bouncebacksKnown ? integer(standing.bouncebackPoints) : unknown(),
        decimalOrUnknown(standing.bouncebackPartsHeard, 0),
        percent(standing.bouncebackConversion, 1),
        percent(standing.totalBonusConversion, 1),
      );
    }
    if (applicability.lightning) {
      cells.push(
        standing.lightningKnown ? integer(standing.lightningPoints) : unknown(),
        standing.lightningKnown && standing.lightningGames > 0
          ? decimal(standing.lightningPoints / standing.lightningGames, 1)
          : unknown(),
      );
    }
    return { id: standing.teamId, teamId: standing.teamId, cells };
  });
  return {
    id: `standings:${scope.id}`,
    title: 'Standings',
    scope: scope.id,
    scopeLabel: scope.label,
    columns,
    rows,
  };
}

export function buildTeamStatisticsTable(
  state: DirectorState,
  scope: TableScope,
  naming: TableNaming,
): QbliveDataTable {
  const applicability = scopeApplicability(state, scope);
  const tiers = scopeTierColumns(applicability.tiers);
  const showBonuses = applicability.bonuses;
  const showBouncebacks = applicability.bouncebacks;
  const showLightning = applicability.lightning;
  const columns = teamStatisticsColumns(
    {
      bonuses: showBonuses,
      bouncebacks: showBouncebacks,
      lightning: showLightning,
      regulationTossups: applicability.regulationTossups,
    },
    tiers,
  );
  const standings = finalTeamStandings(
    state,
    scope,
    deriveTeamStandings(state, undefined, {
      phaseId: scope.phaseId,
      poolId: scope.poolId,
      teamIds: scope.teamIds,
    }),
  );
  const rows: QbliveRow[] = standings.map((standing) => {
    const cells: QbliveCell[] = [
      { value: naming.teamName(standing.teamId), entityId: standing.teamId },
      integer(standing.gamesPlayed),
      ...tiers.map((tier) => integer(standing[tier.id])),
      standing.tossupsHeardKnown ? integer(standing.tossupsHeard) : unknown(),
      decimalOrUnknown(pptuhFor(standing.pointsFor, standing.tossupsHeard, standing.tossupsHeardKnown), 2),
    ];
    if (applicability.regulationTossups !== null) {
      cells.push(decimalOrUnknown(ppxFor(standing, applicability.regulationTossups), 2));
    }
    if (showBonuses) {
      cells.push(
        integer(standing.bonuses),
        integer(standing.bonusPoints),
        // PPB with no bonuses heard is undefined, not zero: a manual result
        // without detail and a team that never heard a bonus both render "—".
        decimalOrUnknown(ppbFor(standing.bonusPoints, standing.bonuses), 2),
      );
    }
    if (showBouncebacks) {
      cells.push(
        // Unknown bounceback breakdowns render "—", never a fabricated zero (#748).
        standing.bouncebacksKnown ? integer(standing.bouncebackPoints) : unknown(),
        decimalOrUnknown(standing.bouncebackPartsHeard, 0),
        percent(standing.bouncebackConversion, 1),
        percent(standing.totalBonusConversion, 1),
      );
    }
    if (showLightning) {
      cells.push(
        standing.lightningKnown ? integer(standing.lightningPoints) : unknown(),
        standing.lightningKnown && standing.lightningGames > 0
          ? decimal(standing.lightningPoints / standing.lightningGames, 1)
          : unknown(),
      );
    }
    cells.push(decimal(standing.gamesPlayed > 0 ? standing.pointsFor / standing.gamesPlayed : 0, 1));
    return { id: standing.teamId, teamId: standing.teamId, cells };
  });
  return {
    id: `team-statistics:${scope.id}`,
    title: 'Team statistics',
    scope: scope.id,
    scopeLabel: scope.label,
    columns,
    rows,
  };
}

/** Fractional games played renders trimmed (1, 0.5, never 1.00); unknown is "—". */
function gamesCell(gamesPlayed: number, gamesPlayedKnown: boolean): QbliveCell {
  if (gamesPlayedKnown === false) return unknown();
  return {
    value: gamesPlayed,
    display: Number.isInteger(gamesPlayed) ? String(gamesPlayed) : gamesPlayed.toFixed(2),
  };
}

function eligibilityCell(value: boolean | null): QbliveCell {
  if (value === true) return { value: 'yes', display: 'Yes' };
  if (value === false) return { value: 'no', display: 'No' };
  return unknown();
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
  const applicability = scopeApplicability(state, scope);
  const tiers = scopeTierColumns(applicability.tiers);
  const showBonuses = applicability.bonuses;
  // Metadata columns appear only when some published row carries that metadata.
  const published = standings.filter((standing) => naming.playerName(standing.playerId) !== null);
  const metaOf = (playerId: string): PlayerMeta | null => naming.playerMeta?.(playerId) ?? null;
  const showYear = published.some((standing) => typeof metaOf(standing.playerId)?.schoolYear === 'number');
  const showUndergraduate = published.some(
    (standing) => typeof metaOf(standing.playerId)?.undergraduateEligible === 'boolean',
  );
  const showDivisionTwo = published.some(
    (standing) => typeof metaOf(standing.playerId)?.divisionTwoEligible === 'boolean',
  );
  const columns = playerStatisticsColumns(tiers, {
    year: showYear,
    undergraduate: showUndergraduate,
    divisionTwo: showDivisionTwo,
    bonuses: showBonuses,
  });
  // Rank ties share one number with the YellowFruit `=` marker, keyed on the
  // canonical PPTUH exactly as Director ties them: unknown ties with unknown,
  // and both sides of an equal adjacent pair carry the marker.
  const publishedStandings = standings.filter((standing) => naming.playerName(standing.playerId) !== null);
  const tieKeys = publishedStandings.map((standing) => {
    const pptuh = pptuhFor(standing.points, standing.tossupsHeard, standing.tossupsHeardKnown);
    return pptuh === null ? 'unknown' : String(pptuh);
  });
  let publishedIndex = 0;
  let previousRank = 0;
  standings.forEach((standing) => {
    const name = naming.playerName(standing.playerId);
    if (name === null) return;
    const position = publishedIndex;
    publishedIndex += 1;
    const sharesPrevious = position > 0 && tieKeys[position] === tieKeys[position - 1];
    const sharesNext = tieKeys[position] === tieKeys[position + 1];
    const tied = sharesPrevious || sharesNext;
    const rank = sharesPrevious ? previousRank : position + 1;
    previousRank = rank;
    const pptuh = pptuhFor(standing.points, standing.tossupsHeard, standing.tossupsHeardKnown);
    // Valued per game under each game's own definition inside derivePlayerStandings (#671).
    // Revaluing the aggregate buckets with live defaults here would rewrite history — and a
    // house format's arithmetic is already the arithmetic those games were valued with.
    const points = standing.points;
    const meta = metaOf(standing.playerId);
    const cells: QbliveCell[] = [
      rankCell(rank, tied),
      { value: name, entityId: standing.playerId },
      { value: naming.teamName(standing.teamId), entityId: standing.teamId },
    ];
    if (showYear) {
      const year = meta?.schoolYear ?? null;
      cells.push(typeof year === 'number' ? { value: year, display: `Grade ${year}` } : unknown());
    }
    if (showUndergraduate) cells.push(eligibilityCell(meta?.undergraduateEligible ?? null));
    if (showDivisionTwo) cells.push(eligibilityCell(meta?.divisionTwoEligible ?? null));
    cells.push(
      // Fractional GP needs both player and game TUH: without a game denominator the
      // participation is unknown, not zero, and PPG with it (#746).
      gamesCell(standing.gamesPlayed, standing.gamesPlayedKnown),
      standing.tossupsHeardKnown === false ? unknown() : integer(standing.tossupsHeard),
      ...tiers.map((tier) => integer(standing[tier.id])),
      integer(points),
      standing.gamesPlayedKnown ? decimal(standing.ppg, 1) : unknown(),
      decimalOrUnknown(pptuh, 2),
    );
    if (showBonuses) cells.push(integer(standing.bonusPoints));
    rows.push({ id: standing.playerId, playerId: standing.playerId, teamId: standing.teamId, cells });
  });
  return {
    id: `player-statistics:${scope.id}`,
    title: 'Individual statistics',
    scope: scope.id,
    scopeLabel: scope.label,
    columns,
    rows,
  };
}
