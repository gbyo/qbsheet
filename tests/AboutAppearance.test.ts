/** @vitest-environment jsdom */

/**
 * The marketing pages honouring the scoresheet's appearance choice.
 *
 * The first test is the one that matters. `src/about/appearance.ts` repeats the storage key rather
 * than importing it, because importing across the entry boundary makes Rollup hoist a shared chunk
 * into the scorer's asset directory — see the note in that file, and the chunk-naming commentary in
 * `vite.config.ts`. Repeating a string is only safe if something notices when the two copies stop
 * agreeing, and this is that something.
 */
import { beforeEach, describe, expect, test } from 'vitest';
import startAppearance, { aboutAppearanceStorageKey } from '../src/about/appearance';
import { appearanceStorageKey } from '../src/app/displayPreference';

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('the deliberately duplicated storage key', () => {
  test('is the same key the scoresheet writes', () => {
    expect(aboutAppearanceStorageKey).toBe(appearanceStorageKey);
  });
});

describe('applying the choice to a prerendered page', () => {
  test('a scorekeeper who chose dark gets dark here too', () => {
    window.localStorage.setItem(aboutAppearanceStorageKey, 'dark');
    startAppearance();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  test('a scorekeeper who chose light overrides a device set to dark', () => {
    window.localStorage.setItem(aboutAppearanceStorageKey, 'light');
    startAppearance();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  /**
   * The default has to leave no attribute at all: `about.css` guards its dark block with
   * `:not([data-theme='light'])`, so anything written here that is not one of the two overrides
   * would take the device preference out of the picture rather than deferring to it.
   */
  test('following the device leaves the stylesheet to decide', () => {
    window.localStorage.setItem(aboutAppearanceStorageKey, 'system');
    startAppearance();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  test('a device that has never opened the scoresheet leaves the stylesheet to decide', () => {
    startAppearance();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  test('a value written by a build that knew more than this one is ignored, not applied', () => {
    window.localStorage.setItem(aboutAppearanceStorageKey, 'high-contrast-sepia');
    startAppearance();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
});
