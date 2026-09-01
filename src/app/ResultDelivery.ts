/**
 * The one boundary for a completed result travelling to tournament control.
 *
 * The scorer and Recent Games have different jobs, but neither is allowed to invent its own
 * submission semantics. Both use the normalizer below, and both persist through the same bounded
 * ledger updater. The retry service additionally owns the private device-only capability store.
 */
import FruityServerClient from '../integrations/fruity/FruityServerClient';
import { deliverFinalResult } from '../integrations/fruity/FruityResultDestination';
import type { IFinalDelivery } from '../integrations/fruity/FruityResultDestination';
import {
  GameStore,
  IServerDeliveryLedger,
  IStoredGameRecord,
  ServerDeliveryLedgerOutcome,
} from '../game/GameStore';
import { IResultDeliveryCapability, ResultDeliveryCapabilityStore } from './ResultDeliveryCapability';

const rejectedDeliveryFallback = 'Tournament control did not accept this result.';

function nowIso(now: Date): string {
  return Number.isFinite(now.getTime()) ? now.toISOString() : new Date().toISOString();
}

function latestTimestamp(...values: Array<string | undefined>): string | undefined {
  let latest: { value: string; time: number } | undefined;
  for (const value of values) {
    if (value === undefined) continue;
    const time = new Date(value).getTime();
    if (!Number.isFinite(time) || (latest !== undefined && time <= latest.time)) continue;
    latest = { value, time };
  }
  return latest?.value;
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
  const acceptedAt = accepted
    ? (latestTimestamp(previous?.acceptedAt, previous?.lastAttemptedAt, at) ?? at)
    : undefined;
  const nextLedger: IServerDeliveryLedger = {
    attemptCount,
    ...(previous?.firstAttemptedAt !== undefined
      ? { firstAttemptedAt: previous.firstAttemptedAt }
      : delivery.attempted
        ? { firstAttemptedAt: at }
        : {}),
    ...(delivery.attempted
      ? { lastAttemptedAt: at }
      : previous?.lastAttemptedAt
        ? { lastAttemptedAt: previous.lastAttemptedAt }
        : {}),
    ...(accepted
      ? {
          acceptedAt,
          acceptedOnAttempt: previous?.acceptedOnAttempt ?? attemptCount,
        }
      : previous?.acceptedAt
        ? {
            acceptedAt: previous.acceptedAt,
            ...(previous.acceptedOnAttempt !== undefined
              ? { acceptedOnAttempt: previous.acceptedOnAttempt }
              : {}),
          }
        : {}),
    ...(accepted
      ? { acceptedAsDuplicate: delivery.duplicate === true || previous?.acceptedAsDuplicate === true }
      : previous?.acceptedAsDuplicate !== undefined
        ? { acceptedAsDuplicate: previous.acceptedAsDuplicate }
        : {}),
    ...(delivery.matchId !== undefined
      ? { matchId: delivery.matchId }
      : previous?.matchId
        ? { matchId: previous.matchId }
        : {}),
    ...(delivery.fingerprint !== undefined
      ? { fingerprint: delivery.fingerprint }
      : previous?.fingerprint
        ? { fingerprint: previous.fingerprint }
        : {}),
    ...(delivery.reviewRequired !== undefined
      ? { reviewRequired: delivery.reviewRequired }
      : previous?.reviewRequired !== undefined
        ? { reviewRequired: previous.reviewRequired }
        : {}),
    ...(delivery.warningCodes && delivery.warningCodes.length > 0
      ? { warningCodes: delivery.warningCodes.slice(0, 32) }
      : previous?.warningCodes
        ? { warningCodes: previous.warningCodes }
        : {}),
    ...(accepted
      ? {}
      : { lastFailureDetail: delivery.detail ?? previous?.lastFailureDetail ?? rejectedDeliveryFallback }),
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
    private makeClient: (baseUrl: string) => FruityServerClient = (baseUrl) =>
      new FruityServerClient(baseUrl),
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

  /** Network/server pending outcomes are safe to retry unattended; refusals remain a person's job. */
  canAutoRetry(record: IStoredGameRecord): boolean {
    return (
      record.serverDelivery === 'pending' &&
      record.serverDeliveryLedger?.retryable === true &&
      this.canRetry(record)
    );
  }

  async recordOutcome(
    recordId: string,
    delivery: IFinalDelivery,
    now: Date = new Date(),
  ): Promise<IStoredGameRecord | null> {
    const updated = await recordFinalDelivery(this.store, recordId, delivery, now);
    if (delivery.delivery === 'sent' || !delivery.retryable || delivery.unsupported)
      this.capabilities.remove(recordId);
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
