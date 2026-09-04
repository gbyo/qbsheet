// RFC 9285 alphabet. Spaces are data; never trim a payload.
const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
export function encodeBase45(bytes: Uint8Array): string {
  let result = '';
  for (let i = 0; i < bytes.length; i += 2) {
    let value = bytes[i] * (i + 1 < bytes.length ? 256 : 1) + (bytes[i + 1] ?? 0);
    result += alphabet[value % 45];
    value = Math.floor(value / 45);
    result += alphabet[value % 45];
    if (i + 1 < bytes.length) result += alphabet[Math.floor(value / 45)];
  }
  return result;
}

export function decodeBase45(text: string): Uint8Array | null {
  if (text.length % 3 === 1) return null;
  const bytes = new Uint8Array(Math.floor((text.length * 2) / 3));
  let offset = 0;
  for (let i = 0; i < text.length; i += 3) {
    const count = Math.min(3, text.length - i);
    let value = 0;
    for (let j = 0; j < count; j += 1) {
      const digit = alphabet.indexOf(text[i + j]);
      if (digit < 0) return null;
      value += digit * 45 ** j;
    }
    if (value > (count === 3 ? 65535 : 255)) return null;
    if (count === 3) bytes[offset++] = Math.floor(value / 256);
    bytes[offset++] = value % 256;
  }
  return bytes;
}
