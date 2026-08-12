/** The scorekeeper name is a device preference, not game data or a capability token. */
export const operatorNameStorageKey = 'qbsheet.operator-name.v1';

/**
 * Whether this device has been asked for a scorekeeper name.
 *
 * Separate from the name itself, because "no name" and "never asked" are different states and only
 * the second one earns a dialog. A scorekeeper who was asked and left it blank meant it, and asking
 * again every time the site loads would be the software arguing with them.
 */
export const operatorNameAskedStorageKey = 'qbsheet.operator-name-asked.v1';

function storage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function readOperatorName(): string {
  try {
    return storage()?.getItem(operatorNameStorageKey)?.trim() ?? '';
  } catch {
    return '';
  }
}

export function readOperatorNameAsked(): boolean {
  try {
    return storage()?.getItem(operatorNameAskedStorageKey) === '1';
  } catch {
    return false;
  }
}

/**
 * Remember that the question has been put.
 *
 * A browser that will not store this answers `false` and gets asked again next load, which is the
 * safe end of the trade: a repeated dialog on a device that keeps nothing is a smaller problem than
 * a name silently dropped from every result it sends.
 */
export function writeOperatorNameAsked(): boolean {
  const target = storage();
  if (!target) return false;
  try {
    target.setItem(operatorNameAskedStorageKey, '1');
    return true;
  } catch {
    return false;
  }
}

export function writeOperatorName(value: string): boolean {
  const target = storage();
  if (!target) return false;
  try {
    const name = value.trim();
    if (name === '') target.removeItem(operatorNameStorageKey);
    else target.setItem(operatorNameStorageKey, name);
    return true;
  } catch {
    return false;
  }
}
