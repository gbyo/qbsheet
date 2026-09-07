/**
 * @vitest-environment jsdom
 */
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

let nextPayload: string | null = null;

vi.mock('../src/app/QrDecoding', () => ({
  loadQrDecoder: async () => ({ scan: async () => nextPayload }),
}));

const { default: QrScannerDialog, scanIntervalMs } = await import('../src/app/QrScannerDialog');

function fakeStream(): MediaStream {
  return {
    getTracks: () => [{ stop: vi.fn() }],
  } as unknown as MediaStream;
}

beforeEach(() => {
  vi.useFakeTimers();
  nextPayload = null;
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => fakeStream()) },
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
    configurable: true,
    writable: true,
    value: null,
  });
  HTMLMediaElement.prototype.play = vi.fn(async () => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'mediaDevices');
});

test('offers a decoded payload to the current validator after rerender', async () => {
  const previous = vi.fn(() => 'old validator');
  const current = vi.fn(() => null);
  const view = render(<QrScannerDialog onClose={() => undefined} onDecoded={previous} />);

  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  view.rerender(<QrScannerDialog onClose={() => undefined} onDecoded={current} />);
  nextPayload = 'qbsheet://current';

  await act(async () => {
    await vi.advanceTimersByTimeAsync(scanIntervalMs + 10);
  });

  expect(previous).not.toHaveBeenCalled();
  expect(current).toHaveBeenCalledOnce();
  expect(current).toHaveBeenCalledWith('qbsheet://current');
});
