import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const appRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(appRoot, '../..');

/**
 * YF Shuttle is its own small Vite application.
 *
 * Like QBBridge it reads a handful of pure modules out of the root repository — the QBJ parser
 * its assignments are tested against and the shared filename rules — so the file boundary stays
 * in this config rather than in a build step. It shares no application state with any other app.
 */
export default defineConfig({
  root: appRoot,
  base: './',
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  server: {
    host: '127.0.0.1',
    port: 1426,
    strictPort: true,
    fs: { allow: [appRoot, repositoryRoot] },
  },
  preview: {
    host: '127.0.0.1',
    port: 1426,
    strictPort: true,
  },
  build: {
    outDir: resolve(appRoot, 'dist'),
    emptyOutDir: true,
    sourcemap: true,
  },
});
