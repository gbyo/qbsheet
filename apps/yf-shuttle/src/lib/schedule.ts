/**
 * The one built-in schedule: Wildcat 12-team / 8-round / two prelim pools / Gold + Maroon.
 *
 * # Seeds, not names
 *
 * Everything here is keyed by overall seed number (1–12) and by stable room slot — never by
 * team name, room display name, pool name, or phase name. The loaded `.yft` is validated
 * structurally first (`validateWildcatCompatibility`): twelve teams, a tournament seed order
 * covering all of them, a prelim phase whose two pools of six match the A/B seed split, and
 * rounds numbered 1–8 across a prelim and a playoff phase. Only then are seeds resolved to the
 * file's own team ids.
 *
 * The expected seed split (from the tournament's own seed order):
 *
 * - Prelim A: seeds 1, 4, 5, 8, 9, 12 — played in the gold slots (default rooms 319/320/321)
 * - Prelim B: seeds 2, 3, 6, 7, 10, 11 — played in the maroon slots (default 315/317/318)
 */

import type { ShuttleRound, ShuttleTournament } from './tournament';

export type RoomSide = 'gold' | 'maroon';
export type PrelimPoolKey = 'A' | 'B';

export interface RoomSlot {
  /** Stable internal id. Never derived from the display name; renames must not move games. */
  id: string;
  side: RoomSide;
  prelimPool: PrelimPoolKey;
  defaultName: string;
}

export const ROOM_SLOTS: readonly RoomSlot[] = [
  { id: 'slot-maroon-1', side: 'maroon', prelimPool: 'B', defaultName: '315' },
  { id: 'slot-maroon-2', side: 'maroon', prelimPool: 'B', defaultName: '317' },
  { id: 'slot-maroon-3', side: 'maroon', prelimPool: 'B', defaultName: '318' },
  { id: 'slot-gold-1', side: 'gold', prelimPool: 'A', defaultName: '319' },
  { id: 'slot-gold-2', side: 'gold', prelimPool: 'A', defaultName: '320' },
  { id: 'slot-gold-3', side: 'gold', prelimPool: 'A', defaultName: '321' },
];

export const PRESET_ID = 'wildcat-12' as const;

const SEEDS_A: ReadonlySet<number> = new Set([1, 4, 5, 8, 9, 12]);
const SEEDS_B: ReadonlySet<number> = new Set([2, 3, 6, 7, 10, 11]);

type SeedPair = readonly [number, number];

/**
 * Prelim table: round number → slot id → [left seed, right seed].
 *
 * The tables below are the tournament's fixed schedule, transcribed seed-for-seed. Left/right
 * order is kept as listed: it decides which side of the assignment each team is on, and the
 * Match id hashes the two sides in order, so the order is part of the identity.
 */
const PRELIM_TABLE: Readonly<Record<number, Readonly<Record<string, SeedPair>>>> = {
  1: {
    'slot-gold-1': [9, 12],
    'slot-gold-2': [5, 4],
    'slot-gold-3': [8, 1],
    'slot-maroon-1': [6, 11],
    'slot-maroon-2': [3, 10],
    'slot-maroon-3': [7, 2],
  },
  2: {
    'slot-gold-1': [12, 4],
    'slot-gold-2': [9, 1],
    'slot-gold-3': [8, 5],
    'slot-maroon-1': [11, 10],
    'slot-maroon-2': [6, 2],
    'slot-maroon-3': [7, 3],
  },
  3: {
    'slot-gold-1': [8, 4],
    'slot-gold-2': [12, 1],
    'slot-gold-3': [9, 5],
    'slot-maroon-1': [7, 10],
    'slot-maroon-2': [11, 2],
    'slot-maroon-3': [6, 3],
  },
  4: {
    'slot-gold-1': [8, 9],
    'slot-gold-2': [5, 12],
    'slot-gold-3': [1, 4],
    'slot-maroon-1': [7, 6],
    'slot-maroon-2': [3, 11],
    'slot-maroon-3': [2, 10],
  },
  5: {
    'slot-gold-1': [5, 1],
    'slot-gold-2': [8, 12],
    'slot-gold-3': [9, 4],
    'slot-maroon-1': [3, 2],
    'slot-maroon-2': [7, 11],
    'slot-maroon-3': [6, 10],
  },
};

export type PlayoffLabel =
  | 'F1' | 'F2' | 'F3' | 'F4' | 'F5' | 'F6'
  | 'B1' | 'B2' | 'B3' | 'B4' | 'B5' | 'B6';

type LabelPair = readonly [PlayoffLabel, PlayoffLabel];

/** Playoff table: round number → slot id → [left label, right label]. */
const PLAYOFF_TABLE: Readonly<Record<number, Readonly<Record<string, LabelPair>>>> = {
  6: {
    'slot-gold-1': ['F2', 'F3'],
    'slot-gold-2': ['F1', 'B3'],
    'slot-gold-3': ['B1', 'B2'],
    'slot-maroon-1': ['F5', 'F6'],
    'slot-maroon-2': ['F4', 'B6'],
    'slot-maroon-3': ['B4', 'B5'],
  },
  7: {
    'slot-gold-1': ['B1', 'B3'],
    'slot-gold-2': ['F2', 'B2'],
    'slot-gold-3': ['F1', 'F3'],
    'slot-maroon-1': ['B4', 'B6'],
    'slot-maroon-2': ['F5', 'B5'],
    'slot-maroon-3': ['F4', 'F6'],
  },
  8: {
    'slot-gold-1': ['F1', 'B2'],
    'slot-gold-2': ['B1', 'F3'],
    'slot-gold-3': ['F2', 'B3'],
    'slot-maroon-1': ['F4', 'B5'],
    'slot-maroon-2': ['B4', 'F6'],
    'slot-maroon-3': ['F5', 'B6'],
  },
};

export const PRELIM_ROUNDS = [1, 2, 3, 4, 5] as const;
export const PLAYOFF_ROUNDS = [6, 7, 8] as const;

export interface PlannedGame {
  roundNumber: number;
  roundId: string;
  slotId: string;
  leftTeamId: string;
  rightTeamId: string;
}

export interface WildcatCompatibility {
  prelimPhaseId: string;
  playoffPhaseId: string;
  /** Prelim pool of six whose seeds are exactly {1,4,5,8,9,12}. */
  poolAId: string;
  /** Prelim pool of six whose seeds are exactly {2,3,6,7,10,11}. */
  poolBId: string;
  roundsByNumber: Map<number, ShuttleRound>;
  teamsBySeed: Map<number, string>;
}

function sameSeeds(members: ReadonlySet<number>, expected: ReadonlySet<number>): boolean {
  if (members.size !== expected.size) return false;
  for (const seed of expected) if (!members.has(seed)) return false;
  return true;
}

/**
 * Check that the loaded file is the Wildcat shape before anything is generated.
 *
 * Structural only: team counts, seed coverage, pool seed-split membership, round numbers 1–8.
 * Team names, room names, pool names, and phase names are never consulted.
 */
export function validateWildcatCompatibility(
  tournament: ShuttleTournament,
): { ok: true; compat: WildcatCompatibility } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  if (tournament.teams.length !== 12) {
    errors.push(
      `The Wildcat preset needs exactly 12 teams, but this file has ${tournament.teams.length}.`,
    );
  }

  const teamsBySeed = new Map<number, string>();
  for (const team of tournament.teams) {
    if (team.seed === undefined) {
      errors.push(`Team “${team.name}” has no seed in the tournament seed order.`);
    } else if (teamsBySeed.has(team.seed)) {
      errors.push(`Two teams share seed ${team.seed}; the seed order is ambiguous.`);
    } else {
      teamsBySeed.set(team.seed, team.id);
    }
  }
  for (let seed = 1; seed <= 12; seed += 1) {
    if (!teamsBySeed.has(seed)) errors.push(`No team holds seed ${seed}; the preset needs seeds 1–12.`);
  }

  if (tournament.timed === null) {
    errors.push(
      'This YellowFruit file does not say whether rounds are timed, so a room cannot score it. ' +
        'Save it again from YellowFruit and reload it.',
    );
  }

  const roundsByNumber = new Map<number, ShuttleRound>();
  for (const round of tournament.rounds) {
    if (round.number !== undefined && !roundsByNumber.has(round.number)) roundsByNumber.set(round.number, round);
  }
  for (let number = 1; number <= 8; number += 1) {
    if (!roundsByNumber.has(number)) errors.push(`This file has no round ${number}; the preset needs rounds 1–8.`);
  }

  let prelimPhaseId = '';
  let playoffPhaseId = '';
  if (errors.length === 0) {
    const prelimPhases = new Set(PRELIM_ROUNDS.map((number) => roundsByNumber.get(number)!.phaseId));
    const playoffPhases = new Set(PLAYOFF_ROUNDS.map((number) => roundsByNumber.get(number)!.phaseId));
    if (prelimPhases.size !== 1) {
      errors.push('Rounds 1–5 are not all in one phase, so the prelim pools cannot be found.');
    } else {
      [prelimPhaseId] = [...prelimPhases];
    }
    if (playoffPhases.size !== 1) {
      errors.push('Rounds 6–8 are not all in one phase, so the playoff pools cannot be found.');
    } else {
      [playoffPhaseId] = [...playoffPhases];
    }
  }

  let poolAId = '';
  let poolBId = '';
  if (errors.length === 0) {
    const prelimPools = tournament.pools.filter((pool) => pool.phaseId === prelimPhaseId);
    if (prelimPools.length !== 2) {
      errors.push(
        `The prelim phase needs exactly two pools, but this file has ${prelimPools.length}.`,
      );
    } else {
      for (const pool of prelimPools) {
        if (pool.teamIds.length !== 6) {
          errors.push(`Pool “${pool.name}” has ${pool.teamIds.length} teams; the preset needs two pools of six.`);
          continue;
        }
        const seeds = new Set<number>();
        for (const teamId of pool.teamIds) {
          const team = tournament.teams.find((entry) => entry.id === teamId);
          if (team?.seed !== undefined) seeds.add(team.seed);
        }
        if (sameSeeds(seeds, SEEDS_A)) poolAId = pool.id;
        else if (sameSeeds(seeds, SEEDS_B)) poolBId = pool.id;
        else {
          errors.push(
            `Pool “${pool.name}” holds seeds ${[...seeds].sort((a, b) => a - b).join(', ')}, ` +
              'which matches neither prelim group (1/4/5/8/9/12 nor 2/3/6/7/10/11).',
          );
        }
      }
      if (errors.length === 0 && (!poolAId || !poolBId)) {
        errors.push('The two prelim pools do not form the expected A/B seed split.');
      }
    }
    const playoffPools = tournament.pools.filter((pool) => pool.phaseId === playoffPhaseId);
    if (playoffPools.length !== 2) {
      errors.push(
        `The playoff phase needs exactly two pools, but this file has ${playoffPools.length}.`,
      );
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    compat: { prelimPhaseId, playoffPhaseId, poolAId, poolBId, roundsByNumber, teamsBySeed },
  };
}

/** All 30 prelim games, in round order, with the file's own team and round ids. */
export function planPrelims(compat: WildcatCompatibility): PlannedGame[] {
  const games: PlannedGame[] = [];
  for (const roundNumber of PRELIM_ROUNDS) {
    const round = compat.roundsByNumber.get(roundNumber)!;
    for (const slot of ROOM_SLOTS) {
      const pair = PRELIM_TABLE[roundNumber][slot.id];
      games.push({
        roundNumber,
        roundId: round.id,
        slotId: slot.id,
        leftTeamId: compat.teamsBySeed.get(pair[0])!,
        rightTeamId: compat.teamsBySeed.get(pair[1])!,
      });
    }
  }
  return games;
}

export type PlayoffSlots = Record<PlayoffLabel, string>;

/** All 18 playoff games, in round order, once F1–F6 / B1–B6 are known. */
export function planPlayoffs(compat: WildcatCompatibility, slots: PlayoffSlots): PlannedGame[] {
  const games: PlannedGame[] = [];
  for (const roundNumber of PLAYOFF_ROUNDS) {
    const round = compat.roundsByNumber.get(roundNumber)!;
    for (const slot of ROOM_SLOTS) {
      const pair = PLAYOFF_TABLE[roundNumber][slot.id];
      games.push({
        roundNumber,
        roundId: round.id,
        slotId: slot.id,
        leftTeamId: slots[pair[0]],
        rightTeamId: slots[pair[1]],
      });
    }
  }
  return games;
}
