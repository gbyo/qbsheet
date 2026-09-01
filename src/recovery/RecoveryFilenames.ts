import { IGamePackage } from '../game/GamePackage';
import { qbsheetBackupFileName, sanitizeFileNamePart } from '../integrations/file/QbjDownload';
import { IRecoveryFilenameMapping } from './RecoveryTypes';

export type RecoveryFilenameMappingEntry = Pick<IRecoveryFilenameMapping, 'gameKey' | 'fileName'>;
export type RecoveryFilenameMappings =
  ReadonlyMap<string, string> | Iterable<RecoveryFilenameMappingEntry | readonly [string, string]>;

const qbsheetExtension = '.qbsheet';
const maximumRecoveryFileNameLength = 180;

function hasControlCharacter(value: string): boolean {
  return Array.from(value, (character) => character.codePointAt(0) ?? 0).some(
    (codePoint) => codePoint <= 0x1f || codePoint === 0x7f,
  );
}

/** A filename is a leaf name, not a path, and is constrained to the names this feature creates. */
export function isSafeQbsheetFileName(value: string): boolean {
  return (
    value.length > qbsheetExtension.length &&
    value.length <= maximumRecoveryFileNameLength &&
    value.endsWith(qbsheetExtension) &&
    value !== '.' + qbsheetExtension &&
    value !== '..' + qbsheetExtension &&
    !value.startsWith('.') &&
    !/[\\/]/u.test(value) &&
    !hasControlCharacter(value) &&
    /^[\p{L}\p{N}._-]+$/u.test(value)
  );
}

function mappingEntries(mappings: RecoveryFilenameMappings): RecoveryFilenameMappingEntry[] {
  const entries: RecoveryFilenameMappingEntry[] = [];
  if (mappings instanceof Map) {
    for (const [gameKey, fileName] of mappings.entries()) {
      if (typeof gameKey === 'string' && typeof fileName === 'string') entries.push({ gameKey, fileName });
    }
    return entries;
  }
  for (const entry of mappings) {
    if (Array.isArray(entry)) {
      const [gameKey, fileName] = entry;
      if (typeof gameKey === 'string' && typeof fileName === 'string') entries.push({ gameKey, fileName });
    } else if (
      entry &&
      typeof entry === 'object' &&
      'gameKey' in entry &&
      'fileName' in entry &&
      typeof entry.gameKey === 'string' &&
      typeof entry.fileName === 'string'
    ) {
      entries.push({ gameKey: entry.gameKey, fileName: entry.fileName });
    }
  }
  return entries;
}

/** A deterministic 64-bit non-cryptographic suffix; the local game key never appears in a file. */
function stableGameSuffix(gameKey: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const character of gameKey) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

function baseWithoutExtension(fileName: string): string {
  return fileName.endsWith(qbsheetExtension) ? fileName.slice(0, -qbsheetExtension.length) : fileName;
}

function safeBaseFileName(baseFileName: string): string {
  if (isSafeQbsheetFileName(baseFileName)) return baseFileName;
  const base = baseWithoutExtension(baseFileName)
    .split(/[\\/]/u)
    .map((part) => sanitizeFileNamePart(part, 'Recovery'))
    .filter(Boolean)
    .join('-');
  const safeRoot = sanitizeFileNamePart(base, 'Recovery').slice(
    0,
    maximumRecoveryFileNameLength - qbsheetExtension.length,
  );
  return `${safeRoot || 'Recovery'}${qbsheetExtension}`;
}

/**
 * Choose one stable leaf name for a game key.
 *
 * The first attempt keeps the familiar download name. If that name is already mapped to another
 * local attempt, the suffix is derived only from the local key and a numeric tie-breaker handles
 * even a deliberately constructed hash collision. A later call with the same mapping returns the
 * exact same name, so scoring another question does not create another file.
 */
export function chooseCollisionSafeQbsheetFileName(
  baseFileName: string,
  gameKey: string,
  mappings: RecoveryFilenameMappings = [],
): string {
  const base = safeBaseFileName(baseFileName);
  const entries = mappingEntries(mappings);
  const existingForGame = entries.find(
    (entry) => entry.gameKey === gameKey && isSafeQbsheetFileName(entry.fileName),
  );
  if (existingForGame) return existingForGame.fileName;

  const usedByOtherGame = new Set(
    entries.filter((entry) => entry.gameKey !== gameKey).map((entry) => entry.fileName),
  );
  if (!usedByOtherGame.has(base)) return base;

  const root = baseWithoutExtension(base);
  const suffix = `attempt-${stableGameSuffix(gameKey)}`;
  const fitWithSuffix = (suffixValue: string): string => {
    const tail = `-${suffixValue}${qbsheetExtension}`;
    const rootLimit = Math.max(1, maximumRecoveryFileNameLength - tail.length);
    return `${root.slice(0, rootLimit)}${tail}`;
  };
  let candidate = fitWithSuffix(suffix);
  let counter = 2;
  while (usedByOtherGame.has(candidate)) {
    candidate = fitWithSuffix(`${suffix}-${counter}`);
    counter += 1;
  }
  return candidate;
}

/** Choose a collision-safe name directly from the existing QBSheet game-package naming policy. */
export function chooseQbsheetBackupFileName(
  packageValue: IGamePackage,
  gameKey: string,
  mappings: RecoveryFilenameMappings = [],
): string {
  return chooseCollisionSafeQbsheetFileName(qbsheetBackupFileName(packageValue), gameKey, mappings);
}

/** Alias for callers that describe the operation as selecting rather than choosing. */
export const selectQbsheetBackupFileName = chooseQbsheetBackupFileName;
