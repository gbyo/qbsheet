/**
 * Write the HTML entry for every wiki page.
 *
 * # Why these files exist at all
 *
 * `about/wiki/<slug>/index.html` is the same near-empty document as `about/faq/index.html`: a head, and
 * a `<div id="about-root">` for `aboutPrerenderPlugin` to fill. Vite needs a real file per document to
 * treat it as a build entry, and having one means wiki pages travel through exactly the same pipeline
 * as the hand-written pages — the same asset injection, the same prerender, the same service-worker
 * exclusion rules. The alternative, emitting these documents from inside the build, would have meant a
 * second path through all of that for no gain.
 *
 * # Why they are generated rather than written
 *
 * The wiki is synced, so its page list changes without anybody touching this repository by hand. These
 * files are therefore an output of the wiki and not a thing to maintain: `.github/workflows/sync-wiki.yml`
 * runs this script immediately after it copies the Markdown, in the same commit. Running it by hand is
 * only ever needed after editing `wiki/` locally.
 *
 * Directories for pages the wiki no longer has are removed, because a stale entry would build a page
 * whose Markdown is gone and fail the prerender.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wikiDirectory = join(root, 'wiki');
const outputDirectory = join(root, 'about', 'wiki');
const siteUrl = 'https://qbsheet.com';

/** GitHub's own furniture, which becomes navigation rather than a page. See `wikiContent`. */
const notPages = new Set(['_Sidebar', '_Footer']);

/** The wiki's names are already hyphenated words, so a slug is the name lowercased and nothing else. */
const slugFor = (name) => name.toLowerCase();

/** The first level-one heading. Every page in this wiki opens with one. */
function titleOf(markdown, fallback) {
  const match = /^#\s+(.+)$/m.exec(markdown);
  return match === null ? fallback : match[1].trim();
}

/** The opening paragraph as one line, for a meta description. Mirrors `describe` in `wikiContent`. */
function describe(markdown) {
  const body = markdown.replace(/^#[^\n]*\n/, '');
  const paragraph = body
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .find((block) => block.length > 0 && !block.startsWith('#') && !block.startsWith('|'));
  if (paragraph === undefined) return '';
  return paragraph
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Attribute-safe, because a page title or an opening line may contain either kind of quote. */
const attribute = (value) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function documentFor(name, markdown) {
  const slug = slugFor(name);
  const title = attribute(titleOf(markdown, name.replace(/-/g, ' ')));
  // Bounded, because a meta description is truncated by everything that reads one anyway, and an
  // opening paragraph in this wiki can run several sentences.
  const summary = describe(markdown).slice(0, 300);
  const description = attribute(summary.length > 0 ? summary : `${title} — QBSheet wiki.`);
  const canonical = `${siteUrl}/about/wiki/${slug}/`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="${description}" />
    <link rel="canonical" href="${canonical}" />
    <meta property="og:type" content="article" />
    <meta property="og:url" content="${canonical}" />
    <meta property="og:title" content="${title} | QBSheet wiki" />
    <meta property="og:description" content="${description}" />
    <link rel="icon" href="../../../favicon.ico" sizes="48x48 32x32 16x16" />
    <link rel="icon" type="image/svg+xml" href="../../../icon.svg" sizes="any" />
    <link rel="apple-touch-icon" href="../../../apple-touch-icon.png" />
    <title>${title} | QBSheet wiki</title>
  </head>
  <body>
    <div id="about-root"></div>
    <script type="module" src="/src/about/pages.ts"></script>
  </body>
</html>
`;
}

/**
 * Replace the generated run of lines in a hand-written file.
 *
 * `public/sitemap.xml` and `public/llms.txt` each list the site's pages, and the wiki's share of that
 * list changes whenever the wiki does. Rewriting the whole file would mean this script owning entries
 * a person wrote; rewriting nothing would mean seventeen URLs maintained by hand against a directory
 * that syncs itself. So each file carries a marked region, and only that region is generated.
 *
 * A missing marker is an error rather than a silent skip, because the symptom otherwise is a sitemap
 * that quietly stops listing half the site.
 */
function replaceRegion(text, marker, replacement, file) {
  const start = `<!-- wiki:start ${marker} -->`;
  const end = `<!-- wiki:end ${marker} -->`;
  const from = text.indexOf(start);
  const to = text.indexOf(end);
  if (from === -1 || to === -1) throw new Error(`${file} has no ${marker} wiki markers.`);
  return `${text.slice(0, from + start.length)}\n${replacement}\n${text.slice(to)}`;
}

const names = readdirSync(wikiDirectory)
  .filter((file) => file.endsWith('.md'))
  .map((file) => file.slice(0, -'.md'.length))
  .filter((name) => !notPages.has(name))
  .sort();

mkdirSync(outputDirectory, { recursive: true });

const wanted = new Set(names.map(slugFor));
for (const entry of readdirSync(outputDirectory, { withFileTypes: true })) {
  // Only directories: the wiki has no index page of its own, and `Home` is an ordinary article.
  if (!entry.isDirectory() || wanted.has(entry.name)) continue;
  rmSync(join(outputDirectory, entry.name), { recursive: true, force: true });
  console.log(`removed about/wiki/${entry.name}/`);
}

for (const name of names) {
  const markdown = readFileSync(join(wikiDirectory, `${name}.md`), 'utf8');
  const directory = join(outputDirectory, slugFor(name));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'index.html'), documentFor(name, markdown));
}

const pages = names.map((name) => {
  const markdown = readFileSync(join(wikiDirectory, `${name}.md`), 'utf8');
  return { name, slug: slugFor(name), title: titleOf(markdown, name.replace(/-/g, ' ')), markdown };
});

const sitemapPath = join(root, 'public', 'sitemap.xml');
writeFileSync(
  sitemapPath,
  replaceRegion(
    readFileSync(sitemapPath, 'utf8'),
    'pages',
    pages
      .map((page) => `  <url>\n    <loc>${siteUrl}/about/wiki/${page.slug}/</loc>\n  </url>`)
      .join('\n'),
    'public/sitemap.xml',
  ),
);

const llmsPath = join(root, 'public', 'llms.txt');
writeFileSync(
  llmsPath,
  replaceRegion(
    readFileSync(llmsPath, 'utf8'),
    'pages',
    pages
      .map((page) => {
        const summary = describe(page.markdown).slice(0, 160);
        return `- [${page.title}](${siteUrl}/about/wiki/${page.slug}/)${summary === '' ? '' : `: ${summary}`}`;
      })
      .join('\n'),
    'public/llms.txt',
  ),
);

console.log(`wrote ${names.length} wiki page entries, and the sitemap and llms.txt regions`);
