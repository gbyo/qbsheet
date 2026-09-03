/**
 * The routing rules in `scripts/ci/impact.mjs`.
 *
 * These are the tests that stop the optimisation from becoming a regression. Each one is a change a
 * contributor actually makes, and the assertion is which CI domains that change is allowed to skip.
 * Two directions matter and both are asserted:
 *
 * * **Coverage.** A change that can reach the scorer runs the scorer checks, including the browser
 *   torture test. Nothing in here weakens that.
 * * **Routing.** A change that provably cannot reach the scorer does not run them.
 *
 * The lockfile cases run against the repository's real `package-lock.json`, because the whole
 * difficulty there is npm's hoisting in *this* workspace layout and a synthetic fixture would not
 * reproduce it.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classify, DOMAINS, lockfileProjects, ruleFor } from '../../scripts/ci/impact.mjs';

/** The domains a set of changed paths turns on, as a sorted list, for readable assertions. */
function affected(paths: string[], lockfiles?: { base: unknown; head: unknown }): string[] {
  const result = classify(paths, lockfiles);
  return DOMAINS.filter((domain) => result.domains[domain]);
}

/** Only as much of the lockfile shape as these tests read. */
interface ILockfile {
  packages: Record<string, Record<string, unknown>>;
}

const realLockfile = (): ILockfile =>
  JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8')) as ILockfile;

/** A deep copy, so a test can mutate a lockfile without affecting the next one. */
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('every rule is well formed', () => {
  it('names only domains the workflow knows about', () => {
    // `classify` throws on an unknown domain, so running every rule's own glob proves the whole
    // table. A typo in a rule would otherwise be silent until the domain it meant to set was needed.
    for (const path of ['src/x.ts', 'docs/x.md', 'crates/tournament-store/src/x.rs']) {
      expect(() => classify([path])).not.toThrow();
    }
    expect(() => classify(['package.json'])).not.toThrow();
  });

  it('classifies every file currently in the repository', () => {
    // The fail-safe exists for a path nobody anticipated, and it is meant to stay rare. If this
    // fails, a directory arrived without a rule. CI is still safe — an unclassified path runs
    // everything — but the fix is a rule in `impact.mjs`, not a run of the whole matrix forever.
    const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.length > 0);
    expect(tracked.length).toBeGreaterThan(100);
    const unmatched = tracked.filter((path) => path !== 'package-lock.json' && ruleFor(path) === undefined);
    expect(unmatched).toEqual([]);
  });
});

describe('a scorer change keeps the whole scorer safety net', () => {
  it('runs the scorer suite and the browser torture test for scorer runtime source', () => {
    expect(affected(['src/scorer/Scoresheet.tsx'])).toEqual(['quality', 'scorer', 'scorer-browser']);
  });

  it('runs them for the scoring engine, the app shell, and persistence', () => {
    for (const path of [
      'src/scoring/canApplyScoreEvent.ts',
      'src/app/useConnectedRuntime.ts',
      'src/persistence/GameDatabase.ts',
      'src/pwa/serviceWorker.ts',
      'src/game/GamePackage.ts',
    ]) {
      expect(affected([path]), path).toContain('scorer');
      expect(affected([path]), path).toContain('scorer-browser');
    }
  });

  it('runs the browser suite for the offline shell, served assets, and the entry document', () => {
    expect(affected(['index.html'])).toContain('scorer-browser');
    expect(affected(['public/manifest.webmanifest'])).toContain('scorer-browser');
    expect(affected(['about/faq/index.html'])).toContain('scorer-browser');
  });

  it('runs the browser suite for the wiki, which the build prerenders', () => {
    // `wiki/` looks like documentation and is not: vite.config.ts reads it to emit
    // `about/wiki/<slug>/index.html`, and `e2e/Wiki.spec.ts` opens those pages.
    expect(affected(['wiki/Start-here.md'])).toEqual(['scorer', 'scorer-browser']);
  });

  it('runs the browser suite for Playwright configuration and the shared browser helpers', () => {
    expect(affected(['playwright.config.ts'])).toContain('scorer-browser');
    expect(affected(['e2e/support/scoringLayout.ts'])).toContain('scorer-browser');
    expect(affected(['e2e/ScorerTorture.spec.ts'])).toContain('scorer-browser');
  });

  it('stops a unit-test-only change short of the browser suite', () => {
    // A file under `tests/` is run by the scorer job. It cannot change what a browser does.
    expect(affected(['tests/RoomGameProperty.test.ts'])).toEqual(['quality', 'scorer']);
  });

  it('stops a QBSheet Live demo-backend change short of the browser suite', () => {
    // The demo backend is a development affordance: nothing imports it, nothing builds it, and its
    // own tests are in the root Node project. The unmapped-script catch-all would run Playwright.
    expect(affected(['scripts/qblive-demo/server.mjs'])).toEqual(['quality', 'scorer']);
  });
});

describe('a Director-only change does not run the scorer browser torture test', () => {
  it('routes Director source to the Director job alone', () => {
    // Nothing outside `src/director/` imports `src/director/`. That is the fact this rests on.
    expect(affected(['src/director/rooms/RoomsView.tsx'])).toEqual(['quality', 'director-ui']);
    expect(affected(['src/director/live/publication.ts'])).toEqual(['quality', 'director-ui']);
  });

  it('routes the Director shell and its build config to the Director job', () => {
    expect(affected(['apps/director/src/native.ts'])).toEqual(['quality', 'director-ui']);
    expect(affected(['apps/director/vite.config.ts'])).toEqual(['quality', 'director-ui']);
  });

  it('runs the Director browser spec, and only it, for a Director browser test change', () => {
    // The spec lives with the application it drives now, and it has its own Playwright config
    // because it starts `apps/director`'s dev server rather than the website's.
    expect(affected(['e2e/director/Director.spec.ts'])).toEqual(['quality', 'director-ui']);
    expect(affected(['playwright.director.config.ts'])).toEqual(['quality', 'director-ui']);
  });

  it('owes the scorer nothing, because the website no longer builds Director', () => {
    // `director.html` was a root build input as well as the Director entry, so a Director entry
    // change used to have to run the project-path build. There is no such entry any more: the
    // website's only Director is the marketing page under `about/`, and Director itself is built
    // by `apps/director`.
    for (const domains of [
      affected(['src/director/rooms/RoomsView.tsx']),
      affected(['apps/director/index.html']),
      affected(['e2e/director/Director.spec.ts']),
    ]) {
      expect(domains).not.toContain('scorer');
      expect(domains).not.toContain('scorer-browser');
    }
  });
});

describe('a QBLive-only change relies on the dedicated QBLive workflow', () => {
  it('runs no product job for the Cloudflare backend beyond repository lint', () => {
    // `qblive.yml` runs this in workerd. What it does not run is `eslint` and `prettier`, which is
    // the one thing the regular CI keeps for these paths.
    expect(affected(['apps/qblive-backend-cloudflare/src/index.ts'])).toEqual(['quality']);
  });

  it('runs no product job for the push gateway or Live Web', () => {
    expect(affected(['apps/qblive-push/src/index.ts'])).toEqual(['quality']);
    expect(affected(['apps/live-web/src/App.tsx'])).toEqual(['quality']);
  });

  it('runs nothing at all for an iOS-only change', () => {
    const result = classify(['ios/QBSheetLiveKit/Sources/QBSheetLiveKit/Snapshot.swift', 'ios/project.yml']);
    expect(result.any).toBe(false);
    expect(result.domains['scorer-browser']).toBe(false);
    expect(result.domains.scorer).toBe(false);
    expect(result.domains['rust-director']).toBe(false);
    expect(result.domains['rust-tournament-store']).toBe(false);
    expect(result.domains['rust-qbtcp']).toBe(false);
  });

  it('compiles Director for a protocol or projection change, because src/director imports them', () => {
    expect(affected(['packages/qblive-protocol/src/snapshot.ts'])).toEqual(['quality', 'director-ui']);
    expect(affected(['packages/qblive-projection/src/project.ts'])).toEqual(['quality', 'director-ui']);
    expect(affected(['packages/qblive-protocol/src/snapshot.ts'])).not.toContain('scorer-browser');
  });

  it('runs nothing for the QBLive documentation', () => {
    expect(affected(['docs/QBLIVE.md', 'docs/QBLIVE_IOS.md'])).toEqual([]);
  });
});

describe('the tournament packages route by their real consumers', () => {
  it('runs the package suite and the Director build, and not the scorer', () => {
    // The scorer imports no `@qbsheet/*` package. Only `src/director/` does.
    for (const name of ['tournament-core', 'tournament-formats', 'tournament-domain']) {
      expect(affected([`packages/${name}/src/index.ts`]), name).toEqual([
        'quality',
        'director-ui',
        'tournament-js',
      ]);
    }
  });

  it('runs every JavaScript domain for a workspace package that has no rule yet', () => {
    expect(affected(['packages/something-new/src/index.ts'])).toEqual([
      'quality',
      'scorer',
      'scorer-browser',
      'director-ui',
      'tournament-js',
      'qblive-js',
    ]);
  });
});

describe('the Rust crates are independent, except where Cargo says otherwise', () => {
  it('runs only the tournament-store crate for a tournament-store change', () => {
    expect(affected(['crates/tournament-store/src/lib.rs'])).toEqual(['rust-tournament-store']);
    expect(affected(['crates/tournament-store/Cargo.toml'])).toEqual(['rust-tournament-store']);
  });

  it('runs the Director crate for a QBTCP change, because it path-depends on it', () => {
    // apps/director/src-tauri/Cargo.toml: qbtcp-server = { path = "../../../crates/qbtcp-server" }
    expect(affected(['crates/qbtcp-server/src/main.rs'])).toEqual(['rust-director', 'rust-qbtcp']);
  });

  it('runs only the Director crate for a Director native change', () => {
    expect(affected(['apps/director/src-tauri/src/live.rs'])).toEqual(['rust-director']);
    expect(affected(['apps/director/src-tauri/Cargo.lock'])).toEqual(['rust-director']);
  });

  it('never runs the browser torture test for a Rust-only change', () => {
    for (const path of [
      'crates/tournament-store/src/lib.rs',
      'crates/qbtcp-server/src/main.rs',
      'apps/director/src-tauri/src/lib.rs',
    ]) {
      expect(affected([path]), path).not.toContain('scorer-browser');
      expect(affected([path]), path).not.toContain('scorer');
    }
  });
});

describe('documentation and repository furniture run nothing', () => {
  it('finishes a documentation-only change with no validation job', () => {
    const result = classify(['README.md', 'docs/QBTCP.md', 'CONTRIBUTING.md']);
    expect(result.any).toBe(false);
    expect(result['docs-only']).toBe(true);
  });

  it('runs nothing for issue forms, funding, and Dependabot configuration', () => {
    expect(affected(['.github/ISSUE_TEMPLATE/bug.yml', '.github/dependabot.yml'])).toEqual([]);
  });

  it('leaves another workflow to its own path filter', () => {
    // `qblive.yml` filters on its own paths, itself included. Running the scorer jobs for an edit to
    // it would test nothing about the edit.
    expect(affected(['.github/workflows/qblive.yml'])).toEqual([]);
  });
});

describe('a change to the routing runs the routing', () => {
  it('runs every domain when the CI workflow changes', () => {
    expect(affected(['.github/workflows/ci.yml'])).toEqual([...DOMAINS]);
  });

  it('runs every domain when the classifier changes', () => {
    expect(affected(['scripts/ci/impact.mjs'])).toEqual([...DOMAINS]);
  });

  it('runs the root suite, which holds these tests, when these tests change', () => {
    expect(affected(['tests/ci/impact.test.ts'])).toEqual(['quality', 'scorer']);
  });
});

describe('an unrecognised path fails safe', () => {
  it('runs every domain and reports the path', () => {
    const result = classify(['some/new/subsystem/main.rs']);
    expect(DOMAINS.filter((domain) => result.domains[domain])).toEqual([...DOMAINS]);
    expect(result.unclassified).toEqual(['some/new/subsystem/main.rs']);
    expect(result['docs-only']).toBe(false);
  });

  it('does not let one prose file make an unknown file look harmless', () => {
    const result = classify(['README.md', 'some/new/subsystem/main.rs']);
    expect(result['docs-only']).toBe(false);
    expect(result.domains['scorer-browser']).toBe(true);
  });
});

describe('shared and global configuration is treated conservatively', () => {
  it('keeps the root Vite config inside the scorer and website domains', () => {
    // It builds the scorer, prerenders the marketing pages, and emits the service worker. It has
    // no Director entry, no Director chunking, and no Director service-worker exclusion left.
    expect(affected(['vite.config.ts'])).toEqual(['quality', 'scorer', 'scorer-browser']);
  });

  it('keeps the marketing pages inside the scorer domains', () => {
    // The Director and QBLive pages are prerendered documents like every other page under
    // `about/`, so they belong to the website build rather than to the Director application.
    expect(affected(['about/director/index.html'])).toEqual(['scorer', 'scorer-browser']);
    expect(affected(['src/about/QbLive.tsx'])).toEqual(['quality', 'scorer', 'scorer-browser']);
  });

  it('runs every JavaScript domain for the root TypeScript config, which every package extends', () => {
    expect(affected(['tsconfig.json'])).toEqual([
      'quality',
      'scorer',
      'scorer-browser',
      'director-ui',
      'tournament-js',
      'qblive-js',
    ]);
  });

  it('runs every JavaScript domain for the root manifest', () => {
    // Its `scripts` block is every command CI runs, and its ranges are the scorer's dependencies.
    expect(affected(['package.json'])).toEqual([
      'quality',
      'scorer',
      'scorer-browser',
      'director-ui',
      'tournament-js',
      'qblive-js',
    ]);
  });

  it('keeps a lint or format configuration change inside the quality job', () => {
    expect(affected(['eslint.config.js'])).toEqual(['quality']);
    expect(affected(['.prettierrc.json'])).toEqual(['quality']);
  });

  it('does not run the quality job for files it cannot inspect', () => {
    // Prettier and ESLint see `.ts`, `.tsx`, `.js`, `.mjs`, `.cjs` and `.css`. Nothing else.
    expect(affected(['ios/Shared/Snapshot.swift'])).toEqual([]);
    expect(affected(['crates/tournament-store/src/lib.rs'])).not.toContain('quality');
    expect(affected(['docs/QBTCP.md'])).not.toContain('quality');
  });
});

describe('the root lockfile', () => {
  it('does not run the scorer for a QBLive workspace-only dependency change', () => {
    // The case that makes or breaks this optimisation. `npm install --workspace=@qbsheet/live-web`
    // rewrites the root lockfile, and npm hoists the new package into the root `node_modules`, so
    // the diff looks exactly like a root install. What separates them is who declared it.
    const base = realLockfile();
    const head = copy(base);
    const workspace = head.packages['apps/live-web'] as { dependencies: Record<string, string> };
    workspace.dependencies = { ...workspace.dependencies, 'qr-scanner-lite': '^1.2.0' };
    head.packages['node_modules/qr-scanner-lite'] = {
      version: '1.2.0',
      resolved: 'https://registry.npmjs.org/qr-scanner-lite/-/qr-scanner-lite-1.2.0.tgz',
      license: 'MIT',
    };

    const { projects, unexplained } = lockfileProjects(base, head);
    expect(unexplained).toEqual([]);
    expect(projects).toEqual(['apps/live-web']);

    const result = classify(['apps/live-web/package.json', 'package-lock.json'], { base, head });
    expect(result.domains['scorer-browser']).toBe(false);
    expect(result.domains.scorer).toBe(false);
    expect(result.domains['qblive-js']).toBe(true);
  });

  it('does not run the scorer for a Director-only dependency change', () => {
    // `@tauri-apps/api` is declared by `apps/director` and by nothing else, so a bump to it is
    // reachable from that workspace alone even though it lives in the hoisted root tree.
    const base = realLockfile();
    const head = copy(base);
    const entry = head.packages['node_modules/@tauri-apps/api'] as { version: string };
    expect(entry).toBeDefined();
    entry.version = '2.99.0';

    expect(lockfileProjects(base, head)).toEqual({ projects: ['apps/director'], unexplained: [] });
    const result = classify(['package-lock.json'], { base, head });
    expect(result.domains['scorer-browser']).toBe(false);
    expect(result.domains['director-ui']).toBe(true);
  });

  it('runs the scorer and the browser suite for a root dependency update', () => {
    const base = realLockfile();
    const head = copy(base);
    const root = head.packages[''] as { dependencies: Record<string, string> };
    root.dependencies = { ...root.dependencies, jsqr: '^1.5.0' };
    (head.packages['node_modules/jsqr'] as { version: string }).version = '1.5.0';

    const result = classify(['package.json', 'package-lock.json'], { base, head });
    expect(result.domains.scorer).toBe(true);
    expect(result.domains['scorer-browser']).toBe(true);
  });

  it('runs the scorer for a transitive update under a root dependency', () => {
    // Nobody declared `postcss`; it arrives under `vite`, which the scorer builds with. A bump to
    // it is a scorer dependency update whatever the manifest says.
    const base = realLockfile();
    const head = copy(base);
    expect(head.packages['node_modules/picomatch']).toBeDefined();
    (head.packages['node_modules/picomatch'] as { version: string }).version = '99.0.0';

    const result = classify(['package-lock.json'], { base, head });
    expect(result.domains.scorer).toBe(true);
    expect(result.domains['scorer-browser']).toBe(true);
  });

  it('runs the scorer for a shared toolchain update, because npm hoists it', () => {
    const base = realLockfile();
    const head = copy(base);
    (head.packages['node_modules/vitest'] as { version: string }).version = '4.2.0';

    const result = classify(['package-lock.json'], { base, head });
    expect(result.domains.scorer).toBe(true);
    // The tournament packages declare no dev dependencies of their own and run on the hoisted
    // `vitest`, which is exactly why the root project maps to every JavaScript domain.
    expect(result.domains['tournament-js']).toBe(true);
    expect(result.domains['qblive-js']).toBe(true);
  });

  it('runs everything for a lockfile entry no workspace explains', () => {
    const base = realLockfile();
    const head = copy(base);
    head.packages['node_modules/nothing-asked-for-this'] = { version: '1.0.0' };

    const { unexplained } = lockfileProjects(base, head);
    expect(unexplained).toEqual(['node_modules/nothing-asked-for-this']);

    const result = classify(['package-lock.json'], { base, head });
    expect(DOMAINS.filter((domain) => result.domains[domain])).toEqual([...DOMAINS]);
  });

  it('runs everything when the base lockfile cannot be read', () => {
    const result = classify(['package-lock.json'], { base: null, head: realLockfile() });
    expect(DOMAINS.filter((domain) => result.domains[domain])).toEqual([...DOMAINS]);
    expect(result.notes.join(' ')).toContain('could not be compared');
  });

  it('does not read a new workspace as a root dependency change', () => {
    // Adding `apps/live-web` to the root `workspaces` list rewrites the root lockfile entry without
    // changing anything the root project installs. Reading that as a root dependency change would
    // run the scorer browser suite for every workspace anyone adds.
    const base = realLockfile();
    const head = copy(base);
    const root = head.packages[''] as { workspaces: string[] };
    root.workspaces = [...root.workspaces, 'apps/something-new'];
    head.packages['apps/something-new'] = { name: '@qbsheet/something-new', version: '0.1.0' };
    head.packages['node_modules/@qbsheet/something-new'] = {
      resolved: 'apps/something-new',
      link: true,
    };

    const { projects, unexplained } = lockfileProjects(base, head);
    expect(unexplained).toEqual([]);
    expect(projects).toEqual(['apps/something-new']);

    // And the workspace has no rule yet, so it fails safe to everything rather than to nothing.
    const result = classify(['package-lock.json'], { base, head });
    expect(DOMAINS.filter((domain) => result.domains[domain])).toEqual([...DOMAINS]);
  });

  it('routes nothing when the lockfile is byte-identical', () => {
    const base = realLockfile();
    expect(lockfileProjects(base, copy(base))).toEqual({ projects: [], unexplained: [] });
  });
});

describe('a mixed change is the union of its parts', () => {
  it('runs each domain its own files ask for and nothing else', () => {
    expect(
      affected(['src/director/teams/TeamsView.tsx', 'crates/tournament-store/src/lib.rs', 'docs/QBLIVE.md']),
    ).toEqual(['quality', 'director-ui', 'rust-tournament-store']);
  });
});
