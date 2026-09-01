// @vitest-environment node

/**
 * That a device in airplane mode has the arcade already.
 *
 * The games are behind a dynamic `import()`, which is the whole reason a reloading Chromebook does
 * not pay for them — and it is also the thing that would quietly make them a *network* feature if
 * their chunk ever fell outside the offline shell. There is no runtime check that could catch that:
 * the arcade would work perfectly in every test and on every developer's machine, and fail on the
 * one device that matters, in a gym, with no network.
 *
 * So this asks the build. It runs the real one and asserts that the arcade's JavaScript and its
 * stylesheet are both named in the service worker's precache list, which is the list the worker
 * writes into the cache when it installs — before anybody has opened the arcade at all.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { isScorerPrecacheAsset } from '../vite.config';

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * Into a directory of this file's own, and never into `dist/`.
 *
 * `WikiBuild.test.ts` also builds, vitest runs test files in parallel workers, and two Vite builds
 * writing the same output directory at once produce a `dist/` that neither of them described — which
 * shows up as a dozen unrelated suites failing for reasons that have nothing to do with either.
 */
let dist = '';

beforeAll(() => {
  dist = mkdtempSync(join(tmpdir(), 'qbsheet-arcade-build-'));
  execFileSync('npx', ['vite', 'build', '--outDir', dist, '--emptyOutDir'], {
    cwd: root,
    env: { ...process.env, BASE_PATH: './' },
    stdio: 'inherit',
  });
}, 180_000);

afterAll(() => {
  if (dist !== '') rmSync(dist, { recursive: true, force: true });
});

/** The names in the generated worker's `PRECACHE`, which is a literal array in its source. */
function precachedAssets(): string[] {
  const worker = readFileSync(join(dist, 'sw.js'), 'utf8');
  const list = worker.match(/const PRECACHE = (\[[\s\S]*?\]);/);
  if (list === null) throw new Error('The generated service worker has no PRECACHE list.');
  return JSON.parse(list[1]) as string[];
}

describe('the arcade chunk in a production build', () => {
  test('is emitted as an ordinary scorer asset rather than an unreachable one', () => {
    const emitted = readdirSync(join(dist, 'assets'));
    const arcade = emitted.filter((name) => name.startsWith('ArcadeDialog-'));

    // Its code and its stylesheet, both content-hashed, both under `assets/`.
    expect(arcade.filter((name) => name.endsWith('.js'))).toHaveLength(1);
    expect(arcade.filter((name) => name.endsWith('.css'))).toHaveLength(1);
    arcade.forEach((name) => expect(isScorerPrecacheAsset(`assets/${name}`)).toBe(true));
  });

  test('is precached, so airplane mode and a blocked network both still open it', () => {
    const precache = precachedAssets();
    const arcade = precache.filter((name) => name.includes('ArcadeDialog-'));

    expect(arcade.filter((name) => name.endsWith('.js'))).toHaveLength(1);
    expect(arcade.filter((name) => name.endsWith('.css'))).toHaveLength(1);
  });

  test('is the only chunk the games are in, so nothing else drags them in', () => {
    const assets = join(dist, 'assets');
    /*
     * A string literal rather than an identifier: the build minifies, so `qbbirdWorld` and every
     * other name in the file is gone from the output, while the text QBBird paints on its ready
     * screen survives verbatim and is written nowhere else in the repository.
     */
    const marker = 'Space, Arrow Up, or tap to flap';
    const carriers = readdirSync(assets)
      .filter((name) => name.endsWith('.js'))
      .filter((name) => readFileSync(join(assets, name), 'utf8').includes(marker));

    expect(carriers).toHaveLength(1);
    expect(carriers[0]).toMatch(/^ArcadeDialog-/);
  });
});
