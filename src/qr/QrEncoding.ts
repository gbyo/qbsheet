import { encode } from 'uqr';

export class QrEncodeError extends Error {
  constructor(message = 'This text is too long to encode in a QR code.') {
    super(message);
    this.name = 'QrEncodeError';
  }
}

/** No border in metadata; rendered SVGs add a four-module quiet zone. */
export function encodeQr(text: string, maxVersion = 40) {
  try {
    const code = encode(text, { ecc: 'M', boostEcc: false, border: 0, maxVersion });
    return { modules: code.data, version: code.version, moduleCount: code.size };
  } catch {
    throw new QrEncodeError();
  }
}
export function qrModules(text: string): boolean[][] {
  return encodeQr(text).modules;
}

/**
 * An SVG QR code.
 *
 * One `<path>` of rectangles rather than one element per module: a version-6 code is 41×41, and
 * 1 681 elements is a page a browser prints slowly. The quiet zone is four modules, which is the
 * specification's minimum and the thing most often left out of a hand-made code.
 */
export function qrSvg(text: string, options: { size?: number; quietZone?: number } = {}): string {
  const modules = encodeQr(text).modules;
  const quiet = options.quietZone ?? 4;
  const count = modules.length + quiet * 2;
  const pixels = options.size ?? 320;
  let path = '';
  modules.forEach((row, rowIndex) => {
    row.forEach((dark, columnIndex) => {
      if (dark) path += `M${columnIndex + quiet} ${rowIndex + quiet}h1v1h-1z`;
    });
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pixels}" height="${pixels}"`,
    ` viewBox="0 0 ${count} ${count}" shape-rendering="crispEdges" role="img"`,
    ` aria-label="QBSheet QR code">`,
    `<rect width="${count}" height="${count}" fill="#ffffff"/>`,
    `<path d="${path}" fill="#000000"/>`,
    `</svg>`,
  ].join('');
}
