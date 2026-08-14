/**
 * @vitest-environment jsdom
 */

/**
 * Which decoder a browser gets, and what the glue around it does.
 *
 * QBSheet supports current Chrome, Edge, Safari and Firefox, and only some of those have a decoder
 * of their own — `BarcodeDetector` exists on ChromeOS, Android and macOS Chrome and nowhere else that
 * matters here. The choice below is therefore not an optimisation. It is the difference between the
 * feature working on a director's Windows laptop and appearing to be broken on it.
 *
 * Whether jsQR can read a photograph of a QR code is jsQR's own test suite. What is asserted here is
 * everything around that: that the browser's decoder is preferred when it is really there, that a
 * `BarcodeDetector` which does not do QR codes is not mistaken for one that does, that a frame is
 * shrunk before a JavaScript decoder is asked to walk it, and that no path throws.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { loadQrDecoder, maxDecodeEdge } from '../src/app/QrDecoding';

function videoOf(width: number, height: number): HTMLVideoElement {
  const element = document.createElement('video');
  Object.defineProperty(element, 'videoWidth', { configurable: true, value: width });
  Object.defineProperty(element, 'videoHeight', { configurable: true, value: height });
  return element;
}

/** A 2D context that records what it was asked to draw and reads back a blank frame. */
function stubCanvasContext() {
  const drawn: { width: number; height: number }[] = [];
  const context = {
    drawImage: vi.fn((_source: unknown, _x: number, _y: number, width: number, height: number) => {
      drawn.push({ width, height });
    }),
    getImageData: vi.fn((_x: number, _y: number, width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4),
      width,
      height,
    })),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  return { context, drawn };
}

function stubDetector(options: { formats?: string[]; payload?: string | null } = {}) {
  const detect = vi.fn(async () =>
    options.payload === undefined || options.payload === null ? [] : [{ rawValue: options.payload }],
  );
  const constructed: { formats?: string[] }[] = [];
  (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector = class {
    static getSupportedFormats = async () => options.formats ?? ['qr_code', 'ean_13'];

    constructor(settings?: { formats?: string[] }) {
      constructed.push(settings ?? {});
    }

    detect = detect;
  };
  return { detect, constructed };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector;
});

describe('choosing a decoder', () => {
  test('the browser’s own decoder is used when it reads QR codes', async () => {
    const { detect, constructed } = stubDetector({ payload: 'scanned-text' });

    const decoder = await loadQrDecoder();

    expect(constructed).toEqual([{ formats: ['qr_code'] }]);
    expect(await decoder?.scan(videoOf(1280, 720))).toBe('scanned-text');
    expect(detect).toHaveBeenCalled();
  });

  test('a frame with no code in it is not an error', async () => {
    stubDetector({ payload: null });

    const decoder = await loadQrDecoder();

    expect(await decoder?.scan(videoOf(1280, 720))).toBeNull();
  });

  test('a detector that throws on a frame keeps the scanner running', async () => {
    (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector = class {
      static getSupportedFormats = async () => ['qr_code'];

      async detect(): Promise<{ rawValue?: string }[]> {
        throw new Error('a frame between sizes');
      }
    };

    const decoder = await loadQrDecoder();

    expect(await decoder?.scan(videoOf(1280, 720))).toBeNull();
  });

  test('a barcode detector that does not do QR codes is not used as one', async () => {
    stubDetector({ formats: ['ean_13', 'code_128'] });
    const { drawn } = stubCanvasContext();

    const decoder = await loadQrDecoder();
    await decoder?.scan(videoOf(800, 600));

    // It fell through to the portable decoder rather than returning nothing forever.
    expect(drawn.length).toBe(1);
  });

  test('a browser with neither a detector nor a canvas has no decoder, and says so', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);

    expect(await loadQrDecoder()).toBeNull();
  });
});

describe('the portable decoder', () => {
  test('a large frame is shrunk before it is walked', async () => {
    const { drawn } = stubCanvasContext();

    const decoder = await loadQrDecoder();
    const found = await decoder?.scan(videoOf(1920, 1080));

    expect(drawn).toEqual([{ width: maxDecodeEdge, height: Math.round((1080 * maxDecodeEdge) / 1920) }]);
    // A blank frame holds no QR code, which is not a failure.
    expect(found).toBeNull();
  });

  test('a small frame is left at its own size', async () => {
    const { drawn } = stubCanvasContext();

    const decoder = await loadQrDecoder();
    await decoder?.scan(videoOf(320, 240));

    expect(drawn).toEqual([{ width: 320, height: 240 }]);
  });

  test('a camera that has not produced a frame yet is not an error', async () => {
    const { drawn } = stubCanvasContext();

    const decoder = await loadQrDecoder();

    expect(await decoder?.scan(videoOf(0, 0))).toBeNull();
    expect(drawn).toEqual([]);
  });
});
