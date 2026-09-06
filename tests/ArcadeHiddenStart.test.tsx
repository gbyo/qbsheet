/**
 * @vitest-environment jsdom
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import useArcadeLoop from '../src/arcade/useArcadeLoop';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Probe(props: { onHidden: () => void }) {
  useArcadeLoop({ running: true, step: () => undefined, onHidden: props.onHidden });
  return null;
}

test('a loop that starts while the document is hidden pauses before scheduling a frame', () => {
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  const requestFrame = vi.spyOn(window, 'requestAnimationFrame');
  const hidden = vi.fn();

  render(<Probe onHidden={hidden} />);

  expect(hidden).toHaveBeenCalledTimes(1);
  expect(requestFrame).not.toHaveBeenCalled();
});
