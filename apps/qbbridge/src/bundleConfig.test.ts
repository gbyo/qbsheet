/**
 * The bundle configuration, checked in milliseconds rather than on a release runner.
 *
 * The same guard Director carries, for the same reason it was written: a `bundle.icon` list that
 * names `icons/icon.icon` kills a macOS build inside Xcode's `actool` with one opaque line, after
 * a full compile. `icon.icon` is an Icon Composer *source directory*, not an image. It lives in
 * the tree as the design input the raster icons were generated from, and it must never appear in
 * a `bundle.icon` list. See `docs/DIRECTOR_RELEASE.md`.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcTauri = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri');

const bundleConfigs = ['tauri.conf.json', 'tauri.macos.conf.json'];

describe('QBSheet Bridge bundle configuration', () => {
  it('every icon in every bundle config is a real image file', () => {
    for (const file of bundleConfigs) {
      const raw = JSON.parse(readFileSync(join(srcTauri, file), 'utf8')) as {
        bundle?: { icon?: unknown };
      };
      const icons = raw.bundle?.icon;
      if (icons === undefined) continue;
      expect(Array.isArray(icons), `${file} bundle.icon is not a list`).toBe(true);
      for (const icon of icons as unknown[]) {
        expect(typeof icon, `${file} has a non-path icon entry`).toBe('string');
        const path = join(srcTauri, icon as string);
        expect(existsSync(path), `${file} references missing icon ${icon}`).toBe(true);
        expect(statSync(path).isFile(), `${file} icon ${icon} is not a file`).toBe(true);
      }
    }
  });

  it('the Icon Composer source is present and is not bundled', () => {
    expect(statSync(join(srcTauri, 'icons/icon.icon')).isDirectory()).toBe(true);
    for (const file of bundleConfigs) {
      expect(readFileSync(join(srcTauri, file), 'utf8')).not.toContain('icon.icon');
    }
  });

  it('the window and the product are both named QBSheet Bridge', () => {
    const raw = JSON.parse(readFileSync(join(srcTauri, 'tauri.conf.json'), 'utf8')) as {
      productName?: string;
      identifier?: string;
      app?: { windows?: { title?: string }[] };
    };
    expect(raw.productName).toBe('QBSheet Bridge');
    expect(raw.identifier).toBe('com.qbsheet.bridge');
    expect(raw.app?.windows?.[0]?.title).toBe('QBSheet Bridge');
  });

  it('the macOS config keeps the same deployment floor Director ships against', () => {
    const raw = JSON.parse(readFileSync(join(srcTauri, 'tauri.macos.conf.json'), 'utf8')) as {
      bundle?: { macOS?: { minimumSystemVersion?: unknown } };
    };
    expect(raw.bundle?.macOS?.minimumSystemVersion).toBe('11.0');
  });
});
