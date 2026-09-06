/** @vitest-environment jsdom */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import DvdOverlay from '../src/scorer/secrets/DvdOverlay';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('resumes DVD motion after the tab hides while the pointer is over the logo', () => {
  let hidden = false;
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => hidden,
  });

  let nextFrameId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      nextFrameId += 1;
      frames.set(nextFrameId, callback);
      return nextFrameId;
    }),
  );
  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn((frameId: number) => {
      frames.delete(frameId);
    }),
  );

  render(<DvdOverlay origin={createRef<HTMLButtonElement>()} onClose={vi.fn()} onCorner={vi.fn()} />);
  const logo = screen.getByRole('button', { name: 'Exit DVD mode' });
  const startingTransform = logo.style.transform;

  fireEvent.pointerEnter(logo);

  hidden = true;
  fireEvent(document, new Event('visibilitychange'));
  hidden = false;
  fireEvent(document, new Event('visibilitychange'));

  const runNextFrame = (now: number) => {
    const entry = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
    expect(entry).toBeDefined();
    const [id, callback] = entry!;
    frames.delete(id);
    act(() => callback(now));
  };

  // The first visible frame resets the time base; the next one should move the logo again.
  runNextFrame(1_000);
  runNextFrame(2_000);

  expect(logo.style.transform).not.toBe(startingTransform);
});
