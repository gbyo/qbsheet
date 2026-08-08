/**
 * Serves Fluent UI's icon font from this tournament's own server instead of Microsoft's CDN.
 *
 * MODAQ calls Fluent's `initializeIcons()` itself, at module scope, with no arguments. Called that
 * way, Fluent reads `window.FabricConfig.iconBaseUrl`, so setting that global is enough to move
 * every glyph onto our origin without patching MODAQ.
 *
 * Two reasons the CDN default cannot stand. The room page's CSP permits fonts from 'self' and data:
 * only, so the CDN request is blocked outright and every icon renders as an empty box — the menu
 * chevrons, the buzz and protest controls, the checkboxes. And a quiz bowl venue is routinely a LAN
 * with no uplink, or school wifi that filters office.net: an icon set that has to arrive over the
 * internet is an icon set that goes missing on the one day it matters. The whole set is 272KB, and a
 * browser only fetches the subsets it actually draws from.
 *
 * Import this module before anything that reaches modaq; `index.tsx` does. The ordering is
 * load-bearing in one direction: Fluent's registry keeps the first registration of each icon name
 * and ignores later ones, so a base URL set after MODAQ's call would be silently discarded.
 */

// This file is imported for its side effects only. The empty export is what makes it a module rather
// than a script, which keeps the declarations below out of the global scope — `require` in
// particular, which the Electron main process has its own real one of.
export {};

/**
 * Where the woff files are emitted, relative to the room bundle root.
 *
 * The trailing slash is required: Fluent concatenates this with a bare filename.
 */
const iconFontPath = '/fonts/';

declare global {
  interface Window {
    FabricConfig?: { iconBaseUrl?: string; fontBaseUrl?: string };
  }
}

/** webpack's require.context, declared locally so this doesn't depend on @types/webpack-env */
declare const require: {
  context(path: string, useSubdirectories?: boolean, regExp?: RegExp): { keys(): string[] } & ((id: string) => unknown);
};

window.FabricConfig = { ...window.FabricConfig, iconBaseUrl: iconFontPath };

/**
 * Emit the font files, which nothing imports on its own.
 *
 * Fluent asks for each subset by its exact published filename, hash included, so the room build
 * emits these under their original names rather than webpack's usual hashed ones.
 *
 * `fluent-icon-fonts` is a webpack alias for the installed package's `fonts` directory, which its
 * `exports` map doesn't otherwise make reachable.
 */
const iconFonts = require.context('fluent-icon-fonts', false, /\.woff$/);
iconFonts.keys().forEach(iconFonts);
