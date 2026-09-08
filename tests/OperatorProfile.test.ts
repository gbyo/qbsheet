import { afterEach, describe, expect, it, vi } from 'vitest';
import { operatorInitials, saveOperatorProfile } from '../src/director/operator/operatorProfile';

describe('operator profile persistence', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not throw when browser storage rejects the write', () => {
    const setItem = vi.fn(() => {
      throw new DOMException('Storage is unavailable', 'SecurityError');
    });
    vi.stubGlobal('localStorage', { setItem });

    expect(() => saveOperatorProfile({ displayName: 'Gibson', role: 'Director' })).not.toThrow();
    expect(setItem).toHaveBeenCalledOnce();
  });

  it('keeps non-BMP characters intact when building initials', () => {
    expect(operatorInitials('😀 Bell')).toBe('😀B');
    expect(operatorInitials('😀A')).toBe('😀A');
  });
});
