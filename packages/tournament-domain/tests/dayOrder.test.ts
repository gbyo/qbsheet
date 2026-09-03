/**
 * The tournament-day sequence.
 *
 * Rounds 1-5, Lunch, Rounds 6-9 with no clock times anywhere must still be a
 * definite order that survives reloads, archives, and Live projection. These
 * tests pin the invariants: explicit order wins, missing values sort last,
 * duplicates and gaps densify deterministically, legacy data keeps the order
 * Director already displayed, and reorder inputs can never lose an item.
 */

import { describe, expect, test } from 'vitest';
import {
  compareDayOrder,
  legacyDayOrder,
  nextDayOrder,
  normalizeDayOrder,
  orderDayItems,
  type DayOrdered,
} from '../src/dayOrder.js';

function round(id: string, dayOrder?: number | null, number = 1): DayOrdered & { number: number } {
  return { id, dayOrder, number };
}

function event(id: string, dayOrder?: number | null): DayOrdered {
  return { id, dayOrder };
}

describe('compareDayOrder', () => {
  test('explicit order beats missing order; ties break stably by id', () => {
    expect(compareDayOrder({ id: 'b', dayOrder: 5 }, { id: 'a' })).toBeLessThan(0);
    expect(compareDayOrder({ id: 'b' }, { id: 'a', dayOrder: 5 })).toBeGreaterThan(0);
    expect(compareDayOrder({ id: 'a', dayOrder: 2 }, { id: 'b', dayOrder: 2 })).toBeLessThan(0);
    expect(compareDayOrder({ id: 'a', dayOrder: NaN }, { id: 'b' })).not.toBe(0);
  });
});

describe('orderDayItems', () => {
  test('merges rounds and events by day order, unordered items last', () => {
    const items = orderDayItems(
      [
        {
          id: 'r1',
          phaseId: 'p',
          name: 'Round 1',
          number: 1,
          revision: 1,
          status: 'planned',
          packetId: null,
          scheduledGameIds: [],
          dayOrder: 0,
          scheduledStart: null,
          releasedAt: null,
          startedAt: null,
          closedAt: null,
        },
        {
          id: 'r2',
          phaseId: 'p',
          name: 'Round 2',
          number: 2,
          revision: 1,
          status: 'planned',
          packetId: null,
          scheduledGameIds: [],
          scheduledStart: null,
          releasedAt: null,
          startedAt: null,
          closedAt: null,
        },
      ],
      [
        {
          id: 'lunch',
          type: 'lunch',
          title: 'Lunch',
          visibility: 'public',
          dayOrder: 1,
          createdAt: '',
          updatedAt: '',
        },
      ],
    );
    expect(items.map((item) => item.id)).toEqual(['r1', 'lunch', 'r2']);
  });
});

describe('normalizeDayOrder', () => {
  test('densifies duplicates and gaps deterministically', () => {
    const { rounds, timeline } = normalizeDayOrder(
      [round('r1', 7), round('r2', 7), round('r3', 1)],
      [event('lunch', 3)],
    );
    expect(rounds.map((entry) => entry.dayOrder)).toEqual([2, 3, 0]);
    expect(timeline.map((entry) => entry.dayOrder)).toEqual([1]);
  });

  test('explicit reorder input wins; unknown ids keep relative order at the end', () => {
    const { rounds, timeline } = normalizeDayOrder(
      [round('r1', 0), round('r2', 1), round('r3', 2)],
      [event('lunch', 3)],
      ['lunch', 'r2'],
    );
    const byId = new Map([...rounds, ...timeline].map((entry) => [entry.id, entry.dayOrder]));
    expect(byId.get('lunch')).toBe(0);
    expect(byId.get('r2')).toBe(1);
    expect(byId.get('r1')).toBe(2);
    expect(byId.get('r3')).toBe(3);
  });

  test('stale reorder input cannot drop an item', () => {
    const { rounds } = normalizeDayOrder([round('r1', 0), round('r2', 1)], [], ['r2']);
    expect(rounds.map((entry) => entry.id)).toEqual(['r1', 'r2']);
    expect(rounds.map((entry) => entry.dayOrder)).toEqual([1, 0]);
  });

  test('already-dense orders come back unchanged', () => {
    const before = [round('r1', 0), round('r2', 1)];
    const { rounds } = normalizeDayOrder(before, []);
    expect(rounds[0]).toBe(before[0]);
    expect(rounds[1]).toBe(before[1]);
  });
});

describe('nextDayOrder', () => {
  test('appends after the highest explicit order', () => {
    expect(nextDayOrder([round('r1', 0), round('r2', 4)], [event('lunch', 2)])).toBe(5);
    expect(nextDayOrder([], [])).toBe(0);
  });
});

describe('legacyDayOrder', () => {
  test('preserves the order Director displayed: times, then round numbers, then ids', () => {
    const { rounds, timeline } = legacyDayOrder(
      [
        { ...round('r2', undefined, 2), scheduledStart: null },
        { ...round('r1', undefined, 1), scheduledStart: null },
      ],
      [{ ...event('lunch'), scheduledStart: null, title: 'Lunch' }],
    );
    const byId = new Map([...rounds, ...timeline].map((entry) => [entry.id, entry.dayOrder]));
    // Round-vs-round falls to round number. Untimed round-vs-event puts the
    // rounds first: id order would strand 'lunch' above Round 1, which no
    // director arranged.
    expect(byId.get('r1')).toBe(0);
    expect(byId.get('r2')).toBe(1);
    expect(byId.get('lunch')).toBe(2);
  });

  test('a timed lunch between two timed rounds keeps its displayed position', () => {
    const { rounds, timeline } = legacyDayOrder(
      [
        { ...round('r5', undefined, 5), scheduledStart: '2026-01-10T14:00:00Z' },
        { ...round('r6', undefined, 6), scheduledStart: '2026-01-10T15:00:00Z' },
      ],
      [{ ...event('lunch'), scheduledStart: '2026-01-10T14:30:00Z', title: 'Lunch' }],
    );
    const ordered = [...rounds, ...timeline].sort((a, b) => (a.dayOrder ?? 0) - (b.dayOrder ?? 0));
    expect(ordered.map((entry) => entry.id)).toEqual(['r5', 'lunch', 'r6']);
  });
});
