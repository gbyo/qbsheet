import { describe, expect, test } from 'vitest';
import { isSafariBrowser } from '../src/app/browserCompatibility';

describe('isSafariBrowser', () => {
  test('recognizes Safari on macOS and iOS', () => {
    expect(
      isSafariBrowser(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Safari/605.1.15',
      ),
    ).toBe(true);
    expect(
      isSafariBrowser(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe(true);
  });

  test('does not mistake Chromium or Firefox browsers for Safari', () => {
    expect(
      isSafariBrowser(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
      ),
    ).toBe(false);
    expect(
      isSafariBrowser(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/145.0.0.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe(false);
    expect(
      isSafariBrowser(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/145.0 Mobile/15E148 Safari/605.1.15',
      ),
    ).toBe(false);
  });
});
