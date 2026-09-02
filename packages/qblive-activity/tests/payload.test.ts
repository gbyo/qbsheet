/**
 * Shard sizing, decided by measurement.
 *
 * The prompt for QBSheet Live says to start at eight teams per shard "subject to actual encoded
 * ActivityKit payload measurements", and not to assume eight always fits. These tests are that
 * measurement. They print the numbers so the figures in `docs/QBLIVE_ACTIVITY.md` are reproducible
 * rather than asserted.
 */

import { describe, expect, test } from 'vitest';
import {
  APNS_BROADCAST_PAYLOAD_LIMIT,
  ActivityMode,
  broadcastPayloadBytes,
  chooseTeamsPerShard,
  DEFAULT_TEAMS_PER_SHARD,
  shardCount,
  shardForTeamIndex,
  shardStateFingerprint,
  SHARD_PAYLOAD_BUDGET,
  slotForTeamIndex,
  type ActivityShardState,
  type ActivityTeamState,
} from '../src/index.js';

/** A live game with every optional field present and same-shard opponents. */
function typicalLiveTeam(index: number): ActivityTeamState {
  return {
    i: index,
    m: ActivityMode.live,
    o: index % 2 === 0 ? index + 1 : index - 1,
    s: 185,
    x: 140,
    u: 13,
    rm: '104',
    rd: 7,
  };
}

/**
 * The worst case a real tournament produces.
 *
 * Cross-shard opponents (so the opponent's name is carried rather than an index), long room labels,
 * and a scheduled time. `on` is the expensive field and the one most likely to be forgotten in an
 * estimate.
 */
function worstCaseTeam(index: number): ActivityTeamState {
  return {
    i: index,
    m: ActivityMode.live,
    on: 'Thomas Jefferson High School for Science and Technology B',
    s: 1885,
    x: 1440,
    u: 24,
    rm: 'Science Wing Room 231A',
    rd: 14,
    st: 1757088000,
  };
}

function shard(size: number, team: (index: number) => ActivityTeamState): ActivityShardState {
  return { r: 999999, t: Array.from({ length: size }, (_unused, index) => team(index)) };
}

describe('shard payload sizes', () => {
  test('measured sizes are reported', () => {
    const rows: string[] = [];
    for (const size of [2, 4, 6, 8, 12, 16, 24, 32]) {
      const typical = broadcastPayloadBytes(shard(size, typicalLiveTeam));
      const worst = broadcastPayloadBytes(shard(size, worstCaseTeam));
      rows.push(
        `${String(size).padStart(2)} teams  typical ${String(typical).padStart(5)} B  ` +
          `worst ${String(worst).padStart(5)} B  ` +
          `(limit ${APNS_BROADCAST_PAYLOAD_LIMIT}, budget ${SHARD_PAYLOAD_BUDGET})`,
      );
    }
    console.log(`\nBroadcast payload measurements\n${rows.join('\n')}\n`);
    expect(rows).toHaveLength(8);
  });

  test('the default of eight teams fits the budget even in the worst case', () => {
    const worst = broadcastPayloadBytes(shard(DEFAULT_TEAMS_PER_SHARD, worstCaseTeam));
    expect(worst).toBeLessThanOrEqual(SHARD_PAYLOAD_BUDGET);
    // And with real headroom, not by a byte.
    expect(worst).toBeLessThan(APNS_BROADCAST_PAYLOAD_LIMIT * 0.75);
  });

  test('a typical eight-team shard is small', () => {
    expect(broadcastPayloadBytes(shard(8, typicalLiveTeam))).toBeLessThan(1024);
  });

  test('the size chosen for pathological strings is smaller than the default', () => {
    const enormous = (index: number): ActivityTeamState => ({
      ...worstCaseTeam(index),
      on: 'X'.repeat(400),
      rm: 'Y'.repeat(200),
      ev: 'Z'.repeat(200),
    });
    const chosen = chooseTeamsPerShard(enormous);
    expect(chosen).toBeLessThan(DEFAULT_TEAMS_PER_SHARD);
    expect(broadcastPayloadBytes(shard(chosen, enormous))).toBeLessThanOrEqual(SHARD_PAYLOAD_BUDGET);
  });

  test('measurement chooses sixteen, not the conservative default of eight', () => {
    // The recorded numbers above: a sixteen-team shard is 1 072 B typical and 2 618 B in the
    // pessimistic case, against a 3 072 B budget and Apple's 5 120 B hard limit. Eight was the
    // starting guess; sixteen is what the encoding actually supports, and it halves the number of
    // APNs channels a tournament consumes. The guess is kept as the fallback for a publication that
    // has not measured, which is why it is lower than what measurement returns.
    expect(chooseTeamsPerShard(typicalLiveTeam)).toBe(16);
    expect(chooseTeamsPerShard(worstCaseTeam)).toBe(16);
    expect(DEFAULT_TEAMS_PER_SHARD).toBeLessThanOrEqual(16);
  });

  test('no shard size is chosen that would exceed the hard limit', () => {
    for (const build of [typicalLiveTeam, worstCaseTeam]) {
      const size = chooseTeamsPerShard(build);
      expect(broadcastPayloadBytes(shard(size, build))).toBeLessThan(APNS_BROADCAST_PAYLOAD_LIMIT);
    }
  });
});

describe('channel allocation scales with shards, not with viewers', () => {
  test('a 64-team tournament needs eight channels at most', () => {
    expect(shardCount(64)).toBe(8);
    expect(shardCount(1)).toBe(1);
    expect(shardCount(0)).toBe(0);
    expect(shardCount(65)).toBe(9);
  });

  test('team index maps to a stable shard and slot', () => {
    expect(shardForTeamIndex(0)).toBe(0);
    expect(shardForTeamIndex(7)).toBe(0);
    expect(shardForTeamIndex(8)).toBe(1);
    expect(slotForTeamIndex(8)).toBe(0);
    expect(slotForTeamIndex(15)).toBe(7);
  });

  test('a thousand viewers of one shard still need one channel', () => {
    // Not a code path — an assertion about the design. Viewers do not appear in the calculation.
    const viewers = 1000;
    const teams = 8;
    expect(shardCount(teams)).toBe(1);
    expect(viewers).toBeGreaterThan(shardCount(teams));
  });
});

describe('deduplication', () => {
  test('the fingerprint ignores the revision', () => {
    const first = shard(8, typicalLiveTeam);
    const second = { ...structuredClone(first), r: first.r + 5 };
    expect(shardStateFingerprint(first)).toBe(shardStateFingerprint(second));
  });

  test('the fingerprint changes when a score changes', () => {
    const first = shard(8, typicalLiveTeam);
    const second = structuredClone(first);
    second.t[0].s = (second.t[0].s ?? 0) + 10;
    expect(shardStateFingerprint(first)).not.toBe(shardStateFingerprint(second));
  });

  test('the fingerprint changes when a game becomes final', () => {
    const first = shard(8, typicalLiveTeam);
    const second = structuredClone(first);
    second.t[0].m = ActivityMode.final;
    expect(shardStateFingerprint(first)).not.toBe(shardStateFingerprint(second));
  });
});
