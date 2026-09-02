/**
 * The platform side of transfers: Tauri where there is one, honest limits where there is not.
 *
 * # The browser preview is not a degraded desktop app
 *
 * A page cannot enumerate USB volumes, and it should not be able to. So the browser build does not
 * pretend: `browserTransferPlatform` reports that automatic detection is unavailable and offers the
 * three things a browser genuinely does well — drop files on the window, pick files, download files.
 * Those go through the same ingestion pipeline as everything else, so a director working in the
 * preview gets the real feature with one part missing rather than a different, worse feature.
 *
 * The reverse also holds and matters more: nothing is removed from the desktop app to keep the
 * preview at parity. Automatic drive detection is the point of the desktop app.
 */
import type {
  RemovableVolumeSource,
  TransferDirectoryEntry,
  TransferFileSystem,
  TransferReadResult,
  TransferVolume,
} from '../transfers/ports';

interface NativeBridge {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: NativeBridge;
  }
}

function bridge(): NativeBridge | null {
  return typeof window === 'undefined' ? null : (window.__TAURI_INTERNALS__ ?? null);
}

export function isNativeTransfers(): boolean {
  return bridge() !== null;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Turn whatever Tauri rejected with into a sentence.
 *
 * The native layer returns `{ code, message }`, and a raw `[object Object]` in a toast during round
 * five is worse than no message at all.
 */
function nativeMessage(reason: unknown, fallback: string): string {
  if (reason instanceof Error) return reason.message;
  if (reason && typeof reason === 'object' && 'message' in reason) {
    const message = (reason as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return fallback;
}

export class NativeTransferFileSystem implements TransferFileSystem, RemovableVolumeSource {
  readonly kind = 'native' as const;

  constructor(private readonly native: NativeBridge) {}

  private async call<T>(command: string, args: Record<string, unknown>, fallback: string): Promise<T> {
    try {
      return (await this.native.invoke(command, args)) as T;
    } catch (reason: unknown) {
      throw new Error(nativeMessage(reason, fallback));
    }
  }

  async listVolumes(): Promise<TransferVolume[]> {
    const volumes = await this.call<Array<Record<string, unknown>>>(
      'transfers_list_volumes',
      {},
      'Connected drives could not be read.',
    );
    return volumes.map((volume) => ({
      mountPoint: String(volume.mountPoint ?? ''),
      name: String(volume.name ?? ''),
      removable: volume.removable === true,
      readOnly: volume.readOnly === true,
      ...(typeof volume.totalBytes === 'number' ? { totalBytes: volume.totalBytes } : {}),
      ...(typeof volume.availableBytes === 'number' ? { availableBytes: volume.availableBytes } : {}),
      ...(typeof volume.fileSystem === 'string' ? { fileSystem: volume.fileSystem } : {}),
    }));
  }

  async listDirectory(path: string, limit: number): Promise<TransferDirectoryEntry[]> {
    const entries = await this.call<Array<Record<string, unknown>>>(
      'transfers_list_directory',
      { path, limit },
      'That folder could not be read.',
    );
    return entries.map((entry) => ({
      name: String(entry.name ?? ''),
      path: String(entry.path ?? ''),
      directory: entry.directory === true,
      byteLength: typeof entry.byteLength === 'number' ? entry.byteLength : 0,
      ...(typeof entry.modifiedAt === 'string' ? { modifiedAt: entry.modifiedAt } : {}),
      ...(entry.symlink === true ? { symlink: true } : {}),
    }));
  }

  async readFile(path: string, maxBytes: number): Promise<TransferReadResult> {
    const file = await this.call<{ contentBase64?: string; byteLength?: number }>(
      'transfers_read_file',
      { path, maxBytes },
      'That file could not be read.',
    );
    const bytes = decodeBase64(file.contentBase64 ?? '');
    return { bytes, byteLength: file.byteLength ?? bytes.byteLength };
  }

  async writeFileAtomic(path: string, contents: string): Promise<void> {
    await this.call(
      'transfers_write_file',
      {
        request: { path, contentBase64: encodeBase64(contents) },
      },
      'That file could not be written.',
    );
  }

  async createDirectory(path: string): Promise<void> {
    await this.call('transfers_create_directory', { path }, 'That folder could not be created.');
  }

  async exists(path: string): Promise<boolean> {
    try {
      return await this.call<boolean>('transfers_exists', { path }, 'That location could not be read.');
    } catch {
      return false;
    }
  }

  async availableBytes(path: string): Promise<number | undefined> {
    try {
      const bytes = await this.call<number | null>(
        'transfers_available_bytes',
        { path },
        'Free space could not be read.',
      );
      return typeof bytes === 'number' ? bytes : undefined;
    } catch {
      return undefined;
    }
  }
}

export interface ChosenFolder {
  path: string;
  name: string;
}

/** Open the platform's own folder picker. The pick is the grant; nothing widens it afterwards. */
export async function chooseTransferFolder(): Promise<ChosenFolder | null> {
  const native = bridge();
  if (!native) return null;
  try {
    const chosen = await native.invoke('transfers_choose_folder');
    if (!chosen || typeof chosen !== 'object') return null;
    const record = chosen as { path?: unknown; name?: unknown };
    return typeof record.path === 'string'
      ? { path: record.path, name: typeof record.name === 'string' ? record.name : record.path }
      : null;
  } catch (reason: unknown) {
    throw new Error(nativeMessage(reason, 'That folder could not be chosen.'));
  }
}

/**
 * Re-grant access to a location the director configured in an earlier session.
 *
 * Locations persist in the tournament document; the operating-system permission does not, and
 * should not. Startup walks the saved list and re-authorizes each one, and a folder that is gone or
 * a share that is not mounted yet reports that plainly instead of vanishing from the list.
 */
export async function authorizeTransferRoot(path: string): Promise<{ ok: boolean; message?: string }> {
  const native = bridge();
  if (!native) return { ok: false, message: 'Native transfer folders need the Director desktop app.' };
  try {
    await native.invoke('transfers_authorize_root', { path });
    return { ok: true };
  } catch (reason: unknown) {
    return { ok: false, message: nativeMessage(reason, 'That folder is not available right now.') };
  }
}

export async function forgetTransferRoot(path: string): Promise<void> {
  const native = bridge();
  if (!native) return;
  try {
    await native.invoke('transfers_forget_root', { path });
  } catch {
    // Dropping a grant that is already gone is not a failure worth telling anyone about.
  }
}

export interface TransferPlatform {
  fileSystem: TransferFileSystem | null;
  volumes: RemovableVolumeSource | null;
  /** True when the platform can enumerate drives and read folders on its own. */
  native: boolean;
  /** Why native transfers are unavailable, when they are. Shown in the Transfers page. */
  limitation?: string;
}

export function createTransferPlatform(): TransferPlatform {
  const native = bridge();
  if (!native)
    return {
      fileSystem: null,
      volumes: null,
      native: false,
      limitation:
        'This browser preview cannot detect drives or watch folders. Drag files onto this page, choose files, or download prepared assignments.',
    };
  const fileSystem = new NativeTransferFileSystem(native);
  return { fileSystem, volumes: fileSystem, native: true };
}

/** Save a prepared file through the browser, for the manual upload-it-yourself cloud workflow. */
export function downloadTextFile(fileName: string, contents: string, mimeType: string): void {
  if (typeof document === 'undefined') return;
  const blob = new Blob([contents], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on a later task so the navigation has started; revoking synchronously cancels it in
  // some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
