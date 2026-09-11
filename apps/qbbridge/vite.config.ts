import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const appRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(appRoot, '../..');

/**
 * QBBridge is its own small Vite application.
 *
 * It reads a handful of pure modules out of the root repository — the QBJ parser it tests
 * assignments against, the canonical digest helpers, the QBTCP pairing-link builder and the QR
 * encoder — the same way Director does, so the file boundary stays in this config rather than in
 * a build step. It shares no application architecture with Director.
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
    port: 1425,
    strictPort: true,
    fs: { allow: [appRoot, repositoryRoot] },
  },
  preview: {
    host: '127.0.0.1',
    port: 1425,
    strictPort: true,
  },
  build: {
    outDir: resolve(appRoot, 'dist'),
    emptyOutDir: true,
    sourcemap: true,
  },
});
