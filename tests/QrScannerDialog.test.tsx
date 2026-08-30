/**
 * @vitest-environment jsdom
 */

/**
 * The camera, and letting go of it.
 *
 * There is no camera in a unit test and there is no camera on a CI runner, so the browser's media
 * and decoder APIs are stood in for here. That is not a compromise: the interesting behaviour is not
 * whether jsQR can read a photograph — it can, and that is its maintainers' test suite — but what
 * this dialog does around it. Whether it asks for the camera at all before somebody pressed the
 * button. Whether it stops every track when it closes, including the case where the permission
 * prompt was still up when the scorekeeper changed their mind. Whether a refused payload keeps the
 * scanner open instead of dumping somebody back to the homepage with nothing to show for it.
 *
 * A camera indicator that stays lit after a dialog closes is the failure this file exists for.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

/**
 * The decoder is stubbed at its own boundary.
 *
 * Whether a QR code can be read out of a bitmap is jsQR's problem and jsQR's test suite; what this
 * file is about is the dialog around it. Mocking the module rather than the browser API underneath it
 * also means these tests never load the lazy chunk, which is the same thing they are asserting the
 * `BarcodeDetector` path does.
 */
let nextPayload: string | null = null;
/** Set to false for the browser that can open a camera and has no way to read anything from it. */
let decoderAvailable = true;

vi.mock('../src/app/QrDecoding', () => ({
  loadQrDecoder: async () =>
    decoderAvailable ? { scan: async () => nextPayload } : null,
}));

const {
  default: QrScannerDialog,
  cameraDeniedMessage,
  cameraMissingMessage,
  decoderMissingMessage,
  scanIntervalMs,
} = await import('../src/app/QrScannerDialog');

/** A media track that remembers being stopped, which is the whole assertion in half the tests. */
function fakeTrack() {
  return { kind: 'video', stop: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() };
}

function fakeStream(tracks: ReturnType<typeof fakeTrack>[]) {
  return { getTracks: () => tracks, getVideoTracks: () => tracks } as unknown as MediaStream;
}

let requestedConstraints: MediaStreamConstraints | null = null;

function stubCamera(open: () => Promise<MediaStream>): void {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async (constraints: MediaStreamConstraints) => {
        requestedConstraints = constraints;
        return open();
      }),
    },
  });
}

beforeEach(() => {
  nextPayload = null;
  decoderAvailable = true;
  requestedConstraints = null;
  vi.useFakeTimers();
  // jsdom's media element has neither of these, and neither is what is under test.
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

/** Let the camera open, the decoder load, and one scan run. */
async function scanOnce(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(scanIntervalMs + 10);
  });
}

describe('the scanner dialog', () => {
  test('opens as a dialog with a title, and asks for the rear camera', async () => {
    const tracks = [fakeTrack()];
    stubCamera(async () => fakeStream(tracks));

    render(<QrScannerDialog onClose={() => undefined} onDecoded={() => null} />);
    await scanOnce();

    expect(screen.getByRole('dialog', { name: 'Scan tournament QR code' })).toBeInTheDocument();
    // `ideal`, never `exact`: a Chromebook with only a front camera has to work.
    expect(requestedConstraints).toEqual({ video: { facingMode: { ideal: 'environment' } } });
    expect(screen.getByRole('status')).toHaveTextContent('Looking for a QR code');
  });

  test('focus enters the dialog and returns to whatever opened it', async () => {
    stubCamera(async () => fakeStream([fakeTrack()]));
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();

    const view = render(<QrScannerDialog onClose={() => undefined} onDecoded={() => null} />);
    await scanOnce();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));

    view.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  test('Escape closes it', async () => {
    stubCamera(async () => fakeStream([fakeTrack()]));
    const onClose = vi.fn();

    render(<QrScannerDialog onClose={onClose} onDecoded={() => null} />);
    await scanOnce();

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });

    expect(onClose).toHaveBeenCalled();
  });

  test('a valid scan is handed to the caller exactly once', async () => {
    stubCamera(async () => fakeStream([fakeTrack()]));
    const onDecoded = vi.fn(() => null);
    nextPayload = 'https://qbsheet.com/#qbtcp-pair?v=1&server=http%3A%2F%2F10.0.0.4%3A3000&code=48213906';

    render(<QrScannerDialog onClose={() => undefined} onDecoded={onDecoded} />);
    await scanOnce();

    expect(onDecoded).toHaveBeenCalledTimes(1);
    expect(onDecoded).toHaveBeenCalledWith(nextPayload);

    // Accepted, so the loop stops rather than offering the same payload four times a second.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(scanIntervalMs * 4);
    });
    expect(onDecoded).toHaveBeenCalledTimes(1);
  });

  test('a refused code keeps the scanner open with an explanation', async () => {
    stubCamera(async () => fakeStream([fakeTrack()]));
    const onDecoded = vi.fn(() => 'That is not a QBSheet pairing code.');
    nextPayload = 'WIFI:S=Venue;T=WPA;P=hunter2;;';

    render(<QrScannerDialog onClose={() => undefined} onDecoded={onDecoded} />);
    await scanOnce();

    expect(screen.getByRole('alert')).toHaveTextContent('That is not a QBSheet pairing code.');
    expect(screen.getByRole('dialog', { name: 'Scan tournament QR code' })).toBeInTheDocument();

    // And it is not re-offered while the same code is still in shot.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(scanIntervalMs * 4);
    });
    expect(onDecoded).toHaveBeenCalledTimes(1);
  });

  test('a refused camera says so and leaves the manual path intact', async () => {
    const denial = new Error('denied');
    denial.name = 'NotAllowedError';
    stubCamera(async () => {
      throw denial;
    });

    render(<QrScannerDialog onClose={() => undefined} onDecoded={() => null} />);
    await scanOnce();

    expect(screen.getByRole('alert')).toHaveTextContent(cameraDeniedMessage);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  test('a device with no camera at all is told plainly', async () => {
    const missing = new Error('none');
    missing.name = 'NotFoundError';
    stubCamera(async () => {
      throw missing;
    });

    render(<QrScannerDialog onClose={() => undefined} onDecoded={() => null} />);
    await scanOnce();

    expect(screen.getByRole('alert')).toHaveTextContent(cameraMissingMessage);
  });

  test('a browser with no media API is told before anything is asked of it', async () => {
    Reflect.deleteProperty(navigator, 'mediaDevices');

    render(<QrScannerDialog onClose={() => undefined} onDecoded={() => null} />);
    await scanOnce();

    expect(screen.getByRole('alert')).toHaveTextContent(cameraMissingMessage);
  });

  test('a browser that can open a camera but cannot decode releases it again', async () => {
    const tracks = [fakeTrack()];
    stubCamera(async () => fakeStream(tracks));
    // No native detector and no fallback — the realistic case is an offline device holding a shell
    // cached before this feature existed, whose lazy chunk is not there to fetch.
    decoderAvailable = false;

    render(<QrScannerDialog onClose={() => undefined} onDecoded={() => null} />);
    await scanOnce();

    expect(screen.getByRole('alert')).toHaveTextContent(decoderMissingMessage);
    // The camera must not stay lit behind a message saying nothing can be read from it.
    expect(tracks[0].stop).toHaveBeenCalled();
  });
});

describe('letting go of the camera', () => {
  test('every track is stopped when the dialog unmounts', async () => {
    const tracks = [fakeTrack(), fakeTrack()];
    stubCamera(async () => fakeStream(tracks));

    const view = render(<QrScannerDialog onClose={() => undefined} onDecoded={() => null} />);
    await scanOnce();
    expect(tracks[0].stop).not.toHaveBeenCalled();

    view.unmount();

    expect(tracks[0].stop).toHaveBeenCalledTimes(1);
    expect(tracks[1].stop).toHaveBeenCalledTimes(1);
  });

  test('a stream that arrives after the dialog closed is stopped rather than attached', async () => {
    const tracks = [fakeTrack()];
    let hand: (stream: MediaStream) => void = () => undefined;
    stubCamera(
      () =>
        new Promise<MediaStream>((resolve) => {
          hand = resolve;
        }),
    );

    // Closed while the browser's permission prompt was still on screen.
    const view = render(<QrScannerDialog onClose={() => undefined} onDecoded={() => null} />);
    view.unmount();

    await act(async () => {
      hand(fakeStream(tracks));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(tracks[0].stop).toHaveBeenCalledTimes(1);
  });

  test('the decode loop stops with the dialog', async () => {
    const tracks = [fakeTrack()];
    stubCamera(async () => fakeStream(tracks));
    const onDecoded = vi.fn(() => 'no');
    nextPayload = 'anything';

    const view = render(<QrScannerDialog onClose={() => undefined} onDecoded={onDecoded} />);
    await scanOnce();
    const calls = onDecoded.mock.calls.length;

    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(scanIntervalMs * 10);
    });

    expect(onDecoded).toHaveBeenCalledTimes(calls);
  });
});
