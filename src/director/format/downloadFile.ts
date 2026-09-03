/**
 * Handing a generated file to the browser.
 *
 * Publish and Standings both do this, and both used to carry their own copy of the anchor dance
 * including the same comment about when to revoke. One copy means one place to fix it if a browser
 * ever changes its mind about how an object URL may be released.
 */
export function downloadBytes(content: Uint8Array, name: string, type: string): void {
  const copy = new Uint8Array(content);
  const url = URL.createObjectURL(new Blob([copy.buffer as ArrayBuffer], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoking synchronously can cancel the download in some browsers before navigation starts.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function downloadText(content: string, name: string, type: string): void {
  downloadBytes(new TextEncoder().encode(content), name, type);
}

export const csvMediaType = 'text/csv;charset=utf-8';
