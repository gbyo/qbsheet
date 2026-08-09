/**
 * Where a game comes from, and where its result goes.
 *
 * Two small interfaces, and they exist for one reason: so that neither the scoring engine nor the
 * scoresheet ever learns whether there is a network. A `GameSource` produces a frozen
 * `IGamePackage` and then has no further part in the game; a `ResultDestination` is handed a
 * finished result and reports what became of it. Between the two sits an ordinary local game that
 * would behave identically if every server in the building fell over — which is the property the
 * whole application is built to have.
 *
 * Deliberately not a plugin framework. There are two sources and two destinations, they are both in
 * this repository, and a registry with lifecycle hooks would be architecture for its own sake. The
 * only thing being prevented here is `fetch` appearing inside a component that scores a tossup.
 */
import { IGamePackage } from './GamePackage';

export type GameSourceResult =
  | { ok: true; value: IGamePackage }
  | { ok: false; errors: string[] };

export interface IGameSource {
  /** For the connection detail and for logs. Never shown as a brand. */
  readonly kind: 'file' | 'tournament-control';
  load(): Promise<GameSourceResult>;
}

/** What became of one attempt to deliver a result. */
export type DeliveryOutcome =
  | { state: 'sent'; detail?: string }
  /** Reached control and was refused. Not retried; somebody has to look at it. */
  | { state: 'rejected'; detail: string }
  /** Did not reach anybody. Retried in the background; never blocks the room. */
  | { state: 'unreachable'; detail: string };

export interface IResultDestination {
  readonly kind: 'download' | 'tournament-control';
  /**
   * Deliver a finished result.
   *
   * Called only after the result is durably recorded locally. A destination is never the reason a
   * game is safe, and its failure is never the reason a room is stopped.
   */
  deliver(qbj: object, packageValue: IGamePackage): Promise<DeliveryOutcome>;
}
