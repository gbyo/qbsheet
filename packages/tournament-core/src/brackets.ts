/**
 * Seeded single-elimination brackets.
 *
 * A bracket is not a schedule. Most of its games do not know their participants when the bracket is
 * drawn, so this module models a game by where its two teams *come from* — a seed, or the outcome
 * of an earlier game — and resolves those references as results arrive. That is the whole reason
 * this file exists rather than a call to `generateRoundRobinSchedule`: a round robin can be written
 * out in advance, and a bracket genuinely cannot.
 *
 * Two things follow from that and are load-bearing elsewhere:
 *
 *  - A node whose slots are unresolved is *not* a `ScheduledMatch`. It cannot be, because
 *    `ScheduledMatch` requires two team ids. Callers materialise a match only once both slots
 *    resolve, which is what keeps an unusable assignment from reaching a room.
 *  - Byes are byes. A first-round bye is recorded as a bye against no opponent, never as a
 *    fabricated game, and it consumes no room and no packet.
 *
 * Round numbering here is phase-local (`roundIndex`, zero-based) because a bracket's shape does not
 * depend on where in the day it is played. `placeBracketRounds` maps those indices onto the real
 * tournament round numbers, which is what every operational surface shows.
 */

import type { EntityId } from './model';

/** Where one side of a bracket game comes from. */
export type BracketSlotSource =
  /** A fixed seed inside this bracket; `seed` is 1-based. */
  | { readonly kind: 'seed'; readonly seed: number }
  /** The winner of an earlier game in this bracket, named by its `key`. */
  | { readonly kind: 'winner'; readonly gameKey: string }
  /** The loser of an earlier game in this bracket — used by third-place and placement games. */
  | { readonly kind: 'loser'; readonly gameKey: string };

export type BracketGameKind = 'elimination' | 'third-place' | 'placement';

export interface BracketNode {
  /** Stable identifier inside one bracket: `A`, `B`, … `Z`, `AA`, … Used in printed brackets. */
  readonly key: string;
  /** Phase-local round, zero-based. Map to a tournament round with `placeBracketRounds`. */
  readonly roundIndex: number;
  /** Ordering inside the round, zero-based. */
  readonly sequence: number;
  readonly label: string;
  readonly kind: BracketGameKind;
  readonly slotA: BracketSlotSource;
  readonly slotB: BracketSlotSource;
}

export interface BracketBye {
  readonly seed: number;
  readonly roundIndex: number;
  /**
   * `true` when this bye is one the format promises the top seeds, `false` when the bracket's size
   * forces an extra one. A director explaining the afternoon to a coach needs that distinction.
   */
  readonly protectedSeed: boolean;
}

export type BracketIssueSeverity = 'error' | 'warning';

export interface BracketIssue {
  readonly code: string;
  readonly severity: BracketIssueSeverity;
  readonly message: string;
}

export interface BracketPlan {
  /** Number of real teams in the bracket. */
  readonly teamCount: number;
  /** Next power of two at or above `teamCount`; the structural size of the draw. */
  readonly bracketSize: number;
  readonly roundCount: number;
  readonly nodes: readonly BracketNode[];
  readonly byes: readonly BracketBye[];
  /** Plain-language sentences a director can read aloud. */
  readonly notes: readonly string[];
  readonly issues: readonly BracketIssue[];
}

export interface BracketPlanOptions {
  /**
   * Seeds that should receive a first-round bye whenever the draw allows one. Defaults to the top
   * two, which is the rule this format states. A seed listed here that the draw cannot give a bye
   * to produces a note, never a silently different bracket.
   */
  readonly protectedByeSeeds?: number;
  /** Add a third-place game between the two losing semifinalists. Off by default. */
  readonly thirdPlaceGame?: boolean;
}

function nextPowerOfTwo(value: number): number {
  if (value <= 1) return Math.max(1, value);
  let size = 1;
  while (size < value) size *= 2;
  return size;
}

/**
 * The standard single-elimination seed order for a draw of `size`.
 *
 * Built by repeated mirroring, which is the property that makes it standard: at every round the
 * best remaining seed meets the worst remaining seed, so the phantom seeds that stand in for an
 * undersized field always land opposite the top of the draw and the byes fall where the format
 * says they should.
 */
export function seedOrder(size: number): number[] {
  if (size < 1) return [];
  let order = [1];
  while (order.length < size) {
    const doubled = order.length * 2;
    const next: number[] = [];
    for (const seed of order) {
      next.push(seed, doubled + 1 - seed);
    }
    order = next;
  }
  return order;
}

function gameKeyAt(index: number): string {
  // A…Z, then AA…AZ, BA…, which keeps printed brackets readable well past any realistic division.
  let remaining = index;
  let key = '';
  do {
    key = String.fromCharCode(65 + (remaining % 26)) + key;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return key;
}

function roundLabel(roundsRemaining: number): string {
  switch (roundsRemaining) {
    case 1:
      return 'Championship';
    case 2:
      return 'Semifinal';
    case 3:
      return 'Quarterfinal';
    default:
      return `Round of ${2 ** roundsRemaining}`;
  }
}

/**
 * Draw a seeded single-elimination bracket for `teamCount` teams.
 *
 * The returned plan is structural: it names seeds, not teams. Binding seeds to teams is the
 * caller's job (see `resolveBracket`), which is what lets a division be re-seeded after a tie
 * ruling without redrawing the bracket.
 */
export function planSingleEliminationBracket(
  teamCount: number,
  options: BracketPlanOptions = {},
): BracketPlan {
  const issues: BracketIssue[] = [];
  const notes: string[] = [];
  const protectedByeSeeds = options.protectedByeSeeds ?? 2;

  if (!Number.isInteger(teamCount) || teamCount < 0) {
    return {
      teamCount: 0,
      bracketSize: 0,
      roundCount: 0,
      nodes: [],
      byes: [],
      notes: [],
      issues: [
        {
          code: 'invalid-team-count',
          severity: 'error',
          message: 'A bracket needs a whole number of teams.',
        },
      ],
    };
  }
  if (teamCount < 2) {
    if (teamCount === 1) {
      notes.push('A one-team division has no bracket; the single team is its champion by default.');
    }
    return {
      teamCount,
      bracketSize: teamCount,
      roundCount: 0,
      nodes: [],
      byes: [],
      notes,
      issues:
        teamCount === 0
          ? [{ code: 'empty-division', severity: 'error', message: 'A division needs at least one team.' }]
          : [],
    };
  }

  const bracketSize = nextPowerOfTwo(teamCount);
  const roundCount = Math.log2(bracketSize);
  const nodes: BracketNode[] = [];
  const byes: BracketBye[] = [];
  let keyIndex = 0;

  let positions: (BracketSlotSource | null)[] = seedOrder(bracketSize).map((seed) =>
    seed <= teamCount ? ({ kind: 'seed', seed } as const) : null,
  );

  for (let roundIndex = 0; roundIndex < roundCount; roundIndex += 1) {
    const next: (BracketSlotSource | null)[] = [];
    let sequence = 0;
    for (let position = 0; position < positions.length; position += 2) {
      const left = positions[position];
      const right = positions[position + 1];
      if (left && right) {
        const key = gameKeyAt(keyIndex);
        keyIndex += 1;
        nodes.push({
          key,
          roundIndex,
          sequence,
          label: roundLabel(roundCount - roundIndex),
          kind: 'elimination',
          slotA: left,
          slotB: right,
        });
        sequence += 1;
        next.push({ kind: 'winner', gameKey: key });
        continue;
      }
      const survivor = left ?? right;
      if (survivor) {
        if (survivor.kind === 'seed') {
          byes.push({
            seed: survivor.seed,
            roundIndex,
            protectedSeed: survivor.seed <= protectedByeSeeds,
          });
        }
        next.push(survivor);
        continue;
      }
      next.push(null);
    }
    positions = next;
  }

  if (options.thirdPlaceGame) {
    const semifinals = nodes.filter((node) => node.roundIndex === roundCount - 2);
    if (semifinals.length === 2) {
      nodes.push({
        key: gameKeyAt(keyIndex),
        roundIndex: roundCount - 1,
        sequence: 1,
        label: 'Third-place game',
        kind: 'third-place',
        slotA: { kind: 'loser', gameKey: semifinals[0].key },
        slotB: { kind: 'loser', gameKey: semifinals[1].key },
      });
    } else {
      issues.push({
        code: 'third-place-unavailable',
        severity: 'warning',
        message: 'This bracket is too small for a third-place game; none was added.',
      });
    }
  }

  const firstRoundByes = byes.filter((bye) => bye.roundIndex === 0);
  const protectedByes = firstRoundByes.filter((bye) => bye.protectedSeed);
  const extraByes = firstRoundByes.filter((bye) => !bye.protectedSeed);
  const wantedProtected = Math.min(protectedByeSeeds, teamCount);

  if (firstRoundByes.length > 0) {
    notes.push(
      `${teamCount}-team division: ${firstRoundByes.length} first-round bye${
        firstRoundByes.length === 1 ? ' is' : 's are'
      } required by the bracket size.`,
    );
  } else {
    notes.push(`${teamCount}-team division: the bracket is full, so no team receives a first-round bye.`);
  }
  if (protectedByes.length > 0) {
    notes.push(`Protected byes: ${protectedByes.map((bye) => `#${bye.seed}`).join(', ')}.`);
  }
  if (extraByes.length > 0) {
    notes.push(
      `Additional bracket bye${extraByes.length === 1 ? '' : 's'} beyond the protected seeds: ${extraByes
        .map((bye) => `#${bye.seed}`)
        .join(', ')}.`,
    );
  }
  if (protectedByes.length < wantedProtected) {
    const missing = [];
    for (let seed = 1; seed <= wantedProtected; seed += 1) {
      if (!protectedByes.some((bye) => bye.seed === seed)) missing.push(`#${seed}`);
    }
    issues.push({
      code: 'protected-bye-unavailable',
      severity: 'warning',
      message: `A ${teamCount}-team bracket has only ${firstRoundByes.length} first-round bye${
        firstRoundByes.length === 1 ? '' : 's'
      }, so ${missing.join(' and ')} play${missing.length === 1 ? 's' : ''} in the first round.`,
    });
  }

  return {
    teamCount,
    bracketSize,
    roundCount,
    nodes: [...nodes].sort(
      (left, right) => left.roundIndex - right.roundIndex || left.sequence - right.sequence,
    ),
    byes,
    notes,
    issues,
  };
}

export type BracketRoundPolicy = 'earliest' | 'latest' | 'championship-last';

export interface BracketRoundPlacement {
  /** Phase-local index, matching `BracketNode.roundIndex`. */
  readonly roundIndex: number;
  /** The tournament round number an operator, a packet, and a printed schedule all use. */
  readonly roundNumber: number;
}

export interface BracketRoundPlan {
  readonly placements: readonly BracketRoundPlacement[];
  /** Reserved rounds this bracket does not use — a rest round, not a round to invent a game for. */
  readonly unusedRoundNumbers: readonly number[];
  readonly issues: readonly BracketIssue[];
}

/**
 * Map a bracket's phase-local rounds onto reserved tournament round numbers.
 *
 * A division smaller than the reserved block leaves a round unused. Which round that is, is a
 * tournament-operations decision rather than a mathematical one — a four-team division can play its
 * semifinals early and its final alongside every other division's final, or play both late — so it
 * is a policy here and never a fabricated game.
 */
export function placeBracketRounds(
  roundCount: number,
  availableRoundNumbers: readonly number[],
  policy: BracketRoundPolicy = 'championship-last',
): BracketRoundPlan {
  const available = [...availableRoundNumbers].sort((left, right) => left - right);
  if (roundCount <= 0) return { placements: [], unusedRoundNumbers: available, issues: [] };
  if (available.length < roundCount) {
    return {
      placements: [],
      unusedRoundNumbers: available,
      issues: [
        {
          code: 'insufficient-rounds',
          severity: 'error',
          message: `This bracket needs ${roundCount} rounds but only ${available.length} are reserved.`,
        },
      ],
    };
  }
  let chosen: number[];
  if (policy === 'latest') {
    chosen = available.slice(available.length - roundCount);
  } else if (policy === 'championship-last' && roundCount >= 1) {
    chosen = [...available.slice(0, roundCount - 1), available[available.length - 1]];
  } else {
    chosen = available.slice(0, roundCount);
  }
  const used = new Set(chosen);
  return {
    placements: chosen.map((roundNumber, roundIndex) => ({ roundIndex, roundNumber })),
    unusedRoundNumbers: available.filter((roundNumber) => !used.has(roundNumber)),
    issues: [],
  };
}

export interface BracketSeeding {
  readonly seed: number;
  readonly teamId: EntityId;
}

export interface BracketGameOutcome {
  readonly gameKey: string;
  readonly winnerTeamId: EntityId;
  readonly loserTeamId: EntityId;
}

export interface ResolvedBracketSlot {
  readonly source: BracketSlotSource;
  readonly teamId: EntityId | null;
  /** Compact text for a wall bracket when `teamId` is null, e.g. `Winner of #4/#5`. */
  readonly placeholder: string;
  /** The same reference with team names, for a team schedule: `Winner of #4 Greenwood A / #5 Ware Shoals A`. */
  readonly placeholderDetail: string;
}

export interface ResolvedBracketGame {
  readonly key: string;
  readonly roundIndex: number;
  readonly roundNumber: number | null;
  readonly sequence: number;
  readonly label: string;
  readonly kind: BracketGameKind;
  readonly slotA: ResolvedBracketSlot;
  readonly slotB: ResolvedBracketSlot;
  /** Both participants are known, so this game can be scheduled and assigned. */
  readonly ready: boolean;
  readonly winnerTeamId: EntityId | null;
  readonly loserTeamId: EntityId | null;
}

export interface ResolvedBracket {
  readonly plan: BracketPlan;
  readonly games: readonly ResolvedBracketGame[];
  readonly byes: readonly (BracketBye & {
    readonly teamId: EntityId | null;
    readonly roundNumber: number | null;
  })[];
  readonly championTeamId: EntityId | null;
  readonly runnerUpTeamId: EntityId | null;
  readonly thirdPlaceTeamId: EntityId | null;
  readonly complete: boolean;
}

export interface ResolveBracketInput {
  readonly plan: BracketPlan;
  readonly seeding: readonly BracketSeeding[];
  readonly outcomes?: readonly BracketGameOutcome[];
  readonly roundPlacements?: readonly BracketRoundPlacement[];
  /** Team display names, used only to build human placeholders like `Winner of Ninety Six A / Greenwood A`. */
  readonly teamNames?: ReadonlyMap<EntityId, string>;
}

function placeholderFor(
  source: BracketSlotSource,
  nodesByKey: ReadonlyMap<string, BracketNode>,
  seedNames: ReadonlyMap<number, string>,
  withNames: boolean,
): string {
  const describe = (slot: BracketSlotSource): string => {
    if (slot.kind !== 'seed') return slot.gameKey;
    const name = withNames ? seedNames.get(slot.seed) : undefined;
    return name ? `#${slot.seed} ${name}` : `#${slot.seed}`;
  };
  if (source.kind === 'seed') return describe(source);
  const verb = source.kind === 'winner' ? 'Winner' : 'Loser';
  const node = nodesByKey.get(source.gameKey);
  if (!node) return `${verb} of ${source.gameKey}`;
  return `${verb} of ${describe(node.slotA)} / ${describe(node.slotB)}`;
}

/**
 * Bind a drawn bracket to real teams and to whatever has already been played.
 *
 * Resolution is a fixed point over rounds: a game becomes ready when both of its slots resolve, and
 * a slot resolves either because it names a seed or because the game it names has an accepted
 * outcome. Nothing is guessed — an unplayed dependency leaves the slot null and the game not ready,
 * which is precisely the state that must not be released to a room.
 */
export function resolveBracket(input: ResolveBracketInput): ResolvedBracket {
  const teamBySeed = new Map(input.seeding.map((entry) => [entry.seed, entry.teamId]));
  const seedNames = new Map<number, string>();
  for (const entry of input.seeding) {
    const name = input.teamNames?.get(entry.teamId);
    if (name) seedNames.set(entry.seed, name);
  }
  const nodesByKey = new Map(input.plan.nodes.map((node) => [node.key, node]));
  const outcomeByKey = new Map((input.outcomes ?? []).map((outcome) => [outcome.gameKey, outcome]));
  const roundNumberByIndex = new Map(
    (input.roundPlacements ?? []).map((placement) => [placement.roundIndex, placement.roundNumber]),
  );

  const resolveSlot = (source: BracketSlotSource): EntityId | null => {
    if (source.kind === 'seed') return teamBySeed.get(source.seed) ?? null;
    const outcome = outcomeByKey.get(source.gameKey);
    if (!outcome) return null;
    return source.kind === 'winner' ? outcome.winnerTeamId : outcome.loserTeamId;
  };

  const games: ResolvedBracketGame[] = input.plan.nodes.map((node) => {
    const teamAId = resolveSlot(node.slotA);
    const teamBId = resolveSlot(node.slotB);
    const outcome = outcomeByKey.get(node.key);
    return {
      key: node.key,
      roundIndex: node.roundIndex,
      roundNumber: roundNumberByIndex.get(node.roundIndex) ?? null,
      sequence: node.sequence,
      label: node.label,
      kind: node.kind,
      slotA: {
        source: node.slotA,
        teamId: teamAId,
        placeholder: placeholderFor(node.slotA, nodesByKey, seedNames, false),
        placeholderDetail: placeholderFor(node.slotA, nodesByKey, seedNames, true),
      },
      slotB: {
        source: node.slotB,
        teamId: teamBId,
        placeholder: placeholderFor(node.slotB, nodesByKey, seedNames, false),
        placeholderDetail: placeholderFor(node.slotB, nodesByKey, seedNames, true),
      },
      ready: teamAId !== null && teamBId !== null,
      winnerTeamId: outcome?.winnerTeamId ?? null,
      loserTeamId: outcome?.loserTeamId ?? null,
    };
  });

  const byes = input.plan.byes.map((bye) => ({
    ...bye,
    teamId: teamBySeed.get(bye.seed) ?? null,
    roundNumber: roundNumberByIndex.get(bye.roundIndex) ?? null,
  }));

  // The final is the only elimination game in the last phase-local round; matching on that rather
  // than on a label keeps the derivation working if labels are ever localised.
  const championship = games.find(
    (game) => game.kind === 'elimination' && game.roundIndex === input.plan.roundCount - 1,
  );
  const thirdPlace = games.find((game) => game.kind === 'third-place');
  // A one-team division has no championship game; that team is its champion.
  const soleTeam = input.plan.teamCount === 1 ? (teamBySeed.get(1) ?? null) : null;

  return {
    plan: input.plan,
    games,
    byes,
    championTeamId: championship?.winnerTeamId ?? soleTeam,
    runnerUpTeamId: championship?.loserTeamId ?? null,
    thirdPlaceTeamId: thirdPlace?.winnerTeamId ?? null,
    complete:
      input.plan.teamCount <= 1
        ? true
        : games.filter((game) => game.kind === 'elimination').every((game) => game.winnerTeamId !== null),
  };
}

/**
 * Which games a bracket outcome makes newly resolvable.
 *
 * Used to answer two operational questions with one call: what became schedulable when a result was
 * accepted, and what stops being valid when that result is corrected.
 */
export function bracketGamesDependingOn(plan: BracketPlan, gameKey: string): readonly BracketNode[] {
  const direct = plan.nodes.filter(
    (node) =>
      (node.slotA.kind !== 'seed' && node.slotA.gameKey === gameKey) ||
      (node.slotB.kind !== 'seed' && node.slotB.gameKey === gameKey),
  );
  const seen = new Set(direct.map((node) => node.key));
  const queue = [...direct];
  const all = [...direct];
  while (queue.length > 0) {
    const current = queue.shift() as BracketNode;
    for (const node of plan.nodes) {
      if (seen.has(node.key)) continue;
      const dependsOnCurrent =
        (node.slotA.kind !== 'seed' && node.slotA.gameKey === current.key) ||
        (node.slotB.kind !== 'seed' && node.slotB.gameKey === current.key);
      if (!dependsOnCurrent) continue;
      seen.add(node.key);
      all.push(node);
      queue.push(node);
    }
  }
  return all.sort((left, right) => left.roundIndex - right.roundIndex || left.sequence - right.sequence);
}

export interface BracketAward {
  readonly place: 'champion' | 'runner-up' | 'third';
  readonly teamId: EntityId;
}

/** Derive the plaque recipients a completed bracket already determines. */
export function bracketAwards(bracket: ResolvedBracket): readonly BracketAward[] {
  const awards: BracketAward[] = [];
  if (bracket.championTeamId) awards.push({ place: 'champion', teamId: bracket.championTeamId });
  if (bracket.runnerUpTeamId) awards.push({ place: 'runner-up', teamId: bracket.runnerUpTeamId });
  if (bracket.thirdPlaceTeamId) awards.push({ place: 'third', teamId: bracket.thirdPlaceTeamId });
  return awards;
}
