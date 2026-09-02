/**
 * Turn Live Web's production Vite output into the one self-contained HTML file embedded by the
 * Director local server. No runtime request may leave the venue network, so scripts and styles are
 * inlined and the native server injects only the local publication bootstrap.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'apps/live-web/dist');
const output = resolve(root, 'apps/director/src-tauri/assets/live-web.html');
const assetsOutput = resolve(root, 'apps/director/src-tauri/assets/live-web');
let html = await readFile(resolve(dist, 'index.html'), 'utf8');

const stylesheet = html.match(/<link rel="stylesheet"(?: crossorigin)? href="([^"]+)">/);
if (!stylesheet) throw new Error('Live Web build did not contain its stylesheet.');
const script = html.match(/<script type="module"(?: crossorigin)? src="([^"]+)"><\/script>/);
if (!script) throw new Error('Live Web build did not contain its application script.');

const css = await readFile(resolve(dist, stylesheet[1].replace(/^\//, '')), 'utf8');
const javascript = await readFile(resolve(dist, script[1].replace(/^\//, '')), 'utf8');
await mkdir(assetsOutput, { recursive: true });
await writeFile(resolve(assetsOutput, 'styles.css'), css);
await writeFile(resolve(assetsOutput, 'app.js'), javascript);

html = html.replace(stylesheet[0], '<link rel="stylesheet" href="./assets/styles.css">');
html = html.replace(script[0], '<script type="module" src="./assets/app.js"></script>');
html = html.replace(
  '</head>',
  '<base href="<!--QBSHEET_LOCAL_BASE-->"><meta name="qbsheet-live-local-bundle" content="offline"></head>',
);
if (html.includes('<meta name="qbsheet-live-local-bundle"')) {
  html = html.replace(
    '<meta name="qbsheet-live-local-bundle" content="offline">',
    '<meta name="qbsheet-live-local-bundle" content="offline"><!--QBSHEET_LOCAL_BOOTSTRAP-->',
  );
}
await mkdir(dirname(output), { recursive: true });
await writeFile(output, html);
console.log(`wrote ${output} and ${assetsOutput}`);
