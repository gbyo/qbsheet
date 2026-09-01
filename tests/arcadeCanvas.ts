/**
 * A 2D context jsdom does not have.
 *
 * Without one, `getContext` returns null after logging a "not implemented" error, `prepareFrame`
 * gives up, and every drawing path in both games is untested — including the ones that would throw
 * on a typo in a colour token. This is the smallest object the arcade actually calls, so the draw
 * code runs for real and the tests stay quiet.
 */
import { vi } from 'vitest';

export interface IStubbedCanvas {
  /** Every `fillText` the games issued, which is the only drawing a test has any reason to assert on. */
  text: string[];
  fills: number;
}

export function stubArcadeCanvas(): IStubbedCanvas {
  const record: IStubbedCanvas = { text: [], fills: 0 };
  const context = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    setTransform: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    arc: vi.fn(),
    ellipse: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    fill: vi.fn(() => {
      record.fills += 1;
    }),
    stroke: vi.fn(),
    fillText: vi.fn((value: string) => {
      record.text.push(value);
    }),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  return record;
}
