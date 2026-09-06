import { afterEach, describe, expect, it, vi } from 'vitest';

import { newDeviceId } from '../src/app/ConnectedSession';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('newDeviceId', () => {
  it('does not collapse to an all-zero identifier when Web Crypto is unavailable', () => {
    vi.stubGlobal('crypto', undefined);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    expect(newDeviceId()).toBe('device-808080808080808080808080');
  });
});
