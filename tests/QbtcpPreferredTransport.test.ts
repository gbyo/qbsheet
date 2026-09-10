/**
 * The scorer's preferred-transport policy (issue #772).
 *
 * Internet relay first, LAN fallback, local last. These tests pin the pure decisions in
 * `src/qbtcp/QbtcpPreferredTransport.ts`: endpoint normalization, contract-state mapping,
 * failure classification (credential/refusal answers must never trigger LAN failover),
 * the sticky failover memory (two consecutive outages latch, coming home needs proof),
 * quota-style failures as transport failures, and stable cross-transport retry keys.
 */
import { describe, expect, test } from 'vitest';
import {
  classifyTransportFailure,
  describeTransport,
  endpointForTransport,
  initialFailoverMemory,
  isPrimaryTransport,
  isQuotaStyleFailure,
  LAN_FAILOVER_CONSECUTIVE_FAILURES,
  newFinalRetryKey,
  normalizeEndpoint,
  notePreferredPathHealed,
  notePrimaryResult,
  notePrimarySuccess,
  PRIMARY_HEALTH_CHECK_INTERVAL_MS,
  RELAY_RECEIPT_COPY,
  selectTransportPollIntervalMs,
  STANDARD_POLL_INTERVAL_MS,
  STREAM_HEALTHY_POLL_INTERVAL_MS,
  transportForContractState,
  transportStatusCopy,
  type IFailoverMemory,
} from '../src/qbtcp/QbtcpPreferredTransport';

const endpoints = { primary: 'https://relay.example.workers.dev', lan: 'http://192.168.1.24:8787' };

describe('normalizeEndpoint', () => {
  test('trims, lowercases nothing, and strips the trailing slash', () => {
    expect(normalizeEndpoint('  https://relay.example.workers.dev/  ')).toEqual({
      ok: true,
      value: 'https://relay.example.workers.dev',
    });
  });

  test('adds http when no scheme is present', () => {
    expect(normalizeEndpoint('192.168.1.24:8787')).toEqual({
      ok: true,
      value: 'http://192.168.1.24:8787',
    });
  });

  test('keeps a meaningful path', () => {
    expect(normalizeEndpoint('https://example.com/qbtcp/')).toEqual({
      ok: true,
      value: 'https://example.com/qbtcp',
    });
  });

  test('rejects blank input, queries, fragments, and non-http schemes', () => {
    expect(normalizeEndpoint('   ')).toEqual({ ok: false });
    expect(normalizeEndpoint('https://example.com/?token=abc')).toEqual({ ok: false });
    expect(normalizeEndpoint('https://example.com/#room')).toEqual({ ok: false });
    expect(normalizeEndpoint('ws://example.com/')).toEqual({ ok: false });
    expect(normalizeEndpoint('ftp://example.com/')).toEqual({ ok: false });
  });

  test('rejects bare schemes without slashes instead of prefixing them into http URLs', () => {
    // `mailto:a@b.c` must not become `http://b.c`; `localhost:3000` stays a host:port pair.
    expect(normalizeEndpoint('mailto:foo@bar.com')).toEqual({ ok: false });
    expect(normalizeEndpoint('tel:+123')).toEqual({ ok: false });
    expect(normalizeEndpoint('localhost:3000')).toEqual({ ok: true, value: 'http://localhost:3000' });
    expect(normalizeEndpoint('example.com:8080/path')).toEqual({
      ok: true,
      value: 'http://example.com:8080/path',
    });
  });
});

describe('transport mapping', () => {
  test('offline-local is local-only even with a LAN configured', () => {
    expect(transportForContractState('offline-local', endpoints, false)).toEqual({ kind: 'none' });
    expect(transportForContractState('offline-local', endpoints, true)).toEqual({ kind: 'none' });
  });

  test('a live stream is the Internet stream until the LAN takes over', () => {
    expect(transportForContractState('stream-live', endpoints, false)).toEqual({
      kind: 'internet-stream',
      endpoint: endpoints.primary,
    });
    expect(transportForContractState('stream-live', endpoints, true)).toEqual({
      kind: 'lan',
      endpoint: endpoints.lan,
    });
  });

  test('healing states keep HTTP on the serving endpoint', () => {
    expect(transportForContractState('stream-connecting', endpoints, false)).toEqual({
      kind: 'internet-http',
      endpoint: endpoints.primary,
    });
    expect(transportForContractState('stream-degraded', endpoints, true)).toEqual({
      kind: 'lan',
      endpoint: endpoints.lan,
    });
    expect(transportForContractState('http-only', endpoints, false)).toEqual({
      kind: 'internet-http',
      endpoint: endpoints.primary,
    });
  });

  test('an active LAN without an address falls back to primary HTTP, never to nothing', () => {
    expect(transportForContractState('stream-live', { primary: endpoints.primary }, true)).toEqual({
      kind: 'internet-http',
      endpoint: endpoints.primary,
    });
  });

  test('endpoint and primary helpers', () => {
    expect(endpointForTransport({ kind: 'none' })).toBeNull();
    expect(endpointForTransport({ kind: 'lan', endpoint: endpoints.lan })).toBe(endpoints.lan);
    expect(isPrimaryTransport({ kind: 'internet-stream', endpoint: endpoints.primary })).toBe(true);
    expect(isPrimaryTransport({ kind: 'internet-http', endpoint: endpoints.primary })).toBe(true);
    expect(isPrimaryTransport({ kind: 'lan', endpoint: endpoints.lan })).toBe(false);
    expect(isPrimaryTransport({ kind: 'none' })).toBe(false);
  });

  test('only the healthy stream relaxes the poll cadence', () => {
    expect(selectTransportPollIntervalMs({ kind: 'internet-stream', endpoint: endpoints.primary })).toBe(
      STREAM_HEALTHY_POLL_INTERVAL_MS,
    );
    for (const transport of [
      { kind: 'internet-http', endpoint: endpoints.primary },
      { kind: 'lan', endpoint: endpoints.lan },
      { kind: 'none' },
    ] as const) {
      expect(selectTransportPollIntervalMs(transport)).toBe(STANDARD_POLL_INTERVAL_MS);
    }
  });
});

describe('scorer-facing words', () => {
  test('healthy paths do not teach topology; degraded paths say what to do', () => {
    expect(transportStatusCopy({ kind: 'internet-stream', endpoint: endpoints.primary })).toBe(
      'Connected to tournament control',
    );
    expect(transportStatusCopy({ kind: 'lan', endpoint: endpoints.lan })).toBe(
      'Connected over the local network',
    );
    expect(transportStatusCopy({ kind: 'none' })).toMatch(/keep scoring/i);
  });

  test('diagnostics name the path but never a credential', () => {
    expect(describeTransport({ kind: 'internet-stream', endpoint: endpoints.primary })).toContain(
      'internet relay stream',
    );
    expect(describeTransport({ kind: 'none' })).toBe('this device only');
    expect(RELAY_RECEIPT_COPY).toMatch(/pick it up/i);
    expect(RELAY_RECEIPT_COPY).not.toMatch(/accept/i);
  });
});

describe('failure classification', () => {
  test('quota-style bodies are transport failures, never refusals', () => {
    expect(isQuotaStyleFailure('Error 1027: daily limit exceeded')).toBe(true);
    expect(isQuotaStyleFailure('storage-unavailable, retryable')).toBe(true);
    expect(isQuotaStyleFailure('over the account limit')).toBe(true);
    expect(isQuotaStyleFailure('Internal Server Error')).toBe(false);
    expect(isQuotaStyleFailure(undefined)).toBe(false);
  });

  test('success classifies to null', () => {
    expect(classifyTransportFailure({ ok: true, value: null })).toBeNull();
  });

  test('a missing status is an outage', () => {
    expect(classifyTransportFailure({ ok: false, error: 'timeout' })).toBe('transport-unavailable');
  });

  test('credential and refusal answers never trigger failover', () => {
    expect(classifyTransportFailure({ ok: false, error: 'no', status: 401 })).toBe('credential');
    expect(classifyTransportFailure({ ok: false, error: 'no', status: 403 })).toBe('refused');
    expect(classifyTransportFailure({ ok: false, error: 'no', status: 409 })).toBe('refused');
  });

  test('retryable statuses are outages; anything else refused is a refusal', () => {
    for (const status of [408, 429, 500, 503]) {
      expect(classifyTransportFailure({ ok: false, error: 'x', status })).toBe('transport-unavailable');
    }
    expect(classifyTransportFailure({ ok: false, error: 'x', status: 404 })).toBe('refused');
  });

  test('a quota body on a retryable status still classifies as an outage', () => {
    expect(
      classifyTransportFailure({ ok: false, error: 'limited', status: 429, detail: 'quota exceeded' }),
    ).toBe('transport-unavailable');
  });
});

describe('failover memory', () => {
  test('two consecutive outages latch the LAN; one does not', () => {
    expect(LAN_FAILOVER_CONSECUTIVE_FAILURES).toBe(2);
    let memory: IFailoverMemory = initialFailoverMemory;
    memory = notePrimaryResult(memory, 'transport-unavailable', true);
    expect(memory.lanActive).toBe(false);
    memory = notePrimaryResult(memory, 'transport-unavailable', true);
    expect(memory.lanActive).toBe(true);
    expect(memory.consecutivePrimaryFailures).toBe(2);
  });

  test('no LAN address means no latch, however long the outage', () => {
    let memory: IFailoverMemory = initialFailoverMemory;
    for (let i = 0; i < 5; i += 1) {
      memory = notePrimaryResult(memory, 'transport-unavailable', false);
    }
    expect(memory.lanActive).toBe(false);
    expect(memory.consecutivePrimaryFailures).toBe(5);
  });

  test('credential and refusal answers leave memory untouched', () => {
    const before: IFailoverMemory = { consecutivePrimaryFailures: 1, lanActive: false };
    expect(notePrimaryResult(before, 'credential', true)).toBe(before);
    expect(notePrimaryResult(before, 'refused', true)).toBe(before);
    expect(notePrimaryResult(before, null, true)).toBe(before);
  });

  test('success clears the counter but never unlatches the LAN by itself', () => {
    const latched: IFailoverMemory = { consecutivePrimaryFailures: 2, lanActive: true };
    const cleared = notePrimarySuccess(latched);
    expect(cleared.consecutivePrimaryFailures).toBe(0);
    expect(cleared.lanActive).toBe(true);
    expect(notePrimarySuccess(initialFailoverMemory)).toBe(initialFailoverMemory);
  });

  test('coming home requires the healed record, which resets everything', () => {
    const latched: IFailoverMemory = { consecutivePrimaryFailures: 0, lanActive: true };
    expect(notePreferredPathHealed(latched)).toEqual({ consecutivePrimaryFailures: 0, lanActive: false });
    expect(notePreferredPathHealed(initialFailoverMemory)).toBe(initialFailoverMemory);
  });

  test('the health-check cadence is a minute', () => {
    expect(PRIMARY_HEALTH_CHECK_INTERVAL_MS).toBe(60_000);
  });
});

describe('final retry keys', () => {
  test('keys are namespaced, hex, and unique per final', () => {
    const first = newFinalRetryKey();
    const second = newFinalRetryKey();
    expect(first).toMatch(/^retry-[0-9a-f]{32}$/);
    expect(second).not.toBe(first);
  });
});
