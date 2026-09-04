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

  /*
   * Lunch sits between two rounds, and the day order has to say so.
   *
   * A sequenced timeline event used to be dropped from this fallback altogether, so a team that
   * had finished Round 2 was told Round 3 was next and walked past lunch. The Swift client pins
   * the same behaviour against the same fixture in `QBLiveFixtureTests.untimedEventUsesPublishedSequence`.
   */
  function withLunchBetweenRounds(): QbliveSnapshot {
    const snapshot = untimedSnapshot();
    snapshot.schedule = [
      game('game-before', 'round-before', 'Round 2', 2, 1),
      game('game-after', 'round-after', 'Round 3', 3, 3),
    ];
    snapshot.timeline = [
      {
        id: 'event-between',
        type: 'lunch',
        title: 'Lunch',
        description: null,
        sequence: 2,
        scheduledStart: null,
        scheduledEnd: null,
        teamIds: ['team-a'],
        roomId: null,
        location: null,
      },
    ];
    return snapshot;
  }

  test('an unfinished earlier round still comes before a sequenced event', () => {
    const next = nextEventForTeam(withLunchBetweenRounds(), 'team-a', new Date('2026-09-05T14:00:00Z'));
    expect(next?.kind).toBe('game');
    expect(next?.game?.id).toBe('game-before');
  });

  test('once that round is played the sequenced event is next, not the later round', () => {
    const snapshot = withLunchBetweenRounds();
    snapshot.schedule[0].state = 'final';
    const next = nextEventForTeam(snapshot, 'team-a', new Date('2026-09-05T14:00:00Z'));
    expect(next?.kind).toBe('event');
    expect(next?.event?.id).toBe('event-between');
  });

  test('a legacy event with no sequence stays out of the untimed fallback', () => {
    const snapshot = withLunchBetweenRounds();
    snapshot.schedule[0].state = 'final';
    snapshot.timeline[0].sequence = null;
    const next = nextEventForTeam(snapshot, 'team-a', new Date('2026-09-05T14:00:00Z'));
    expect(next?.game?.id).toBe('game-after');
  });
});
