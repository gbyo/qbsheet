/**
 * The tournament-day sequence.
 *
 * # Why explicit order exists
 *
 * A tournament day is a sequence — Round 1 through Round 5, Lunch, Round 6
 * through Round 9 — and most tournaments run it with no clock times at all.
 * Ordering rounds and non-game timeline events by optional timestamps cannot
 * represent that day: untimed items have no key to sort by, and generated IDs
 * or array positions are accidents of persistence, not director intent.
 *
 * So every round and every timeline event carries an explicit `dayOrder`.
 * The merged day list sorts by it; timestamps only break ties for legacy data
 * during migration. New items append at the end, reorder operations assign a
 * dense sequence in one commit (undo-safe because the commit is one state
 * transition like any other), and normalization repairs duplicates and gaps
 * deterministically on every load.
 */

import type { DirectorId } from './model.js';
import type { Round } from './model.js';
import type { TournamentTimelineEvent } from './timeline.js';

/** Anything that takes part in the tournament-day sequence. */
export interface DayOrdered {
  id: DirectorId;
  dayOrder?: number | null;
}

/** Loose input shape for untrusted records (migrations, interchange). */
export interface DayOrderInput {
  id?: unknown;
  dayOrder?: unknown;
  scheduledStart?: unknown;
  number?: unknown;
}

function inputKey(item: DayOrderInput): string {
  return typeof item.id === 'string' ? item.id : '';
}

function inputDayOrder(item: DayOrderInput): number | null {
  return typeof item.dayOrder === 'number' && Number.isFinite(item.dayOrder)
    ? item.dayOrder
    : null;
}

function inputTimestamp(item: DayOrderInput): string | null {
  return typeof item.scheduledStart === 'string' && item.scheduledStart.length > 0
    ? item.scheduledStart
    : null;
}

function inputNumber(item: DayOrderInput): number {
  return typeof item.number === 'number' && Number.isFinite(item.number) ? item.number : 0;
}

export type DayItemKind = 'round' | 'event';

export interface OrderedDayItem {
  kind: DayItemKind;
  id: DirectorId;
  dayOrder: number;
  round?: Round;
  event?: TournamentTimelineEvent;
}

function effectiveDayOrder(item: DayOrdered): number {
  return typeof item.dayOrder === 'number' && Number.isFinite(item.dayOrder)
    ? item.dayOrder
    : Number.MAX_SAFE_INTEGER;
}

function finiteDayOrderOrNull(item: DayOrdered): number | null {
  return typeof item.dayOrder === 'number' && Number.isFinite(item.dayOrder) ? item.dayOrder : null;
}

/**
 * Order two day items: explicit sequence first, stable id tiebreak so loads
 * never flap. Never consults timestamps, ids-as-time, or array position.
 */
export function compareDayOrder(left: DayOrdered, right: DayOrdered): number {
  return (
    effectiveDayOrder(left) - effectiveDayOrder(right) || left.id.localeCompare(right.id)
  );
}

/**
 * Merge rounds and timeline events into the canonical tournament-day list.
 * Items without an explicit order sort after ordered ones, stably by id.
 */
export function orderDayItems(
  rounds: readonly Round[],
  timeline: readonly TournamentTimelineEvent[],
): OrderedDayItem[] {
  const items: OrderedDayItem[] = [
    ...rounds.map((round) => ({
      kind: 'round' as const,
      id: round.id,
      dayOrder: finiteDayOrderOrNull(round) ?? Number.MAX_SAFE_INTEGER,
      round,
    })),
    ...timeline.map((event) => ({
      kind: 'event' as const,
      id: event.id,
      dayOrder: finiteDayOrderOrNull(event) ?? Number.MAX_SAFE_INTEGER,
      event,
    })),
  ];
  items.sort(
    (left, right) => left.dayOrder - right.dayOrder || left.id.localeCompare(right.id),
  );
  return items;
}

/** One past the highest explicit day order, for appending new items. */
export function nextDayOrder(
  rounds: readonly DayOrdered[],
  timeline: readonly DayOrdered[],
): number {
  let maximum = -1;
  for (const item of [...rounds, ...timeline]) {
    const order = finiteDayOrderOrNull(item);
    if (order !== null && order > maximum) maximum = order;
  }
  return maximum + 1;
}

/**
 * Assign a dense 0-based day sequence following `orderedIds`. Ids absent from
 * the list keep their current relative order at the end, so a stale caller
 * can never drop an item out of the day. Idempotent and safe to run on load:
 * already-dense orders come back unchanged.
 */
export function normalizeDayOrder<R extends DayOrdered, E extends DayOrdered>(
  rounds: readonly R[],
  timeline: readonly E[],
  orderedIds?: readonly DirectorId[],
): { rounds: R[]; timeline: E[] } {
  const byId = new Map<DirectorId, R | E>();
  for (const item of [...rounds, ...timeline]) {
    if (!byId.has(item.id)) byId.set(item.id, item);
  }
  const sequence: Array<R | E> = [];
  if (orderedIds) {
    for (const id of orderedIds) {
      const item = byId.get(id);
      if (item && !sequence.includes(item)) {
        sequence.push(item);
        byId.delete(id);
      }
    }
  }
  const remainder = [...byId.values()].sort(compareDayOrder);
  sequence.push(...remainder);
  const orderOf = new Map<DirectorId, number>();
  sequence.forEach((item, index) => {
    if (!orderOf.has(item.id)) orderOf.set(item.id, index);
  });
  const assignR = (item: R): R =>
    item.dayOrder === orderOf.get(item.id) ? item : { ...item, dayOrder: orderOf.get(item.id) };
  const assignE = (item: E): E =>
    item.dayOrder === orderOf.get(item.id) ? item : { ...item, dayOrder: orderOf.get(item.id) };
  return { rounds: rounds.map(assignR), timeline: timeline.map(assignE) };
}

function compareOptionalTimestamp(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left < right ? -1 : 1;
}

/**
 * Deterministic day order for tournaments created before explicit sequencing.
 *
 * Replicates the order Director displayed prior to dayOrder: timed items by
 * start time, untimed rounds by round number, everything else stably by id.
 * The result preserves what the director currently sees, so migration never
 * rearranges a tournament day on its own.
 */
export function legacyDayOrder<R extends DayOrderInput, E extends DayOrderInput>(
  rounds: readonly R[],
  timeline: readonly E[],
): { rounds: R[]; timeline: E[] } {
  const merged: Array<{ kind: DayItemKind; item: DayOrderInput }> = [
    ...rounds.map((item) => ({ kind: 'round' as const, item })),
    ...timeline.map((item) => ({ kind: 'event' as const, item })),
  ];
  merged.sort((left, right) => {
    const leftTime = inputTimestamp(left.item);
    const rightTime = inputTimestamp(right.item);
    const time = compareOptionalTimestamp(leftTime, rightTime);
    if (time !== 0) return time;
    if (left.kind === 'round' && right.kind === 'round') {
      const spread = inputNumber(left.item) - inputNumber(right.item);
      if (spread !== 0) return spread;
    }
    if (left.kind !== right.kind) {
      // Timed ties keep the displayed id order, but an untimed event must not
      // land above untimed rounds on an id accident like 'lunch' < 'round-1'.
      if (leftTime === null && rightTime === null) return left.kind === 'round' ? -1 : 1;
    }
    return inputKey(left.item).localeCompare(inputKey(right.item));
  });
  return normalizeDayOrder(
    rounds.map((item) => ({ ...item, id: inputKey(item), dayOrder: inputDayOrder(item) })),
    timeline.map((item) => ({ ...item, id: inputKey(item), dayOrder: inputDayOrder(item) })),
    merged.map((entry) => inputKey(entry.item)),
  );
}
