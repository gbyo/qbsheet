import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const appRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(appRoot, '../..');

/**
 * Director is a separate Vite application, but it deliberately consumes the approved Director
 * surface from the root scorer repository until the shared UI package is split out. Keeping this
 * boundary in the app config means the scorer entry and service-worker build remain untouched.
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
    port: 1420,
    strictPort: true,
    fs: {
      allow: [appRoot, repositoryRoot],
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: resolve(appRoot, 'dist'),
    emptyOutDir: true,
    sourcemap: true,
  },
});
