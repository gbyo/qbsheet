/**
 * Turning a camera frame into a string, and nothing else.
 *
 * # Two implementations, because the supported browsers are not one browser
 *
 * QBSheet supports current Chrome, Edge, Safari and Firefox. `BarcodeDetector` — the browser's own
 * decoder, hardware-accelerated and free — exists on ChromeOS, Android and macOS Chrome and does not
 * exist on Safari, on Firefox, or on Chrome for Windows and Linux. A room's Chromebook gets the fast
 * path; a director's Windows laptop gets a decoder in JavaScript. Shipping only the first would make
 * this feature quietly absent on a machine that has a working camera, which is worse than not having
 * it at all.
 *
 * # Why the fallback is loaded lazily
 *
 * Because scanning a QR code is the rarest thing this application does, and the ordinary path
 * through it — a Chromebook that reloads mid-round — must not pay for a decoder it will never call.
 * `import()` puts jsQR in a chunk of its own that is fetched when somebody presses Scan QR, and on a
 * browser with `BarcodeDetector` it is never fetched at all.
 *
 * # Why the frame is shrunk first
 *
 * A 1080p camera frame is two million pixels, and a pure-JavaScript decoder run over it several
 * times a second on a school Chromebook is a hot fan and a dropped preview. A QR code that fills a
 * reasonable part of the frame is still comfortably readable at 640 pixels on its long edge, which
 * is a tenth of the work.
 */

/** What the dialog holds: one call, one frame, one answer. */
export interface IQrDecoder {
  /** The decoded text, or null when this frame held no QR code. Never throws. */
  scan(video: HTMLVideoElement): Promise<string | null>;
}

/** The long edge a frame is reduced to before the JavaScript decoder sees it. */
export const maxDecodeEdge = 640;

interface IBarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue?: string }[]>;
}

interface IBarcodeDetectorConstructor {
  new (options?: { formats?: string[] }): IBarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
}

function nativeDetector(): IBarcodeDetectorConstructor | undefined {
  return (globalThis as { BarcodeDetector?: IBarcodeDetectorConstructor }).BarcodeDetector;
}

/**
 * The browser's own decoder, if it has one that reads QR codes.
 *
 * `getSupportedFormats` is asked rather than assumed: the Shape Detection API is a family, and a
 * browser that ships barcode formats without `qr_code` would otherwise return nothing forever while
 * looking like it was working.
 */
async function openNativeDecoder(): Promise<IQrDecoder | null> {
  const Detector = nativeDetector();
  if (Detector === undefined) return null;
  try {
    const formats = await Detector.getSupportedFormats?.();
    if (formats !== undefined && !formats.includes('qr_code')) return null;
    const detector = new Detector({ formats: ['qr_code'] });
    return {
      async scan(video) {
        try {
          const found = await detector.detect(video);
          const value = found[0]?.rawValue;
          return typeof value === 'string' && value !== '' ? value : null;
        } catch {
          // A frame the detector could not process — a video element between sizes, a transient
          // decoder fault. The next frame is a quarter of a second away.
          return null;
        }
      },
    };
  } catch {
    // The constructor itself refused. Fall through to the portable decoder rather than leaving the
    // scanner with no way to read anything.
    return null;
  }
}

/** The portable decoder: a canvas, a downscale, and jsQR. */
async function openFallbackDecoder(): Promise<IQrDecoder | null> {
  let decode: typeof import('jsqr').default;
  try {
    ({ default: decode } = await import('jsqr'));
  } catch {
    // The chunk did not load — an offline device that was cached before this feature existed is the
    // realistic case. The dialog reports that scanning is unavailable and the address box still works.
    return null;
  }

  const canvas = document.createElement('canvas');
  // `willReadFrequently` is the difference between a readback that stays on the CPU and one that
  // stalls on the GPU every frame.
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (context === null) return null;

  return {
    async scan(video) {
      const width = video.videoWidth;
      const height = video.videoHeight;
      // A camera that has not produced a frame yet reports zero. Not an error; just not ready.
      if (width === 0 || height === 0) return null;
      const scale = Math.min(1, maxDecodeEdge / Math.max(width, height));
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      try {
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const frame = context.getImageData(0, 0, canvas.width, canvas.height);
        // `dontInvert` is a deliberate halving of the work: a QR code printed or projected the other
        // way round is not a case any tournament produces, and trying both doubles the per-frame cost
        // on the devices that need the fallback in the first place.
        const found = decode(frame.data, frame.width, frame.height, { inversionAttempts: 'dontInvert' });
        return found === null || found.data === '' ? null : found.data;
      } catch {
        return null;
      }
    },
  };
}

/**
 * Whichever decoder this browser can offer, or null when it can offer neither.
 *
 * Null is a real answer and the caller has to say so out loud. Silently showing a camera preview that
 * will never decode anything is the failure worth avoiding.
 */
export async function loadQrDecoder(): Promise<IQrDecoder | null> {
  return (await openNativeDecoder()) ?? (await openFallbackDecoder());
}
