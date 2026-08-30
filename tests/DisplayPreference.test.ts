/** @vitest-environment jsdom */

/**
 * Appearance and text size, as a device preference.
 *
 * Two things are being checked, and the second is the one with consequences. The first is ordinary:
 * a choice persists, an unknown value falls back, a reset clears. The second is that the choice
 * actually reaches the page — appearance as a `data-theme` attribute the stylesheets can select on,
 * text size as a root font size every `rem` in the application resolves against. A preference that
 * is stored perfectly and never applied is the bug worth catching, because it looks like it works.
 */
import { beforeEach, describe, expect, test } from 'vitest';
import {
  appearanceStorageKey,
  applyDisplayPreferences,
  clearDisplayPreferences,
  displayPreferences,
  loadAppearance,
  loadTextSize,
  resetDisplayPreferences,
  setAppearance,
  setTextSize,
  subscribeDisplayPreferences,
  textSizeScales,
  textSizeStorageKey,
} from '../src/app/displayPreference';

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.removeProperty('--room-text-scale');
  resetDisplayPreferences();
});

describe('what is stored', () => {
  test('defaults to following the device, in both directions', () => {
    expect(loadAppearance()).toBe('system');
    expect(loadTextSize()).toBe('standard');
  });

  test('remembers a deliberate override', () => {
    setAppearance('dark');
    setTextSize('large');
    expect(window.localStorage.getItem(appearanceStorageKey)).toBe('dark');
    expect(window.localStorage.getItem(textSizeStorageKey)).toBe('large');
    expect(loadAppearance()).toBe('dark');
    expect(loadTextSize()).toBe('large');
  });

  test('a value this build does not recognize reads as the default rather than as itself', () => {
    window.localStorage.setItem(appearanceStorageKey, 'sepia');
    window.localStorage.setItem(textSizeStorageKey, 'enormous');
    expect(loadAppearance()).toBe('system');
    expect(loadTextSize()).toBe('standard');
  });

  test('a device that refuses storage still answers, with the defaults', () => {
    expect(loadAppearance(null)).toBe('system');
    expect(loadTextSize(null)).toBe('standard');
  });
});

describe('what reaches the page', () => {
  test('a deliberate appearance is an attribute the stylesheets can select on', () => {
    applyDisplayPreferences('dark', 'standard');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    applyDisplayPreferences('light', 'standard');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  /**
   * The absence is load-bearing. `app-shell.css` guards its dark block with
   * `:not([data-theme='light'])`, so `system` has to leave no attribute at all — an attribute
   * spelling `system` would match neither guard and the device preference would stop working.
   */
  test('following the device leaves no attribute behind', () => {
    applyDisplayPreferences('dark', 'standard');
    applyDisplayPreferences('system', 'standard');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  test('text size is a multiplier on the root, so every rem in the application follows', () => {
    applyDisplayPreferences('system', 'large');
    expect(document.documentElement.style.getPropertyValue('--room-text-scale')).toBe(String(textSizeScales.large));

    applyDisplayPreferences('system', 'standard');
    expect(document.documentElement.style.getPropertyValue('--room-text-scale')).toBe('1');
  });

  test('the standard size is exactly the browser’s own preference, unscaled', () => {
    expect(textSizeScales.standard).toBe(1);
  });

  test('setting a preference applies it in the same turn as storing it', () => {
    setAppearance('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    setTextSize('comfortable');
    expect(document.documentElement.style.getPropertyValue('--room-text-scale')).toBe(
      String(textSizeScales.comfortable),
    );
  });
});

describe('the live value', () => {
  test('tells subscribers, so Settings and the scoresheet cannot disagree', () => {
    const seen: string[] = [];
    const unsubscribe = subscribeDisplayPreferences(() => seen.push(displayPreferences().appearance));

    setAppearance('dark');
    setAppearance('light');
    unsubscribe();
    setAppearance('system');

    expect(seen).toEqual(['dark', 'light']);
    // Still applied after unsubscribing; the subscription is for rendering, not for the effect.
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  test('setting the value it already has tells nobody', () => {
    let calls = 0;
    const unsubscribe = subscribeDisplayPreferences(() => {
      calls += 1;
    });
    setAppearance('system');
    unsubscribe();
    expect(calls).toBe(0);
  });

  test('returns a stable snapshot, so a subscriber is not handed a new object every render', () => {
    expect(displayPreferences()).toBe(displayPreferences());
  });
});

describe('resetting device preferences', () => {
  test('clears both, and returns the screen to the device in the same turn', () => {
    setAppearance('dark');
    setTextSize('large');

    expect(clearDisplayPreferences()).toBe(true);

    expect(window.localStorage.getItem(appearanceStorageKey)).toBeNull();
    expect(window.localStorage.getItem(textSizeStorageKey)).toBeNull();
    expect(displayPreferences()).toEqual({ appearance: 'system', textSize: 'standard' });
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(document.documentElement.style.getPropertyValue('--room-text-scale')).toBe('1');
  });

  test('leaves unrelated keys alone', () => {
    window.localStorage.setItem('qbsheet.unrelated-sentinel', 'kept');
    setAppearance('dark');
    clearDisplayPreferences();
    expect(window.localStorage.getItem('qbsheet.unrelated-sentinel')).toBe('kept');
  });
});
