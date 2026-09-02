/**
 * A QR code, rendered without a dependency.
 *
 * # Why hand-written
 *
 * Director already carries `jsqr` for *reading* codes; nothing in the tree writes one. A generator
 * library is a few tens of kilobytes for a feature used on one screen, and the subset needed here
 * is small and fixed: a URL of at most ~200 characters, byte mode, error correction level M.
 *
 * This is a complete QR encoder for versions 1–10 in byte mode, which covers every bootstrap URL
 * the format can produce (`buildBootstrapUrl` caps the URL at 512 characters, and version 10 at
 * level M holds 213 bytes — a URL longer than that is refused before it gets here).
 *
 * The implementation follows ISO/IEC 18004. It is tested against known-good codes in
 * `qr.test.ts`, including decoding the rendered output back with `jsqr`, which is the only test
 * that actually proves the thing scans.
 */

/** Error correction level M: ~15% recovery. The middle choice for a printed page. */
const ERROR_CORRECTION_LEVEL_M = 0;

/** Total codewords per version. */
const totalCodewords = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

/** Error-correction codewords per block, and block counts, for level M, versions 1–10. */
const ecSpecM: { ecPerBlock: number; group1: number; group2: number }[] = [
  { ecPerBlock: 10, group1: 1, group2: 0 },
  { ecPerBlock: 16, group1: 1, group2: 0 },
  { ecPerBlock: 26, group1: 1, group2: 0 },
  { ecPerBlock: 18, group1: 2, group2: 0 },
  { ecPerBlock: 24, group1: 2, group2: 0 },
  { ecPerBlock: 16, group1: 4, group2: 0 },
  { ecPerBlock: 18, group1: 4, group2: 0 },
  { ecPerBlock: 22, group1: 2, group2: 2 },
  { ecPerBlock: 22, group1: 3, group2: 2 },
  { ecPerBlock: 26, group1: 4, group2: 1 },
];

/** Alignment pattern centres per version. Version 1 has none. */
/** Bits the character-count field occupies in byte mode: 8 below version 10, 16 from 10 up. */
function countBits(version: number): number {
  return version < 10 ? 8 : 16;
}

function dataCodewordCount(version: number): number {
  const spec = ecSpecM[version - 1];
  return totalCodewords[version - 1] - spec.ecPerBlock * (spec.group1 + spec.group2);
}

/**
 * Byte-mode capacity at level M.
 *
 * Derived rather than tabulated. The published capacity table is easy to transcribe from the wrong
 * error-correction column — level L's numbers look plausible under level M and produce codes that
 * overflow their data region silently — so it is computed from the block structure instead.
 */
function byteCapacity(version: number): number {
  return Math.floor((dataCodewordCount(version) * 8 - 4 - countBits(version)) / 8);
}

const alignmentCentres: number[][] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

// ---------------------------------------------------------------------------
// Galois field arithmetic over GF(256), the field QR error correction uses.
// ---------------------------------------------------------------------------

const exponentTable = new Uint8Array(512);
const logTable = new Uint8Array(256);

{
  let value = 1;
  for (let index = 0; index < 255; index += 1) {
    exponentTable[index] = value;
    logTable[value] = index;
    value <<= 1;
    // The generator polynomial for QR's field: x^8 + x^4 + x^3 + x^2 + 1.
    if (value & 0x100) value ^= 0x11d;
  }
  for (let index = 255; index < 512; index += 1) exponentTable[index] = exponentTable[index - 255];
}

function multiply(left: number, right: number): number {
  if (left === 0 || right === 0) return 0;
  return exponentTable[logTable[left] + logTable[right]];
}

/** The generator polynomial for `degree` error-correction codewords. */
function generatorPolynomial(degree: number): number[] {
  let polynomial = [1];
  for (let index = 0; index < degree; index += 1) {
    const next = new Array<number>(polynomial.length + 1).fill(0);
    for (let position = 0; position < polynomial.length; position += 1) {
      next[position] ^= polynomial[position];
      next[position + 1] ^= multiply(polynomial[position], exponentTable[index]);
    }
    polynomial = next;
  }
  return polynomial;
}

function errorCorrectionCodewords(data: number[], count: number): number[] {
  const generator = generatorPolynomial(count);
  const remainder = new Array<number>(count).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.shift();
    remainder.push(0);
    if (factor !== 0) {
      for (let index = 0; index < count; index += 1) {
        remainder[index] ^= multiply(generator[index + 1], factor);
      }
    }
  }
  return remainder;
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

export class QrEncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QrEncodeError';
  }
}

function chooseVersion(byteLength: number): number {
  for (let version = 1; version <= ecSpecM.length; version += 1) {
    if (byteLength <= byteCapacity(version)) return version;
  }
  throw new QrEncodeError('That link is too long to encode in a QR code this build can produce.');
}

/** Bit-level accumulation, because QR's data stream is not byte-aligned until the end. */
class BitBuffer {
  readonly bits: number[] = [];

  push(value: number, length: number): void {
    for (let index = length - 1; index >= 0; index -= 1) this.bits.push((value >> index) & 1);
  }

  get length(): number {
    return this.bits.length;
  }

  toBytes(): number[] {
    const bytes: number[] = [];
    for (let index = 0; index < this.bits.length; index += 8) {
      let byte = 0;
      for (let offset = 0; offset < 8; offset += 1) byte = (byte << 1) | (this.bits[index + offset] ?? 0);
      bytes.push(byte);
    }
    return bytes;
  }
}

function encodeData(text: string, version: number): number[] {
  const data = new TextEncoder().encode(text);
  const spec = ecSpecM[version - 1];
  const blockCount = spec.group1 + spec.group2;
  const dataCodewords = dataCodewordCount(version);

  const buffer = new BitBuffer();
  // Mode indicator 0100 = byte mode.
  buffer.push(0b0100, 4);
  buffer.push(data.length, countBits(version));
  for (const byte of data) buffer.push(byte, 8);

  // Terminator, up to four zero bits, then pad to a byte boundary.
  const remaining = dataCodewords * 8 - buffer.length;
  buffer.push(0, Math.min(4, Math.max(0, remaining)));
  while (buffer.length % 8 !== 0) buffer.push(0, 1);

  const bytes = buffer.toBytes();
  // The two alternating pad bytes the specification names.
  const padBytes = [0xec, 0x11];
  let padIndex = 0;
  while (bytes.length < dataCodewords) {
    bytes.push(padBytes[padIndex % 2]);
    padIndex += 1;
  }

  // Split into blocks, compute error correction, then interleave.
  const shortBlockLength = Math.floor(dataCodewords / blockCount);
  const blocks: { data: number[]; ec: number[] }[] = [];
  let offset = 0;
  for (let index = 0; index < blockCount; index += 1) {
    const length = index < spec.group1 ? shortBlockLength : shortBlockLength + 1;
    const blockData = bytes.slice(offset, offset + length);
    offset += length;
    blocks.push({ data: blockData, ec: errorCorrectionCodewords(blockData, spec.ecPerBlock) });
  }

  const interleaved: number[] = [];
  const longest = Math.max(...blocks.map((block) => block.data.length));
  for (let index = 0; index < longest; index += 1) {
    for (const block of blocks) if (index < block.data.length) interleaved.push(block.data[index]);
  }
  for (let index = 0; index < spec.ecPerBlock; index += 1) {
    for (const block of blocks) interleaved.push(block.ec[index]);
  }
  return interleaved;
}

// ---------------------------------------------------------------------------
// Matrix construction
// ---------------------------------------------------------------------------

type Cell = 0 | 1 | null;

function buildMatrix(version: number, codewords: number[], mask: number): Cell[][] {
  const size = version * 4 + 17;
  const matrix: Cell[][] = Array.from({ length: size }, () => Array<Cell>(size).fill(null));
  const reserved: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false));

  const place = (row: number, column: number, value: Cell, isReserved = true): void => {
    matrix[row][column] = value;
    reserved[row][column] = isReserved;
  };

  const finder = (top: number, left: number): void => {
    for (let row = -1; row <= 7; row += 1) {
      for (let column = -1; column <= 7; column += 1) {
        const r = top + row;
        const c = left + column;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const inRing = row >= 0 && row <= 6 && column >= 0 && column <= 6;
        const isDark =
          inRing &&
          (row === 0 ||
            row === 6 ||
            column === 0 ||
            column === 6 ||
            (row >= 2 && row <= 4 && column >= 2 && column <= 4));
        place(r, c, isDark ? 1 : 0);
      }
    }
  };

  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  // Timing patterns.
  for (let index = 8; index < size - 8; index += 1) {
    const value: Cell = index % 2 === 0 ? 1 : 0;
    place(6, index, value);
    place(index, 6, value);
  }

  // Alignment patterns, skipping the three that would collide with the finders.
  const centres = alignmentCentres[version - 1];
  for (const row of centres) {
    for (const column of centres) {
      if (
        (row === 6 && column === 6) ||
        (row === 6 && column === size - 7) ||
        (row === size - 7 && column === 6)
      ) {
        continue;
      }
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const isDark = Math.max(Math.abs(dy), Math.abs(dx)) !== 1;
          place(row + dy, column + dx, isDark ? 1 : 0);
        }
      }
    }
  }

  // The dark module, which is always set.
  place(size - 8, 8, 1);

  // Reserve the format-information areas; they are filled after masking.
  for (let index = 0; index <= 8; index += 1) {
    if (index !== 6) {
      reserved[8][index] = true;
      reserved[index][8] = true;
    }
  }
  for (let index = 0; index < 8; index += 1) {
    reserved[8][size - 1 - index] = true;
    reserved[size - 1 - index][8] = true;
  }

  // Version information, for versions 7 and up.
  if (version >= 7) {
    const bits = versionInformation(version);
    for (let index = 0; index < 18; index += 1) {
      const bit = ((bits >> index) & 1) as Cell;
      const row = Math.floor(index / 3);
      const column = index % 3;
      place(row, size - 11 + column, bit);
      place(size - 11 + column, row, bit);
    }
  }

  // Data placement.
  //
  // Two-module columns, right to left, alternating upward and downward, skipping the vertical
  // timing column. Written as the loop the specification describes rather than as index arithmetic
  // over column pairs: the earlier arithmetic form used one column twice, which produces a code
  // that is structurally perfect and does not decode.
  let bitIndex = 0;
  let direction = -1;
  let row = size - 1;
  let column = size - 1;
  while (column > 0) {
    if (column === 6) column -= 1;
    for (;;) {
      for (let offset = 0; offset < 2; offset += 1) {
        const target = column - offset;
        if (reserved[row][target]) continue;
        const byte = codewords[bitIndex >> 3] ?? 0;
        const bit = (byte >> (7 - (bitIndex & 7))) & 1;
        matrix[row][target] = (bit ^ (maskAt(mask, row, target) ? 1 : 0)) as Cell;
        bitIndex += 1;
      }
      row += direction;
      if (row < 0 || row >= size) {
        row -= direction;
        direction = -direction;
        column -= 2;
        break;
      }
    }
  }

  // Format information, now that masking is decided.
  //
  // The two copies have irregular layouts — the top-left one steps around the timing row and
  // column, the other runs along the bottom-left and top-right edges. This is the mapping from
  // the specification, written out rather than derived, because every attempt to express it as a
  // formula is a place to be subtly wrong in a way that only shows up as "the code does not scan".
  const format = formatInformation(mask);
  for (let index = 0; index < 15; index += 1) {
    const bit = ((format >> index) & 1) as Cell;

    // Vertical copy: up the left of the top-left finder, then the bottom-left edge.
    if (index < 6) matrix[index][8] = bit;
    else if (index < 8) matrix[index + 1][8] = bit;
    else matrix[size - 15 + index][8] = bit;

    // Horizontal copy: in from the top-right edge, then across under the top-left finder.
    if (index < 8) matrix[8][size - index - 1] = bit;
    else if (index === 8) matrix[8][7] = bit;
    else matrix[8][14 - index] = bit;
  }
  // Always dark, and it sits inside the reserved region, so it is written back last.
  matrix[size - 8][8] = 1;

  return matrix;
}

function maskAt(mask: number, row: number, column: number): boolean {
  switch (mask) {
    case 0:
      return (row + column) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return column % 3 === 0;
    case 3:
      return (row + column) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0;
    case 5:
      return ((row * column) % 2) + ((row * column) % 3) === 0;
    case 6:
      return (((row * column) % 2) + ((row * column) % 3)) % 2 === 0;
    default:
      return (((row + column) % 2) + ((row * column) % 3)) % 2 === 0;
  }
}

function formatInformation(mask: number): number {
  const data = (ERROR_CORRECTION_LEVEL_M << 3) | mask;
  let value = data << 10;
  for (let index = 14; index >= 10; index -= 1) {
    if ((value >> index) & 1) value ^= 0b10100110111 << (index - 10);
  }
  return ((data << 10) | value) ^ 0b101010000010010;
}

function versionInformation(version: number): number {
  let value = version << 12;
  for (let index = 17; index >= 12; index -= 1) {
    if ((value >> index) & 1) value ^= 0b1111100100101 << (index - 12);
  }
  return (version << 12) | value;
}

/**
 * Penalty score for a mask, per the specification's four rules.
 *
 * A scanner reads a badly masked code less reliably, and the failure shows up as "the QR on the
 * poster works from twelve inches but not from three feet" — the exact complaint a tournament
 * cannot debug. Evaluating all eight masks costs a millisecond.
 */
function penalty(matrix: Cell[][]): number {
  const size = matrix.length;
  let score = 0;

  // Rule 1: runs of five or more identical modules in a row or column.
  for (const along of [true, false]) {
    for (let major = 0; major < size; major += 1) {
      let run = 1;
      for (let minor = 1; minor < size; minor += 1) {
        const current = along ? matrix[major][minor] : matrix[minor][major];
        const previous = along ? matrix[major][minor - 1] : matrix[minor - 1][major];
        if (current === previous) {
          run += 1;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }

  // Rule 2: 2x2 blocks of one colour.
  for (let row = 0; row < size - 1; row += 1) {
    for (let column = 0; column < size - 1; column += 1) {
      const value = matrix[row][column];
      if (
        value === matrix[row][column + 1] &&
        value === matrix[row + 1][column] &&
        value === matrix[row + 1][column + 1]
      ) {
        score += 3;
      }
    }
  }

  // Rule 3: the finder-like pattern 1:1:3:1:1 with four light modules on one side.
  const patterns = [
    [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0],
    [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1],
  ];
  for (const along of [true, false]) {
    for (let major = 0; major < size; major += 1) {
      for (let minor = 0; minor <= size - 11; minor += 1) {
        for (const pattern of patterns) {
          let matches = true;
          for (let index = 0; index < 11; index += 1) {
            const cell = along ? matrix[major][minor + index] : matrix[minor + index][major];
            if ((cell ?? 0) !== pattern[index]) {
              matches = false;
              break;
            }
          }
          if (matches) score += 40;
        }
      }
    }
  }

  // Rule 4: deviation from an even balance of dark and light.
  let dark = 0;
  for (const row of matrix) for (const cell of row) if (cell === 1) dark += 1;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/** The QR modules for a string: `true` is a dark module. */
export function qrModules(text: string): boolean[][] {
  const data = new TextEncoder().encode(text);
  const version = chooseVersion(data.length);
  const codewords = encodeData(text, version);
  let best: Cell[][] | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = buildMatrix(version, codewords, mask);
    const score = penalty(candidate);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  if (!best) throw new QrEncodeError('The QR code could not be generated.');
  return best.map((row) => row.map((cell) => cell === 1));
}

/**
 * An SVG QR code.
 *
 * One `<path>` of rectangles rather than one element per module: a version-6 code is 41×41, and
 * 1 681 elements is a page a browser prints slowly. The quiet zone is four modules, which is the
 * specification's minimum and the thing most often left out of a hand-made code.
 */
export function qrSvg(text: string, options: { size?: number; quietZone?: number } = {}): string {
  const modules = qrModules(text);
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
    ` aria-label="QR code for this tournament's QBSheet Live link">`,
    `<rect width="${count}" height="${count}" fill="#ffffff"/>`,
    `<path d="${path}" fill="#000000"/>`,
    `</svg>`,
  ].join('');
}
