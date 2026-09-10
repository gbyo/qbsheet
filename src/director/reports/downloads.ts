/**
 * Single-file downloads that work in the browser and the Tauri app.
 *
 * Large multi-file artifacts (like the stat-report ZIP) are packaged before
 * they reach this module; everything here moves one byte payload to exactly
 * one destination.
 */

import { isNativeDirector, saveNativeFile } from '../platform/native';
import { errorNotice, infoNotice, type AnnounceInput } from '../notices';

export function safeReportName(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-|-$/g, '') || 'tournament'
  );
}

export type SaveOrDownloadResult =
  | { status: 'saved'; path?: string }
  | { status: 'cancelled' }
  | { status: 'unavailable' }
  | { status: 'error'; message: string };

export async function saveOrDownloadBytes(
  bytes: Uint8Array,
  name: string,
  mimeType: string,
  onAnnounce: (announcement: AnnounceInput) => void,
  successMessage: string,
  cancelledMessage: string,
): Promise<SaveOrDownloadResult> {
  try {
    if (isNativeDirector()) {
      const result = await saveNativeFile(name, bytes);
      if (result.status === 'cancelled') {
        onAnnounce(infoNotice(cancelledMessage));
        return { status: 'cancelled' };
      }
      if (result.status === 'unavailable') {
        onAnnounce(infoNotice('The native file-save dialog is unavailable.'));
        return { status: 'unavailable' };
      }
      onAnnounce(`${successMessage} Saved to ${result.path}.`);
      return { status: 'saved', path: result.path };
    }
    downloadBytes(bytes, name, mimeType);
    onAnnounce(`${successMessage}.`);
    return { status: 'saved' };
  } catch (reason: unknown) {
    const message = reason instanceof Error ? reason.message : `${successMessage} failed.`;
    onAnnounce(errorNotice(message));
    return { status: 'error', message };
  }
}

export function saveOrDownloadText(
  content: string,
  name: string,
  mimeType: string,
  onAnnounce: (announcement: AnnounceInput) => void,
  successMessage: string,
): void {
  downloadBytes(new TextEncoder().encode(content), name, mimeType);
  onAnnounce(`${successMessage}.`);
}

function downloadBytes(content: Uint8Array, name: string, type: string): void {
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
