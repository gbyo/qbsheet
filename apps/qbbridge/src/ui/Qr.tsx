import { useMemo } from 'react';
import bridgePackage from '../../package.json';
import { pairingQrSvg } from '../model/pairing';
import './Qr.css';

const pairingMarker = '#qbtcp-pair?';

/**
 * A short physical-sheet identifier derived from the already-printed pairing code.
 *
 * This is deliberately not a new credential or identifier. The full code is printed elsewhere on
 * the same room sheet; the suffix just gives staff a fast way to tell two generations apart after
 * a code is regenerated.
 */
function pairingCodeSuffix(url: string): string | null {
  const markerIndex = url.indexOf(pairingMarker);
  if (markerIndex < 0) return null;
  const parameters = new URLSearchParams(url.slice(markerIndex + pairingMarker.length));
  const code = parameters.get('code');
  return code && /^[0-9]{8}$/.test(code) ? code.slice(-4) : null;
}

/**
 * A pairing QR.
 *
 * The payload is the launch URL and nothing else. The accessible description says what the code
 * is for rather than reading the URL out, because the URL carries a pairing code and an
 * eight-digit number spelled aloud is not what anybody wants from an image label — the code is
 * already on screen beside it as text.
 *
 * Printed room sheets also show a small generation stamp. It is hidden beside the ordinary room
 * QR in the application and becomes visible only inside `.room-print-sheet`, so the operational
 * metadata helps staff identify stale paper without adding noise to the live room table.
 */
export default function Qr({ url, roomName }: { url: string; roomName: string }) {
  const svg = useMemo(() => {
    try {
      return pairingQrSvg(url);
    } catch {
      return null;
    }
  }, [url]);
  const sheetStamp = useMemo(() => {
    const suffix = pairingCodeSuffix(url);
    const codeLabel = suffix ? ` · Pairing code ends ${suffix}` : '';
    return `QBBridge ${bridgePackage.version} · Generated ${new Date().toLocaleString()}${codeLabel} · Use only the newest sheet for this room.`;
  }, [url]);

  if (!svg) return null;
  return (
    <>
      <span
        className="qr"
        role="img"
        aria-label={`Pairing QR code for ${roomName}. Scan it with QBSheet Scorer, or type the pairing code shown beside it.`}
        // The SVG is produced by the shared encoder from a URL this application built; it contains
        // no input from a file, a relay, or a scorer.
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <span className="qr-sheet-stamp" aria-hidden="true">
        {sheetStamp}
      </span>
    </>
  );
}
