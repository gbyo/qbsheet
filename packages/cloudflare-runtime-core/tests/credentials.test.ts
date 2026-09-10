import { describe, expect, it } from 'vitest';
import { isSha256Hex, randomToken, sha256Hex, timingSafeEqual } from '../src/credentials';

describe('credentials', () => {
  it('mints unique high-entropy tokens', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => randomToken()));
    expect(tokens.size).toBe(100);
    for (const token of tokens) {
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('hashes the SHA-256 test vector', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('compares in constant shape: equal, unequal, and malformed', () => {
    expect(timingSafeEqual('a'.repeat(64), 'a'.repeat(64))).toBe(true);
    expect(timingSafeEqual('a'.repeat(64), 'b'.repeat(64))).toBe(false);
    expect(timingSafeEqual('a'.repeat(64), 'short')).toBe(false);
    expect(isSha256Hex('a'.repeat(64))).toBe(true);
    expect(isSha256Hex('xyz')).toBe(false);
    expect(isSha256Hex(null)).toBe(false);
  });
});

describe('credential stores stay separate', () => {
  it('same-shaped tokens from one service never resolve in another', async () => {
    // Models the real boundary: two Durable Objects, two tables, no shared rows. The
    // stores below are Maps the way each service's hash table is a namespace.
    const storeFor = () => {
      const hashes = new Map<string, string>();
      return {
        async issue(): Promise<string> {
          const token = randomToken();
          hashes.set(await sha256Hex(token), 'owner');
          return token;
        },
        async accepts(presented: string): Promise<boolean> {
          for (const [hash] of hashes) {
            if (timingSafeEqual(hash, await sha256Hex(presented))) return true;
          }
          return false;
        },
      };
    };
    const relay = storeFor();
    const collaboration = storeFor();
    const relayToken = await relay.issue();
    const collaborationToken = await collaboration.issue();
    expect(await relay.accepts(relayToken)).toBe(true);
    expect(await collaboration.accepts(collaborationToken)).toBe(true);
    expect(await relay.accepts(collaborationToken)).toBe(false);
    expect(await collaboration.accepts(relayToken)).toBe(false);
    expect(await relay.accepts('forged')).toBe(false);
  });
});
