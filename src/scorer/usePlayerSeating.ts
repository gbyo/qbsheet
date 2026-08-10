/**
 * React lifecycle around the seating preference.
 *
 * Read once per game, written whenever it changes, and never read by anything that scores. See
 * `PlayerSeating` for why it is kept out of the event history.
 */
import { useCallback, useMemo, useState } from 'react';
import { LeftOrRight } from '../scoring/types';
import {
  applyOrder,
  emptySeating,
  loadSeating,
  moveWithin,
  orderBySeating,
  PlayerSeating,
  saveSeating,
  takeSeat,
} from './PlayerSeating';

export interface IPlayerSeatingApi {
  seating: PlayerSeating;
  /** Sort any list of players into the room's preferred order. */
  order: <T>(side: LeftOrRight, items: readonly T[], nameOf: (item: T) => string) => T[];
  /** Move one player up or down among the ones currently visible on that side. */
  move: (
    side: LeftOrRight,
    rosterNames: readonly string[],
    visibleNames: readonly string[],
    name: string,
    direction: -1 | 1,
  ) => void;
  /** Set the visible seat order for one or both teams in a single view-only update. */
  arrange: (rosterNames: PlayerSeating, visibleOrders: Partial<PlayerSeating>) => void;
  /** Seat the incoming player where the outgoing one was. */
  substitute: (side: LeftOrRight, rosterNames: readonly string[], outgoing: string, incoming: string) => void;
}

export default function usePlayerSeating(gameKey: string): IPlayerSeatingApi {
  const [seating, setSeating] = useState<PlayerSeating>(() => (gameKey === '' ? emptySeating() : loadSeating(gameKey)));

  const commit = useCallback(
    (next: PlayerSeating) => {
      setSeating(next);
      saveSeating(gameKey, next);
    },
    [gameKey],
  );

  const order = useCallback(
    <T>(side: LeftOrRight, items: readonly T[], nameOf: (item: T) => string) =>
      orderBySeating(items, seating[side], nameOf),
    [seating],
  );

  const move = useCallback(
    (
      side: LeftOrRight,
      rosterNames: readonly string[],
      visibleNames: readonly string[],
      name: string,
      direction: -1 | 1,
    ) => {
      const reordered = moveWithin(visibleNames, name, direction);
      commit({ ...seating, [side]: applyOrder(seating[side], rosterNames, reordered) });
    },
    [commit, seating],
  );

  const arrange = useCallback(
    (rosterNames: PlayerSeating, visibleOrders: Partial<PlayerSeating>) => {
      const next = { ...seating };
      for (const side of ['left', 'right'] as LeftOrRight[]) {
        const visible = visibleOrders[side];
        if (visible) next[side] = applyOrder(seating[side], rosterNames[side], visible);
      }
      commit(next);
    },
    [commit, seating],
  );

  const substitute = useCallback(
    (side: LeftOrRight, rosterNames: readonly string[], outgoing: string, incoming: string) => {
      commit({ ...seating, [side]: takeSeat(seating[side], rosterNames, outgoing, incoming) });
    },
    [commit, seating],
  );

  return useMemo(
    () => ({ seating, order, move, arrange, substitute }),
    [seating, order, move, arrange, substitute],
  );
}
