import { describe, expect, test, vi } from 'vitest';
import { completedGameRetentionMs, GameStore, IStoredGameRecord, memoryGameStore } from '../src/game/GameStore';
import {
  ResultDeliveryService,
} from '../src/app/ResultDelivery';
import {
  IResultDeliveryCapabilityStorage,
  ResultDeliveryCapabilityStore,
} from '../src/app/ResultDeliveryCapability';
import FruityServerClient from '../src/integrations/fruity/FruityServerClient';
import { classifyFinalDelivery } from '../src/integrations/fruity/FruityResultDestination';
import { validPackage } from './packages';
import { buildDiagnostics, findLeaks } from '../src/app/Diagnostics';

class MemoryStorage implements IResultDeliveryCapabilityStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

class RefusingStorage extends MemoryStorage {
  override setItem(): void {
    throw new Error('QuotaExceededError');
  }
}

function fakeClient(postFinal: (...args: never[]) => Promise<unknown>): FruityServerClient {
  return { postFinal } as unknown as FruityServerClient;
}

async function completedStore(): Promise<{ store: GameStore; record: IStoredGameRecord }> {
  const store = memoryGameStore();
  const created = await store.create({
    package: validPackage(),
    setup: { left: { name: 'A', players: [] }, right: { name: 'B', players: [] } },
    connected: true,
    now: new Date('2026-08-11T14:00:00.000Z'),
  });
  const record = await store.update(created.id, {
    completedAt: '2026-08-11T14:00:00.000Z',
    finalQbj: { tossups_read: 20, match_teams: [{ points: 100 }, { points: 90 }] },
    finalScore: { left: 100, right: 90 },
  });
  if (!record) throw new Error('test record did not persist');
  return { store, record };
}

/**
 * The clock the capability store is judged against.
 *
 * Capabilities expire `completedGameRetentionMs` -- seven days -- after the game completed, and every
 * fixture below completes at `2026-08-11T14:00Z`. Left on the real clock, these tests passed for a
 * week after they were written and then began failing everywhere at once, because `has()` correctly
 * reported every capability as expired. The store has always accepted an injected clock; the tests
 * simply were not using it. Anchoring it to the same era as the fixtures is what makes them a test of
 * the ledger rather than of what day it is.
 */
const capabilityClock = () => new Date('2026-08-11T14:05:00.000Z');

const accepted = (extra: Record<string, unknown> = {}) => ({
  ok: true as const,
  value: { accepted: true, duplicate: false, ...extra },
});

describe('normalizing completed-result delivery', () => {
  test('accepted false is a rejection even when HTTP succeeded', () => {
    expect(
      classifyFinalDelivery({ ok: true, value: { accepted: false, duplicate: false } }),
    ).toMatchObject({ delivery: 'rejected', attempted: true, retryable: false });
  });

  test('duplicate receipt is successful delivery', () => {
    expect(
      classifyFinalDelivery({
        ok: true,
        value: { accepted: false, duplicate: true, matchId: 'sm-4471', fingerprint: 'fp-1' },
      }),
    ).toMatchObject({
      delivery: 'sent',
      duplicate: true,
      matchId: 'sm-4471',
      fingerprint: 'fp-1',
      attempted: true,
    });
  });

  test('network failure and retryable 5xx remain pending', () => {
    expect(classifyFinalDelivery({ ok: false, error: 'Could not reach tournament control.' })).toMatchObject({
      delivery: 'pending',
      attempted: true,
      retryable: true,
    });
    expect(
      classifyFinalDelivery({ ok: false, status: 503, error: 'Tournament control is restarting.' }),
    ).toMatchObject({ delivery: 'pending', status: 503, attempted: true, retryable: true });
  });

  test('explicit refusals preserve their distinct manual-retry meanings', () => {
    expect(classifyFinalDelivery({ ok: false, status: 401, error: 'Session expired.' })).toMatchObject({
      delivery: 'rejected',
      retryable: false,
    });
    expect(classifyFinalDelivery({ ok: false, status: 403, error: 'Origin is not approved.' })).toMatchObject({
      delivery: 'rejected',
      retryable: true,
    });
    expect(classifyFinalDelivery({ ok: false, status: 409, error: 'Another device is scoring.' })).toMatchObject({
      delivery: 'rejected',
      retryable: true,
    });
    expect(classifyFinalDelivery({ ok: false, status: 408, error: 'The request timed out.' })).toMatchObject({
      delivery: 'pending',
      retryable: true,
    });
    expect(classifyFinalDelivery({ ok: false, status: 429, error: 'Too many requests.' })).toMatchObject({
      delivery: 'pending',
      retryable: true,
    });
    expect(classifyFinalDelivery({ ok: false, status: 400, error: 'Malformed result.' })).toMatchObject({
      delivery: 'rejected',
      retryable: false,
    });
    expect(
      classifyFinalDelivery({
        ok: false,
        unsupported: true,
        error: 'Tournament control does not offer result on this connection.',
      }),
    ).toMatchObject({ delivery: 'rejected', unsupported: true, attempted: false, retryable: false });
  });
});

describe('bounded result-delivery ledger and private retry capability', () => {
  const capability = {
    baseUrl: 'http://control.test',
    sessionId: 'session-1',
    sessionToken: 'session-secret',
  };

  test('persists attempts, timestamps, receipt ids, and duplicate acceptance', async () => {
    const { store, record } = await completedStore();
    const storage = new MemoryStorage();
    const capabilities = new ResultDeliveryCapabilityStore(storage, capabilityClock);
    capabilities.remember(record.id, capability, record.completedAt!);
    const responses = [
      { ok: false as const, error: 'Could not reach tournament control.' },
      accepted({ duplicate: true, matchId: 'sm-4471', fingerprint: 'fp-4471' }),
    ];
    const postFinal = vi.fn(async () => responses.shift()!);
    const service = new ResultDeliveryService(store, capabilities, () => fakeClient(postFinal));

    await service.retry(record.id, new Date('2026-08-11T14:01:00.000Z'));
    const pending = await store.get(record.id);
    expect(pending?.serverDelivery).toBe('pending');
    expect(pending?.serverDeliveryLedger).toMatchObject({
      attemptCount: 1,
      firstAttemptedAt: '2026-08-11T14:01:00.000Z',
      lastAttemptedAt: '2026-08-11T14:01:00.000Z',
      retryable: true,
      outcome: 'pending',
    });

    const beforeRetry = pending?.finalQbj;
    await service.retry(record.id, new Date('2026-08-11T14:02:00.000Z'));
    const acceptedRecord = await store.get(record.id);
    expect(acceptedRecord?.serverDelivery).toBe('sent');
    expect(acceptedRecord?.serverDeliveryLedger).toMatchObject({
      attemptCount: 2,
      firstAttemptedAt: '2026-08-11T14:01:00.000Z',
      lastAttemptedAt: '2026-08-11T14:02:00.000Z',
      acceptedAt: '2026-08-11T14:02:00.000Z',
      acceptedOnAttempt: 2,
      acceptedAsDuplicate: true,
      matchId: 'sm-4471',
      fingerprint: 'fp-4471',
      outcome: 'accepted',
      retryable: false,
    });
    expect(acceptedRecord?.finalQbj).toEqual(beforeRetry);
    expect(acceptedRecord?.finalScore).toEqual(record.finalScore);
    expect(acceptedRecord?.events).toEqual(record.events);
    expect(capabilities.has(record.id)).toBe(false);
    expect(postFinal).toHaveBeenCalledTimes(2);
  });

  test('only retryable pending records qualify for unattended delivery', async () => {
    const { store, record } = await completedStore();
    const capabilities = new ResultDeliveryCapabilityStore(new MemoryStorage(), capabilityClock);
    capabilities.remember(record.id, capability, record.completedAt!);
    const service = new ResultDeliveryService(store, capabilities, () => fakeClient(vi.fn(async () => accepted())));
    const pending = await store.update(record.id, {
      serverDelivery: 'pending',
      serverDeliveryLedger: { attemptCount: 1, retryable: true, outcome: 'pending' },
    });
    expect(service.canAutoRetry(pending!)).toBe(true);
    expect(service.canAutoRetry({ ...pending!, connected: false })).toBe(false);
    expect(service.canAutoRetry({ ...pending!, finalQbj: undefined })).toBe(false);
    expect(
      service.canAutoRetry({
        ...pending!,
        serverDeliveryLedger: { attemptCount: 1, retryable: false, outcome: 'pending' },
      }),
    ).toBe(false);
    const withoutCapability = new ResultDeliveryService(
      store,
      new ResultDeliveryCapabilityStore(new MemoryStorage(), capabilityClock),
    );
    expect(withoutCapability.canAutoRetry(pending!)).toBe(false);

    const rejected = await store.update(record.id, {
      serverDelivery: 'rejected',
      serverDeliveryLedger: { attemptCount: 1, retryable: true, outcome: 'rejected' },
    });
    expect(service.canRetry(rejected!)).toBe(true);
    expect(service.canAutoRetry(rejected!)).toBe(false);
  });

  test('manual and automatic retries share one in-flight delivery', async () => {
    const { store, record } = await completedStore();
    const capabilities = new ResultDeliveryCapabilityStore(new MemoryStorage(), capabilityClock);
    capabilities.remember(record.id, capability, record.completedAt!);
    let release: ((value: ReturnType<typeof accepted>) => void) | undefined;
    const response = new Promise<ReturnType<typeof accepted>>((resolve) => {
      release = resolve;
    });
    const postFinal = vi.fn(() => response);
    const service = new ResultDeliveryService(store, capabilities, () => fakeClient(postFinal));

    const automatic = service.retry(record.id);
    const manual = service.retry(record.id);
    await vi.waitFor(() => expect(postFinal).toHaveBeenCalledOnce());

    release?.(accepted());
    await Promise.all([automatic, manual]);
    expect((await store.get(record.id))?.serverDelivery).toBe('sent');
    expect((await store.get(record.id))?.serverDeliveryLedger?.attemptCount).toBe(1);
  });

  test('first-send acceptance is recorded as one attempt and does not mark the QBJ as downloaded', async () => {
    const { store, record } = await completedStore();
    const storage = new MemoryStorage();
    const capabilities = new ResultDeliveryCapabilityStore(storage, capabilityClock);
    capabilities.remember(record.id, capability, record.completedAt!);
    const service = new ResultDeliveryService(
      store,
      capabilities,
      () => fakeClient(vi.fn(async () => accepted({ matchId: 'sm-4471', fingerprint: 'fp-1' }))),
    );

    const result = await service.retry(record.id, new Date('2026-08-11T14:01:00.000Z'));
    expect(result?.delivery).toBe('sent');
    const updated = await store.get(record.id);
    expect(updated?.serverDeliveryLedger).toMatchObject({
      attemptCount: 1,
      acceptedOnAttempt: 1,
      acceptedAsDuplicate: false,
      matchId: 'sm-4471',
      fingerprint: 'fp-1',
    });
    expect(updated?.qbjDownloadedAt).toBeUndefined();
    expect(capabilities.has(record.id)).toBe(false);
  });

  test('a fresh service can retry after reload, and room movement does not replace the old capability', async () => {
    const first = await completedStore();
    const second = await completedStore();
    const storage = new MemoryStorage();
    const capabilities = new ResultDeliveryCapabilityStore(storage, capabilityClock);
    capabilities.remember(first.record.id, capability, first.record.completedAt!);
    const serviceAfterReload = new ResultDeliveryService(
      first.store,
      new ResultDeliveryCapabilityStore(storage, capabilityClock),
      () => fakeClient(vi.fn(async () => accepted({ matchId: 'sm-4471' }))),
    );

    // The active room may now have a different game, but the old record id still has its own
    // private session capability.
    capabilities.remember(second.record.id, { ...capability, sessionId: 'session-2' }, second.record.completedAt!);
    expect(capabilities.has(first.record.id)).toBe(true);
    expect(capabilities.has(second.record.id)).toBe(true);
    await serviceAfterReload.retry(first.record.id);
    expect((await first.store.get(first.record.id))?.serverDelivery).toBe('sent');
  });

  test('expired and pruned capabilities are removed without changing the game record', async () => {
    const { record } = await completedStore();
    const storage = new MemoryStorage();
    const initial = new Date('2026-08-11T14:00:00.000Z');
    let now = new Date(initial);
    const capabilities = new ResultDeliveryCapabilityStore(storage, () => now);
    capabilities.remember(record.id, capability, record.completedAt!);
    expect(capabilities.has(record.id)).toBe(true);
    now = new Date(initial.getTime() + completedGameRetentionMs + 1);
    capabilities.prune(new Set([record.id]));
    expect(capabilities.has(record.id)).toBe(false);

    capabilities.remember(record.id, capability, record.completedAt!);
    capabilities.prune(new Set());
    expect(capabilities.has(record.id)).toBe(false);
  });

  test('a backward clock cannot regress accepted state or lower the attempt count', async () => {
    const { store, record } = await completedStore();
    const storage = new MemoryStorage();
    const capabilities = new ResultDeliveryCapabilityStore(storage, capabilityClock);
    capabilities.remember(record.id, capability, record.completedAt!);
    const postFinal = vi
      .fn()
      .mockResolvedValueOnce({ ok: false as const, error: 'Could not reach tournament control.' })
      .mockResolvedValueOnce(accepted({ duplicate: true }));
    const service = new ResultDeliveryService(store, capabilities, () => fakeClient(postFinal));

    await service.retry(record.id, new Date('2026-08-11T14:05:00.000Z'));
    await service.retry(record.id, new Date('2026-08-11T13:05:00.000Z'));
    const updated = await store.get(record.id);
    expect(updated?.serverDelivery).toBe('sent');
    expect(updated?.serverDeliveryLedger?.attemptCount).toBe(2);
    expect(updated?.serverDeliveryLedger?.firstAttemptedAt).toBe('2026-08-11T14:05:00.000Z');
    expect(updated?.serverDeliveryLedger?.acceptedAt).toBe('2026-08-11T14:05:00.000Z');
    expect(service.canRetry(updated!)).toBe(false);
    expect(postFinal).toHaveBeenCalledTimes(2);
  });

  test('unsupported delivery does not create an attempt or leave a pointless retry', async () => {
    const { store, record } = await completedStore();
    const storage = new MemoryStorage();
    const capabilities = new ResultDeliveryCapabilityStore(storage, capabilityClock);
    capabilities.remember(record.id, capability, record.completedAt!);
    const service = new ResultDeliveryService(
      store,
      capabilities,
      () =>
        fakeClient(
          vi.fn(async () => ({
            ok: false as const,
            unsupported: true,
            error: 'Tournament control does not offer result on this connection.',
          })),
        ),
    );

    const result = await service.retry(record.id);
    expect(result?.unsupported).toBe(true);
    const updated = await store.get(record.id);
    expect(updated?.serverDeliveryLedger).toMatchObject({ attemptCount: 0, outcome: 'unsupported', retryable: false });
    expect(capabilities.has(record.id)).toBe(false);
  });

  test('credentials stay out of the stored record and its frozen QBJ', async () => {
    const { store, record } = await completedStore();
    const storage = new MemoryStorage();
    const capabilities = new ResultDeliveryCapabilityStore(storage, capabilityClock);
    capabilities.remember(record.id, capability, record.completedAt!);
    const service = new ResultDeliveryService(store, capabilities, () => fakeClient(vi.fn(async () => accepted())));
    await service.retry(record.id);
    const serialized = JSON.stringify(await store.get(record.id));
    expect(serialized).not.toContain(capability.sessionToken);
    expect(serialized).not.toContain(capability.sessionId);
    expect(JSON.stringify(record.finalQbj)).not.toContain(capability.sessionToken);
    expect(findLeaks(buildDiagnostics({ now: new Date('2026-08-11T14:00:00.000Z') }), [capability.sessionToken])).toEqual([]);
  });

  test('a refused private-capability write does not make the completed result unsafe', async () => {
    const { store, record } = await completedStore();
    const capabilities = new ResultDeliveryCapabilityStore(new RefusingStorage(), capabilityClock);
    expect(capabilities.remember(record.id, capability, record.completedAt!)).toBe(false);
    expect((await store.get(record.id))?.finalQbj).toEqual(record.finalQbj);
  });
});
