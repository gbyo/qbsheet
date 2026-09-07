import { describe, expect, it } from 'vitest';

import { ProviderTokenCache } from '../src/credential';

describe('provider token cache', () => {
  it('coalesces concurrent cache misses into one token mint', async () => {
    const cache = new ProviderTokenCache();
    let mintCount = 0;
    let finishMint: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      finishMint = resolve;
    });

    const mint = async () => {
      mintCount += 1;
      await gate;
      return 'provider-token';
    };

    const first = cache.token(1_000, mint);
    const second = cache.token(1_000, mint);

    expect(mintCount).toBe(1);
    finishMint?.();
    await expect(Promise.all([first, second])).resolves.toEqual(['provider-token', 'provider-token']);
    expect(mintCount).toBe(1);
  });
});
