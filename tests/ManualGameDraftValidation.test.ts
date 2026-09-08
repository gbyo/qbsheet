/** @vitest-environment jsdom */

import { beforeEach, describe, expect, test } from 'vitest';
import { emptyInput, manualDraftStorageKey, readManualGameDraft } from '../src/app/ManualGameDraft';

beforeEach(() => {
  window.localStorage.clear();
});

describe('manual game draft validation', () => {
  test('rejects malformed persisted break lists before they reach the editor', () => {
    const input = emptyInput();
    window.localStorage.setItem(
      manualDraftStorageKey,
      JSON.stringify({ ...input, options: { ...input.options, breaks: 'after tossup 10' } }),
    );

    expect(readManualGameDraft()).toBeNull();
  });
});
