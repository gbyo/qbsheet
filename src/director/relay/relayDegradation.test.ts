import { describe, expect, it } from 'vitest';
import { describeRelayDegradation, describeResultDelivery } from './relayDegradation';

const PROVIDER_JARGON = /worker|durable object|\bdo\b|1027|cursor|cloudflare|http \d|wss?/i;

describe('degradation language', () => {
  it('keeps every scorekeeper string transport- and provider-neutral', () => {
    const copies = [
      describeRelayDegradation({ kind: 'sync', retryable: true, lanAvailable: true, localDurable: true }),
      describeRelayDegradation({ kind: 'sync', retryable: true, lanAvailable: false, localDurable: true }),
      describeRelayDegradation({ kind: 'sync', retryable: false, lanAvailable: false, localDurable: true }),
      describeRelayDegradation({
        kind: 'result-send',
        retryable: true,
        lanAvailable: true,
        localDurable: false,
      }),
      describeRelayDegradation({
        kind: 'result-send',
        retryable: true,
        lanAvailable: false,
        localDurable: true,
      }),
      describeRelayDegradation({
        kind: 'result-send',
        retryable: false,
        lanAvailable: false,
        localDurable: true,
      }),
      describeResultDelivery(true),
      describeResultDelivery(false),
    ];
    for (const copy of copies) {
      expect(copy.title).not.toMatch(PROVIDER_JARGON);
      expect(copy.detail).not.toMatch(PROVIDER_JARGON);
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.detail.length).toBeGreaterThan(0);
    }
  });

  it('collapses relay, internet, and LAN loss into local / reconnecting / saved-local', () => {
    expect(
      describeRelayDegradation({ kind: 'sync', retryable: true, lanAvailable: true, localDurable: true })
        .state,
    ).toBe('local');
    expect(
      describeRelayDegradation({ kind: 'sync', retryable: true, lanAvailable: false, localDurable: true })
        .state,
    ).toBe('reconnecting');
    expect(
      describeRelayDegradation({ kind: 'sync', retryable: false, lanAvailable: false, localDurable: true })
        .state,
    ).toBe('unavailable');
  });

  it('treats a quota failure as transport failure: keep scoring, game saved here', () => {
    const copy = describeRelayDegradation({
      kind: 'result-send',
      retryable: true,
      lanAvailable: false,
      localDurable: true,
    });
    expect(copy.state).toBe('saved-local');
    expect(copy.title).toContain('saved on this device');
  });

  it('confirms durable receipt distinctly from saved-local', () => {
    expect(describeResultDelivery(true).state).toBe('received');
    expect(describeResultDelivery(false).state).toBe('saved-local');
  });
});
