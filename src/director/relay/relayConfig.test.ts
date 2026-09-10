import { describe, expect, it } from 'vitest';
import {
  isRelayTournamentId,
  isWorkersDevOrigin,
  normalizeRelayBaseUrl,
  relayFailureBudgetWarning,
  relayOwnershipExplainer,
  relayQbliveRecommendation,
} from './relayConfig';

describe('relay origin validation', () => {
  it('accepts a workers.dev origin with no custom domain required', () => {
    const result = normalizeRelayBaseUrl('https://qbtcp-relay-abc.xyz123.workers.dev');
    expect(result).toEqual({ ok: true, value: 'https://qbtcp-relay-abc.xyz123.workers.dev' });
    if (result.ok) expect(isWorkersDevOrigin(result.value)).toBe(true);
  });

  it('trims whitespace and trailing slashes', () => {
    expect(normalizeRelayBaseUrl('  https://example.workers.dev///  ')).toEqual({
      ok: true,
      value: 'https://example.workers.dev',
    });
  });

  it('rejects plain http', () => {
    const result = normalizeRelayBaseUrl('http://192.168.1.24:8787');
    expect(result.ok).toBe(false);
  });

  it('rejects origins with paths, queries, fragments, or credentials', () => {
    for (const bad of [
      'https://example.workers.dev/qbtcp/v1',
      'https://example.workers.dev?tournament=abc',
      'https://example.workers.dev#setup',
      'https://user:pass@example.workers.dev',
    ]) {
      expect(normalizeRelayBaseUrl(bad).ok).toBe(false);
    }
  });

  it('accepts a custom domain as an explicitly marked advanced setting', () => {
    const result = normalizeRelayBaseUrl('https://relay.example-tournament.org');
    expect(result).toEqual({ ok: true, value: 'https://relay.example-tournament.org' });
    if (result.ok) expect(isWorkersDevOrigin(result.value)).toBe(false);
  });
});

describe('relay tournament ids', () => {
  it('accepts the 24-character bounded alphabet and rejects the rest', () => {
    expect(isRelayTournamentId('bcdfghjkmnpqrstvwxyz1234')).toBe(true);
    for (const bad of [
      '',
      'short',
      'AAAA',
      'aeiouAEIOU1234567890123',
      'bcdfghjkmnpqrstvwxyz12345',
      '../etc',
    ]) {
      expect(isRelayTournamentId(bad)).toBe(false);
    }
  });
});

describe('product copy', () => {
  it('names the tournament — not QBSheet — as the relay operator', () => {
    expect(relayOwnershipExplainer).toMatch(/controlled by the tournament/i);
    // The forbidden phrases ("QBSheet Cloud", "QBSheet servers", …) may only appear negated.
    expect(relayOwnershipExplainer).not.toMatch(/QBSheet Cloud/i);
    expect(relayOwnershipExplainer).toMatch(/not on QBSheet servers/i);
    expect(relayOwnershipExplainer).toMatch(/no QBSheet account/i);
  });

  it('makes the account-level failure budget explicit and recommends self-hosted QBLive', () => {
    expect(relayFailureBudgetWarning).toMatch(/same Workers Free request budget/i);
    expect(relayFailureBudgetWarning).toMatch(/self-hosted QBServer for QBLive/i);
    expect(relayQbliveRecommendation).toMatch(/self-hosted QBServer/i);
    // A dedicated account is guidance, not a mathematical claim.
    expect(relayFailureBudgetWarning).not.toMatch(/mathematically required|must use a dedicated/i);
  });
});
