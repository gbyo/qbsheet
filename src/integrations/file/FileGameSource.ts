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
import { OpenGameResult, openGameText } from '../../game/OpenGameDefinition';
import { maxQbjBytes } from '../../qbj/QbjSerialization';

/**
 * The picker's accept list. Advisory — the contents are what actually decide.
 *
 * `.qbj` leads because that is what a file is now. `.qbg` stays because a director's folder of them
 * still opens, and neither extension is consulted when deciding how to read what is inside.
 */
export const gameFileAccept = '.qbj,.qbg,.json,application/json';

export class FileGameSource implements IGameSource {
  readonly kind = 'file';

  constructor(private file: File) {}

  /**
   * Read the file for everything it contains.
   *
   * The full-fidelity entry point: a document holding several games returns the choice rather than
   * collapsing it, and one missing its scoring rules says so in a way the caller can answer.
   */
  async open(): Promise<OpenGameResult> {
    if (this.file.size > maxQbjBytes) {
      return { ok: false, errors: ['That file is too large to be a game file.'] };
    }
    let text: string;
    try {
      text = await this.file.text();
    } catch {
      return { ok: false, errors: ['That file could not be read.'] };
    }
    return openGameText(text);
  }

  /**
   * The `IGameSource` contract: one game or an error.
   *
   * A document that needs a choice cannot be answered from here, because there is nobody to ask —
   * so it is reported rather than picked from. Callers that can show a picker use `open`.
   */
  async load(): Promise<GameSourceResult> {
    const opened = await this.open();
    if (!opened.ok) return { ok: false, errors: opened.errors };
    if (opened.kind === 'choice') {
      return { ok: false, errors: ['This file contains more than one game. Choose which one to score.'] };
    }
    return { ok: true, value: opened.definition };
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
