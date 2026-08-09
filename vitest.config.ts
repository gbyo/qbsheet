import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    // jsdom refuses `localStorage` on an opaque origin, and the journal every scored question is
    // written to lives there. Without a real origin the tests would exercise a browser that cannot
    // save, which is a case worth testing deliberately and not by accident.
    environmentOptions: { jsdom: { url: 'https://example.org/scoresheet/' } },
    setupFiles: ['./tests/setup.ts'],
    // Engine tests live next to the engine; application and integration tests live in `tests/`.
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
    css: false,
  },
});
