/**
 * Return the comparison key used by human-facing Director search controls.
 *
 * Displayed values are never changed: this is only for matching and ranking.
 * NFD makes composed and decomposed Unicode spellings comparable, and removing
 * Unicode marks makes an omitted accent match the original spelling.
 */
export function normalizeSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
}
