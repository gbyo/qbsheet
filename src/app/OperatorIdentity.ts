/** The scorekeeper name is a device preference, not game data or a capability token. */
export const operatorNameStorageKey = 'qbsheet.operator-name.v1';

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
