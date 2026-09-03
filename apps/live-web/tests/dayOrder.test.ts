/**
 * Live Web follows the explicit tournament-day sequence.
 *
 * With no clock time anywhere, the next event for a team is the first
 * unfinished game in day-sequence order — never a guessed time, never round
 * number when the director has reordered the day.
 */

import { describe, expect, test } from 'vitest';
import { parseSnapshot, type QbliveSnapshot } from '@qbsheet/qblive-protocol';
import defaultSnapshot from '@qbsheet/qblive-protocol/fixtures/snapshot-default.json';
import { nextEventForTeam } from '../src/state/derive';

function game(
  id: string,
  roundId: string,
  roundName: string,
  roundNumber: number,
  sequence: number | null,
): QbliveSnapshot['schedule'][number] {
  return {
    id,
    roundId,
    roundName,
    roundNumber,
    sequence,
    phaseId: null,
    phaseName: null,
    poolId: null,
    poolName: null,
    teamIds: ['team-a', 'team-b'],
    roomId: null,
    scheduledStart: null,
    state: 'upcoming',
  };
}

function untimedSnapshot(): QbliveSnapshot {
  const base = parseSnapshot(defaultSnapshot);
  return {
    ...base,
    timeline: [],
    schedule: [game('game-1', 'round-1', 'Round 1', 1, 0), game('game-2', 'round-2', 'Round 2', 2, 2)],
  };
}

describe('sequence-first next event', () => {
  test('an untimed team sees the first unfinished game in day order with no time', () => {
    const next = nextEventForTeam(untimedSnapshot(), 'team-a', new Date('2026-09-05T14:00:00Z'));
    expect(next?.kind).toBe('game');
    expect(next?.game?.id).toBe('game-1');
    expect(next?.scheduledStart).toBeNull();
  });

  test('day order beats round number when the director reordered the day', () => {
    const snapshot = untimedSnapshot();
    snapshot.schedule[0].sequence = 5;
    snapshot.schedule[1].sequence = 1;
    const next = nextEventForTeam(snapshot, 'team-a', new Date('2026-09-05T14:00:00Z'));
    expect(next?.game?.id).toBe('game-2');
  });
});
