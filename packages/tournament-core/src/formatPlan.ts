/**
 * Planning a whole tournament day in the terms a director actually uses.
 *
 * A director says "seventeen teams, three pools, five rounds this morning, three seeded divisions
 * this afternoon". Phases, pools, advancement rules, seeds and bracket slots are how that is
 * *stored*; they are not how it is decided. This module turns the sentence into a plan and, just as
 * importantly, tells the truth about what the plan produces before anything is generated — how many
 * games each team gets, which divisions end up short, and which teams receive byes they did not ask
 * for.
 *
 * Nothing here writes to a snapshot. It is a preview, and the wizard that uses it produces ordinary
 * phases and pools that stay editable afterwards.
 */

import {
  planSingleEliminationBracket,
  placeBracketRounds,
  type BracketPlan,
  type BracketRoundPolicy,
} from './brackets';

export interface FormatPlanIssue {
  readonly code: string;
  readonly severity: 'error' | 'warning' | 'recommendation';
  readonly message: string;
}

/**
 * Distribute `teamCount` teams over `poolCount` pools as evenly as possible, larger pools first.
 *
 * Larger-first is the convention printed schedules assume: Pool A is the one that might have the
 * extra team, so a five-team pool is always the last one and the odd bye rotation lands where a
 * director expects to find it.
 */
export function recommendPoolSizes(teamCount: number, poolCount: number): number[] {
  if (!Number.isInteger(teamCount) || !Number.isInteger(poolCount) || poolCount < 1 || teamCount < 0) {
    return [];
  }
  const base = Math.floor(teamCount / poolCount);
  const remainder = teamCount % poolCount;
  return Array.from({ length: poolCount }, (_, index) => base + (index < remainder ? 1 : 0));
}

/** Rounds a single pool of `size` teams needs for one complete round robin, byes included. */
export function roundsForPool(size: number): number {
  if (size < 2) return 0;
  return size % 2 === 0 ? size - 1 : size;
}

/** Games each team in a pool of `size` actually plays in one complete round robin. */
export function gamesPerTeamInPool(size: number): number {
  return Math.max(0, size - 1);
}

export interface PrelimStructure {
  readonly teamCount: number;
  readonly poolCount: number;
  readonly poolSizes: readonly number[];
  readonly prelimRounds: number;
}

/**
 * The morning structure this format recommends for a field of `teamCount`.
 *
 * Three pools and five rounds is the shape a 16–18 team one-day event settles into: every team
 * plays five morning rounds, six-team pools play five games and five-team pools play four with one
 * bye, and the afternoon has three divisions to fill. Outside that range the recommendation is the
 * pool count whose natural rotation comes closest to a full morning without exceeding it.
 */
export function recommendPrelimStructure(teamCount: number): PrelimStructure {
  if (teamCount >= 16 && teamCount <= 18) {
    const poolSizes = recommendPoolSizes(teamCount, 3);
    return { teamCount, poolCount: 3, poolSizes, prelimRounds: 5 };
  }
  if (teamCount < 2) {
    return { teamCount, poolCount: 1, poolSizes: [teamCount], prelimRounds: 0 };
  }
  // Prefer pools of five or six, which is what keeps a morning to five or so rounds.
  let best: PrelimStructure | null = null;
  for (let poolCount = 1; poolCount <= Math.max(1, Math.floor(teamCount / 4)); poolCount += 1) {
    const poolSizes = recommendPoolSizes(teamCount, poolCount);
    if (poolSizes.some((size) => size < 4)) continue;
    const prelimRounds = Math.max(...poolSizes.map(roundsForPool));
    const candidate: PrelimStructure = { teamCount, poolCount, poolSizes, prelimRounds };
    if (!best) {
      best = candidate;
      continue;
    }
    const score = (value: PrelimStructure) => Math.abs(value.prelimRounds - 5) * 10 + value.poolCount;
    if (score(candidate) < score(best)) best = candidate;
  }
  return best ?? { teamCount, poolCount: 1, poolSizes: [teamCount], prelimRounds: roundsForPool(teamCount) };
}

export interface PoolRotationReport {
  readonly poolSizes: readonly number[];
  readonly prelimRounds: number;
  readonly perPool: readonly {
    readonly size: number;
    readonly naturalRounds: number;
    readonly gamesPerTeam: number;
    readonly byesPerTeam: number;
    readonly idleRounds: number;
  }[];
  readonly issues: readonly FormatPlanIssue[];
  readonly valid: boolean;
}

/**
 * Check that the requested pool sizes actually fit the requested number of preliminary rounds.
 *
 * A pool needs `size - 1` rounds when its size is even and `size` when it is odd, and it cannot be
 * stretched: a four-team pool inside a five-round morning leaves two rounds with nothing to play.
 * That is reported rather than filled with a fabricated game or a second meeting nobody asked for.
 */
export function validatePoolRotation(poolSizes: readonly number[], prelimRounds: number): PoolRotationReport {
  const issues: FormatPlanIssue[] = [];
  const perPool = poolSizes.map((size) => {
    const naturalRounds = roundsForPool(size);
    return {
      size,
      naturalRounds,
      gamesPerTeam: gamesPerTeamInPool(size),
      byesPerTeam: size % 2 === 1 && size >= 2 ? 1 : 0,
      idleRounds: Math.max(0, prelimRounds - naturalRounds),
    };
  });

  if (poolSizes.length === 0) {
    issues.push({ code: 'no-pools', severity: 'error', message: 'Configure at least one preliminary pool.' });
  }
  for (const pool of perPool) {
    if (pool.size < 2) {
      issues.push({
        code: 'pool-too-small',
        severity: 'error',
        message: `A pool of ${pool.size} team${pool.size === 1 ? '' : 's'} cannot play a round robin.`,
      });
      continue;
    }
    if (pool.naturalRounds > prelimRounds) {
      issues.push({
        code: 'rotation-too-long',
        severity: 'error',
        message: `A ${pool.size}-team pool needs ${pool.naturalRounds} rounds for a full round robin, but only ${prelimRounds} preliminary round${prelimRounds === 1 ? ' is' : 's are'} configured.`,
      });
    } else if (pool.idleRounds > 0) {
      issues.push({
        code: 'rotation-leaves-idle-rounds',
        severity: 'warning',
        message: `A ${pool.size}-team pool finishes its round robin in ${pool.naturalRounds} rounds, so its teams are idle for ${pool.idleRounds} of the ${prelimRounds} preliminary rounds.`,
      });
    }
  }

  const sizes = [...new Set(poolSizes)];
  if (sizes.length > 1) {
    const spread = Math.max(...poolSizes) - Math.min(...poolSizes);
    if (spread > 1) {
      issues.push({
        code: 'unusual-pool-imbalance',
        severity: 'warning',
        message: `Pool sizes differ by ${spread} teams (${poolSizes.join(' / ')}). That is allowed, but it gives teams noticeably different preliminary schedules.`,
      });
    }
    const gameCounts = [...new Set(poolSizes.map(gamesPerTeamInPool))];
    if (gameCounts.length > 1) {
      issues.push({
        code: 'unequal-games-played',
        severity: 'recommendation',
        message: `Teams will play ${gameCounts.sort((left, right) => left - right).join(' or ')} preliminary games depending on their pool, so any comparison across pools needs a per-game ranking basis rather than raw wins.`,
      });
    }
  }

  return {
    poolSizes,
    prelimRounds,
    perPool,
    issues,
    valid: issues.every((entry) => entry.severity !== 'error'),
  };
}

export type DivisionSizingMethod = 'pool-placement' | 'global-seed';

export interface PoolPrelimPlayoffPlanInput {
  readonly teamCount: number;
  readonly poolCount?: number;
  readonly poolSizes?: readonly number[];
  readonly prelimRounds?: number;
  readonly divisionCount?: number;
  readonly divisionNames?: readonly string[];
  /** How many finishing places each division takes when using pool placement. Defaults to 2. */
  readonly qualifiersPerDivision?: number;
  readonly placementMethod?: DivisionSizingMethod;
  /** First tournament round number of the playoff phase. Defaults to `prelimRounds + 1`. */
  readonly playoffStartRound?: number;
  /** How many rounds the afternoon reserves. Defaults to the deepest division's bracket. */
  readonly playoffRoundCount?: number;
  readonly protectedByeSeeds?: number;
  readonly thirdPlaceGames?: boolean;
  readonly bracketRoundPolicy?: BracketRoundPolicy;
}

export interface PlannedDivision {
  readonly name: string;
  readonly order: number;
  readonly teamCount: number;
  readonly placements: readonly number[] | null;
  readonly seedRange: { readonly from: number; readonly to: number | null } | null;
  readonly remainder: boolean;
  readonly bracket: BracketPlan;
  readonly roundNumbers: readonly number[];
  readonly unusedRoundNumbers: readonly number[];
}

export interface PoolPrelimPlayoffPlan {
  readonly teamCount: number;
  readonly poolCount: number;
  readonly poolSizes: readonly number[];
  readonly poolNames: readonly string[];
  readonly prelimRounds: number;
  readonly prelimRoundNumbers: readonly number[];
  readonly playoffRoundNumbers: readonly number[];
  readonly totalRounds: number;
  readonly placementMethod: DivisionSizingMethod;
  readonly divisions: readonly PlannedDivision[];
  readonly rotation: PoolRotationReport;
  readonly issues: readonly FormatPlanIssue[];
  readonly notes: readonly string[];
  readonly valid: boolean;
  /** Preliminary games each team plays, one entry per distinct pool size. */
  readonly prelimGamesPerTeam: readonly number[];
  /** Fewest and most playoff games a team can play, byes and elimination included. */
  readonly playoffGamesPerTeam: { readonly minimum: number; readonly maximum: number };
}

export function poolName(index: number): string {
  // A…Z then AA…, matching how pools are read aloud at a tournament.
  let remaining = index;
  let name = '';
  do {
    name = String.fromCharCode(65 + (remaining % 26)) + name;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return `Pool ${name}`;
}

const defaultDivisionNames = ['Championship', 'Division II', 'Division III', 'Division IV', 'Division V'];

/**
 * Division sizes the configured placement rule will actually produce.
 *
 * This is the number a director most wants before committing: "top two from each of a 6/6/5 morning"
 * is a six-team Championship, a six-team Division II, and a *five*-team Division III, and the five
 * needs a third first-round bye that nobody chose.
 */
function divisionSizes(
  method: DivisionSizingMethod,
  teamCount: number,
  poolSizes: readonly number[],
  divisionCount: number,
  qualifiersPerDivision: number,
): number[] {
  if (divisionCount < 1) return [];
  if (method === 'global-seed') {
    const sizes: number[] = [];
    let remaining = teamCount;
    for (let index = 0; index < divisionCount; index += 1) {
      const last = index === divisionCount - 1;
      const take = last ? remaining : Math.min(remaining, qualifiersPerDivision * poolSizes.length);
      sizes.push(Math.max(0, take));
      remaining -= take;
    }
    return sizes;
  }
  const sizes: number[] = [];
  let claimed = 0;
  for (let index = 0; index < divisionCount; index += 1) {
    if (index === divisionCount - 1) {
      sizes.push(Math.max(0, teamCount - claimed));
      break;
    }
    const from = index * qualifiersPerDivision + 1;
    const to = from + qualifiersPerDivision - 1;
    // A pool only supplies a finishing place it actually has, which is why a 6/6/5 morning gives a
    // full Championship and Division II but a short Division III.
    let count = 0;
    for (let place = from; place <= to; place += 1) {
      count += poolSizes.filter((size) => size >= place).length;
    }
    sizes.push(count);
    claimed += count;
  }
  return sizes;
}

/** Plan a "pool prelims → seeded playoff divisions" tournament and report what it produces. */
export function planPoolPrelimsWithPlayoffDivisions(
  input: PoolPrelimPlayoffPlanInput,
): PoolPrelimPlayoffPlan {
  const issues: FormatPlanIssue[] = [];
  const notes: string[] = [];
  const teamCount = Math.max(0, Math.trunc(input.teamCount));
  const recommended = recommendPrelimStructure(teamCount);
  const poolCount = Math.max(1, input.poolCount ?? input.poolSizes?.length ?? recommended.poolCount);
  const poolSizes = [...(input.poolSizes ?? recommendPoolSizes(teamCount, poolCount))];
  const prelimRounds = Math.max(0, input.prelimRounds ?? recommended.prelimRounds);
  const placementMethod: DivisionSizingMethod = input.placementMethod ?? 'pool-placement';
  const qualifiersPerDivision = Math.max(1, input.qualifiersPerDivision ?? 2);
  const divisionCount = Math.max(1, input.divisionCount ?? Math.min(3, Math.max(1, poolCount)));
  const protectedByeSeeds = input.protectedByeSeeds ?? 2;

  const assigned = poolSizes.reduce((total, size) => total + size, 0);
  if (assigned !== teamCount) {
    issues.push({
      code: 'pool-size-mismatch',
      severity: 'error',
      message: `The pool sizes account for ${assigned} teams but the field has ${teamCount}.`,
    });
  }

  const rotation = validatePoolRotation(poolSizes, prelimRounds);
  issues.push(...rotation.issues);

  const prelimRoundNumbers = Array.from({ length: prelimRounds }, (_, index) => index + 1);
  const sizes = divisionSizes(placementMethod, teamCount, poolSizes, divisionCount, qualifiersPerDivision);

  const brackets = sizes.map((size) =>
    planSingleEliminationBracket(size, {
      protectedByeSeeds,
      thirdPlaceGame: input.thirdPlaceGames ?? false,
    }),
  );
  const deepest = brackets.reduce((maximum, bracket) => Math.max(maximum, bracket.roundCount), 0);
  const playoffRoundCount = Math.max(0, input.playoffRoundCount ?? deepest);
  const playoffStartRound = input.playoffStartRound ?? prelimRounds + 1;
  const playoffRoundNumbers = Array.from(
    { length: playoffRoundCount },
    (_, index) => playoffStartRound + index,
  );

  if (playoffRoundCount < deepest) {
    issues.push({
      code: 'insufficient-playoff-rounds',
      severity: 'error',
      message: `The largest playoff division needs ${deepest} rounds but only ${playoffRoundCount} are reserved.`,
    });
  }

  const divisions: PlannedDivision[] = sizes.map((size, index) => {
    const last = index === divisionCount - 1;
    const bracket = brackets[index];
    const placement = placeBracketRounds(
      bracket.roundCount,
      playoffRoundNumbers,
      input.bracketRoundPolicy ?? 'championship-last',
    );
    const from = index * qualifiersPerDivision * poolCount + 1;
    return {
      name: input.divisionNames?.[index] ?? defaultDivisionNames[index] ?? `Division ${index + 1}`,
      order: index + 1,
      teamCount: size,
      placements:
        placementMethod === 'pool-placement' && !last
          ? Array.from(
              { length: qualifiersPerDivision },
              (_, offset) => index * qualifiersPerDivision + offset + 1,
            )
          : null,
      seedRange:
        placementMethod === 'global-seed' && !last
          ? { from, to: from + qualifiersPerDivision * poolCount - 1 }
          : null,
      remainder: last,
      bracket,
      roundNumbers: placement.placements.map((entry) => entry.roundNumber),
      unusedRoundNumbers: placement.unusedRoundNumbers,
    };
  });

  for (const division of divisions) {
    if (division.teamCount === 0) {
      issues.push({
        code: 'empty-division',
        severity: 'error',
        message: `Division “${division.name}” would have no teams. Reduce the number of divisions or the places each takes.`,
      });
      continue;
    }
    if (division.teamCount === 1) {
      issues.push({
        code: 'single-team-division',
        severity: 'warning',
        message: `Division “${division.name}” would have one team, which plays no playoff games and is its champion by default.`,
      });
    }
    for (const bracketIssue of division.bracket.issues) {
      issues.push({
        code: bracketIssue.code,
        severity: bracketIssue.severity,
        message: `${division.name}: ${bracketIssue.message}`,
      });
    }
    for (const note of division.bracket.notes) notes.push(`${division.name}: ${note}`);
    if (division.unusedRoundNumbers.length > 0) {
      notes.push(
        `${division.name}: no game in round ${division.unusedRoundNumbers.join(', ')}; those teams rest rather than play a filler game.`,
      );
    }
  }

  const prelimGamesPerTeam = [...new Set(poolSizes.map(gamesPerTeamInPool))].sort(
    (left, right) => left - right,
  );
  // A team that loses its first playoff game plays one; a team that wins the whole division plays
  // one per bracket round, minus a first-round bye if it had one. A single-team division plays none.
  const playoffMinimum = divisions.some((division) => division.teamCount <= 1)
    ? 0
    : divisions.some((division) => division.teamCount > 1)
      ? 1
      : 0;
  const playoffMaximum = divisions.reduce(
    (maximum, division) => Math.max(maximum, division.bracket.roundCount),
    0,
  );

  if (prelimGamesPerTeam.length > 1) {
    notes.push(
      `Teams play ${prelimGamesPerTeam.join(' or ')} preliminary games depending on pool size, so preliminary standings are ranked inside each pool.`,
    );
  }

  return {
    teamCount,
    poolCount,
    poolSizes,
    poolNames: poolSizes.map((_, index) => poolName(index)),
    prelimRounds,
    prelimRoundNumbers,
    playoffRoundNumbers,
    totalRounds: prelimRounds + playoffRoundCount,
    placementMethod,
    divisions,
    rotation,
    issues,
    notes,
    valid: issues.every((entry) => entry.severity !== 'error'),
    prelimGamesPerTeam,
    playoffGamesPerTeam: { minimum: playoffMinimum, maximum: playoffMaximum },
  };
}

/** The plan this format recommends for a field size, with nothing else configured. */
export function recommendPoolPrelimPlayoffPlan(teamCount: number): PoolPrelimPlayoffPlan {
  const structure = recommendPrelimStructure(teamCount);
  return planPoolPrelimsWithPlayoffDivisions({
    teamCount,
    poolCount: structure.poolCount,
    poolSizes: structure.poolSizes,
    prelimRounds: structure.prelimRounds,
    divisionCount: Math.min(3, Math.max(1, structure.poolCount)),
    playoffRoundCount: 3,
  });
}
