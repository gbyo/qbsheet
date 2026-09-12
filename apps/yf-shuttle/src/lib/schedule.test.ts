/**
 * The Wildcat preset, pinned down: exact pairings, full round robins, and structural checks.
 *
 * The schedule tables are the tournament's fixed plan transcribed seed-for-seed. These tests
 * hold the transcription honest — every team plays every round, every pool completes a full
 * five-game round robin, the playoffs field exactly the twelve slots — without ever naming a
 * team, room, pool, or phase.
 */

import { describe, expect, test } from 'vitest';
import {
  PLAYOFF_ROUNDS,
  PRELIM_ROUNDS,
  ROOM_SLOTS,
  planPlayoffs,
  planPrelims,
  validateWildcatCompatibility,
  type PlayoffSlots,
} from '../lib/schedule';
import { loadedFixture, loadedSynthetic, syntheticTeams, syntheticYftText } from '../tests/helpers';
import { loadShuttleTournament } from '../lib/tournament';

function compatOf(tournament = loadedFixture()) {
  const result = validateWildcatCompatibility(tournament);
  if (!result.ok) throw new Error(result.errors.join(' '));
  return result.compat;
}

describe('the prelim preset', () => {
  test('contains exactly 30 unique games', () => {
    const games = planPrelims(compatOf());
    expect(games).toHaveLength(30);
    const keys = games.map(
      (game) => `${game.roundNumber}:${game.slotId}:${game.leftTeamId}:${game.rightTeamId}`,
    );
    expect(new Set(keys).size).toBe(30);
  });

  test('every team plays exactly once in each of rounds 1–5', () => {
    const tournament = loadedFixture();
    const compat = compatOf(tournament);
    const games = planPrelims(compat);
    for (const round of PRELIM_ROUNDS) {
      const sides = games
        .filter((game) => game.roundNumber === round)
        .flatMap((game) => [game.leftTeamId, game.rightTeamId]);
      expect(sides).toHaveLength(12);
      expect(new Set(sides).size).toBe(12);
      expect(new Set(sides)).toEqual(new Set(tournament.teams.map((team) => team.id)));
    }
  });

  test('each six-team pool completes a full five-game round robin', () => {
    const tournament = loadedFixture();
    const compat = compatOf(tournament);
    const bySeed = new Map(tournament.teams.map((team) => [team.id, team.seed!]));
    const poolOfSeed = (seed: number): string =>
      [1, 4, 5, 8, 9, 12].includes(seed) ? 'A' : 'B';
    const pairsByPool = new Map<string, Set<string>>();
    for (const game of planPrelims(compat)) {
      const leftSeed = bySeed.get(game.leftTeamId)!;
      const rightSeed = bySeed.get(game.rightTeamId)!;
      // No cross-pool games before the playoffs.
      expect(poolOfSeed(leftSeed)).toBe(poolOfSeed(rightSeed));
      const key = [leftSeed, rightSeed].sort((a, b) => a - b).join('v');
      const pool = poolOfSeed(leftSeed);
      const seen = pairsByPool.get(pool) ?? new Set<string>();
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      pairsByPool.set(pool, seen);
    }
    // C(6,2) = 15 pairings per pool.
    expect(pairsByPool.get('A')?.size).toBe(15);
    expect(pairsByPool.get('B')?.size).toBe(15);
  });

  test('matches the published round-1 pairings seed-for-seed', () => {
    const tournament = loadedFixture();
    const compat = compatOf(tournament);
    const seedOf = new Map(tournament.teams.map((team) => [team.id, team.seed!]));
    const round1 = new Map(
      planPrelims(compat)
        .filter((game) => game.roundNumber === 1)
        .map((game) => [game.slotId, [game.leftTeamId, game.rightTeamId] as const]),
    );
    const seedPair = (slot: string): [number, number] => {
      const pair = round1.get(slot)!;
      return [seedOf.get(pair[0])!, seedOf.get(pair[1])!];
    };
    expect(seedPair('slot-gold-1')).toEqual([9, 12]);
    expect(seedPair('slot-gold-2')).toEqual([5, 4]);
    expect(seedPair('slot-gold-3')).toEqual([8, 1]);
    expect(seedPair('slot-maroon-1')).toEqual([6, 11]);
    expect(seedPair('slot-maroon-2')).toEqual([3, 10]);
    expect(seedPair('slot-maroon-3')).toEqual([7, 2]);
  });

  test('uses six stable slots, three per side', () => {
    expect(ROOM_SLOTS).toHaveLength(6);
    expect(ROOM_SLOTS.filter((slot) => slot.side === 'gold')).toHaveLength(3);
    expect(ROOM_SLOTS.filter((slot) => slot.side === 'maroon')).toHaveLength(3);
    expect(new Set(ROOM_SLOTS.map((slot) => slot.id)).size).toBe(6);
    expect(new Set(ROOM_SLOTS.map((slot) => slot.defaultName)).size).toBe(6);
  });
});

describe('the playoff preset', () => {
  function slots(): PlayoffSlots {
    const teams = syntheticTeams();
    const id = (seed: number): string => teams.find((team) => team.seed === seed)!.id;
    return {
      F1: id(1), F2: id(4), F3: id(5), F4: id(8), F5: id(9), F6: id(12),
      B1: id(2), B2: id(3), B3: id(6), B4: id(7), B5: id(10), B6: id(11),
    };
  }

  test('contains exactly 18 games', () => {
    const tournament = loadedSynthetic();
    const compat = compatOf(tournament);
    expect(planPlayoffs(compat, slots())).toHaveLength(18);
  });

  test('every team plays exactly once in each of rounds 6–8', () => {
    const tournament = loadedSynthetic();
    const compat = compatOf(tournament);
    const games = planPlayoffs(compat, slots());
    for (const round of PLAYOFF_ROUNDS) {
      const sides = games
        .filter((game) => game.roundNumber === round)
        .flatMap((game) => [game.leftTeamId, game.rightTeamId]);
      expect(sides).toHaveLength(12);
      expect(new Set(sides).size).toBe(12);
    }
  });

  test('matches the published round-6 pairings label-for-label', () => {
    const tournament = loadedSynthetic();
    const compat = compatOf(tournament);
    const table = slots();
    const labelOf = (id: string): string =>
      (Object.entries(table).find(([, teamId]) => teamId === id) ?? ['?'])[0];
    const round6 = new Map(
      planPlayoffs(compat, table)
        .filter((game) => game.roundNumber === 6)
        .map((game) => [game.slotId, [labelOf(game.leftTeamId), labelOf(game.rightTeamId)] as const]),
    );
    expect(round6.get('slot-gold-1')).toEqual(['F2', 'F3']);
    expect(round6.get('slot-gold-2')).toEqual(['F1', 'B3']);
    expect(round6.get('slot-gold-3')).toEqual(['B1', 'B2']);
    expect(round6.get('slot-maroon-1')).toEqual(['F5', 'F6']);
    expect(round6.get('slot-maroon-2')).toEqual(['F4', 'B6']);
    expect(round6.get('slot-maroon-3')).toEqual(['B4', 'B5']);
  });

  test('gold rooms only host top-half labels and maroon only bottom-half', () => {
    const tournament = loadedSynthetic();
    const table = slots();
    const top = new Set(['F1', 'F2', 'F3', 'B1', 'B2', 'B3']);
    const labelOf = (id: string): string =>
      (Object.entries(table).find(([, teamId]) => teamId === id) ?? ['?'])[0];
    for (const game of planPlayoffs(compatOf(tournament), table)) {
      const slot = ROOM_SLOTS.find((entry) => entry.id === game.slotId)!;
      const labels = [labelOf(game.leftTeamId), labelOf(game.rightTeamId)];
      if (slot.side === 'gold') expect(labels.every((label) => top.has(label))).toBe(true);
      else expect(labels.every((label) => !top.has(label))).toBe(true);
    }
  });
});

describe('compatibility validation', () => {
  test('accepts the real sample file and the synthetic file', () => {
    expect(validateWildcatCompatibility(loadedFixture()).ok).toBe(true);
    expect(validateWildcatCompatibility(loadedSynthetic()).ok).toBe(true);
  });

  test('rejects a file with the wrong team count', () => {
    const parsed = JSON.parse(syntheticYftText());
    const tournament = parsed.objects[0];
    tournament.registrations.pop();
    tournament.YfData.seeds.pop();
    const report = loadShuttleTournament(JSON.stringify(parsed));
    expect(report.ok).toBe(true);
    if (report.ok) {
      const compat = validateWildcatCompatibility(report.tournament);
      expect(compat.ok).toBe(false);
      if (!compat.ok) expect(compat.errors.join(' ')).toMatch(/12 teams/);
    }
  });

  test('rejects a file that does not state timed or untimed', () => {
    const parsed = JSON.parse(syntheticYftText());
    delete parsed.objects[0].scoring_rules.YfData;
    const report = loadShuttleTournament(JSON.stringify(parsed));
    expect(report.ok).toBe(true);
    if (report.ok) {
      const compat = validateWildcatCompatibility(report.tournament);
      expect(compat.ok).toBe(false);
      if (!compat.ok) expect(compat.errors.join(' ')).toMatch(/timed/);
    }
  });

  test('rejects a file missing round numbers', () => {
    const parsed = JSON.parse(syntheticYftText());
    parsed.objects[0].phases[0].rounds.pop();
    const report = loadShuttleTournament(JSON.stringify(parsed));
    expect(report.ok).toBe(true);
    if (report.ok) {
      const compat = validateWildcatCompatibility(report.tournament);
      expect(compat.ok).toBe(false);
    }
  });

  test('rejects pools that break the A/B seed split', () => {
    const parsed = JSON.parse(syntheticYftText());
    const pools = parsed.objects[0].phases[0].pools;
    // Swap one team across pools: seed 1 moves to B, seed 2 moves to A.
    const aTeams = pools[0].pool_teams;
    const bTeams = pools[1].pool_teams;
    const moved = aTeams.shift();
    aTeams.push(bTeams.shift());
    bTeams.push(moved);
    const report = loadShuttleTournament(JSON.stringify(parsed));
    expect(report.ok).toBe(true);
    if (report.ok) {
      expect(validateWildcatCompatibility(report.tournament).ok).toBe(false);
    }
  });
});
