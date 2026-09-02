import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    // A real origin, so localStorage works: the stale-cache behaviour is a thing worth testing.
    environmentOptions: { jsdom: { url: 'https://live.qbsheet.com/t/bcdfghjkmnpqrstvwxyz' } },
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.tsx', 'tests/**/*.test.ts'],
  },
});
