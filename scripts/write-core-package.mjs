import { mkdir, writeFile } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await writeFile('dist/package.json', `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`);
