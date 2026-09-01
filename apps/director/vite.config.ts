import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const appRoot = import.meta.dirname;
const repositoryRoot = resolve(appRoot, '../..');

export default defineConfig({
  root: appRoot,
  base: './',
  plugins: [react()],
  resolve: {
    // The Director entry imports the shared root UI. Dedupe keeps the root source and this package
    // from ever creating two React contexts when the package is installed alongside the repository.
    dedupe: ['react', 'react-dom'],
  },
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    fs: {
      // The app deliberately composes the existing PR #182 Director UI from the repository root.
      allow: [repositoryRoot],
    },
  },
  build: {
    outDir: resolve(appRoot, 'dist'),
    emptyOutDir: true,
  },
});
