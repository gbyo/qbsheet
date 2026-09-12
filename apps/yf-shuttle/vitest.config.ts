import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const appRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(appRoot, '../..');

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    // A real origin: shuttle state lives in `localStorage`, which jsdom refuses on an opaque one.
    environmentOptions: { jsdom: { url: 'https://yfshuttle.test/' } },
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: [resolve(appRoot, 'src/tests/setup.ts')],
  },
  server: {
    fs: { allow: [appRoot, repositoryRoot] },
  },
});
