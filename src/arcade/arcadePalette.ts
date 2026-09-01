/**
 * The scoresheet's own colours and type, in a form a canvas can use.
 *
 * # Why the games do not have a palette of their own
 *
 * Because there is exactly one thing that would make the arcade feel like a different application
 * bolted on to this one, and it is a bird flying past obstacles in colours QBSheet never uses. Every
 * value below is a token already defined in `app-shell.css`, read from the live document, so a game
 * follows the appearance the scorekeeper chose without knowing that light and dark exist.
 *
 * # Why it is read from the document rather than imported
 *
 * A stylesheet's custom properties are not values a module can import; they are three sets of values
 * whose winner depends on `data-theme` and on the device's own setting. `getComputedStyle` is the
 * only thing that knows which one is in force. Reading it is not free, which is why `paletteKey`
 * exists: the two cheap facts that decide the answer, so a game re-reads only when one of them has
 * actually changed rather than sixty times a second.
 *
 * # Why every token has a fallback
 *
 * jsdom resolves no custom properties at all, and a canvas handed `fillStyle = ''` silently keeps
 * the previous colour. The fallbacks are the light values from `app-shell.css`, so a test renders a
 * real palette and a browser that somehow loaded the markup without the stylesheet still draws a
 * legible game rather than a black rectangle.
 */

export interface IArcadePalette {
  text: string;
  muted: string;
  faint: string;
  border: string;
  borderStrong: string;
  surface: string;
  surfaceSunken: string;
  accent: string;
  onAccent: string;
  success: string;
  warning: string;
  error: string;
  /**
   * The document's own font stack, so a score drawn on a canvas is the typeface the rest of the
   * application is set in. Canvas takes no inheritance; without this the browser's default serif is
   * what a player sees, next to a dialog set in IBM Plex Sans.
   */
  fontFamily: string;
}

/** The light values from `app-shell.css`, and the answer wherever the document has none. */
const fallback: IArcadePalette = {
  text: '#1c1d20',
  muted: '#5c6066',
  faint: '#8a8f96',
  border: '#d8dade',
  borderStrong: '#c2c5ca',
  surface: '#ffffff',
  surfaceSunken: '#f6f7f8',
  accent: '#1565c0',
  onAccent: '#ffffff',
  success: '#1e6b32',
  warning: '#8a5300',
  error: '#a8231b',
  fontFamily: "'IBM Plex Sans', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
};

/** The custom properties, which are read as a group. `fontFamily` is an ordinary property; see below. */
const tokens: Record<Exclude<keyof IArcadePalette, 'fontFamily'>, string> = {
  text: '--room-text',
  muted: '--room-muted',
  faint: '--room-faint',
  border: '--room-border',
  borderStrong: '--room-border-strong',
  surface: '--room-surface',
  surfaceSunken: '--room-surface-sunken',
  accent: '--room-accent',
  onAccent: '--room-on-accent',
  success: '--room-success',
  warning: '--room-warning',
  error: '--room-error',
};

/**
 * What the palette currently depends on, as one cheap string.
 *
 * The deliberate choice written to the root element by `displayPreference`, the device setting that
 * decides it when there is no choice, and the raised-contrast request that `contrast.css` answers by
 * moving the same tokens. All three are attribute or media-query reads; none resolves a stylesheet. A
 * game compares this between frames and re-reads the real palette only when one of them has moved.
 */
export function arcadePaletteKey(): string {
  const chosen = typeof document === 'undefined' ? '' : (document.documentElement.dataset.theme ?? '');
  const query = (media: string): string => {
    try {
      return window.matchMedia(media).matches ? '1' : '0';
    } catch {
      // A browser without `matchMedia`. The chosen appearance is then the whole answer.
      return '0';
    }
  };
  return `${chosen}|${query('(prefers-color-scheme: dark)')}|${query('(prefers-contrast: more)')}`;
}

/** The tokens as they resolve on this element right now. */
export default function readArcadePalette(element: Element | null): IArcadePalette {
  if (element === null || typeof window === 'undefined') return fallback;
  let computed: CSSStyleDeclaration;
  try {
    computed = window.getComputedStyle(element);
  } catch {
    return fallback;
  }
  const entries = Object.entries(tokens).map(([name, token]) => {
    const value = computed.getPropertyValue(token).trim();
    return [name, value === '' ? fallback[name as keyof IArcadePalette] : value];
  });
  const fontFamily = computed.fontFamily.trim();
  return {
    ...(Object.fromEntries(entries) as Omit<IArcadePalette, 'fontFamily'>),
    fontFamily: fontFamily === '' ? fallback.fontFamily : fontFamily,
  };
}
