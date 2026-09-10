import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcTauri = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri');

const bundleConfigs = [
  'tauri.conf.json',
  'tauri.macos.conf.json',
  'tauri.linux.conf.json',
  'tauri.windows.conf.json',
  'tauri.updater.conf.json',
];

describe('Director bundle configuration (#732)', () => {
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
        // The abandoned 0.1.0 macOS release died in actool — one opaque line,
        // after a full compile — because a platform config listed
        // icons/icon.icon, an Xcode Icon Composer source *directory*. Bundlers
        // need raster images, so a directory must fail here, in milliseconds,
        // instead of on the release runner.
        expect(statSync(path).isFile(), `${file} icon ${icon} is not a file`).toBe(true);
      }
    }
  });

  it('the macOS config keeps the documented deployment floor', () => {
    const raw = JSON.parse(readFileSync(join(srcTauri, 'tauri.macos.conf.json'), 'utf8')) as {
      bundle?: { macOS?: { minimumSystemVersion?: unknown } };
    };
    expect(raw.bundle?.macOS?.minimumSystemVersion).toBe('11.0');
  });
});
