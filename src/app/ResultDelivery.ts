/**
 * The one boundary for a completed result travelling to tournament control.
 *
 * The scorer and Recent Games have different jobs, but neither is allowed to invent its own
 * submission semantics. Both use the normalizer below, and both persist through the same bounded
 * ledger updater. The retry service additionally owns the private device-only capability store.
 */
import FruityServerClient from '../integrations/fruity/FruityServerClient';
import { ApiResult, IResultReceipt, ISessionCredentials } from '../integrations/fruity/ServerTypes';
import {
  GameStore,
  IServerDeliveryLedger,
  IStoredGameRecord,
  ServerDeliveryLedgerOutcome,
} from '../game/GameStore';
import {
  IResultDeliveryCapability,
  ResultDeliveryCapabilityStore,
} from './ResultDeliveryCapability';

export interface IFinalDelivery {
  /** Never `none`: this path is only for a connected completed result. */
  delivery: Exclude<IStoredGameRecord['serverDelivery'], 'none'>;
  /** Safe-to-display server, client, or network explanation. */
  detail?: string;
  /** Control already had this exact statistical result. This is successful delivery. */
  duplicate?: boolean;
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
 * The order is intentional: a duplicate receipt is a successful receipt even if a server happens
 * to omit or contradict its `accepted` flag. A successful response with `accepted: false` is not
 * success, and a 5xx is not a permanent human rejection.
 */
export function classifyFinalDelivery(result: ApiResult<IResultReceipt>): IFinalDelivery {
  if (result.ok) {
    const receipt = result.value;
    if (receipt.duplicate === true || receipt.accepted === true) {
      return {
        delivery: 'sent',
        detail: receipt.duplicate ? 'Tournament control already had this result on record.' : acceptedFallback,
        duplicate: receipt.duplicate,
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
  if (result.status >= 500 && result.status <= 599) {
    return { delivery: 'pending', detail, attempted: true, retryable: true, status: result.status };
  }
  // These are still useful manual retries after a person fixes the condition. They are never
  // retried in the background and retain the runtime's 403 / writer-conflict semantics.
  if (result.status === 403 || result.status === 409) {
    return { delivery: 'rejected', detail, attempted: true, retryable: true, status: result.status };
  }
  // A 401 invalidates the stored session capability; retrying it from Recent Games cannot repair
  // the pairing, so it is deliberately not offered there.
  return { delivery: 'rejected', detail, attempted: true, retryable: false, status: result.status };
}

/** Run one frozen result through the shared client/classification boundary. */
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

function nowIso(now: Date): string {
  return Number.isFinite(now.getTime()) ? now.toISOString() : new Date().toISOString();
}

function validAttemptCount(value: number | undefined): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

function ledgerOutcome(delivery: IFinalDelivery): ServerDeliveryLedgerOutcome {
  if (delivery.unsupported) return 'unsupported';
  if (delivery.delivery === 'sent') return 'accepted';
  return delivery.delivery;
}

/**
 * Persist one normalized delivery outcome without touching the frozen result fields.
 *
 * The store serializes writes per record. The terminal accepted state is also monotonic here, so a
 * delayed pending response or a backwards-moving wall clock cannot undo a receipt already recorded.
 */
export async function recordFinalDelivery(
  store: GameStore,
  recordId: string,
  delivery: IFinalDelivery,
  now: Date = new Date(),
): Promise<IStoredGameRecord | null> {
  const existing = await store.get(recordId);
  if (!existing || existing.completedAt === undefined || existing.finalQbj === undefined) return existing;
  if (existing.serverDelivery === 'sent' && delivery.delivery !== 'sent') return existing;

  const at = nowIso(now);
  const previous = existing.serverDeliveryLedger;
  const previousAttempts = validAttemptCount(previous?.attemptCount);
  const attemptCount = previousAttempts + (delivery.attempted ? 1 : 0);
  const accepted = delivery.delivery === 'sent';
  const nextLedger: IServerDeliveryLedger = {
    attemptCount,
    ...(previous?.firstAttemptedAt !== undefined
      ? { firstAttemptedAt: previous.firstAttemptedAt }
      : delivery.attempted
        ? { firstAttemptedAt: at }
        : {}),
    ...(delivery.attempted ? { lastAttemptedAt: at } : previous?.lastAttemptedAt ? { lastAttemptedAt: previous.lastAttemptedAt } : {}),
    ...(accepted
      ? {
          acceptedAt: previous?.acceptedAt ?? at,
          acceptedOnAttempt: previous?.acceptedOnAttempt ?? attemptCount,
        }
      : previous?.acceptedAt
        ? {
            acceptedAt: previous.acceptedAt,
            ...(previous.acceptedOnAttempt !== undefined ? { acceptedOnAttempt: previous.acceptedOnAttempt } : {}),
          }
        : {}),
    ...(accepted
      ? { acceptedAsDuplicate: delivery.duplicate === true || previous?.acceptedAsDuplicate === true }
      : previous?.acceptedAsDuplicate !== undefined
        ? { acceptedAsDuplicate: previous.acceptedAsDuplicate }
        : {}),
    ...(delivery.matchId !== undefined ? { matchId: delivery.matchId } : previous?.matchId ? { matchId: previous.matchId } : {}),
    ...(delivery.fingerprint !== undefined
      ? { fingerprint: delivery.fingerprint }
      : previous?.fingerprint
        ? { fingerprint: previous.fingerprint }
        : {}),
    ...(accepted
      ? {}
      : { lastFailureDetail: delivery.detail ?? previous?.lastFailureDetail ?? rejectedFallback }),
    retryable: delivery.retryable,
    outcome: ledgerOutcome(delivery),
  };

  const updated = await store.update(recordId, {
    serverDelivery: delivery.delivery,
    serverDeliveryDetail: accepted ? (delivery.duplicate ? delivery.detail : undefined) : delivery.detail,
    serverDeliveryLedger: nextLedger,
  });
  return updated;
}

/** Shared high-level retry operation used by Recent Games. */
export class ResultDeliveryService {
  private pending = new Map<string, Promise<IFinalDelivery | null>>();

  constructor(
    private store: GameStore,
    private capabilities: ResultDeliveryCapabilityStore,
    private makeClient: (baseUrl: string) => FruityServerClient = (baseUrl) => new FruityServerClient(baseUrl),
  ) {}

  remember(recordId: string, capability: IResultDeliveryCapability, completedAt: string): boolean {
    return this.capabilities.remember(recordId, capability, completedAt);
  }

  canRetry(record: IStoredGameRecord): boolean {
    if (
      !record.connected ||
      record.completedAt === undefined ||
      record.finalQbj === undefined ||
      record.serverDelivery === 'sent' ||
      record.serverDelivery === 'none'
    ) {
      return false;
    }
    if (record.serverDeliveryLedger?.retryable === false) return false;
    return this.capabilities.has(record.id);
  }

  async recordOutcome(recordId: string, delivery: IFinalDelivery, now: Date = new Date()): Promise<IStoredGameRecord | null> {
    const updated = await recordFinalDelivery(this.store, recordId, delivery, now);
    if (delivery.delivery === 'sent' || !delivery.retryable || delivery.unsupported) this.capabilities.remove(recordId);
    return updated;
  }

  async retry(recordId: string, now: Date = new Date()): Promise<IFinalDelivery | null> {
    const previous = this.pending.get(recordId);
    if (previous) return previous;
    const operation = this.performRetry(recordId, now).finally(() => {
      if (this.pending.get(recordId) === operation) this.pending.delete(recordId);
    });
    this.pending.set(recordId, operation);
    return operation;
  }

  private async performRetry(recordId: string, now: Date): Promise<IFinalDelivery | null> {
    const record = await this.store.get(recordId);
    if (!record || !this.canRetry(record)) return null;
    const capability = this.capabilities.get(recordId);
    if (!capability || !record.finalQbj) return null;
    const delivery = await deliverFinalResult(
      this.makeClient(capability.baseUrl),
      { sessionId: capability.sessionId, token: capability.sessionToken },
      record.finalQbj,
    );
    await this.recordOutcome(recordId, delivery, now);
    return delivery;
  }
}
