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
let html = await readFile(resolve(dist, 'index.html'), 'utf8');

for (const match of [...html.matchAll(/<link rel="stylesheet" crossorigin href="([^"]+)">/g)]) {
  const css = await readFile(resolve(dist, match[1].replace(/^\//, '')), 'utf8');
  html = html.replace(match[0], () => `<style>${css}</style>`);
}
for (const match of [...html.matchAll(/<script type="module" crossorigin src="([^"]+)"><\/script>/g)]) {
  const javascript = await readFile(resolve(dist, match[1].replace(/^\//, '')), 'utf8');
  html = html.replace(
    match[0],
    () => `<script type="module">${javascript.replaceAll('</script', '<\\/script')}</script>`,
  );
}

html = html.replace(
  '</head>',
  '<meta name="qbsheet-live-local-bundle" content="offline"><!--QBSHEET_LOCAL_BOOTSTRAP--></head>',
);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, html);
console.log(`wrote ${output}`);
