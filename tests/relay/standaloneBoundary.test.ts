/**
 * The QBTCP relay's deployment boundary, and the cost of owning it.
 *
 * `apps/qbtcp-relay-backend-cloudflare` is the one package in this repository that is not deployed
 * from this repository. "Deploy to Cloudflare" copies that directory alone into a new repository
 * belonging to a tournament operator, installs what its `package.json` declares, and runs
 * `wrangler deploy`. Nothing above it exists at that point, so an import that leaves the directory
 * is not a coupling to clean up later — it is a build failure an operator meets on the deploy
 * button.
 *
 * Two different things follow from that, and both are checked here:
 *
 * * **The boundary holds.** `scripts/ci/relay-standalone.mjs` walks what the standalone commands
 *   compile and rejects anything resolving outside the directory, any undeclared bare specifier,
 *   and any `file:`/`link:`/`workspace:` dependency. Running it from a unit test means the ordinary
 *   regression — someone adds a convenient import — fails in milliseconds on every CI run rather
 *   than in the operator's Cloudflare build log. The full isolated install-and-bundle is the same
 *   script with `--isolated`; CI runs it in its own job.
 *
 * * **The copies have not drifted.** Owning the boundary means the relay keeps its own
 *   implementations of four small helpers and its own copy of one constant. Duplication is the
 *   price of the boundary, and the price of duplication is that nothing stops the two halves
 *   diverging — except this file, which is the only place that can import both. The security
 *   properties are why it is worth the file: a `sha256Hex` whose encoding drifts invalidates every
 *   token hash already written for a live tournament, and a `timingSafeEqual` that gains an early
 *   return leaks credentials one character at a time.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  randomToken as relayRandomToken,
  sha256Hex as relaySha256Hex,
  timingSafeEqual as relayTimingSafeEqual,
  clampPage as relayClampPage,
} from '../../apps/qbtcp-relay-backend-cloudflare/src/protocol/credentials';
import { scoresheetOrigin as relayScoresheetOrigin } from '../../apps/qbtcp-relay-backend-cloudflare/src/protocol/cors';
import {
  randomToken as sharedRandomToken,
  sha256Hex as sharedSha256Hex,
  timingSafeEqual as sharedTimingSafeEqual,
} from '../../packages/cloudflare-runtime-core/src/credentials';
import { clampPage as sharedClampPage } from '../../packages/cloudflare-runtime-core/src/replay';
import { scoresheetOrigin as directorScoresheetOrigin } from '../../src/director/relay/relayConfig';
import { RELAY_DIR, standaloneProblems } from '../../scripts/ci/relay-standalone.mjs';

const root = new URL('../../', import.meta.url);
const relayRoot = new URL(`${RELAY_DIR}/`, root);

describe('the relay is deployable on its own', () => {
  it('reaches nothing outside its own directory', () => {
    // The whole regression, in one assertion. If this fails, read the message: it names the file
    // and the specifier, and the fix is to give the relay its own copy rather than to widen this.
    expect(standaloneProblems(fileURLToPath(relayRoot))).toEqual([]);
  });

  it('declares no dependency that only exists inside this repository', () => {
    // Checked separately from the walk above because it fails differently: a `file:` dependency
    // resolves perfectly in the monorepo and has nothing to install from in the copy, so the
    // import graph looks clean right up until the operator's build.
    const manifest = JSON.parse(readFileSync(new URL('package.json', relayRoot), 'utf8')) as Record<
      string,
      Record<string, string> | undefined
    >;
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
        expect(spec, `${field}.${name}`).not.toMatch(/^(file:|link:|workspace:|portal:|\.)/);
      }
    }
  });

  it('keeps the cross-surface suite out of the standalone commands', () => {
    // `test-monorepo/` is allowed to import the monorepo — that is what stops the relay's inlined
    // #770 contract drifting from the canonical fixtures. It is only safe because neither
    // `npm test` nor `npm run typecheck` reads it, which is what these two configs say.
    const vitest = readFileSync(new URL('vitest.config.ts', relayRoot), 'utf8');
    expect(vitest).toContain("include: ['test/**/*.test.ts']");
    const tsconfig = JSON.parse(readFileSync(new URL('tsconfig.json', relayRoot), 'utf8')) as {
      include: string[];
    };
    expect(tsconfig.include).toEqual(['src', 'test']);
    expect(tsconfig.include).not.toContain('test-monorepo');
  });
});

describe('the relay copies have not drifted from the shared package', () => {
  it('hashes to the same digest, in the same encoding', async () => {
    // Encoding is not cosmetic here: stored token hashes are compared as these strings, so a
    // change of case or padding silently invalidates every hash written for a live tournament.
    for (const value of ['', 'a', 'qbsheet', 'a longer credential with spaces', '🎓 unicode ✓']) {
      const relay = await relaySha256Hex(value);
      expect(relay).toBe(await sharedSha256Hex(value));
      expect(relay).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('compares credentials in constant time, and agrees about every answer', () => {
    const digest = 'a'.repeat(64);
    const cases: [string, string][] = [
      [digest, digest],
      [digest, `${'a'.repeat(63)}b`],
      [`b${'a'.repeat(63)}`, digest],
      [digest, ''],
      ['', ''],
      [digest, digest.slice(0, 63)],
    ];
    for (const [left, right] of cases) {
      expect(relayTimingSafeEqual(left, right), `${left.slice(0, 8)} vs ${right.slice(0, 8)}`).toBe(
        sharedTimingSafeEqual(left, right),
      );
    }
    expect(relayTimingSafeEqual(digest, digest)).toBe(true);
    expect(relayTimingSafeEqual(digest, `${'a'.repeat(63)}b`)).toBe(false);
  });

  it('scans the whole string rather than returning at the first difference', () => {
    // The property that makes the comparison constant-time, asserted on the source rather than by
    // timing: a timing test is flaky, and what actually goes wrong is someone rewriting the loop
    // as `if (left[i] !== right[i]) return false`. Both halves are read, so neither can drift into
    // an early return alone.
    const sources = [
      readFileSync(new URL('src/protocol/credentials.ts', relayRoot), 'utf8'),
      readFileSync(new URL('packages/cloudflare-runtime-core/src/credentials.ts', root), 'utf8'),
    ];
    for (const source of sources) {
      const body = source.slice(source.indexOf('export function timingSafeEqual'));
      const loop = body.slice(body.indexOf('for ('), body.indexOf('return difference === 0'));
      expect(loop).toContain('difference |=');
      expect(loop).not.toMatch(/\breturn\b/);
    }
  });

  it('mints tokens of the same shape', () => {
    for (const token of [relayRandomToken(), sharedRandomToken()]) {
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(relayRandomToken()).not.toBe(relayRandomToken());
  });

  it('clamps pages identically, including the non-finite floor', () => {
    const cases: [number, number, number][] = [
      [64, 1, 128],
      [0, 1, 128],
      [1000, 1, 128],
      [12.7, 1, 128],
      [-5, 1, 128],
      [Number.NaN, 1, 128],
      [Number.POSITIVE_INFINITY, 1, 128],
      [Number.NEGATIVE_INFINITY, 1, 128],
    ];
    for (const [value, low, high] of cases) {
      expect(relayClampPage(value, low, high), `clampPage(${value})`).toBe(sharedClampPage(value, low, high));
    }
  });

  it('agrees with Director about the ordinary Scorer origin', () => {
    // `manage/scorer-readiness` answers "can a scorekeeper who opens ordinary Scorer pair against
    // this relay", and Director renders the answer. If the two constants drift, the relay reports
    // readiness for an origin Director never sends a scorekeeper to, and the check becomes a
    // reassurance rather than a check.
    expect(relayScoresheetOrigin).toBe(directorScoresheetOrigin);
    expect(relayScoresheetOrigin).toBe('https://qbsheet.com');
  });
});
