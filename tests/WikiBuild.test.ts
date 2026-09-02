// @vitest-environment node
/**
 * The checked-in wiki HTML files are deliberately empty prerender targets. This suite builds the
 * production site first and inspects `dist/`, because that is what a browser and a search crawler
 * actually receive.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { JSDOM } from 'jsdom';
import { readWikiPage, wikiPageNames } from '../src/about/wikiContent';

const root = process.cwd();
const dist = join(root, 'dist');
const startHerePath = join(dist, 'about', 'wiki', 'start-here', 'index.html');

/**
 * The page as a browser with scripting switched off would have it.
 *
 * Parsed rather than pattern-matched. A regular expression that looks for `</script>` is the wrong
 * tool twice over: it misses the spellings a real parser accepts (`</script >`), and CodeQL
 * correctly refuses to believe any hand-rolled tag filter -- `js/bad-tag-filter` and
 * `js/incomplete-multi-character-sanitization` both fired on the previous one. Nothing here needs
 * to be clever; jsdom is already a dev dependency, and asking the DOM to drop its own script
 * elements cannot be wrong about what a script element is.
 */
function withScriptsRemoved(html: string): string {
  const { window } = new JSDOM(html);
  for (const script of window.document.querySelectorAll('script')) script.remove();
  return window.document.documentElement.outerHTML;
}

function javascriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(path);
    return entry.isFile() && path.endsWith('.js') ? [path] : [];
  });
}

beforeAll(() => {
  // Keep these assertions independent of a stale or missing `dist/`, and force the relative-URL
  // mode that GitHub Pages and a copied local build both use.
  execFileSync('npm', ['run', 'build'], {
    cwd: root,
    env: { ...process.env, BASE_PATH: './' },
    stdio: 'inherit',
  });
}, 60_000);

describe('production wiki output', () => {
  test('renders every synced article into its generated HTML', () => {
    for (const name of wikiPageNames(root)) {
      const page = readWikiPage(root, name);
      const html = readFileSync(join(dist, 'about', 'wiki', page.slug, 'index.html'), 'utf8');

      expect(html, name).toContain('<div id="about-root"><div class="about-page">');
      expect(html, name).not.toContain('<div id="about-root"></div>');
      expect(html, name).toContain(`<h1>${page.title}</h1>`);
      expect(html, name).toContain(page.bodyHtml);
    }
  });

  test('keeps the article, chrome, and navigation readable without its client scripts', () => {
    const html = readFileSync(startHerePath, 'utf8');
    const withoutScripts = withScriptsRemoved(html);
    const page = readWikiPage(root, 'Start-here');

    expect(withoutScripts).toContain('<header class="about-header">');
    expect(withoutScripts).toContain('<nav class="about-wiki-nav"');
    expect(withoutScripts).toContain(`<h1>${page.title}</h1>`);
    expect(withoutScripts).toContain(page.bodyHtml);
    expect(withoutScripts).toContain('<footer class="about-footer">');
  });

  test('uses relative links and assets from a deeply nested article', () => {
    const html = readFileSync(startHerePath, 'utf8');

    expect(html).toContain('<a href="../../../">Scorer</a>');
    expect(html).toContain('<a href="../../../director.html">Director</a>');
    // The brand mark is inlined into the markup rather than fetched, so the header draws on the
    // first paint and at whatever depth the article sits. There is no `<img>` on this page to
    // check a relative path on; the favicon and the two build assets below cover that.
    expect(html).toContain('<svg class="about-brand-logo"');
    expect(html).toContain('href="../../../favicon.ico"');
    expect(html).toMatch(/<script type="module"[^>]+src="\.\.\/\.\.\/\.\.\/about\/assets\/pages-[^"]+\.js"/);
    expect(html).toMatch(
      /<link rel="stylesheet"[^>]+href="\.\.\/\.\.\/\.\.\/about\/assets\/pages-[^"]+\.css"/,
    );
    expect(html).toContain('href="../troubleshooting/#the-browser-will-not-save-anything"');
    expect(html).not.toMatch(/(?:src|href)="\/src\//);
  });

  test('does not put React or the Markdown renderer in the wiki page runtime', () => {
    const html = readFileSync(startHerePath, 'utf8');
    const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1]);
    const runtime = scripts
      .map((script) => readFileSync(join(dirname(startHerePath), script), 'utf8'))
      .join('\n');

    expect(runtime).not.toMatch(
      /(?:createRoot|hydrateRoot|renderToStaticMarkup|WikiPage|Marked|parseMarkdown)/,
    );
    expect(runtime).not.toContain('https://github.com/gbyo/qbsheet/wiki');
    expect(runtime).not.toContain('This page is for a scorekeeper');
  });

  test('keeps every about page outside the scorer service-worker precache', () => {
    const serviceWorker = readFileSync(join(dist, 'sw.js'), 'utf8');
    const match = /const PRECACHE = (\[[\s\S]*?\]);/.exec(serviceWorker);
    if (match === null) throw new Error('Generated service worker has no PRECACHE list.');
    const precache = JSON.parse(match[1]) as string[];

    expect(precache).toContain('index.html');
    expect(precache.some((file) => file.startsWith('about/'))).toBe(false);
    expect(precache).not.toContain('about/wiki/start-here/index.html');
    expect(precache).not.toContain('about/assets/pages.css');
  });

  test('loads the small progressive-enhancement entry rather than a React page entry', () => {
    const html = readFileSync(startHerePath, 'utf8');

    expect(html).toMatch(/src="\.\.\/\.\.\/\.\.\/about\/assets\/pages-[^"]+\.js"/);
    expect(html).not.toMatch(/src="[^"]*(?:react|scorer)-[^"]+\.js"/i);
  });

  test('has a non-empty production document for every wiki route', () => {
    for (const name of wikiPageNames(root)) {
      const path = join(dist, 'about', 'wiki', name.toLowerCase(), 'index.html');
      const html = readFileSync(path, 'utf8');
      expect(html, name).toContain('<article class="about-wiki-body">');
      expect(html, name).not.toContain('<div id="about-root"></div>');
    }
  });
});

describe('production client output', () => {
  test('does not ship the build-only wiki module or Markdown source in any JavaScript bundle', () => {
    const javascript = javascriptFiles(dist)
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');

    expect(javascript).not.toContain('wikiContent');
    expect(javascript).not.toContain('https://github.com/gbyo/qbsheet/wiki');
    expect(javascript).not.toContain('Start-here');
    expect(javascript).not.toContain('This page is for a scorekeeper');
  });
});
