import { afterEach, describe, expect, it, vi } from 'vitest';

import { newTabId } from '../src/persistence/TabClaim';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('newTabId', () => {
  it('keeps same-tick tab labels distinct when Web Crypto is unavailable', () => {
    vi.stubGlobal('crypto', undefined);
    vi.spyOn(performance, 'now').mockReturnValue(12.4);
    let randomCalls = 0;
    vi.spyOn(Math, 'random').mockImplementation(() => (randomCalls++ < 8 ? 0.25 : 0.75));

    const first = newTabId();
    const second = newTabId();

    expect(first).toBe('tab-4040404040404040-12');
    expect(second).toBe('tab-c0c0c0c0c0c0c0c0-12');
    expect(second).not.toBe(first);
  });
});
