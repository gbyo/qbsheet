/**
 * Opening a game from a file.
 *
 * The universal fallback, and the only path that is guaranteed to work: no server, no address, no
 * pairing code, no network. A tournament that hands out files on USB sticks and a tournament whose
 * server died at 9am use exactly the same code.
 *
 * The file is read as text, bounded, parsed and validated (see `GamePackageValidation`) and then it
 * is a game package like any other. Nothing here interprets anything; the point of the boundary is
 * that a hostile or broken file cannot get past it.
 */
import { IGameSource, GameSourceResult } from '../../game/GameSource';
import { maxGamePackageBytes, readGamePackageText } from '../../game/GamePackageValidation';

/** The picker's accept list. Advisory — the contents are what actually decide. */
export const gameFileAccept = '.qbg,.json,application/json';

export class FileGameSource implements IGameSource {
  readonly kind = 'file';

  constructor(private file: File) {}

  async load(): Promise<GameSourceResult> {
    if (this.file.size > maxGamePackageBytes) {
      return { ok: false, errors: ['That file is too large to be a game file.'] };
    }
    let text: string;
    try {
      text = await this.file.text();
    } catch {
      return { ok: false, errors: ['That file could not be read.'] };
    }
    return readGamePackageText(text);
  }
}

/**
 * Pull a game file out of a drop.
 *
 * Returns the first regular file. A drop carrying a directory, a URL or several files is not an
 * error worth explaining in the drop zone — the picker is right there — so it simply yields nothing.
 */
export function fileFromDrop(dataTransfer: DataTransfer | null): File | null {
  if (!dataTransfer) return null;
  const items = dataTransfer.items;
  if (items && items.length > 0) {
    for (const item of Array.from(items)) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  return dataTransfer.files?.[0] ?? null;
}
