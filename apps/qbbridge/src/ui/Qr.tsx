import { useMemo } from 'react';
import { pairingQrSvg } from '../model/pairing';

/** A pairing QR. The payload is the launch URL and nothing else. */
export default function Qr({ url, label }: { url: string; label: string }) {
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
      aria-label={label}
      // The SVG is produced by the shared encoder from a URL this application built; it contains
      // no input from a file, a relay, or a scorer.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
