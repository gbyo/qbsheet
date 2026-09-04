import { expect, test, vi } from 'vitest';
import { parseScannedQbsheetCode, readScannedQbsheetCode } from '../src/app/ScannedQbsheetCode';
import { encodePortableGameSetup } from '../src/game/PortableGameSetup';
import { portableInput } from './portableSetupFixtures';
const pairing = 'https://example.org/#qbtcp-pair?v=1&server=http%3A%2F%2F192.168.1.20%3A3000&code=48213906';

test('dispatch preserves the pairing parser and its security checks', () => {
  expect(parseScannedQbsheetCode(pairing)).toMatchObject({ kind: 'pairing', intent: { code: '48213906' } });
  expect(parseScannedQbsheetCode(pairing.replace('v=1', 'v=2'))).toMatchObject({ kind: 'problem' });
  expect(parseScannedQbsheetCode(pairing.replace('http%3A', 'javascript%3A'))).toMatchObject({
    kind: 'problem',
  });
});
test('dispatch routes a portable setup to review, not pairing', () => {
  const encoded = encodePortableGameSetup(portableInput());
  if (!encoded.ok) throw new Error(encoded.message);
  const close = vi.fn(),
    pair = vi.fn(),
    review = vi.fn();
  expect(readScannedQbsheetCode(encoded.text, close, pair, review)).toBeNull();
  expect(close).toHaveBeenCalledWith(false);
  expect(pair).not.toHaveBeenCalled();
  expect(review).toHaveBeenCalledWith(portableInput());
});
test.each(['QBSHEET-SETUP:1:!', 'QBSHEET-SETUP:99:AA', 'https://unrelated.example/'])(
  'a rejected payload leaves the scanner open: %s',
  (text) => {
    const close = vi.fn(),
      pair = vi.fn(),
      review = vi.fn();
    expect(readScannedQbsheetCode(text, close, pair, review)).toEqual(expect.any(String));
    expect(close).not.toHaveBeenCalled();
    expect(pair).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
  },
);
test('a pairing scan follows the existing flow', () => {
  const close = vi.fn(),
    pair = vi.fn(),
    review = vi.fn();
  expect(readScannedQbsheetCode(pairing, close, pair, review)).toBeNull();
  expect(pair).toHaveBeenCalledOnce();
  expect(review).not.toHaveBeenCalled();
});
