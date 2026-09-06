/** @vitest-environment jsdom */

import { act, renderHook } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { useSeatDrag } from '../src/scorer/SeatDrag';

function rect(left: number): DOMRect {
  return {
    x: left,
    y: 0,
    left,
    top: 0,
    right: left + 100,
    bottom: 40,
    width: 100,
    height: 40,
    toJSON: () => ({}),
  } as DOMRect;
}

function pointerEvent(type: string, pointerId: number, clientX: number): PointerEvent {
  const event = new Event(type) as PointerEvent;
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    clientX: { value: clientX },
    clientY: { value: 0 },
  });
  return event;
}

test('an unrelated pointer cancellation does not abort the active seat drag', () => {
  const onDrop = vi.fn();
  const hook = renderHook(() => useSeatDrag(3, onDrop));
  const first = document.createElement('div');
  const second = document.createElement('div');
  first.getBoundingClientRect = () => rect(0);
  second.getBoundingClientRect = () => rect(100);

  act(() => {
    hook.result.current.seatRef(0)(first);
    hook.result.current.seatRef(1)(second);
    hook.result.current.onPointerDown(0)({
      button: 0,
      pointerId: 7,
      clientX: 0,
      clientY: 0,
      currentTarget: first,
    } as never);
    window.dispatchEvent(pointerEvent('pointermove', 7, 120));
  });
  expect(hook.result.current.drag?.to).toBe(1);

  act(() => {
    window.dispatchEvent(pointerEvent('pointercancel', 99, 120));
  });
  expect(hook.result.current.drag?.to).toBe(1);

  act(() => {
    window.dispatchEvent(pointerEvent('pointerup', 7, 120));
  });
  expect(onDrop).toHaveBeenCalledWith(0, 1);

  hook.unmount();
});
