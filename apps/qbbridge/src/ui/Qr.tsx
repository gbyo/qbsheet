import { useMemo } from 'react';
import { pairingQrSvg } from '../model/pairing';

/**
 * A pairing QR.
 *
 * The payload is the launch URL and nothing else. The accessible description says what the code
 * is for rather than reading the URL out, because the URL carries a pairing code and an
 * eight-digit number spelled aloud is not what anybody wants from an image label — the code is
 * already on screen beside it as text.
 */
export default function Qr({ url, roomName }: { url: string; roomName: string }) {
  const svg = useMemo(() => {
    try {
      return pairingQrSvg(url);
    } catch {
      return null;
    }
  }, [url]);
  if (!svg) return null;
  return (
    <span
      className="qr"
      role="img"
      aria-label={`Pairing QR code for ${roomName}. Scan it with QBSheet Scorer, or type the pairing code shown beside it.`}
      // The SVG is produced by the shared encoder from a URL this application built; it contains
      // no input from a file, a relay, or a scorer.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
