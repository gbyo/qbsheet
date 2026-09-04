// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { isScorerPrecacheAsset } from '../vite.config';

test.each(['./', '/', '/school/qbsheet/'])(
  'standalone creator production assets work with BASE_PATH=%s without expanding scorer scope',
  (base) => {
    const dist = mkdtempSync(join(tmpdir(), 'qbsheet-package-build-'));
    try {
      execFileSync(
        process.execPath,
        ['node_modules/vite/bin/vite.js', 'build', '--outDir', dist, '--emptyOutDir'],
        {
          cwd: process.cwd(),
          env: { ...process.env, BASE_PATH: base },
          stdio: 'pipe',
        },
      );
      const html = readFileSync(join(dist, 'game-package-creator/index.html'), 'utf8');
      const prefix = base === './' ? '/project/' : base;
      const documentUrl = new URL(`${prefix}game-package-creator/index.html`, 'https://example.org');
      const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(
        (match) => new URL(match[1], documentUrl),
      );
      expect(assets.length).toBeGreaterThan(0);
      for (const asset of assets) {
        expect(asset.pathname.startsWith(prefix)).toBe(true);
        expect(existsSync(join(dist, asset.pathname.slice(prefix.length)))).toBe(true);
        if (base === './') expect(html).not.toMatch(/(?:src|href)="\//);
      }
      const worker = readFileSync(join(dist, 'sw.js'), 'utf8');
      const precache: string[] = JSON.parse(worker.match(/const PRECACHE = (\[[\s\S]*?\]);/)![1]);
      expect(precache).toContain('index.html');
      expect(precache.some((asset) => asset.includes('game-package-creator'))).toBe(false);
      expect(isScorerPrecacheAsset('game-package-creator/index.html')).toBe(false);
      expect(worker).toContain("relativePath.startsWith('game-package-creator/')");
      expect(worker).toContain('url.pathname !== scopeUrl.pathname && url.pathname !== scorerIndexPath');
      // Every creator-only asset belongs outside the shell, while shared editor/codec assets remain offline.
      expect(
        assets.some(
          (asset) =>
            asset.pathname.includes('/game-package-creator/assets/') && asset.pathname.endsWith('.css'),
        ),
      ).toBe(true);
      expect(precache.some((asset) => asset.includes('PortableGameSetup'))).toBe(true);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  },
  180_000,
);
