/**
 * Which parts of QBSheet a set of changed files can affect.
 *
 * # Why this exists
 *
 * Every job in `.github/workflows/ci.yml` used to run on every change, so a Swift file, a Cloudflare
 * Worker, a Rust crate, or a README ran the Playwright scorer torture test. That test protects the
 * browser scoresheet, and none of those files can reach it.
 *
 * The rule this module implements is the only one that matters:
 *
 * > A test runs when a changed file could affect what that test protects.
 *
 * The direction of the safety is asymmetric on purpose. Failing to run a scorer check on a change
 * that can break the scorer is a tournament-day defect. Running a scorer check on a change that
 * cannot is a wasted runner minute. So every uncertainty resolves toward *more* testing: an
 * unrecognised path turns every domain on and says so in the log.
 *
 * # The dependency map, derived from the repository
 *
 * The facts below were read out of the imports, the package manifests, the build configs and the
 * `Cargo.toml` files rather than assumed. They are what the rules encode.
 *
 * * Nothing outside `src/director/` imports `src/director/`, and `src/director/` reaches back into
 *   the scorer tree for exactly two modules (`src/BrandLogo`, `src/qbj/ParseQbjAssignment`). So
 *   Director web code cannot change scorer runtime behaviour, and the browser torture test does not
 *   need to run for it. `e2e/Director.spec.ts` still does — the `director-web` job runs it.
 * * `apps/director/` is a thin Vite/Tauri shell whose `src/main.tsx` imports `src/director/`. Its
 *   build is therefore the real compile of the Director web application.
 * * The scorer proper imports no `@qbsheet/*` workspace package. Only `src/director/` does
 *   (`tournament-core`, `tournament-domain`, `tournament-formats`, `qblive-protocol`,
 *   `qblive-projection`), which is why a tournament or QBLive package change routes to
 *   `director-web` and not to the scorer.
 * * There is no Cargo workspace. Each crate has its own `Cargo.toml` and `Cargo.lock`, so the three
 *   Rust jobs are genuinely independent — with one real edge:
 *   `apps/director/src-tauri/Cargo.toml` path-depends on `crates/qbtcp-server`, so a QBTCP change
 *   must also build the Director crate.
 * * `wiki/` is not prose to CI. `vite.config.ts` reads it at build time to prerender
 *   `about/wiki/<slug>/index.html`, and `e2e/Wiki.spec.ts` opens those pages.
 * * `.github/workflows/qblive.yml` owns the QBLive packages, apps, and iOS. It has its own path
 *   filter over exactly those paths, so the regular CI does not duplicate its work. What the
 *   regular CI keeps for those paths is the coverage `qblive.yml` does *not* provide: repository
 *   formatting and lint.
 *
 * # Reading the rules
 *
 * `RULES` is ordered and the first match wins, so put a specific path above the tree that contains
 * it. `quality` is not listed on most rules because it is derived: see `qualityFor`.
 */

/** Every domain `ci.yml` can route to. These strings are the `changes` job's output names. */
export const DOMAINS = [
  'quality',
  'scorer',
  'scorer-browser',
  'director-web',
  'tournament-js',
  'qblive-js',
  'rust-director',
  'rust-tournament-store',
  'rust-qbtcp',
];

/** A one-line description of each domain, for the step summary. */
export const DOMAIN_LABELS = {
  quality: 'Formatting, lint, and typecheck',
  scorer: 'Scorer unit and integration tests, and the project-path build',
  'scorer-browser': 'Playwright scorer torture test',
  'director-web': 'Director frontend build and tests',
  'tournament-js': 'Tournament core, formats, and domain packages',
  'qblive-js': 'QBSheet Live protocol, projection, activity, conformance, and Live Web',
  'rust-director': 'Director native crate (apps/director/src-tauri)',
  'rust-tournament-store': 'tournament-store crate',
  'rust-qbtcp': 'qbtcp-server crate',
};

/** Everything. What an unrecognised path, or an unreadable lockfile, resolves to. */
const ALL = DOMAINS;

/** Every JavaScript domain. What a change to the root manifest or the root TypeScript config means. */
const ALL_JS = ['quality', 'scorer', 'scorer-browser', 'director-web', 'tournament-js', 'qblive-js'];

const SCORER = ['scorer', 'scorer-browser'];

/**
 * Path rules, in order. The first whose glob matches a changed file decides that file.
 *
 * `domains: []` means "no job in `ci.yml` protects this file". That is a claim about *this*
 * workflow, not about the file being untested: `ios/**` is tested by `qblive.yml`, and `docs/**` is
 * prose. Anything that is neither gets a rule or it falls through to the fail-safe.
 */
export const RULES = [
  // ---------------------------------------------------------------------------------------------
  // The router itself. A change here has to be validated by the jobs it routes, so it runs them all.
  // ---------------------------------------------------------------------------------------------
  {
    glob: '.github/workflows/ci.yml',
    domains: ALL,
    why: 'the CI routing under change; run every domain so the routing is exercised',
  },
  {
    glob: 'scripts/ci/**',
    domains: ALL,
    why: 'the impact classifier itself; run every domain so the routing is exercised',
  },

  // ---------------------------------------------------------------------------------------------
  // Rust. No Cargo workspace, so the crates are independent except for one path dependency.
  // ---------------------------------------------------------------------------------------------
  {
    glob: 'crates/qbtcp-server/**',
    domains: ['rust-qbtcp', 'rust-director'],
    why: 'apps/director/src-tauri/Cargo.toml path-depends on crates/qbtcp-server',
  },
  {
    glob: 'crates/tournament-store/**',
    domains: ['rust-tournament-store'],
    why: 'a standalone crate; nothing else depends on it',
  },
  {
    glob: 'apps/director/src-tauri/**',
    domains: ['rust-director'],
    why: 'the Director native crate',
  },

  // ---------------------------------------------------------------------------------------------
  // Owned by `.github/workflows/qblive.yml`, which has its own path filter over these paths.
  // The regular CI contributes only the repository-wide formatting and lint that qblive.yml lacks,
  // and that arrives through `qualityFor` rather than through these rules.
  // ---------------------------------------------------------------------------------------------
  { glob: 'ios/**', domains: [], why: 'iOS is built and tested by qblive.yml' },
  {
    glob: 'apps/qblive-backend-cloudflare/**',
    domains: [],
    why: 'the Cloudflare backend runs in workerd, in qblive.yml',
  },
  { glob: 'apps/qblive-push/**', domains: [], why: 'the push gateway runs in workerd, in qblive.yml' },
  { glob: 'apps/qblive-push-prototype/**', domains: [], why: 'a prototype, exercised by qblive.yml' },
  {
    glob: 'apps/live-web/**',
    domains: [],
    why: 'Live Web is built, tested, and size-gated by qblive.yml',
  },
  {
    // `src/director/` imports the protocol and the projection, so Director web still has to compile.
    // The protocol and projection suites themselves belong to qblive.yml.
    glob: 'packages/qblive-protocol/**',
    domains: ['director-web'],
    why: 'src/director/live imports @qbsheet/qblive-protocol; the protocol suite is in qblive.yml',
  },
  {
    glob: 'packages/qblive-projection/**',
    domains: ['director-web'],
    why: 'src/director/live imports @qbsheet/qblive-projection; the privacy sweep is in qblive.yml',
  },
  {
    glob: 'packages/qblive-activity/**',
    domains: [],
    why: 'the ActivityKit payload package, measured in qblive.yml',
  },
  {
    glob: 'packages/qblive-conformance/**',
    domains: [],
    why: 'the conformance suite, run against a real backend in qblive.yml',
  },

  // ---------------------------------------------------------------------------------------------
  // Tournament packages. Consumed by `src/director/` and `apps/director/`, and by nothing in the
  // scorer. `tournament-domain` is also a QBLive dependency, and qblive.yml lists it in its filter.
  // ---------------------------------------------------------------------------------------------
  {
    glob: 'packages/tournament-core/**',
    domains: ['tournament-js', 'director-web'],
    why: 'consumed by src/director and apps/director',
  },
  {
    glob: 'packages/tournament-formats/**',
    domains: ['tournament-js', 'director-web'],
    why: 'consumed by src/director and apps/director',
  },
  {
    glob: 'packages/tournament-domain/**',
    domains: ['tournament-js', 'director-web'],
    why: 'consumed by src/director; the QBLive side is covered by qblive.yml',
  },
  {
    glob: 'packages/**',
    domains: ALL_JS,
    why: 'an unmapped workspace package; run every JavaScript domain until it has a rule',
  },

  // ---------------------------------------------------------------------------------------------
  // Director web.
  // ---------------------------------------------------------------------------------------------
  { glob: 'apps/director/README.md', domains: [], why: 'prose' },
  {
    glob: 'apps/director/**',
    domains: ['director-web'],
    why: 'the Director Vite/Tauri shell and its frontend sources',
  },
  {
    glob: 'src/director/**',
    domains: ['director-web'],
    why: 'nothing outside src/director imports src/director, so the scorer cannot be affected',
  },
  {
    // A root build input as well as the Director entry, so the project-path build has to run.
    glob: 'director.html',
    domains: ['director-web', 'scorer'],
    why: 'the Director entry document, and an input to the root site build',
  },

  // ---------------------------------------------------------------------------------------------
  // Scorer.
  // ---------------------------------------------------------------------------------------------
  { glob: 'src/**', domains: SCORER, why: 'scorer runtime source' },
  { glob: 'index.html', domains: SCORER, why: 'the scorer entry document' },
  { glob: 'about/**', domains: SCORER, why: 'prerendered product pages, opened by the browser suite' },
  { glob: 'public/**', domains: SCORER, why: 'served assets, the manifest, and the offline shell' },
  {
    glob: 'wiki/**',
    domains: SCORER,
    why: 'vite.config.ts prerenders these pages at build time and e2e/Wiki.spec.ts opens them',
  },
  {
    // A unit test cannot change what the browser does, so this stops at `scorer`.
    glob: 'tests/**',
    domains: ['scorer'],
    why: 'the root Vitest suite, which the scorer job runs',
  },
  {
    glob: 'e2e/Director.spec.ts',
    domains: ['director-web'],
    why: 'the Director browser spec, which the director-web job runs on its own',
  },
  {
    glob: 'e2e/support/**',
    domains: ['scorer-browser', 'director-web'],
    why: 'shared Playwright helpers, read by both browser runs',
  },
  { glob: 'e2e/**', domains: ['scorer-browser'], why: 'the Playwright scorer specs' },
  {
    glob: 'playwright.config.ts',
    domains: ['scorer-browser', 'director-web'],
    why: 'both Playwright runs read it',
  },
  {
    glob: 'vite.config.ts',
    domains: ['scorer', 'scorer-browser', 'director-web'],
    why: 'the scorer build, the service worker, and the Director chunking all live here',
  },
  {
    glob: 'vitest.config.ts',
    domains: ['scorer', 'director-web'],
    why: 'the root unit-test projects; it cannot reach the browser suite',
  },
  {
    glob: 'scripts/write-core-package.mjs',
    domains: ['scorer'],
    why: 'writes the core package manifest during npm run build:core',
  },
  {
    glob: 'scripts/generate-wiki-pages.mjs',
    domains: SCORER,
    why: 'writes the about/wiki build entries',
  },
  { glob: 'scripts/**', domains: SCORER, why: 'an unmapped build script; assume it reaches the build' },

  // ---------------------------------------------------------------------------------------------
  // Shared configuration.
  // ---------------------------------------------------------------------------------------------
  {
    // Every packages/*/tsconfig.json extends this one, so it reaches every TypeScript domain.
    glob: 'tsconfig.json',
    domains: ALL_JS,
    why: 'the root TypeScript config, extended by every workspace package',
  },
  { glob: 'tsconfig.build.json', domains: ['scorer'], why: 'the production type check' },
  { glob: 'tsconfig.core.json', domains: ['scorer'], why: 'the core export build' },
  {
    // A lint or format rule cannot change what any product does. It can only change whether the
    // quality job passes, and `qualityFor` turns that on for these files.
    glob: 'eslint.config.js',
    domains: [],
    why: 'lint configuration; reaches the quality job only',
  },
  { glob: '.prettierrc.json', domains: [], why: 'format configuration; reaches the quality job only' },
  { glob: '.prettierignore', domains: [], why: 'format configuration; reaches the quality job only' },
  {
    glob: 'stryker.config.json',
    domains: [],
    why: 'read only by the scheduled scoring-mutation workflow',
  },

  // ---------------------------------------------------------------------------------------------
  // The root manifest and lockfile.
  //
  // `package-lock.json` is handled before the rules run — see `classifyLockfile` — because
  // "the lockfile changed, so run the scorer" would defeat the whole exercise: a QBLive or
  // workspace-only install rewrites the root lockfile. `package.json` gets no such treatment. Its
  // `scripts` block is what every CI step invokes and its dependency ranges are the scorer's own,
  // and neither is visible in the lockfile diff, so a change to it runs every JavaScript domain.
  // ---------------------------------------------------------------------------------------------
  {
    glob: 'package.json',
    domains: ALL_JS,
    why: 'the root manifest: the scorer dependency ranges and every CI script live in it',
  },

  // ---------------------------------------------------------------------------------------------
  // Documentation, repository furniture, and other workflows.
  // ---------------------------------------------------------------------------------------------
  { glob: 'docs/**', domains: [], docs: true, why: 'specifications and prose' },
  { glob: '*.md', domains: [], docs: true, why: 'prose' },
  { glob: 'LICENSE', domains: [], docs: true, why: 'prose' },
  { glob: '.github/ISSUE_TEMPLATE/**', domains: [], docs: true, why: 'issue forms' },
  { glob: '.github/PULL_REQUEST_TEMPLATE.md', domains: [], docs: true, why: 'prose' },
  { glob: '.github/CODEOWNERS', domains: [], docs: true, why: 'review routing' },
  { glob: '.github/FUNDING.yml', domains: [], docs: true, why: 'repository furniture' },
  { glob: '.github/dependabot.yml', domains: [], docs: true, why: 'repository furniture' },
  { glob: '.github/labeler.yml', domains: [], docs: true, why: 'repository furniture' },
  {
    // Every other workflow carries its own path filter, and that filter includes the workflow file.
    // Routing a qblive.yml edit through the scorer jobs would test nothing about the edit.
    glob: '.github/workflows/**',
    domains: [],
    why: 'another workflow, which filters on its own paths and on itself',
  },
  { glob: '.gitignore', domains: [], docs: true, why: 'repository furniture' },
  { glob: '.git-blame-ignore-revs', domains: [], docs: true, why: 'repository furniture' },
];

/**
 * The files repository-wide formatting, lint, and typecheck actually inspect.
 *
 * `npm run format:check` is Prettier over `**\/*.{ts,tsx,js,mjs,css}`, `npm run lint` is `eslint .`
 * over the same shapes, and `npm run typecheck` covers `src`, `tests`, `e2e`, the root configs and
 * `scripts`. So the quality job is worth running for exactly those extensions and for the three
 * configs that decide what they mean. A Swift file, a `.plist`, a `.rs`, or a `.md` is none of them.
 */
const QUALITY_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.css'];

/** Generated trees that `eslint.config.js` and `.prettierignore` both exclude. */
const QUALITY_IGNORED = [
  'dist/',
  'node_modules/',
  'target/',
  'coverage/',
  'playwright-report/',
  'test-results/',
  '.stryker-tmp/',
  '.wrangler/',
];

/** The configs that decide what formatting, lint, and typecheck mean. */
const QUALITY_CONFIGS = [
  'eslint.config.js',
  '.prettierrc.json',
  '.prettierignore',
  'tsconfig.json',
  'package.json',
  'package-lock.json',
];

/** Whether `quality` has to run because of this one file. */
export function qualityFor(path) {
  if (QUALITY_CONFIGS.includes(path)) return true;
  const segments = `/${path}`;
  for (const ignored of QUALITY_IGNORED) {
    if (segments.includes(`/${ignored}`)) return false;
  }
  return QUALITY_EXTENSIONS.some((extension) => path.endsWith(extension));
}

/** A glob with `**` and `*`, anchored at both ends. `*` does not cross a directory separator. */
function globToRegExp(glob) {
  let pattern = '';
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === '*') {
      if (glob[index + 1] === '*') {
        // `a/**` matches `a/b` and `a/b/c`, and `**/a` matches `a` as well as `b/a`.
        if (glob[index + 2] === '/') {
          pattern += '(?:.*/)?';
          index += 2;
        } else {
          pattern += '.*';
          index += 1;
        }
      } else {
        pattern += '[^/]*';
      }
      continue;
    }
    pattern += character.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${pattern}$`);
}

const COMPILED = RULES.map((rule) => ({ ...rule, pattern: globToRegExp(rule.glob) }));

/** The first rule that matches, or `undefined` when the path is unrecognised. */
export function ruleFor(path) {
  return COMPILED.find((rule) => rule.pattern.test(path));
}

// -------------------------------------------------------------------------------------------------
// The root lockfile.
// -------------------------------------------------------------------------------------------------

/**
 * npm hoists every workspace dependency into the root `node_modules`, so a QBLive install and a
 * scorer install look identical in the lockfile's key list: both are `node_modules/<name>` entries.
 * Attribution by install path is therefore impossible in this repository, and the two crude answers
 * are both wrong — "any lockfile change runs the scorer" makes this whole exercise pointless
 * because every workspace install rewrites the root lockfile, and "ignore lockfile changes" misses
 * a real scorer dependency update.
 *
 * What the lockfile does still record exactly is *who asked for what*: `packages[""]` holds the root
 * project's own ranges, and `packages["apps/live-web"]` holds that workspace's. So the question
 * "can this dependency reach the scorer?" is answered by walking the lockfile's own resolution from
 * each project's direct dependencies and seeing which projects reach the entries that changed.
 *
 * A changed entry that no project reaches, an unmapped workspace, and an unreadable lockfile all
 * fail safe: the caller runs everything.
 */

/** The lockfile keys that are projects in this repository rather than installed packages. */
function projectKeys(packages) {
  return Object.keys(packages).filter((key) => key === '' || !key.includes('node_modules/'));
}

/** Resolve `name` as Node would from `directory`, against a lockfile's flat key space. */
function resolveFrom(packages, directory, name) {
  const parts = directory === '' ? [] : directory.split('/');
  for (;;) {
    const key = [...parts, 'node_modules', name].join('/');
    if (packages[key]) return key;
    if (parts.length === 0) return undefined;
    parts.pop();
  }
}

/** The directory an installed package's own dependencies resolve from. */
function installDirectory(key) {
  const index = key.lastIndexOf('node_modules/');
  return key.slice(0, index).replace(/\/$/, '');
}

/**
 * Every lockfile entry reachable from one project.
 *
 * `devDependencies` count for the project itself, because npm installs a workspace's dev
 * dependencies. They do not count for a registry package, whose dev dependencies are never
 * installed.
 *
 * The walk **stops at a workspace link**. `node_modules/@qbsheet/tournament-formats` is recorded,
 * because a change to the link entry itself is a change the linking project sees, but the walk does
 * not continue into `packages/tournament-formats`. That workspace has its own closure, and letting
 * the root swallow it would put every workspace's dependencies inside the root's closure — which
 * would make `npm install --workspace` anywhere in the monorepo run the scorer browser suite, the
 * exact outcome this module exists to avoid. The root's *own* direct dependencies are still the
 * shared toolchain every workspace runs on, which is why the root project maps to every JavaScript
 * domain in `LOCKFILE_PROJECT_DOMAINS`.
 */
function closureFor(packages, projectKey) {
  const reached = new Set();
  const queue = [];
  const enqueue = (directory, entry, withDev) => {
    if (!entry) return;
    const names = [
      ...Object.keys(entry.dependencies ?? {}),
      ...Object.keys(entry.optionalDependencies ?? {}),
      ...(withDev ? Object.keys(entry.devDependencies ?? {}) : []),
    ];
    for (const name of names) queue.push([directory, name]);
  };

  enqueue(projectKey, packages[projectKey], true);
  while (queue.length > 0) {
    const [directory, name] = queue.pop();
    const key = resolveFrom(packages, directory, name);
    if (key === undefined || reached.has(key)) continue;
    reached.add(key);
    const entry = packages[key];
    if (entry.link === true) continue;
    enqueue(installDirectory(key), entry, false);
  }
  return reached;
}

/** Deep structural equality, enough for the plain JSON a lockfile entry is. */
function sameEntry(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** The fields of a lockfile entry that decide what gets installed. */
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

/**
 * Whether a *project* entry's dependency declarations changed.
 *
 * Compared field by field rather than whole, because a project entry also carries `workspaces`,
 * `license`, `version`, and `engines`. Adding `apps/live-web` to the root `workspaces` list changes
 * the root entry without changing a single thing the root project installs, and reading that as a
 * root dependency change would run the scorer browser suite for every new workspace.
 */
function sameDeclarations(left, right) {
  return DEPENDENCY_FIELDS.every((field) => sameEntry(left?.[field], right?.[field]));
}

/**
 * Which lockfile projects a `package-lock.json` change reaches.
 *
 * Returns the project keys, plus the entries no project explains. Both lockfiles are consulted for
 * reachability, so a dependency that was removed is attributed from the base and one that was added
 * is attributed from the head.
 */
export function lockfileProjects(base, head) {
  const basePackages = base?.packages ?? {};
  const headPackages = head?.packages ?? {};
  const keys = new Set([...Object.keys(basePackages), ...Object.keys(headPackages)]);

  const isProject = (key) => key === '' || !key.includes('node_modules/');
  const changed = [...keys].filter((key) =>
    isProject(key)
      ? !sameDeclarations(basePackages[key], headPackages[key])
      : !sameEntry(basePackages[key], headPackages[key]),
  );
  if (changed.length === 0) return { projects: [], unexplained: [] };

  const projects = new Set();
  const closures = new Map();
  for (const packages of [basePackages, headPackages]) {
    for (const key of projectKeys(packages)) {
      const existing = closures.get(key) ?? new Set();
      for (const reached of closureFor(packages, key)) existing.add(reached);
      closures.set(key, existing);
    }
  }

  // npm writes a `node_modules/<name>` link for every workspace whether anything depends on it or
  // not — `@qbsheet/live-web` and `@qbsheet/qblive-conformance` are nobody's dependency. Those
  // links are reachable from no project, so they are attributed to the workspace they point at
  // rather than being reported as unexplained.
  const linkTargets = new Map();
  for (const packages of [basePackages, headPackages]) {
    for (const [key, entry] of Object.entries(packages)) {
      if (entry?.link === true && typeof entry.resolved === 'string' && packages[entry.resolved]) {
        linkTargets.set(key, entry.resolved);
      }
    }
  }

  const unexplained = [];
  for (const key of changed) {
    let explained = false;
    if (closures.has(key)) {
      // A project's own manifest entry changed: its ranges, its name, or its workspace list.
      projects.add(key);
      explained = true;
    }
    const target = linkTargets.get(key);
    if (target !== undefined) {
      projects.add(target);
      explained = true;
    }
    for (const [project, closure] of closures) {
      if (closure.has(key)) {
        projects.add(project);
        explained = true;
      }
    }
    if (!explained) unexplained.push(key);
  }

  return { projects: [...projects].sort(), unexplained };
}

/**
 * What each lockfile project means for CI.
 *
 * The root project is every JavaScript domain and not a subset. npm hoists, so the root's
 * `devDependencies` are the `vitest`, `typescript`, and `vite` that every workspace actually runs
 * with, and a bump to one of them can change any of their results.
 */
export const LOCKFILE_PROJECT_DOMAINS = {
  '': ALL_JS,
  'apps/director': ['director-web'],
  'apps/live-web': ['qblive-js'],
  'packages/tournament-core': ['tournament-js', 'director-web'],
  'packages/tournament-domain': ['tournament-js', 'director-web'],
  'packages/tournament-formats': ['tournament-js', 'director-web'],
  'packages/qblive-protocol': ['qblive-js', 'director-web'],
  'packages/qblive-projection': ['qblive-js', 'director-web'],
  'packages/qblive-activity': ['qblive-js'],
  'packages/qblive-conformance': ['qblive-js'],
};

// -------------------------------------------------------------------------------------------------
// Classification.
// -------------------------------------------------------------------------------------------------

/**
 * Classify a set of changed paths.
 *
 * `lockfiles` is `{ base, head }`, each a parsed root `package-lock.json` or `null`. It is only
 * consulted when `package-lock.json` is among the changed paths. `null` on either side means the
 * comparison could not be made, which fails safe to every domain.
 */
export function classify(paths, lockfiles = { base: null, head: null }) {
  const domains = Object.fromEntries(DOMAINS.map((domain) => [domain, false]));
  /** For each domain, the changed files that turned it on. */
  const because = Object.fromEntries(DOMAINS.map((domain) => [domain, []]));
  const unclassified = [];
  const notes = [];
  let allProse = paths.length > 0;

  const turnOn = (list, path) => {
    for (const domain of list) {
      if (!DOMAINS.includes(domain)) throw new Error(`Unknown domain in a rule: ${domain}`);
      domains[domain] = true;
      if (!because[domain].includes(path)) because[domain].push(path);
    }
  };

  for (const path of paths) {
    if (qualityFor(path)) turnOn(['quality'], path);

    if (path === 'package-lock.json') {
      allProse = false;
      const { projects, unexplained } = lockfileProjects(lockfiles.base, lockfiles.head);
      if (lockfiles.base === null || lockfiles.head === null) {
        notes.push(
          'package-lock.json changed but could not be compared against the base, so every domain runs.',
        );
        turnOn(ALL, path);
      } else if (unexplained.length > 0) {
        notes.push(
          `package-lock.json changed ${unexplained.length} entr${unexplained.length === 1 ? 'y' : 'ies'} ` +
            `no workspace explains (${unexplained.slice(0, 5).join(', ')}), so every domain runs.`,
        );
        turnOn(ALL, path);
      } else if (projects.length === 0) {
        notes.push('package-lock.json changed in a way that reaches no workspace, so nothing routes to it.');
      } else {
        for (const project of projects) {
          const mapped = LOCKFILE_PROJECT_DOMAINS[project];
          if (mapped === undefined) {
            notes.push(`package-lock.json touches the unmapped workspace ${project}, so every domain runs.`);
            turnOn(ALL, path);
          } else {
            turnOn(mapped, path);
          }
        }
        notes.push(
          `package-lock.json resolves to: ${projects.map((project) => (project === '' ? '<root>' : project)).join(', ')}.`,
        );
      }
      continue;
    }

    const rule = ruleFor(path);
    if (rule === undefined) {
      // The fail-safe. An unfamiliar source or config file is never assumed harmless.
      allProse = false;
      unclassified.push(path);
      turnOn(ALL, path);
      continue;
    }
    if (rule.docs !== true) allProse = false;
    turnOn(rule.domains, path);
  }

  const any = DOMAINS.some((domain) => domains[domain]);
  return {
    files: paths,
    domains,
    because,
    unclassified,
    notes,
    /** Every changed file is prose: documentation, a licence, or repository furniture. */
    'docs-only': allProse,
    /** No job in `ci.yml` protects anything that changed. `verify` still has to resolve. */
    any,
  };
}
