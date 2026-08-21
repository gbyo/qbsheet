/**
 * The scorekeeper's appearance choice, applied to the marketing and wiki pages.
 *
 * These pages default to `prefers-color-scheme` with no script at all — that is what the media block
 * in `about.css` is for, and it is why this file is a refinement rather than a requirement. What it
 * adds is the one case a media query cannot cover: somebody who deliberately overrode their device
 * in the scoresheet's Settings. The pages share an origin with the scorer and therefore a
 * `localStorage`, so the override is readable here, and a product whose FAQ ignores the choice its
 * scorer honoured looks like two products.
 *
 * # Why the key is repeated rather than imported
 *
 * Importing it from `displayPreference` is one line and was the first thing tried. It makes the
 * marketing pages depend on a module in `src/app`, which Rollup then hoists into a chunk shared
 * between two entries — and `vite.config.ts` documents at length what that costs: the shared chunk
 * is named after the module, the stylesheet Vite extracts is named after the chunk, and both land in
 * `assets/` rather than `about/assets/`, which is the boundary the service worker's precache list is
 * drawn on. It also dragged the webfont declarations out of the about bundle on the way.
 *
 * So the key is written twice, deliberately, exactly as `about.css` writes the palette twice and for
 * the same reason. `AboutAppearance.test.ts` asserts the two spellings agree, which is what makes
 * the duplication safe: they cannot drift without a test failing.
 */

/** Must equal `appearanceStorageKey` in `src/app/displayPreference.ts`. Asserted by its test. */
export const aboutAppearanceStorageKey = 'qbsheet.display.appearance.v1';

export default function startAppearance(): void {
  try {
    const stored = window.localStorage.getItem(aboutAppearanceStorageKey);
    // Only the two deliberate overrides. Anything else -- absent, `system`, or a value written by a
    // build that knew more than this one -- leaves `prefers-color-scheme` in charge.
    if (stored !== 'dark' && stored !== 'light') return;
    document.documentElement.setAttribute('data-theme', stored);
  } catch {
    // A profile that refuses storage reads gets `prefers-color-scheme`, which is the default anyway.
  }
}
