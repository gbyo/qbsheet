import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * QBSheet Live Web.
 *
 * A separate build from the scorer on purpose. The scorer's Vite config maintains a service worker
 * whose precache list is coordinated around an in-progress game, and an asset that leaked into that
 * list would be cached offline for a scorekeeper who has no use for it. Two builds, two output
 * directories, one deployment boundary — see `vite.config.ts` at the repository root and
 * `tests/ServiceWorkerIsolation.test.ts`.
 *
 * There is deliberately no service worker here. Live Web caches its last snapshot in localStorage
 * and says how old it is; an offline shell would additionally have to reason about a stale
 * application version during a tournament, which is complexity that buys a spectator nothing.
 */
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    // A tournament's spectators load this once on arrival, over shared WiFi. Warn early.
    chunkSizeWarningLimit: 250,
    rollupOptions: {
      output: {
        // One chunk. A code-split boundary would be a second request on a congested network to save
        // bytes that were already going to be downloaded within the minute.
        manualChunks: undefined,
      },
    },
  },
  server: { port: 5175 },
  preview: { port: 4175 },
});
