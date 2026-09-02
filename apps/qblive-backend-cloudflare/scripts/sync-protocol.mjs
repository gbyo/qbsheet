/**
 * Copy the QBLive protocol source into this Worker.
 *
 * # Why a copy rather than a dependency
 *
 * This directory has to be deployable by "Deploy to Cloudflare", which clones the repository and
 * builds *this folder* — it cannot resolve `@qbsheet/qblive-protocol` out of a monorepo workspace
 * that is not part of the deployment. A tournament director deploying the template must not need
 * npm workspaces, and must not need a QBSheet account.
 *
 * A copy risks drift, so the copy is generated and checked. `--check` fails when the vendored files
 * differ from the source, and CI runs it. The header written into each file says the same thing to
 * anyone who opens it.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '..', '..', '..', 'packages', 'qblive-protocol', 'src');
const target = resolve(here, '..', 'src', 'protocol');
const files = ['types.ts', 'validate.ts', 'management.ts'];

const header = `// GENERATED FILE — do not edit.
//
// Copied from packages/qblive-protocol/src by scripts/sync-protocol.mjs so that this Worker is
// self-contained and deployable straight from the repository by "Deploy to Cloudflare", which
// cannot resolve monorepo workspace packages. Edit the original and re-run:
//
//     npm run sync-protocol --workspace=@qbsheet/qblive-backend-cloudflare
//
`;

const check = process.argv.includes('--check');
mkdirSync(target, { recursive: true });

let stale = [];
for (const file of files) {
  const contents = header + readFileSync(resolve(source, file), 'utf8');
  const destination = resolve(target, file);
  if (check) {
    if (!existsSync(destination) || readFileSync(destination, 'utf8') !== contents) stale.push(file);
  } else {
    writeFileSync(destination, contents);
    console.log(`synced src/protocol/${file}`);
  }
}

if (check && stale.length > 0) {
  console.error(
    `The vendored QBLive protocol is out of date: ${stale.join(', ')}.\n` +
      'Run: npm run sync-protocol --workspace=@qbsheet/qblive-backend-cloudflare',
  );
  process.exit(1);
}
if (check) console.log('vendored QBLive protocol is up to date');
