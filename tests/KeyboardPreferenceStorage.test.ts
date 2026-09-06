import { describe, expect, test } from 'vitest';
import { saveKeyboardEnabled } from '../src/scorer/keyboardPreference';

describe('keyboard preference persistence result', () => {
  test('reports unavailable storage as unsaved', () => {
    expect(saveKeyboardEnabled(true, null)).toBe(false);
  });

  test('reports a successful write as saved', () => {
    const storage = {
      getItem: () => null,
      removeItem: () => undefined,
      setItem: () => undefined,
    };

    expect(saveKeyboardEnabled(true, storage)).toBe(true);
  });
});
