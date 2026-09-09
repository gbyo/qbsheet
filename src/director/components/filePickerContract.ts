import { openNativeTournamentFile, type NativeFilePickerFilter } from '../platform/native';

export interface PickedFile {
  fileName: string;
  bytes: Uint8Array;
}

const MAX_NATIVE_FILTER_EXTENSIONS = 16;
const MAX_NATIVE_FILTER_EXTENSION_LENGTH = 16;
const NATIVE_MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  'application/json': 'json',
  'application/vnd.quizbowl.qbj+json': 'qbj',
  'text/csv': 'csv',
  'text/plain': 'txt',
};

function normalizeExtension(token: string): string | null {
  const extension = token.trim().toLowerCase().replace(/^\./, '');
  if (
    extension.length === 0 ||
    extension.length > MAX_NATIVE_FILTER_EXTENSION_LENGTH ||
    !/^[a-z0-9][a-z0-9_-]*$/.test(extension)
  ) {
    return null;
  }
  return extension;
}

/**
 * Translate the browser accept contract into the bounded shape understood by the native dialog.
 * Unknown MIME types and wildcard/invalid tokens are deliberately ignored; the native command
 * falls back to its established tournament filters if no safe extension survives.
 */
export function nativeFilePickerFilters(accept?: string): NativeFilePickerFilter[] {
  if (typeof accept !== 'string') return [];

  const extensions: string[] = [];
  const seen = new Set<string>();
  for (const rawToken of accept.split(',')) {
    const token = rawToken.trim().toLowerCase().split(';', 1)[0] ?? '';
    const extension = token.startsWith('.')
      ? normalizeExtension(token)
      : (NATIVE_MIME_EXTENSIONS[token] ?? null);
    if (!extension || seen.has(extension)) continue;
    seen.add(extension);
    extensions.push(extension);
    if (extensions.length === MAX_NATIVE_FILTER_EXTENSIONS) break;
  }

  return extensions.length > 0
    ? [
        { name: 'Accepted files', extensions },
        { name: 'All files', extensions: ['*'] },
      ]
    : [];
}

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function readDirectorFiles(
  native: boolean,
  accept?: string,
  files: File[] = [],
): Promise<PickedFile[] | null> {
  if (native) {
    const selected = await openNativeTournamentFile(nativeFilePickerFilters(accept));
    if (!selected) return null;
    return [{ fileName: selected.fileName, bytes: decodeBase64(selected.contentBase64) }];
  }

  if (files.length === 0) return null;
  return Promise.all(
    files.map(async (file) => ({
      fileName: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    })),
  );
}

/**
 * Select and read Director files through one native/browser contract.
 *
 * Cancellation resolves quietly with no picked files. Selection and read
 * failures, including failures in the consumer callback, are converted into
 * the same optional Director error callback and never escape as rejections.
 */
export async function pickDirectorFiles({
  native,
  accept,
  files,
  onPick,
  onError,
}: {
  native: boolean;
  accept?: string;
  files?: File[];
  onPick: (picked: PickedFile[]) => void | Promise<void>;
  onError?: (message: string) => void;
}): Promise<void> {
  try {
    const picked = await readDirectorFiles(native, accept, files);
    if (picked) await onPick(picked);
  } catch (reason: unknown) {
    const fallback = native ? 'That file could not be opened.' : 'That file could not be read.';
    onError?.(reason instanceof Error ? reason.message : fallback);
  }
}
