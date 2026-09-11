#!/usr/bin/env node
/**
 * Whether `apps/qbtcp-relay-backend-cloudflare` is still deployable on its own.
 *
 * # The contract this protects
 *
 * "Deploy to Cloudflare" does not clone QBSheet. It copies *one directory* into a new repository
 * belonging to the tournament operator, runs `npm install` against the `package.json` in it, and
 * runs `wrangler deploy`. Nothing above that directory exists at any point. So every import the
 * deployed code makes, and every dependency the manifest declares, has to resolve inside the
 * directory — and the moment one does not, the failure lands on an operator pressing the deploy
 * button, not on anyone who can fix it.
 *
 * # Why CI could not already see this
 *
 * The relay's CI job (`cloudflare` in `.github/workflows/qblive.yml`) already runs `npm ci`,
 * `npm run typecheck`, and `npm test` *inside* the relay directory, which looks like the standalone
 * condition and is not: the directory is still sitting in a full QBSheet checkout, so
 * `file:../../packages/cloudflare-runtime-core` resolves, `../../../src/director/...` resolves, and
 * everything passes. The parent directory is the whole difference, and no check in the repository
 * removed it. That is how #840 and the QBBridge origin check both shipped a relay that the deploy
 * button could no longer build.
 *
 * # What this does
 *
 * Two tiers, because the cheap one should run everywhere and the expensive one should not:
 *
 * * `--static` (default, milliseconds, no network): copy nothing, but read the manifest and walk
 *   every module the standalone commands compile, resolving each relative import and rejecting any
 *   that escapes the package root — plus any bare specifier the manifest does not declare, and any
 *   `file:` / `link:` / `workspace:` dependency. This is what a unit test calls, so an ordinary CI
 *   run catches the ordinary regression.
 * * `--isolated` (minutes, installs from the registry): actually copy the directory to a temporary
 *   directory outside the repository, `npm install` there, and run `typecheck`, `test`, and a
 *   `wrangler deploy --dry-run` bundle. This is the real condition rather than a model of it —
 *   the static walk cannot know that a transitive dependency reaches back into the workspace, and
 *   the bundler can.
 *
 * Run both by hand with `node scripts/ci/relay-standalone.mjs --isolated`.
 */
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The package whose standalone deployability is the point. Repository-relative. */
export const RELAY_DIR = 'apps/qbtcp-relay-backend-cloudflare';

/**
 * Directories a copied relay must be able to compile, and the command that compiles each.
 *
 * `test-monorepo/` is deliberately absent: it is the cross-surface drift suite, it reaches into
 * the monorepo on purpose, and neither `npm test` nor `npm run typecheck` reads it. See
 * `apps/qbtcp-relay-backend-cloudflare/vitest.monorepo.config.ts`.
 */
const STANDALONE_ROOTS = ['src', 'test'];

/** Config files the standalone commands load, which are modules and can escape just as easily. */
const STANDALONE_CONFIGS = ['vitest.config.ts', 'wrangler.jsonc', 'tsconfig.json', 'package.json'];

/** Specifiers the Workers runtime and the test pool provide. Never resolved from `node_modules`. */
const RUNTIME_BUILTINS = new Set(['cloudflare:workers', 'cloudflare:test']);

/** A dependency spec that names a place on disk rather than a registry version. */
const LOCAL_SPEC = /^(file:|link:|workspace:|portal:|\.{1,2}\/)/;

const IMPORT = /(?:^|[\s;{}()])(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const REQUIRE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Every `.ts`/`.tsx`/`.mts`/`.js`/`.mjs` file under `dir`, recursively. */
function modulesUnder(dir) {
  const found = [];
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        walk(path);
      } else if (/\.(m?ts|tsx|m?js)$/.test(entry.name)) {
        found.push(path);
      }
    }
  };
  walk(dir);
  return found;
}

/** Every specifier `text` imports, however it spells the import. */
function specifiersIn(text) {
  const found = new Set();
  for (const pattern of [IMPORT, DYNAMIC_IMPORT, REQUIRE]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) found.add(match[1]);
  }
  return [...found];
}

/**
 * Declared dependency names, and every problem with how they are declared.
 *
 * A `file:` dependency is the exact shape that broke this package, so it is rejected by name
 * rather than only by the resolution walk: the walk sees a bare specifier that the manifest
 * declares and would be satisfied, while the copied repository has nothing to install from.
 */
function readManifest(root) {
  const problems = [];
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch (cause) {
    return { declared: new Set(), problems: [`package.json could not be read: ${cause.message}`] };
  }

  const declared = new Set();
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      declared.add(name);
      if (typeof spec === 'string' && LOCAL_SPEC.test(spec)) {
        problems.push(
          `package.json ${field}.${name} is "${spec}", which names a path that does not exist ` +
            'once Cloudflare copies this directory into a repository of its own',
        );
      }
    }
  }
  return { declared, problems };
}

/** The same check over the lockfile, which can outlive the manifest entry that created it. */
function lockfileProblems(root) {
  let lock;
  try {
    lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  } catch (cause) {
    return [`package-lock.json could not be read: ${cause.message}`];
  }
  const problems = [];
  for (const path of Object.keys(lock.packages ?? {})) {
    // npm records a linked workspace package under its resolved relative path.
    if (path.startsWith('../')) {
      problems.push(`package-lock.json records "${path}", which is outside this directory`);
    }
  }
  for (const [name, spec] of Object.entries(lock.packages?.['']?.dependencies ?? {})) {
    if (typeof spec === 'string' && LOCAL_SPEC.test(spec)) {
      problems.push(`package-lock.json root dependency ${name} is "${spec}"`);
    }
  }
  return problems;
}

/** Resolve a relative specifier the way a bundler would, tolerating an omitted extension. */
function resolveRelative(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.js`,
    `${base}.json`,
    join(base, 'index.ts'),
    join(base, 'index.js'),
  ];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* next */
    }
  }
  return base;
}

/**
 * Every way the package at `root` reaches outside itself.
 *
 * `root` is an absolute path to a relay directory — the one in the repository for the static
 * check, or the copied one. Returns a list of human-readable problems; empty means standalone.
 */
export function standaloneProblems(root) {
  const { declared, problems } = readManifest(root);
  problems.push(...lockfileProblems(root));

  const files = [
    ...STANDALONE_ROOTS.flatMap((dir) => modulesUnder(join(root, dir))),
    ...STANDALONE_CONFIGS.map((name) => join(root, name)).filter((path) => {
      try {
        return statSync(path).isFile() && /\.(m?ts|tsx|m?js)$/.test(path);
      } catch {
        return false;
      }
    }),
  ];

  for (const file of files) {
    const where = relative(root, file);
    for (const specifier of specifiersIn(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('.')) {
        const target = resolveRelative(file, specifier);
        const inside = relative(root, target);
        if (inside.startsWith('..') || inside.startsWith(`..${sep}`)) {
          problems.push(`${where} imports "${specifier}", which resolves outside this directory`);
        }
        continue;
      }
      if (specifier.startsWith('/')) {
        problems.push(`${where} imports "${specifier}" by absolute path`);
        continue;
      }
      if (RUNTIME_BUILTINS.has(specifier) || specifier.startsWith('node:')) continue;
      // `@scope/name/sub` and `name/sub` both install from the package named by the first
      // one or two segments.
      const parts = specifier.split('/');
      const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
      if (!declared.has(name)) {
        problems.push(
          `${where} imports "${specifier}", but package.json declares no dependency on "${name}"`,
        );
      }
    }
  }
  return problems;
}

/** Print and exit for the static check. */
function runStatic(repoRoot) {
  const problems = standaloneProblems(join(repoRoot, RELAY_DIR));
  if (problems.length === 0) {
    console.log(`${RELAY_DIR} is self-contained.`);
    return 0;
  }
  console.log(`${RELAY_DIR} reaches outside itself:`);
  for (const problem of problems) console.log(`  - ${problem}`);
  console.log('');
  for (const problem of problems) console.log(`::error::${problem}`);
  return 1;
}

/**
 * The real thing: copy the directory somewhere with no QBSheet above it, and build it there.
 *
 * The copy goes to the OS temporary directory rather than anywhere under the repository, because
 * "anywhere under the repository" still has a `package.json` above it and npm walks upwards.
 */
function runIsolated(repoRoot) {
  const source = join(repoRoot, RELAY_DIR);
  const scratch = mkdtempSync(join(tmpdir(), 'qbtcp-relay-standalone-'));
  const copy = join(scratch, 'relay');

  const run = (command, args, label) => {
    console.log(`\n$ ${command} ${args.join(' ')}`);
    try {
      const output = execFileSync(command, args, {
        cwd: copy,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CI: '1' },
      });
      console.log(output.trimEnd());
      return { ok: true, output };
    } catch (cause) {
      const output = `${cause.stdout ?? ''}${cause.stderr ?? ''}`;
      console.log(output.trimEnd());
      return { ok: false, output, label };
    }
  };

  try {
    cpSync(source, copy, {
      recursive: true,
      filter: (path) => {
        const name = relative(source, path);
        return !(
          name.startsWith('node_modules') ||
          name.startsWith('.wrangler') ||
          // The copy must fail the way Cloudflare's would, and Cloudflare copies the whole
          // directory — including the monorepo suite, which nothing standalone runs.
          false
        );
      },
    });
    console.log(`Copied ${RELAY_DIR} to ${copy} (nothing of QBSheet above it).`);

    const problems = standaloneProblems(copy);
    if (problems.length > 0) {
      for (const problem of problems) console.log(`::error::${problem}`);
      return 1;
    }

    const steps = [
      ['npm', ['install', '--no-audit', '--no-fund'], 'npm install'],
      ['npm', ['run', 'typecheck'], 'npm run typecheck'],
      ['npm', ['test'], 'npm test'],
      ['npx', ['wrangler', 'deploy', '--dry-run', '--outdir', join(scratch, 'bundle')], 'wrangler bundle'],
    ];

    const failures = [];
    for (const [command, args, label] of steps) {
      const result = run(command, args, label);
      if (!result.ok) failures.push(`${label} failed in the isolated copy`);
      // A step can succeed and still prove the boundary is gone — a resolution that silently
      // reached a sibling checkout, say. Any mention of a monorepo-only path is a failure.
      for (const marker of ['packages/cloudflare-runtime-core', 'src/director', '@qbsheet/']) {
        if (result.output.includes(marker) && !result.output.includes('@qbsheet/qbtcp-relay')) {
          failures.push(`${label} output mentions "${marker}", which cannot exist in the copy`);
        }
      }
    }

    if (failures.length > 0) {
      console.log('');
      for (const failure of failures) console.log(`::error::${failure}`);
      return 1;
    }
    console.log(`\n${RELAY_DIR} installs, typechecks, tests, and bundles with no QBSheet present.`);
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  process.exitCode = process.argv.includes('--isolated') ? runIsolated(repoRoot) : runStatic(repoRoot);
}
