import { ScoreEvent } from '../src/scoring/ScoreEvents';

/**
 * Distributive, so each member of the union keeps its own fields. A bare `Omit<ScoreEvent, 'id'>`
 * collapses the union to the properties they all share, which rejects every real event.
 */
export type EventInput<T = ScoreEvent> = T extends ScoreEvent ? Omit<T, 'id'> : never;

let nextId = 0;

/** Give every scorer fixture an id from one shared sequence. */
export function event(partial: EventInput): ScoreEvent {
  nextId += 1;
  return { ...partial, id: `e${nextId}` } as ScoreEvent;
}
