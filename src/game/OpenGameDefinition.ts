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
  | {
      ok: false;
      errors: string[];
      source?: IQbjSource;
      index?: number;
      needsScoringRules?: boolean;
      needsRoster?: boolean;
    };

/**
 * Read a document's text as a game.
 *
 * @param text the raw file or response body — untrusted, and treated as such by both readers
 */
export function openGameText(text: string): OpenGameResult {
  const parsed = parseQbjText(text);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  return openGameValue(parsed.value);
}

/**
 * Read an already-parsed document as a game.
 *
 * The same function as `openGameText` with the JSON step removed, and it exists so that a response
 * body which the network layer has already parsed does not have to be turned back into a string in
 * order to be read. Splitting it this way is the only reason the QBTCP path can promise it uses the
 * file parser: a second entry point that re-implemented any of this would be the drift the whole
 * migration exists to avoid.
 *
 * @param value untrusted parsed JSON — from a file, from a drop, or from a QBTCP response body
 */
export function openGameValue(value: unknown): OpenGameResult {
  const legacyPackage = validateGamePackage(value);
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

  const source = readQbjSource(value);
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
  const looksLikePackage = typeof value === 'object' && value !== null && 'format' in (value as object);
  return { ok: false, errors: looksLikePackage ? legacyPackage.errors : source.errors };
}

/** Define one game from a document the caller has shown a picker for. */
export function chooseGame(
  source: IQbjSource,
  index: number,
  overrides: IGameDefinitionOverrides = {},
): DefineGameResult {
  return defineGame(source, index, overrides);
}
