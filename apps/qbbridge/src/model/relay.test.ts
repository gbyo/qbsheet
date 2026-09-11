/**
 * Retained-finals fetching.
 *
 * The one relay-facing fact pinned here is the truncation bound: it is measured on the
 * relay's row count, not the parsed finals, so a malformed row on a full page cannot
 * suppress the lower-bound warning and let teardown claim completeness it never had.
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import * as native from './native';
import { relayFetchRetainedFinals, relayUnackedWindow, type RelayConnection } from './relay';

const connection: RelayConnection = {
  baseUrl: 'https://qbtcp-relay-test.workers.dev',
  tournamentId: 'bcdfghjkmnpqrstvwxyz2345',
  managementToken: 'management-secret',
};

afterEach(() => {
  vi.restoreAllMocks();
});

function stubResults(rows: unknown[]): void {
  vi.spyOn(native, 'relayRequest').mockImplementation(async () => ({
    status: 200,
    body: JSON.stringify({ results: rows }),
  }));
}

function row(resultId: string): Record<string, unknown> {
  return {
    result_id: resultId,
    room_id: 'room-1',
    match_id: `match-${resultId}`,
    fingerprint: 'fp',
    received_at: '2026-09-10T15:00:00Z',
    qbj: {},
    director_ack_at: '2026-09-10T16:00:00Z',
  };
}

describe('retained finals', () => {
  test('a full page with a malformed row still reports truncation', async () => {
    const rows: unknown[] = Array.from({ length: relayUnackedWindow - 1 }, (_, index) => row(`r-${index}`));
    rows.push({ result_id: 42 });
    stubResults(rows);
    const { finals, truncated } = await relayFetchRetainedFinals(connection);
    expect(finals).toHaveLength(relayUnackedWindow - 1);
    expect(truncated).toBe(true);
  });

  test('a short page of clean rows reports no truncation', async () => {
    stubResults([row('a'), row('b')]);
    const { finals, truncated } = await relayFetchRetainedFinals(connection);
    expect(finals).toHaveLength(2);
    expect(truncated).toBe(false);
  });
});
