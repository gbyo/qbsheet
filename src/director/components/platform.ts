/** Platform conventions the interface has to get right to look native. */

function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    '';
  return /mac|iphone|ipad|ipod/i.test(platform) || /mac os x/i.test(navigator.userAgent ?? '');
}

/**
 * The command/control modifier as this platform writes it.
 *
 * Director used to render the literal string `⌘/Ctrl K`, which is correct on
 * neither platform. A keyboard hint that hedges is a keyboard hint the operator
 * has to decode.
 */
export function modifierKeyLabel(): string {
  return isApplePlatform() ? '⌘' : 'Ctrl';
}

/** e.g. `⌘K` on macOS, `Ctrl K` elsewhere. */
export function shortcutLabel(key: string): string {
  return isApplePlatform() ? `⌘${key.toUpperCase()}` : `Ctrl ${key.toUpperCase()}`;
}

/** The spoken form, so screen readers do not read a glyph. */
export function shortcutAriaLabel(key: string): string {
  return `${isApplePlatform() ? 'Command' : 'Control'} ${key.toUpperCase()}`;
}
