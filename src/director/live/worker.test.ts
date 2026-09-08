import { describe, expect, test } from 'vitest';
import { emptyLivePublication, type LivePublication } from '../domain';
import { recoverStaleInFlight, staleInFlightMs } from './worker';

const publicationId = 'bcdfghjkmnpqrstvwxyz';
const now = new Date('2026-09-08T10:00:00.000Z');

function publicationWithAttempt(lastAttemptAt: string): LivePublication {
  const publication = emptyLivePublication(publicationId, now.toISOString());
  publication.lifecycle = 'live';
  publication.settings.enabled = true;
  publication.outbox = [
    {
      id: 'snapshot-1',
      revision: 1,
      kind: 'snapshot',
      payload: { snapshot: {} },
      state: 'in-flight',
      attempts: 1,
      createdAt: now.toISOString(),
      lastAttemptAt,
      nextAttemptAt: now.toISOString(),
    },
  ];
  publication.sync.pendingItems = 1;
  return publication;
}

describe('recoverStaleInFlight', () => {
  test('recovers an in-flight publish stranded by a backward clock correction', () => {
    const lastAttemptAt = new Date(now.getTime() + staleInFlightMs * 2).toISOString();
    const publication = publicationWithAttempt(lastAttemptAt);

    const recovered = recoverStaleInFlight(publication, now);

    expect(recovered).not.toBe(publication);
    expect(recovered.outbox[0]).toMatchObject({
      state: 'failed',
      nextAttemptAt: now.toISOString(),
      lastError: 'Publish was interrupted before it could finish.',
    });
  });

  test('tolerates small future clock skew for a recent attempt', () => {
    const lastAttemptAt = new Date(now.getTime() + 5_000).toISOString();
    const publication = publicationWithAttempt(lastAttemptAt);

    const recovered = recoverStaleInFlight(publication, now);

    expect(recovered).toBe(publication);
    expect(recovered.outbox[0].state).toBe('in-flight');
  });
});
