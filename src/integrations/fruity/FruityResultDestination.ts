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
import FruityServerClient from './FruityServerClient';
import { ApiResult, IResultReceipt, ISessionCredentials } from './ServerTypes';

/** At most one progress update per this interval, carrying whatever the latest state is. */
export const progressIntervalMs = 5000;

export interface IFinalDelivery {
  /** Never `none`: this path is only for a connected completed result. */
  delivery: 'sent' | 'pending' | 'rejected';
  /** Safe-to-display server, client, or network explanation. */
  detail?: string;
  /** Control already had this exact statistical result. This is successful delivery. */
  duplicate?: boolean;
  /** The server retained the result but left its canonical import for review. */
  reviewRequired?: boolean;
  /** Stable discrepancy identifiers returned with a review receipt. */
  warningCodes?: string[];
  matchId?: string;
  fingerprint?: string;
  /** True only when a request was made to the result endpoint. */
  attempted: boolean;
  /** Whether another explicit attempt with the same private capability can be meaningful. */
  retryable: boolean;
  /** True when discovery refused the operation before making a request. */
  unsupported?: boolean;
  status?: number;
}

const acceptedFallback = 'Tournament control accepted the result.';
const rejectedFallback = 'Tournament control did not accept this result.';

function failureDetail(result: { error: string; detail?: string }): string {
  return result.detail ?? result.error;
}

/**
 * Translate the normalized API result into the operational meaning a record can keep.
 *
 * The order is intentional: `received` is the durable receipt boundary. A result can be retained
 * for review while `accepted` remains false for old clients that interpreted that field as
 * "canonical". It is still a successful delivery from the room's point of view, and must not be
 * retried or presented as lost.
 */
export function classifyFinalDelivery(result: ApiResult<IResultReceipt>): IFinalDelivery {
  if (result.ok) {
    const receipt = result.value;
    const received = receipt.received === true || receipt.duplicate === true || receipt.accepted === true;
    if (received) {
      const reviewRequired = receipt.reviewRequired === true;
      return {
        delivery: 'sent',
        detail: receipt.duplicate
          ? 'Tournament control already had this result on record.'
          : reviewRequired
            ? 'Tournament control received the result; a director must review it.'
            : acceptedFallback,
        duplicate: receipt.duplicate,
        ...(reviewRequired ? { reviewRequired } : {}),
        ...(receipt.warningCodes && receipt.warningCodes.length > 0
          ? { warningCodes: receipt.warningCodes }
          : {}),
        ...(receipt.matchId !== undefined ? { matchId: receipt.matchId } : {}),
        ...(receipt.fingerprint !== undefined ? { fingerprint: receipt.fingerprint } : {}),
        attempted: true,
        retryable: false,
      };
    }
    return {
      delivery: 'rejected',
      detail: rejectedFallback,
      ...(receipt.matchId !== undefined ? { matchId: receipt.matchId } : {}),
      ...(receipt.fingerprint !== undefined ? { fingerprint: receipt.fingerprint } : {}),
      attempted: true,
      retryable: false,
    };
  }

  const detail = failureDetail(result);
  if (result.unsupported) {
    return { delivery: 'rejected', detail, attempted: false, retryable: false, unsupported: true };
  }
  if (result.status === undefined) {
    return { delivery: 'pending', detail, attempted: true, retryable: true };
  }
  // A server-side failure is not a person's rejection. Keep the result retryable without an
  // automatic loop; Recent Games offers the explicit action after reload.
  if (result.status === 408 || result.status === 429 || (result.status >= 500 && result.status <= 599)) {
    return { delivery: 'pending', detail, attempted: true, retryable: true, status: result.status };
  }
  // These are still useful manual retries after a person fixes the condition. They are never
  // retried in the background and retain the runtime's 403 / writer-conflict semantics.
  if (result.status === 403 || result.status === 409) {
    return { delivery: 'rejected', detail, attempted: true, retryable: true, status: result.status };
  }
  // All remaining HTTP failures are explicit client or protocol refusals. A 401 invalidates the
  // stored session capability, so retrying it from Recent Games cannot repair the pairing.
  return { delivery: 'rejected', detail, attempted: true, retryable: false, status: result.status };
}

/** Send one frozen result through the normalized QBTCP result boundary. */
export async function deliverFinalResult(
  client: FruityServerClient,
  credentials: ISessionCredentials,
  frozenQbj: object,
  onResponse?: (result: ApiResult<IResultReceipt>) => void,
): Promise<IFinalDelivery> {
  try {
    const result = await client.postFinal(credentials, frozenQbj);
    onResponse?.(result);
    return classifyFinalDelivery(result);
  } catch {
    // The production client resolves failures as values. This guard keeps the completed result
    // safe if a test double or a future adapter violates that boundary.
    return {
      delivery: 'pending',
      detail: 'Could not reach tournament control.',
      attempted: true,
      retryable: true,
    };
  }
}

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
