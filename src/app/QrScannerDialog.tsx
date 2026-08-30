/**
 * A camera, a decoder, and a string handed back.
 *
 * # What it deliberately does not know
 *
 * Nothing about QBTCP, pairing, tournament control, or what a valid payload looks like. It reads a
 * QR code and offers the text to its caller, and the caller says whether that was the right one. A
 * rejection keeps the camera running with a line of explanation, because the realistic mistake is a
 * scorekeeper pointing this at the wrong QR code on a table covered in paperwork, and closing the
 * dialog on them would mean starting over.
 *
 * # The camera is opened by the press that opened this dialog
 *
 * This component only exists after somebody pressed Scan QR, so mounting it *is* the user gesture,
 * which is what a browser wants to see before it prompts for camera permission. Nothing probes for a
 * camera before that, and a device that never opens this dialog is never asked.
 *
 * # And it is released the moment the dialog goes away
 *
 * The camera indicator light staying on after a modal closes is the single most alarming thing this
 * feature could do. So every track is stopped in the cleanup, the decode loop is cancelled, and a
 * `getUserMedia` promise that resolves *after* the dialog has already been closed stops the stream it
 * was handed rather than attaching it to a component that is gone.
 */
import { useEffect, useRef, useState } from 'react';
import NativeDialog from './NativeDialog';
import { IQrDecoder, loadQrDecoder } from './QrDecoding';

/**
 * How often a frame is read.
 *
 * Not `requestAnimationFrame`. Sixty decodes a second is sixty times more than a person can hold a
 * phone still for, and on the devices using the JavaScript decoder it is the difference between a
 * smooth preview and a slideshow. Four a second finds a code as fast as anybody can aim.
 */
export const scanIntervalMs = 250;

/** How many refused payloads are remembered before the set is dropped. See `refused` below. */
const maxRememberedRejections = 32;

export const cameraDeniedMessage =
  'This browser did not allow QBSheet to use the camera. Allow it in the browser’s site settings, or close this and type the address instead.';
export const cameraMissingMessage =
  'No camera is available on this device. Close this and type the address tournament control gave you.';
export const cameraFailedMessage =
  'The camera could not be started. Close this and type the address tournament control gave you.';
export const decoderMissingMessage =
  'This browser cannot read QR codes. Close this and type the address tournament control gave you.';

/** What went wrong with the camera, in words for the person holding the device. */
export function cameraFailureMessage(thrown: unknown): string {
  const name = thrown instanceof Error ? thrown.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return cameraDeniedMessage;
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
    return cameraMissingMessage;
  }
  return cameraFailedMessage;
}

export default function QrScannerDialog(props: {
  onClose: () => void;
  /**
   * Offer the decoded text.
   *
   * Returns null when the payload was accepted — the caller is then responsible for what happens
   * next, including closing this — or the sentence to show when it was not.
   */
  onDecoded: (text: string) => string | null;
}) {
  const { onClose, onDecoded } = props;
  const video = useRef<HTMLVideoElement>(null);
  /** Whether the camera is up. Drives the quiet status line, not an error. */
  const [scanning, setScanning] = useState(false);
  /** Anything the person has to act on: a denial, a missing camera, the wrong QR code. */
  const [failure, setFailure] = useState('');

  // Kept current by a committed effect, because the reader is a timer that outlives any one render
  // and a rejected scan must be judged by the current caller rather than the one that mounted this.
  const onDecodedRef = useRef(onDecoded);
  useEffect(() => {
    onDecodedRef.current = onDecoded;
  }, [onDecoded]);

  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const release = () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      const element = video.current;
      if (element) {
        try {
          element.srcObject = null;
        } catch {
          // A media element implementation without `srcObject`. The tracks above are what actually
          // holds the camera, and they are already stopped.
        }
      }
    };

    void (async () => {
      const media = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
      if (media === undefined || typeof media.getUserMedia !== 'function') {
        setFailure(cameraMissingMessage);
        return;
      }

      let opened: MediaStream;
      try {
        // `ideal` rather than `exact`: a phone should use the rear camera, and a Chromebook that has
        // only a front one must still work rather than fail a constraint it cannot satisfy.
        opened = await media.getUserMedia({ video: { facingMode: { ideal: 'environment' } } });
      } catch (thrown) {
        if (!stopped) setFailure(cameraFailureMessage(thrown));
        return;
      }
      if (stopped) {
        // Closed while the permission prompt was up. The stream is real and holds the camera.
        opened.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = opened;

      const element = video.current;
      if (element) {
        try {
          element.srcObject = opened;
          await element.play();
        } catch {
          // Autoplay refused, or a media element that cannot play in this environment. The frames
          // still arrive for the decoder in every browser that matters; nothing here is fatal.
        }
      }
      if (stopped) return;

      let decoder: IQrDecoder | null;
      try {
        decoder = await loadQrDecoder();
      } catch {
        decoder = null;
      }
      if (stopped) return;
      if (decoder === null) {
        setFailure(decoderMissingMessage);
        release();
        return;
      }

      setScanning(true);

      const active = decoder;
      /**
       * Payloads already offered and refused.
       *
       * Without this, a QR code the caller rejects is decoded again a quarter of a second later, and
       * again, for as long as it is in shot — which means the caller's validation runs four times a
       * second on a payload whose answer has not changed. Cleared wholesale when it grows, because a
       * bounded set is the point and which entry to evict is not worth deciding.
       */
      const refused = new Set<string>();

      const tick = async () => {
        if (stopped) return;
        const target = video.current;
        const found = target === null ? null : await active.scan(target);
        if (stopped) return;
        if (found !== null && !refused.has(found)) {
          if (refused.size >= maxRememberedRejections) refused.clear();
          refused.add(found);
          const rejection = onDecodedRef.current(found);
          if (stopped) return;
          if (rejection === null) {
            // Accepted. The camera has done its job and there is no reason to hold it for however
            // long the caller takes to unmount this.
            release();
            return;
          }
          setFailure(rejection);
        }
        timer = setTimeout(() => void tick(), scanIntervalMs);
      };
      timer = setTimeout(() => void tick(), scanIntervalMs);
    })();

    return release;
  }, []);

  return (
    <NativeDialog
      title="Scan tournament QR code"
      onClose={onClose}
      className="qr-dialog"
      bodyClassName="qr-dialog-body"
    >
      <p className="scorer-dialog-note">
        Point the camera at the QR code tournament control is showing. QBSheet will not connect to
        anything until you confirm.
      </p>
      {/*
        No alternative text and no label. The preview carries no information a person who cannot see
        it could use — it is the camera pointed at a piece of paper — and naming it would put a
        meaningless announcement between the instruction above and the status below.
      */}
      <div className="qr-preview">
        <video ref={video} className="qr-preview-video" muted playsInline autoPlay />
      </div>
      {/*
        Polite, and it changes twice at most: once when the camera comes up and once if a code is
        refused. A live region that reported every frame would be unusable.
      */}
      <p className="qr-status" role="status">
        {failure === '' ? (scanning ? 'Camera ready. Looking for a QR code…' : 'Starting the camera…') : ''}
      </p>
      {failure !== '' && (
        <p className="shell-errors" role="alert">
          {failure}
        </p>
      )}
      <div className="shell-modal-actions">
        <button type="button" className="shell-button" data-dialog-autofocus onClick={onClose}>
          Cancel
        </button>
      </div>
    </NativeDialog>
  );
}
