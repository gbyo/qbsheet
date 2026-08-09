/**
 * What every test starts from: a device that has scored nothing.
 *
 * jsdom has no IndexedDB, and running the application tests against the in-memory fallback would
 * mean never exercising the durable path — including the one thing it is there for, which is a game
 * surviving a reload. `fake-indexeddb` is a real implementation of the API, so the store under test
 * is the store that ships.
 */
import 'fake-indexeddb/auto';
import './localStorage';
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';

afterEach(() => {
  cleanup();
  // A journal or a database left behind would make a recovery test pass for the wrong reason.
  try {
    window.localStorage.clear();
  } catch {
    // A jsdom without storage is fine; the tests that need it construct their own.
  }
  globalThis.indexedDB = new IDBFactory();
});

// React 18 only suppresses its act() advice when a test environment says so explicitly. Without
// this the scorer's asynchronous effects — the wake lock, the clock — fill the output with
// warnings about updates the tests deliberately drive.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
