import { openNativeTournamentFile } from '../platform/native';

export interface PickedFile {
  fileName: string;
  bytes: Uint8Array;
}

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function readDirectorFiles(native: boolean, files: File[] = []): Promise<PickedFile[] | null> {
  if (native) {
    const selected = await openNativeTournamentFile();
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
  files,
  onPick,
  onError,
}: {
  native: boolean;
  files?: File[];
  onPick: (picked: PickedFile[]) => void | Promise<void>;
  onError?: (message: string) => void;
}): Promise<void> {
  try {
    const picked = await readDirectorFiles(native, files);
    if (picked) await onPick(picked);
  } catch (reason: unknown) {
    const fallback = native ? 'That file could not be opened.' : 'That file could not be read.';
    onError?.(reason instanceof Error ? reason.message : fallback);
  }
}
