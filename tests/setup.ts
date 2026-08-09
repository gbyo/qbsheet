import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
  // Every test starts with a device that has scored nothing. Leaking a journal between tests would
  // make recovery tests pass for the wrong reason.
  try {
    window.localStorage.clear();
  } catch {
    // A jsdom without storage is fine; the tests that need it construct their own.
  }
});
