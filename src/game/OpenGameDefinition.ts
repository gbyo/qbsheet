/**
 * Opening a game, whatever it arrived as.
 *
 * One function, three inputs, one internal type out. The caller — a file picker, a drop zone, a
 * QBTCP response handler — does not learn which of the three it got unless it asks, and the scorer
 * never learns at all.
 *
 * # Order of attempts, and why it is not sniffing
 *
 * QBJ is tried first, then the legacy package. This is not content sniffing in the fragile sense:
 * each reader has an unambiguous discriminator — `objects`/`match_teams` for QBJ, `format:
 * "quizbowl-game"` for a package — and a document that matches neither is refused with the QBJ
 * error, because QBJ is what a file is expected to be now.
 *
 * The file extension is not consulted. A `.qbj` that contains a legacy package still opens, and a
 * `.qbg` that contains QBJ still opens, because the contents are what a document is and the name is
 * what somebody typed.
 */
import { IGameDefinition } from './GameDefinition';
import { IGamePackage } from './GamePackage';
import { validateGamePackage } from './GamePackageValidation';
import {
  DefineGameResult,
  IGameDefinitionOverrides,
  IQbjSource,
  MatchPlayState,
  defineGame,
  readQbjSource,
  scoreableWithoutChoice,
} from '../qbj/ParseQbjAssignment';
import { parseQbjText } from '../qbj/QbjSerialization';

/** Promote a validated legacy package to the internal type. Shape is identical; provenance is not. */
export function gamePackageToDefinition(packageValue: IGamePackage): IGameDefinition {
  return { ...packageValue, origin: 'qbg' };
}

export type OpenGameResult =
  /** Exactly one game, ready to score. */
  | {
      ok: true;
      kind: 'game';
      definition: IGameDefinition;
      legacy: boolean;
      /**
       * How much scoring the document already carried.
       *
       * Anything but `unplayed` means the caller must say so before the scorekeeper starts adding
       * to it. Opening a finished game is legitimate — reviewing or re-exporting a result is why
       * Match-only import exists — but doing it without saying so is how somebody appends a tossup
       * to a game that ended an hour ago.
       */
      state: MatchPlayState;
    }
  /** Several games in one document. The caller shows the picker and calls `chooseGame`. */
  | { ok: true; kind: 'choice'; source: IQbjSource }
  /** A single QBJ game that could not be defined without more from the scorekeeper. */
  | { ok: false; errors: string[]; source?: IQbjSource; index?: number; needsScoringRules?: boolean; needsRoster?: boolean };

/**
 * Read a document's text as a game.
 *
 * @param text the raw file or response body — untrusted, and treated as such by both readers
 */
export function openGameText(text: string): OpenGameResult {
  const parsed = parseQbjText(text);

  if (parsed.ok) {
    const legacyPackage = validateGamePackage(parsed.value);
    if (legacyPackage.ok) {
      // A legacy package describes an assignment; it has no scoring in it by construction.
      return {
        ok: true,
        kind: 'game',
        definition: gamePackageToDefinition(legacyPackage.value),
        legacy: true,
        state: 'unplayed',
      };
    }

    const source = readQbjSource(parsed.value);
    if (source.ok) {
      const single = scoreableWithoutChoice(source.value);
      if (!single) return { ok: true, kind: 'choice', source: source.value };
      const defined = defineGame(source.value, single.index);
      if (defined.ok) {
        return { ok: true, kind: 'game', definition: defined.definition, legacy: false, state: single.state };
      }
      return { ...defined, source: source.value, index: single.index };
    }

    // Neither reader recognized it. A document that looks like a legacy package but failed
    // validation deserves that reader's specific complaints rather than QBJ's generic one.
    const looksLikePackage =
      typeof parsed.value === 'object' && parsed.value !== null && 'format' in (parsed.value as object);
    return { ok: false, errors: looksLikePackage ? legacyPackage.errors : source.errors };
  }

  return { ok: false, errors: parsed.errors };
}

/** Define one game from a document the caller has shown a picker for. */
export function chooseGame(
  source: IQbjSource,
  index: number,
  overrides: IGameDefinitionOverrides = {},
): DefineGameResult {
  return defineGame(source, index, overrides);
}
