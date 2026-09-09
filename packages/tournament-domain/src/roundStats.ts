export interface RoundStatsGameFacts {
  gameId: string;
  roundId: string;
  roundName: string;
  phaseId?: string;
  phaseName?: string;
  packetId?: string | null;
  packetName?: string | null;
  teamIds: readonly string[];
  teamPoints: readonly number[];
  /** False for an administrative result, such as a scoreless forfeit, with no played questions. */
  played: boolean;
  /** True only when the complete detailed score line is trustworthy for this game. */
  detailComplete: boolean;
  /** Exact total tossups read, including overtime when the source reports it. */
  tossupsRead: number | null;
  /** Historical regulation length from this game's own scoring definition. */
  regulationTossupCount: number | null;
  superpowers: number | null;
  powers: number | null;
  gets: number | null;
  negs: number | null;
  bonusesHeard: number | null;
  bonusPoints: number | null;
  /** Historical maximum bonus score from this game's own scoring definition. */
  maximumBonusScore: number | null;
  superpowerApplicable: boolean | null;
  powerApplicable: boolean | null;
  negApplicable: boolean | null;
  bonusApplicable: boolean | null;
}

export interface RoundStatsCoverage {
  playedGames: number;
  detailGames: number;
  tossupsReadGames: number;
  regulationGames: number;
  bonusGames: number;
}

export interface CanonicalRoundStatsRow {
  roundId: string;
  roundName: string;
  phaseId?: string;
  phaseName?: string;
  packetName: string | null;
  /** Accepted competitive results in the row, including forfeits. */
  games: number;
  /** Distinct teams represented by those results. */
  teams: number;
  /** Results with evidence that questions were actually played. */
  playedGames: number;
  /** Common historical regulation length (X), or null when unknown/mixed. */
  regulationTossupCount: number | null;
  /** Exact tossups read across played games, only when every played game reports it. */
  tossupsRead: number | null;
  /** Team points normalized to the common historical regulation length X. */
  pointsPerTeamPerXTuh: number | null;
  /** Superpowers divided by positive tossup conversions. */
  superpowerRate: number | null;
  /** Powers (including superpowers) divided by positive tossup conversions. */
  powerRate: number | null;
  /** Positive tossup conversions divided by tossups read. */
  tossupConversionRate: number | null;
  /** Negs per common historical regulation length X. */
  negRatePerXTuh: number | null;
  /** Bonus points divided by bonuses heard. */
  ppb: number | null;
  /** Bonus points divided by the historical maximum points available on heard bonuses. */
  bonusConversionRate: number | null;
  superpowerApplicable: boolean | null;
  powerApplicable: boolean | null;
  negApplicable: boolean | null;
  bonusApplicable: boolean | null;
  coverage: RoundStatsCoverage;
  /** Human-readable reasons that one or more otherwise useful metrics are unavailable. */
  notes: string[];
}

export interface CanonicalRoundStatsReport {
  rows: CanonicalRoundStatsRow[];
  /** Recomputed from all games in scope. Never an average of row percentages. */
  total: CanonicalRoundStatsRow | null;
}

function finiteNonNegative(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function finitePositive(value: number | null): value is number {
  return finiteNonNegative(value) && value > 0;
}

function sumKnown(values: readonly (number | null)[]): number | null {
  if (values.some((value) => !finiteNonNegative(value))) return null;
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function applicability(
  games: readonly RoundStatsGameFacts[],
  field: 'superpowerApplicable' | 'powerApplicable' | 'negApplicable' | 'bonusApplicable',
  count?: 'superpowers' | 'powers' | 'negs' | 'bonusesHeard' | 'bonusPoints',
): boolean | null {
  const values = games.map((game) => {
    if (game[field] !== null) return game[field];
    if (count && finitePositive(game[count])) return true;
    return null;
  });
  if (values.some((value) => value === true)) return true;
  if (values.length > 0 && values.every((value) => value === false)) return false;
  return null;
}

function applicabilityComparable(
  games: readonly RoundStatsGameFacts[],
  field: 'superpowerApplicable' | 'powerApplicable' | 'negApplicable',
  count: 'superpowers' | 'powers' | 'negs',
): boolean {
  if (games.length === 0) return false;
  const values = games.map((game) => {
    if (game[field] !== null) return game[field];
    if (finitePositive(game[count])) return true;
    return null;
  });
  return values.every((value) => value === true);
}

function commonPositive(values: readonly (number | null)[]): number | null {
  if (values.length === 0 || values.some((value) => !finitePositive(value))) return null;
  const first = values[0] as number;
  return values.every((value) => value === first) ? first : null;
}

function packetLabel(games: readonly RoundStatsGameFacts[]): string | null {
  const labels = games.map((game) => game.packetName?.trim() || game.packetId?.trim() || null);
  const known = [...new Set(labels.filter((value): value is string => value !== null))];
  if (known.length === 0) return null;
  if (known.length === 1 && labels.every((value) => value === known[0])) return known[0];
  return 'Mixed';
}

function uniquePhase(games: readonly RoundStatsGameFacts[]): { phaseId?: string; phaseName?: string } {
  const ids = [...new Set(games.map((game) => game.phaseId).filter((value): value is string => Boolean(value)))];
  if (ids.length !== 1) return {};
  const names = [
    ...new Set(
      games
        .filter((game) => game.phaseId === ids[0])
        .map((game) => game.phaseName)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  return { phaseId: ids[0], ...(names.length === 1 ? { phaseName: names[0] } : {}) };
}

function aggregateRow(
  facts: readonly RoundStatsGameFacts[],
  identity: Pick<CanonicalRoundStatsRow, 'roundId' | 'roundName'>,
): CanonicalRoundStatsRow {
  const played = facts.filter((game) => game.played);
  const detail = played.filter((game) => game.detailComplete);
  const exactTossups = played.filter((game) => finitePositive(game.tossupsRead));
  const exactRegulation = played.filter((game) => finitePositive(game.regulationTossupCount));
  const regulation = commonPositive(played.map((game) => game.regulationTossupCount));
  const tossupsRead =
    played.length > 0 && exactTossups.length === played.length
      ? played.reduce((sum, game) => sum + (game.tossupsRead ?? 0), 0)
      : null;
  const allDetailKnown = played.length > 0 && detail.length === played.length;

  const positiveConversions = allDetailKnown
    ? sumKnown(
        played.map((game) => {
          if (
            !finiteNonNegative(game.superpowers) ||
            !finiteNonNegative(game.powers) ||
            !finiteNonNegative(game.gets)
          ) {
            return null;
          }
          return game.superpowers + game.powers + game.gets;
        }),
      )
    : null;
  const superpowers = allDetailKnown ? sumKnown(played.map((game) => game.superpowers)) : null;
  const powers = allDetailKnown ? sumKnown(played.map((game) => game.powers)) : null;
  const negs = allDetailKnown ? sumKnown(played.map((game) => game.negs)) : null;

  const teamQuestionDenominator =
    regulation !== null && tossupsRead !== null
      ? played.reduce((sum, game) => sum + (game.tossupsRead ?? 0) * game.teamIds.length, 0)
      : 0;
  const points = played.reduce(
    (sum, game) => sum + game.teamPoints.filter((value) => Number.isFinite(value)).reduce((inner, value) => inner + value, 0),
    0,
  );
  const pointsPerTeamPerXTuh =
    regulation !== null && teamQuestionDenominator > 0 ? (points / teamQuestionDenominator) * regulation : null;
  const tossupConversionRate =
    tossupsRead !== null && tossupsRead > 0 && positiveConversions !== null
      ? positiveConversions / tossupsRead
      : null;

  const superpowerRelevant = applicability(played, 'superpowerApplicable', 'superpowers');
  const powerRelevant = applicability(played, 'powerApplicable', 'powers');
  const negRelevant = applicability(played, 'negApplicable', 'negs');
  const bonusRelevant = applicability(played, 'bonusApplicable', 'bonusesHeard');
  const superpowerComparable = applicabilityComparable(played, 'superpowerApplicable', 'superpowers');
  const powerComparable = applicabilityComparable(played, 'powerApplicable', 'powers');
  const negComparable = applicabilityComparable(played, 'negApplicable', 'negs');

  const superpowerRate =
    superpowerComparable && positiveConversions !== null && positiveConversions > 0 && superpowers !== null
      ? superpowers / positiveConversions
      : null;
  const earlyConversions =
    superpowers !== null && powers !== null ? superpowers + powers : null;
  const powerRate =
    powerComparable && positiveConversions !== null && positiveConversions > 0 && earlyConversions !== null
      ? earlyConversions / positiveConversions
      : null;
  const negRatePerXTuh =
    negComparable && regulation !== null && tossupsRead !== null && tossupsRead > 0 && negs !== null
      ? (negs / tossupsRead) * regulation
      : null;

  const bonusGames: RoundStatsGameFacts[] = [];
  let bonusCoverageComplete = played.length > 0;
  for (const game of played) {
    const inferredApplicable =
      game.bonusApplicable ??
      (finitePositive(game.bonusesHeard) || finitePositive(game.bonusPoints) ? true : null);
    if (inferredApplicable === false) continue;
    if (inferredApplicable !== true || !game.detailComplete) {
      bonusCoverageComplete = false;
      continue;
    }
    if (!finiteNonNegative(game.bonusesHeard) || !finiteNonNegative(game.bonusPoints)) {
      bonusCoverageComplete = false;
      continue;
    }
    bonusGames.push(game);
  }
  const totalBonuses = bonusCoverageComplete
    ? bonusGames.reduce((sum, game) => sum + (game.bonusesHeard ?? 0), 0)
    : null;
  const totalBonusPoints = bonusCoverageComplete
    ? bonusGames.reduce((sum, game) => sum + (game.bonusPoints ?? 0), 0)
    : null;
  const ppb =
    bonusRelevant === true && totalBonuses !== null && totalBonuses > 0 && totalBonusPoints !== null
      ? totalBonusPoints / totalBonuses
      : null;
  const bonusMaximumDenominator =
    bonusCoverageComplete && bonusGames.every((game) => finitePositive(game.maximumBonusScore))
      ? bonusGames.reduce(
          (sum, game) => sum + (game.bonusesHeard ?? 0) * (game.maximumBonusScore ?? 0),
          0,
        )
      : null;
  const bonusConversionRate =
    bonusRelevant === true &&
    totalBonusPoints !== null &&
    bonusMaximumDenominator !== null &&
    bonusMaximumDenominator > 0
      ? totalBonusPoints / bonusMaximumDenominator
      : null;

  const notes: string[] = [];
  const excludedAdministrative = facts.length - played.length;
  if (excludedAdministrative > 0) {
    notes.push(
      `${excludedAdministrative} administrative result${excludedAdministrative === 1 ? '' : 's'} excluded from scoring denominators.`,
    );
  }
  if (played.length > 0 && detail.length !== played.length) {
    notes.push(`${detail.length}/${played.length} played games have complete detail.`);
  }
  if (played.length > 0 && exactTossups.length !== played.length) {
    notes.push(`${exactTossups.length}/${played.length} played games report exact tossups read.`);
  }
  if (played.length > 0 && exactRegulation.length !== played.length) {
    notes.push(`${exactRegulation.length}/${played.length} played games have a historical regulation length.`);
  } else if (played.length > 0 && regulation === null) {
    notes.push('Mixed regulation lengths; regulation-normalized metrics are unavailable.');
  }
  if (superpowerRelevant === true && !superpowerComparable) {
    notes.push('Superpower availability is mixed or unknown across the included games.');
  }
  if (powerRelevant === true && !powerComparable) {
    notes.push('Power availability is mixed or unknown across the included games.');
  }
  if (negRelevant === true && !negComparable) {
    notes.push('Neg availability is mixed or unknown across the included games.');
  }
  if (bonusRelevant === true && !bonusCoverageComplete) {
    notes.push(`${bonusGames.length}/${played.length} played games have complete bonus denominators.`);
  }
  if (
    bonusRelevant === true &&
    bonusCoverageComplete &&
    bonusGames.length > 0 &&
    bonusGames.some((game) => !finitePositive(game.maximumBonusScore))
  ) {
    notes.push('Bonus maximum is unknown for at least one included game; bonus conversion is unavailable.');
  }

  const teams = new Set(facts.flatMap((game) => [...game.teamIds])).size;
  return {
    ...identity,
    ...uniquePhase(facts),
    packetName: packetLabel(facts),
    games: facts.length,
    teams,
    playedGames: played.length,
    regulationTossupCount: regulation,
    tossupsRead,
    pointsPerTeamPerXTuh,
    superpowerRate,
    powerRate,
    tossupConversionRate,
    negRatePerXTuh,
    ppb,
    bonusConversionRate,
    superpowerApplicable: superpowerRelevant,
    powerApplicable: powerRelevant,
    negApplicable: negRelevant,
    bonusApplicable: bonusRelevant,
    coverage: {
      playedGames: played.length,
      detailGames: detail.length,
      tossupsReadGames: exactTossups.length,
      regulationGames: exactRegulation.length,
      bonusGames: bonusGames.length,
    },
    notes,
  };
}

/**
 * Derive round-level statistics from already-canonical per-game facts.
 *
 * The derivation is deliberately strict about knownness. A ratio is emitted only when every
 * applicable played game supplies the denominator needed to describe the whole row. Tournament
 * totals are produced by running the same derivation over all scoped games, never by averaging
 * percentages from individual rounds.
 */
export function deriveRoundStats(facts: readonly RoundStatsGameFacts[]): CanonicalRoundStatsReport {
  const groups = new Map<string, RoundStatsGameFacts[]>();
  for (const fact of facts) {
    const games = groups.get(fact.roundId) ?? [];
    games.push(fact);
    groups.set(fact.roundId, games);
  }
  const rows = [...groups.entries()].map(([roundId, games]) =>
    aggregateRow(games, { roundId, roundName: games[0]?.roundName ?? roundId }),
  );
  return {
    rows,
    total: facts.length > 0 ? aggregateRow(facts, { roundId: 'overall', roundName: 'Overall' }) : null,
  };
}
