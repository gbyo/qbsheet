import { describe, expect, test } from 'vitest';
import { normalizeSearchText } from './search';

describe('normalizeSearchText', () => {
  test('matches accents, case, and composed/decomposed Unicode without changing display values', () => {
    const composed = 'José García';
    const decomposed = 'Jose\u0301 Garcia';

    expect(normalizeSearchText('Jose')).toBe(normalizeSearchText(composed).slice(0, 4));
    expect(normalizeSearchText('JOSE')).toBe(normalizeSearchText(composed).slice(0, 4));
    expect(normalizeSearchText(decomposed)).toBe(normalizeSearchText(composed));
    expect(normalizeSearchText('Francois')).toBe(normalizeSearchText('François'));
    expect(normalizeSearchText('Cafe')).toBe(normalizeSearchText('Café'));
    expect(composed).toBe('José García');
    expect(decomposed).toBe('Jose\u0301 Garcia');
  });

  test('does not turn unrelated text into a match', () => {
    expect(normalizeSearchText('José')).not.toContain(normalizeSearchText('Maria'));
  });
});
