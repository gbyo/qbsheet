/**
 * Sending things to tournament control, always after the room already has them.
 *
 * # Order, and why it is never the other way round
 *
 * Every operation here runs *after* the scoresheet has updated and after the local write has been
 * accepted. Nothing a scorekeeper does waits on a request. A room that is one tossup behind because
 * a laptop across the building is busy is a room that falls further behind on every question, and
 * the questions are being read whether or not the network agrees.
 *
 * # Coalescing rather than streaming
 *
 * Control wants to know how the game is going, not every click that got it there. Sending each
 * event would be dozens of requests a game whose only purpose is to reconstruct a state we already
 * have in one object. So progress is a trailing update: the latest complete payload, at most once
 * per interval, and a burst of activity collapses into one send carrying the newest state rather
 * than a queue of stale ones. Falling behind is therefore self-correcting — the thing that gets
 * dropped is always the older picture.
 *
 * # Retry, and what is never retried automatically
 *
 * The completed-result boundary records a network failure as pending so Recent Games can offer one
 * explicit retry later. This destination is a single-attempt adapter for callers that still use the
 * older `IResultDestination` vocabulary; it does not own a background loop. A submission that
 * reached control and was *refused* is not retried automatically, because a refusal is a person's
 * decision and repeating the request will not change it. The distinction is the difference between
 * a network problem and a tournament problem, and conflating them is how a room ends up hammering a
 * server that has already told it no.
 */
import { DeliveryOutcome, IResultDestination } from '../../game/GameSource';
import { IGamePackage } from '../../game/GamePackage';
import { deliverFinalResult } from '../../app/ResultDelivery';
import FruityServerClient, { ISessionCredentials } from './FruityServerClient';

/** At most one progress update per this interval, carrying whatever the latest state is. */
export const progressIntervalMs = 5000;

export class FruityResultDestination implements IResultDestination {
  readonly kind = 'tournament-control';

  constructor(
    private client: FruityServerClient,
    private credentials: ISessionCredentials,
  ) {}

  async deliver(qbj: object): Promise<DeliveryOutcome> {
    const result = await deliverFinalResult(this.client, this.credentials, qbj);
    if (result.delivery === 'sent') return { state: 'sent' };
    if (result.delivery === 'pending') {
      return { state: 'unreachable', detail: result.detail ?? 'Could not reach tournament control.' };
    }
    return { state: 'rejected', detail: result.detail ?? 'Tournament control did not accept this result.' };
  }
}

/**
 * A trailing, coalesced sender for live progress.
 *
 * `offer` is safe to call on every render. It records the newest payload and schedules at most one
 * send; anything offered while a send is in flight replaces what will go next rather than queueing
 * behind it.
 */
export class ProgressSender {
  private latest: object | null = null;

  private timer: ReturnType<typeof setTimeout> | null = null;

  private sending = false;

  private stopped = false;

  constructor(
    private send: (qbj: object) => Promise<unknown>,
    private intervalMs: number = progressIntervalMs,
  ) {}

  offer(qbj: object): void {
    if (this.stopped) return;
    this.latest = qbj;
    if (this.timer !== null || this.sending) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.intervalMs);
  }

  private async flush(): Promise<void> {
    if (this.stopped || this.sending) return;
    const payload = this.latest;
    if (payload === null) return;
    this.latest = null;
    this.sending = true;
    try {
      await this.send(payload);
    } catch {
      // A progress update that did not arrive is not worth reporting and not worth retrying: the
      // next one carries a newer picture of the same game.
    } finally {
      this.sending = false;
      // Something arrived while that was in flight. Schedule it rather than sending immediately, so
      // the interval still means what it says.
      if (this.latest !== null && !this.stopped && this.timer === null) {
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.flush();
        }, this.intervalMs);
      }
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.latest = null;
  }
}

/** A destination that only ever writes a file. Used for a game with no tournament control. */
export class DownloadOnlyDestination implements IResultDestination {
  readonly kind = 'download';

  constructor(private write: (qbj: object, packageValue: IGamePackage) => boolean) {}

  async deliver(qbj: object, packageValue: IGamePackage): Promise<DeliveryOutcome> {
    const written = this.write(qbj, packageValue);
    return written
      ? { state: 'sent' }
      : { state: 'unreachable', detail: 'This browser would not save the file.' };
  }
}
