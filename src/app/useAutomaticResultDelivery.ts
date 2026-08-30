/**
 * Unattended delivery for completed results that tournament control has not received yet.
 *
 * The outbox already exists: the frozen result and delivery ledger are in GameStore, while the
 * private session capability is in ResultDeliveryCapabilityStore. This hook adds no third record.
 * It only decides when the existing ResultDeliveryService should try the same idempotent send again.
 */
import { useEffect } from 'react';
import { IStoredGameRecord } from '../game/GameStore';
import { ResultDeliveryService } from './ResultDelivery';

export const automaticResultRetryDelaysMs = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000] as const;

/** Delay after the attempt already recorded in the ledger. */
export function automaticResultRetryDelayMs(attemptCount: number): number {
  const attempt = Number.isInteger(attemptCount) && attemptCount > 0 ? attemptCount : 1;
  return automaticResultRetryDelaysMs[Math.min(attempt - 1, automaticResultRetryDelaysMs.length - 1)];
}

/** Epoch time at which this pending record may next be tried. Zero means immediately. */
export function automaticResultRetryAt(record: IStoredGameRecord): number {
  const attemptedAt = new Date(record.serverDeliveryLedger?.lastAttemptedAt ?? '').getTime();
  if (!Number.isFinite(attemptedAt)) return 0;
  return attemptedAt + automaticResultRetryDelayMs(record.serverDeliveryLedger?.attemptCount ?? 0);
}

function completionTime(record: IStoredGameRecord): number {
  const completed = new Date(record.completedAt ?? '').getTime();
  return Number.isFinite(completed) ? completed : Number.MAX_SAFE_INTEGER;
}

export interface IAutomaticResultDeliveryInput {
  records: IStoredGameRecord[];
  service: ResultDeliveryService | null;
  onAttemptFinished: () => void | Promise<void>;
}

/**
 * Keep retryable pending finals moving while the application is open.
 *
 * One timer and one attempt at a time. Manual retries share the service's in-flight de-duplication,
 * and every wake-up rechecks the persisted due time before it can make a request.
 */
export default function useAutomaticResultDelivery(input: IAutomaticResultDeliveryInput): void {
  const { records, service, onAttemptFinished } = input;

  useEffect(() => {
    if (!service) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const eligible = () => records.filter((record) => service.canAutoRetry(record));

    const run = async () => {
      timer = undefined;
      const now = Date.now();
      const due = eligible()
        .filter((record) => automaticResultRetryAt(record) <= now)
        .sort(
          (first, second) =>
            completionTime(first) - completionTime(second) || first.id.localeCompare(second.id),
        );
      if (due.length === 0) {
        schedule();
        return;
      }
      await service.retry(due[0].id);
      if (!stopped) await onAttemptFinished();
      // Refreshing the records reruns this effect with the attempt just persisted. Scheduling from
      // this closure would use the stale ledger and could immediately repeat the same request.
    };

    const schedule = () => {
      if (stopped) return;
      if (timer !== undefined) clearTimeout(timer);
      const candidates = eligible();
      if (candidates.length === 0) {
        timer = undefined;
        return;
      }
      const nextAt = Math.min(...candidates.map(automaticResultRetryAt));
      timer = setTimeout(() => void run(), Math.max(0, nextAt - Date.now()));
    };

    const wake = () => schedule();
    schedule();
    window.addEventListener('online', wake);
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', wake);

    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener('online', wake);
      window.removeEventListener('focus', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [records, service, onAttemptFinished]);
}
